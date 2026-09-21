import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { createPersona } from '@/db/personaRepo';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { putChunks } from '@/db/chunkRepo';
import { getRun } from '@/db/runRepo';
import { runEngine, type StartRunInput } from '@/llm/runEngine';
import { MOB_SPELL_CASTER_CLAUSE, MOB_SPELL_SECTION_PREFIX } from '@/llm/promptScaffolding';
import { spellEntryShape } from '@/llm/statBlockContract';
import { foundryPf2eRulesAdapter } from '@/ingest/packs/pf2e-rules';
import {
  ruleChunkSchema,
  stampNewEntity,
  type Persona,
  type RuleChunk,
  type SpellData,
} from '@/domain';
import { clearDatabase } from '../db/helpers';

/**
 * EVERY AI-authored mob lane carries the SAME spells instruction (docs/17 row
 * 200). Row 184 built the vocabulary and the no-invention boundary for the NPC
 * stat-block step and an encounter draft's inline blocks; it never touched the
 * reply contract's own "COMPLETE schema" line, and it never wired the Encounter
 * Cartographer at all — the lane that stocks a dungeon. This pin drives all
 * THREE lanes through the real engine with a mocked chat and requires each to
 * carry both halves with a corpus and NEITHER without one, so the hole cannot
 * silently reopen and a spell-less system's prompt keeps its pre-arc bytes.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {
    constructor() {
      super('No OpenRouter API key configured');
      this.name = 'MissingApiKeyError';
    }
  },
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

vi.mock('@/search', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), searchRules: vi.fn() };
});

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { searchRules } = await import('@/search');
const searchRulesMock = vi.mocked(searchRules);

/** The user turn of the Nth chat call — the prompt the model actually received. */
function lastPrompt(callIndex: number): string {
  const content = chatMock.mock.calls[callIndex]?.[0].at(-1)?.content;
  return typeof content === 'string' ? content : '';
}

/** The full-pipeline waits below can ride a repair turn, so the bound is 15s. */
function waitForRun(assertion: () => void | Promise<void>) {
  return waitFor(assertion, { timeout: 15000 });
}

const SPELL_FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'spells');
const MOB_SPELL_FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'mobSpells');
const NPC_GOLDEN = join(MOB_SPELL_FIXTURES, 'statblock-no-corpus.txt');
/** Pre-arc goldens, captured at HEAD before the caster-awareness slice. */
const NPC_DRAFT_GOLDEN = join(MOB_SPELL_FIXTURES, 'npc-draft-no-corpus.txt');
const ENCOUNTER_DRAFT_GOLDEN = join(MOB_SPELL_FIXTURES, 'encounter-draft-with-corpus.txt');
const CARTOGRAPHER_BRIEF_GOLDEN = join(MOB_SPELL_FIXTURES, 'cartographer-brief-with-corpus.txt');

async function realSpell(file: string, packRelative: string): Promise<SpellData> {
  const bytes = new TextEncoder().encode(readFileSync(join(SPELL_FIXTURES, file), 'utf8'));
  const parsed = await foundryPf2eRulesAdapter.parseFile(packRelative, bytes);
  expect(parsed.failures).toEqual([]);
  const spell = parsed.sections?.[0]?.spell;
  if (spell === undefined) throw new Error(`fixture ${file} produced no spell payload`);
  return spell;
}

let seq = 0;

/** Seeds the campaign's OWN system with the REAL Fireball + Ignition payloads. */
async function seedCorpus(system: 'pathfinder2e' | 'dnd5e'): Promise<void> {
  const fireball = await realSpell('fireball.json', 'spells/spells/rank-3/fireball.json');
  const ignition = await realSpell('ignition.json', 'spells/spells/cantrip/ignition.json');
  const book = await createPackBook({ title: 'Spells', system, filename: 'spells.json' });
  const finished = await finalizePackBook(book.id, {
    sourceId: 'test-spells',
    license: 'ORC',
    entriesImported: 2,
    entriesSkipped: 0,
    entriesFailed: 0,
  });
  const chunk = (name: string, spellData: SpellData): RuleChunk => {
    seq += 1;
    return ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: finished.id,
      pageStart: 1,
      pageEnd: 1,
      chunkType: 'spell',
      headingPath: ['Spells', name],
      text: `${name}\nSource: Pathfinder Player Core (ORC)`,
      statBlock: null,
      spellData,
      contentHash: 'b'.repeat(63) + String(seq % 10),
    });
  };
  await putChunks([chunk('Fireball', fireball), chunk('Ignition', ignition)]);
}

