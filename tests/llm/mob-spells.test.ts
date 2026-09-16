import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import { createCampaign } from '@/db/campaignRepo';
import { getArtifact } from '@/db/artifactRepo';
import { createPersona } from '@/db/personaRepo';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { putChunks } from '@/db/chunkRepo';
import { getRun } from '@/db/runRepo';
import {
  mobSpellChipDetail,
  mobSpellChips,
  mobSpellIndex,
  ruleChunkSchema,
  stampNewEntity,
  type Id,
  type Persona,
  type RuleChunk,
  type SpellData,
} from '@/domain';
import { runEngine } from '@/llm/runEngine';
import { foundryPf2eRulesAdapter } from '@/ingest/packs/pf2e-rules';
import { MOB_SPELL_SECTION_HEADER } from '@/llm/promptScaffolding';
import { clearDatabase } from '../db/helpers';

/**
 * The mob half of the spells arc THROUGH THE REAL RUN PATH (docs/17 row 184):
 * the stat-block step of an AI-authored NPC, the library the prompt offers,
 * the boundary that checks what came back, and the row the engine finally
 * writes. The chat is mocked; nothing else is — the schema, the corpus read,
 * the resolver and the loud notice are the shipped ones.
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

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const SPELL_FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'spells');

async function realSpell(file: string, packRelative: string): Promise<SpellData> {
  const bytes = new TextEncoder().encode(readFileSync(join(SPELL_FIXTURES, file), 'utf8'));
  const parsed = await foundryPf2eRulesAdapter.parseFile(packRelative, bytes);
  expect(parsed.failures).toEqual([]);
  const spell = parsed.sections?.[0]?.spell;
  if (spell === undefined) throw new Error(`fixture ${file} produced no spell payload`);
  return spell;
}

const VALID_DRAFT = {
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

let seq = 0;
async function seedSpellLibrary(fireball: SpellData, ignition: SpellData): Promise<Id> {
  const book = await createPackBook({
    title: 'PF2e Spells',
    system: 'pathfinder2e',
    filename: 'spells.json',
  });
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
      contentHash: 'b'.repeat(63) + String(seq % 10),
      spellData,
    });
  };
  await putChunks([chunk('Fireball', fireball), chunk('Ignition', ignition)]);
  return finished.id;
}

async function seed(): Promise<{ campaignId: Id; persona: Persona }> {
  const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
  const persona = await createPersona({
    slug: 'npc-smith-mob-spells',
    name: 'NPC Smith',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    producesKind: 'npc',
    builtIn: true,
  });
  return { campaignId: campaign.id, persona };
}

const INPUT = (campaignId: Id, persona: Persona) => ({
  campaign: {
    id: campaignId,
    name: 'Ember',
    system: 'pathfinder2e' as const,
    description: '',
    coverImageId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  persona,
  autonomy: 'manual' as const,
  brief: 'a goblin alchemist boss for a level 5 party',
  pinnedChunkIds: [] as Id[],
});

/** Drives the two manual approvals to a finished run and returns its artifact. */
async function runToArtifact(campaignId: Id, persona: Persona) {
  const input = INPUT(campaignId, persona);
  const runId = await runEngine.startRun(input);
  await waitFor(async () => {
    const run = await getRun(runId);
    expect(run?.status).toBe('awaiting_user');
  });
  await runEngine.approve(runId, input);
  await waitFor(async () => {
    const run = await getRun(runId);
    expect(run?.steps.some((step) => step.name === 'statblock')).toBe(true);
  });
  await runEngine.approve(runId, input);
  await waitFor(async () => {
    const run = await getRun(runId);
    expect(run?.status).toBe('completed');
  });
  const run = await getRun(runId);
  const resultId = run?.resultArtifactId;
  if (resultId === null || resultId === undefined) throw new Error('run has no result artifact');
  const artifact = await getArtifact(resultId);
  if (artifact?.kind !== 'npc') throw new Error('run did not produce an npc');
  return { runId, artifact };
}

beforeEach(async () => {
  await clearDatabase();
  seq = 0;
});
afterEach(() => {
  chatMock.mockReset();
});

describe('an AI-authored mob carries spells (docs/17 row 184)', () => {
  it('offers the REAL library in the prompt, stores the assignment, and the chip shows spellAtRank values', async () => {
    const fireball = await realSpell('fireball.json', 'spells/spells/rank-3/fireball.json');
    const ignition = await realSpell('ignition.json', 'spells/spells/cantrip/ignition.json');
    await seedSpellLibrary(fireball, ignition);
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({
        text: JSON.stringify(
          statBlockReply({ spells: [{ name: 'Fireball', castRank: 5 }, { name: 'Ignition' }] }),
        ),
        modelUsed: 'test-model',
        fallback: null,
      });

    const { artifact } = await runToArtifact(campaignId, persona);

    // The prompt OFFERED the real corpus (the grounding half).
    const statblockPrompt = chatMock.mock.calls[1]?.[0].at(-1)?.content ?? '';
    expect(statblockPrompt).toContain(MOB_SPELL_SECTION_HEADER);
    expect(statblockPrompt).toContain('Fireball — Rank 3');
    expect(statblockPrompt).toContain('Ignition — Cantrip');

    // The stored row carries the assignment, and nothing invented.
    expect(artifact.data.statBlock?.spells).toEqual([
      { name: 'Fireball', castRank: 5 },
      // A cantrip carries NOTHING but its name: no rank key at all.
      { name: 'Ignition' },
    ]);

    // The chip model equals spellAtRank's output at the cast rank — Fireball at
    // rank 5 is the heightened 10d6, and the level-5 cantrip is rank 3 / 4d4.
    const index = mobSpellIndex([
      { name: 'Fireball', spellData: fireball },
      { name: 'Ignition', spellData: ignition },
    ]);
    const chips = mobSpellChips(
      artifact.data.statBlock?.spells,
      Number(artifact.data.statBlock?.level),
      index,
    );
    expect(chips.map((chip) => chip.resolved)).toEqual([true, true]);
    const [fireballChip, ignitionChip] = chips;
    if (fireballChip === undefined || ignitionChip === undefined) {
      throw new Error('the run stored no spell assignments');
    }
    expect(mobSpellChipDetail(fireballChip)).toContain('cast at rank 5: 10d6 fire');
    expect(mobSpellChipDetail(ignitionChip)).toContain('cast at rank 3');
    expect(mobSpellChipDetail(ignitionChip)).toContain('4d4 fire');
  }, 30000);

  it('keeps an INVENTED spell name as a loud issue and an unresolved entry, never as text', async () => {
    const fireball = await realSpell('fireball.json', 'spells/spells/rank-3/fireball.json');
    const ignition = await realSpell('ignition.json', 'spells/spells/cantrip/ignition.json');
    await seedSpellLibrary(fireball, ignition);
    const { campaignId, persona } = await seed();
    const invented = statBlockReply({ spells: [{ name: 'Flameball', castRank: 3 }] });
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      // The one repair turn is spent, and the model repeats the invention.
      .mockResolvedValueOnce({ text: JSON.stringify(invented), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(invented), modelUsed: 'test-model', fallback: null });

    const { runId, artifact } = await runToArtifact(campaignId, persona);

    // The repair was asked for, and it named the spell.
    const repairPrompt = chatMock.mock.calls[2]?.[0].at(-1)?.content ?? '';
    expect(repairPrompt).toContain('Flameball');
    expect(repairPrompt).toContain('not in this campaign');

    // Nothing was stored as TEXT: the entry is structured, so the chip knows it
    // exists and knows it does not resolve.
    expect(artifact.data.statBlock?.spells).toEqual([{ name: 'Flameball', castRank: 3 }]);
    const index = mobSpellIndex([
      { name: 'Fireball', spellData: fireball },
      { name: 'Ignition', spellData: ignition },
    ]);
    const chips = mobSpellChips(artifact.data.statBlock?.spells, 5, index);
    expect(chips[0]?.resolved).toBe(false);

    // LOUD on the run row: the step output keeps the issue list AND the notice
    // sentence names the spell and the mob.
    const run = await getRun(runId);
    const statblock = run?.steps.find((step) => step.name === 'statblock');
    const output = statblock?.output as { spellIssues?: string[]; notice?: string } | null;
    expect(output?.spellIssues).toEqual([
      'the mob «Grix» assigns a spell it cannot use: the spell «Flameball» is not in this campaign\'s imported spell library',
    ]);
    expect(output?.notice).toContain('Flameball');
    expect(output?.notice).toContain('Grix');
  }, 30000);

  it('repairs ONCE when the second reply names a real spell', async () => {
    const fireball = await realSpell('fireball.json', 'spells/spells/rank-3/fireball.json');
    const ignition = await realSpell('ignition.json', 'spells/spells/cantrip/ignition.json');
    await seedSpellLibrary(fireball, ignition);
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({
        text: JSON.stringify(statBlockReply({ spells: [{ name: 'Flameball' }] })),
        modelUsed: 'test-model',
        fallback: null,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify(statBlockReply({ spells: [{ name: 'Fireball', castRank: 3 }] })),
        modelUsed: 'test-model',
        fallback: null,
      });

    const { runId, artifact } = await runToArtifact(campaignId, persona);

    expect(artifact.data.statBlock?.spells).toEqual([{ name: 'Fireball', castRank: 3 }]);
    const run = await getRun(runId);
    const statblock = run?.steps.find((step) => step.name === 'statblock');
    expect((statblock?.output as { spellIssues?: string[] } | null)?.spellIssues).toBeUndefined();
    expect(chatMock).toHaveBeenCalledTimes(3);
  }, 30000);

  it('a LEGACY stat block with no spells key parses and carries no assignment', async () => {
    const fireball = await realSpell('fireball.json', 'spells/spells/rank-3/fireball.json');
    const ignition = await realSpell('ignition.json', 'spells/spells/cantrip/ignition.json');
    await seedSpellLibrary(fireball, ignition);
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(statBlockReply()), modelUsed: 'test-model', fallback: null });

    const { artifact } = await runToArtifact(campaignId, persona);

    expect(artifact.data.statBlock?.spells).toBeUndefined();
    expect(mobSpellChips(artifact.data.statBlock?.spells, 5, mobSpellIndex([]))).toEqual([]);
    expect(artifact.data.statBlock?.hp).toBe(60);
  }, 30000);
});