async function seedPersona(mode: 'npc' | 'encounter-draft' | 'cartographer'): Promise<Persona> {
  seq += 1;
  return createPersona({
    slug: `mob-spells-lane-${String(seq)}`,
    name:
      mode === 'npc' ? 'NPC Smith' : mode === 'cartographer' ? 'Encounter Cartographer' : 'Encounter Smith',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    ...(mode === 'cartographer' ? { mode: 'encounter' as const } : { mode: 'generate' as const }),
    producesKind: mode === 'npc' ? 'npc' : 'encounter',
    builtIn: true,
  });
}

const NPC_DRAFT = {
  name: 'Grix',
  summary: 'A goblin alchemist boss.',
  suggestedTags: ['goblin', 'alchemist'],
  body: '# Grix\nShe brews. She throws.',
  appearance: 'Small, soot-stained, goggles.',
  personality: 'Manic, cheerful, volatile.',
  needsStatBlock: true,
};

function statBlockReply(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    system: 'pathfinder2e',
    level: '5',
    size: 'Small',
    creatureType: 'goblinoid',
    ac: 20,
    acNote: '',
    hp: 60,
    hpFormula: '',
    speed: '25 feet',
    abilities: { str: 14, dex: 16, con: 14, int: 16, wis: 12, cha: 10 },
    saves: '',
    skills: '',
    senses: '',
    languages: 'Goblin',
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
    ...over,
  };
}

const NPC_BRIEF = 'a goblin alchemist boss for a level 5 party';

/** Drives the NPC smith to its stat-block step and returns that step's prompt. */
async function npcStatblockPrompt(
  withCorpus: boolean,
  system: 'pathfinder2e' | 'dnd5e' = 'pathfinder2e',
): Promise<string> {
  const campaign = await createCampaign({ name: 'Ember', system });
  if (withCorpus) await seedCorpus(system);
  const persona = await seedPersona('npc');
  const input: StartRunInput = {
    campaign,
    persona,
    autonomy: 'manual',
    brief: NPC_BRIEF,
    pinnedChunkIds: [],
  };
  chatMock
    .mockResolvedValueOnce({ text: JSON.stringify(NPC_DRAFT), modelUsed: 'test-model', fallback: null })
    .mockResolvedValueOnce({
      text: JSON.stringify(
        withCorpus
          ? statBlockReply({ system, spells: [{ name: 'Fireball', castRank: 5 }] })
          : statBlockReply({ system }),
      ),
      modelUsed: 'test-model',
      fallback: null,
    });
  const runId = await runEngine.startRun(input);
  await waitForRun(async () => {
    expect((await getRun(runId))?.status).toBe('awaiting_user');
  });
  await runEngine.approve(runId, input);
  await waitForRun(async () => {
    expect((await getRun(runId))?.steps.find((step) => step.name === 'statblock')?.status).toBe('done');
  });
  return lastPrompt(1);
}

/** Drives the NPC smith to its DRAFT step and returns that step's prompt. */
async function npcDraftPrompt(withCorpus: boolean): Promise<string> {
  const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
  if (withCorpus) await seedCorpus('pathfinder2e');
  const persona = await seedPersona('npc');
  const input: StartRunInput = {
    campaign,
    persona,
    autonomy: 'manual',
    brief: NPC_BRIEF,
    pinnedChunkIds: [],
  };
  chatMock.mockResolvedValueOnce({
    text: JSON.stringify(NPC_DRAFT),
    modelUsed: 'test-model',
    fallback: null,
  });
  const runId = await runEngine.startRun(input);
  await waitForRun(async () => {
    expect((await getRun(runId))?.steps.find((step) => step.name === 'draft')?.status).toBe('done');
  });
  // The LAST call: a mocked reply can ride a repair turn, and the draft prompt
  // is the one this helper is asked for.
  return lastPrompt(chatMock.mock.calls.length - 1);
}

function encounterDraftReply(withCorpus: boolean): Record<string, unknown> {
  return {
    name: 'Ambush at the ford',
    summary: 'A bridge ambush.',
    suggestedTags: ['ambush'],
    body: '# Ambush at the ford',
    difficulty: 'deadly',
    levelHint: '', partyLevel: 5,
    monsters: [
      {
        name: 'Cultist',
        count: 4,
        notes: 'netters',
        statBlock: statBlockReply(
          withCorpus ? { level: '5', spells: [{ name: 'Fireball', castRank: 3 }] } : { level: '5' },
        ),
      },
    ],
    terrain: 'river crossing',
    tactics: 'hit and run',
    treasure: 'none',
    locationKind: 'dungeon',
  };
}

/** Drives the encounter Smith to its draft step and returns that step's prompt. */
async function encounterDraftPrompt(withCorpus: boolean): Promise<string> {
  const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
  if (withCorpus) await seedCorpus('pathfinder2e');
  const persona = await seedPersona('encounter-draft');
  const input: StartRunInput = {
    campaign,
    persona,
    autonomy: 'manual',
    brief: 'A cultist ambush at the ford',
    pinnedChunkIds: [],
  };
  chatMock.mockResolvedValueOnce({
    text: JSON.stringify(encounterDraftReply(withCorpus)),
    modelUsed: 'test-model',
    fallback: null,
  });
  const runId = await runEngine.startRun(input);
  await waitForRun(async () => {
    expect((await getRun(runId))?.steps.find((step) => step.name === 'draft')?.status).toBe('done');
  });
  return lastPrompt(0);
}

function cartographerBriefReply(spells: readonly { name: string; castRank?: number }[]): Record<string, unknown> {
  return {
    name: 'Ash Gate Ambush',
    summary: 'Cultists guard a ruined gate.',
    body: '# Ash Gate\nA room-by-room battle.',
    difficulty: 'hard',
    levelHint: '', partyLevel: 4,
    terrain: 'broken pillars',
    tactics: 'fall back through the gate',
    treasure: 'obsidian key',
    theme: 'ash-choked temple',
    styleNotes: 'inked fantasy map, volcanic stone',
    negative: 'text, labels, tokens',
    monsters: [
      {
        name: 'Ash Cultist',
        count: 1,
        notes: '',
        treasure: '',
        statBlock: statBlockReply({ level: '4', spells }),
      },
    ],
    rooms: [
      {
        name: 'Entry',
        description: 'Broken doors',
        size: 'medium',
        monsterIndexes: [0],
        adjacentRoomIndexes: [],
        key: 'Cracked doors hang off one hinge.',
        keyTreasure: 'Fallen banner: 15 gp',
      },
    ],
    entryRoomIndex: 0,
  };
}

function cartographerInput(
  campaign: Awaited<ReturnType<typeof createCampaign>>,
  persona: Persona,
): StartRunInput {
  return {
    campaign,
    persona,
    autonomy: 'manual',
    brief: 'A temple gate encounter',
    pinnedChunkIds: [],
    // The create dialog's structured party level (docs/17 row 291).
    encounterPartyLevel: 5,
    encounterMapAspect: '4:3',
  };
}

/** Drives the Cartographer to its brief step and returns that step's prompt. */
async function cartographerBriefPrompt(withCorpus: boolean): Promise<string> {
  const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
  if (withCorpus) await seedCorpus('pathfinder2e');
  const persona = await seedPersona('cartographer');
  chatMock.mockResolvedValueOnce({
    text: JSON.stringify(
      cartographerBriefReply(withCorpus ? [{ name: 'Fireball', castRank: 3 }] : []),
    ),
    modelUsed: 'test-model',
    fallback: null,
  });
  const runId = await runEngine.startRun(cartographerInput(campaign, persona));
  await waitForRun(async () => {
    expect((await getRun(runId))?.steps.find((step) => step.name === 'brief')?.status).toBe('done');
  });
  return lastPrompt(0);
}

beforeEach(async () => {
  await clearDatabase();
  seq = 0;
  chatMock.mockReset();
  searchRulesMock.mockReset();
  searchRulesMock.mockResolvedValue([]);
});

afterEach(() => {
  chatMock.mockReset();
});

describe('every AI-authored mob lane carries the ONE spells instruction (docs/17 row 200)', () => {
  it('the NPC stat-block step carries the clause and the vocabulary with a corpus', async () => {
    const present = await npcStatblockPrompt(true);
    expect(present).toContain(MOB_SPELL_SECTION_PREFIX);
    // The caster-awareness clause (docs/17 row 201) rides the SAME prompt the
    // vocabulary does, so the rule and the list cannot drift.
    expect(present).toContain(MOB_SPELL_CASTER_CLAUSE);
    expect(present).toContain('MUST be given spells');
    expect(present).toContain('necromancer');
    // The count is STATED (docs/17 row 211): 2 cantrips, then 2 per rank.
    expect(present).toContain('2 cantrips, then 2 spells of each rank');
    expect(present).toContain('Fireball — Rank 3');
    expect(present).toContain('Ignition — Cantrip');
    // The contract line offers the field the vocabulary invites: row 184's defect.
    expect(present).toContain('"spells": [');
    expect(present).toContain('matching this COMPLETE schema');
  }, 60000);

  it('the NPC stat-block prompt renders the PF2e PROSE SHAPE its own request schema demands (docs/17 row 205)', async () => {
    const present = await npcStatblockPrompt(true, 'pathfinder2e');
    expect(present).toContain(spellEntryShape('pathfinder2e'));
    expect(present).toContain('"autoHeightenLevel"');
    expect(present).not.toContain('"casterLevel"');
    expect(present).not.toContain('"characterLevel"');
  }, 60000);

  it('the dnd5e NPC stat-block prompt renders the dnd5e shape — the mirror (docs/17 row 205)', async () => {
    const present = await npcStatblockPrompt(true, 'dnd5e');
    expect(present).toContain(spellEntryShape('dnd5e'));
    expect(present).toContain('"casterLevel"');
    expect(present).toContain('"characterLevel"');
    expect(present).not.toContain('"autoHeightenLevel"');
  }, 60000);

  it('the NPC DRAFT step carries the clause with a corpus', async () => {
    const present = await npcDraftPrompt(true);
    expect(present).toContain(MOB_SPELL_CASTER_CLAUSE);
    expect(present).toContain('MUST be given spells');
    expect(present).toContain('2 cantrips, then 2 spells of each rank');
    // The draft authors no stat block, so it is offered the RULE, not the list.
    expect(present).not.toContain(MOB_SPELL_SECTION_PREFIX);
  }, 60000);

  it('the caster clause states the 2-per-level count and keeps the contract fields (docs/17 row 211)', () => {
    // THE bytes the model reads, pinned: 2 cantrips, then 2 of each rank up to
    // the highest it can cast, chosen from the imported list.
    expect(MOB_SPELL_CASTER_CLAUSE).toContain(
      '2 cantrips, then 2 spells of each rank (spell level) up to the highest it can cast',
    );
    expect(MOB_SPELL_CASTER_CLAUSE).toContain("chosen from the campaign's imported spell list");
    // The DC / attack / tradition fields are byte-unchanged (docs/17 row 201).
    expect(MOB_SPELL_CASTER_CLAUSE).toContain('"spellDC"');
    expect(MOB_SPELL_CASTER_CLAUSE).toContain('"spellAttack"');
    expect(MOB_SPELL_CASTER_CLAUSE).toContain('"tradition"');
    // The old open-ended count is GONE — no derivation of the creature's real
    // spell allotment survives in the clause.
    expect(MOB_SPELL_CASTER_CLAUSE).not.toContain('cantrips plus the spells its level allows');
  });

  it('the NPC DRAFT step keeps its PRE-ARC bytes without a corpus', async () => {
    // BYTE-IDENTITY: the pre-arc draft prompt, captured at HEAD before the
    // caster clause existed. A corpus-less system pays nothing. Separate test
    // from the one above because the corpus is per-DATABASE, not per-run.
    const absent = await npcDraftPrompt(false);
    expect(absent).toBe(readFileSync(NPC_DRAFT_GOLDEN, 'utf8'));
    expect(absent).not.toContain(MOB_SPELL_CASTER_CLAUSE);
  }, 60000);

  it('the NPC stat-block step keeps its PRE-ARC bytes without a corpus', async () => {
    const absent = await npcStatblockPrompt(false);
    // BYTE-IDENTITY: the pre-arc prompt, captured at the pre-fix tree.
    expect(absent).toBe(readFileSync(NPC_GOLDEN, 'utf8'));
    expect(absent).not.toContain(MOB_SPELL_SECTION_PREFIX);
    expect(absent).not.toContain(MOB_SPELL_CASTER_CLAUSE);
    expect(absent).not.toContain('"spells"');
  }, 60000);

  it('the encounter draft carries the clause and the vocabulary with a corpus', async () => {
    const present = await encounterDraftPrompt(true);
    expect(present).toContain(MOB_SPELL_SECTION_PREFIX);
    expect(present).toContain('Fireball — Rank 3');
    expect(present).toContain('"spells": [');
    // The owner's scope: the Encounter Smith keeps its existing OPTIONAL
    // invitation — the caster clause is the NPC lane's alone (docs/17 row 201).
    expect(present).not.toContain(MOB_SPELL_CASTER_CLAUSE);
    // BYTE-IDENTITY with the pre-arc prompt captured at HEAD: the shared
    // composer gained a third function, and this lane's bytes did not move.
    expect(present).toBe(readFileSync(ENCOUNTER_DRAFT_GOLDEN, 'utf8'));
  }, 60000);

  it('the encounter draft carries neither without a corpus', async () => {
    const absent = await encounterDraftPrompt(false);
    expect(absent).not.toContain(MOB_SPELL_SECTION_PREFIX);
    expect(absent).not.toContain(MOB_SPELL_CASTER_CLAUSE);
    expect(absent).not.toContain('"spells"');
  }, 60000);

  it('the Cartographer lane carries the clause and the vocabulary with a corpus', async () => {
    const present = await cartographerBriefPrompt(true);
    expect(present).toContain(MOB_SPELL_SECTION_PREFIX);
    expect(present).toContain('Fireball — Rank 3');
    expect(present).toContain('"spells": [');
    expect(present).not.toContain(MOB_SPELL_CASTER_CLAUSE);
    // BYTE-IDENTITY with the pre-arc brief captured at HEAD.
    expect(present).toBe(readFileSync(CARTOGRAPHER_BRIEF_GOLDEN, 'utf8'));
  }, 60000);

  it('the Cartographer lane carries neither without a corpus', async () => {
    const absent = await cartographerBriefPrompt(false);
    expect(absent).not.toContain(MOB_SPELL_SECTION_PREFIX);
    expect(absent).not.toContain(MOB_SPELL_CASTER_CLAUSE);
    expect(absent).not.toContain('"spells"');
  }, 60000);

  it('the Cartographer validates an invented spell, repairs ONCE, then ships it LOUD', async () => {
    const campaign = await createCampaign({ name: 'Ash', system: 'dnd5e' });
    await seedCorpus('dnd5e');
    const persona = await seedPersona('cartographer');
    const invented = cartographerBriefReply([{ name: 'Flameball', castRank: 3 }]);
    // Every call (the brief, then the one repair) re-serves the same invention.
    chatMock.mockResolvedValue({ text: JSON.stringify(invented), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(cartographerInput(campaign, persona));
    await waitForRun(async () => {
      expect((await getRun(runId))?.steps.find((step) => step.name === 'brief')?.status).toBe('done');
    });

    // ONE repair turn, and it named the offending spell through the ONE seam.
    expect(chatMock).toHaveBeenCalledTimes(2);
    const repair = chatMock.mock.calls[1]?.[0].at(-1)?.content ?? '';
    expect(repair).toContain('Flameball');
    expect(repair).toContain('not in this campaign');

    // The name SURVIVES on the block and is loud on the step: raw issues plus
    // the notice naming the spell and the mob, never a silent drop.
    const brief = (await getRun(runId))?.steps.find((step) => step.name === 'brief');
    const output = brief?.output as { spellIssues?: string[]; notice?: string } | null | undefined;
    expect(output?.spellIssues?.[0]).toContain('Flameball');
    expect(output?.spellIssues?.[0]).toContain('Ash Cultist');
    expect(output?.notice).toContain('Flameball');
    expect(output?.notice).toContain('Ash Cultist');
  }, 60000);
});
