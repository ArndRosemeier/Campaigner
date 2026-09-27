import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import { createCampaign } from '@/db/campaignRepo';
import { createArtifact, getArtifact } from '@/db/artifactRepo';
import { createModule as createModuleRow } from '@/db/moduleRepo';
import { addPersona } from '@/db/personaRepo';
import { getRun } from '@/db/runRepo';
import {
  createModule,
  mobCasterLevel,
  mobSpellChips,
  mobSpellIndex,
  moduleSchema,
  type Campaign,
  type Id,
  type Module,
  type Persona,
} from '@/domain';
import { runEngine, type StartRunInput } from '@/llm/runEngine';
import { pcDraftSchema } from '@/llm/schemas';
import { BUILT_IN_PERSONAS } from '@/llm/personas/builtins';
import { MOB_SPELL_CASTER_CLAUSE, MOB_SPELL_SECTION_PREFIX } from '@/llm/promptScaffolding';
import { resolveRefillPersona } from '@/features/campaign/refillPersona';
import { realSpell, seedSpellCorpus, userPromptOf } from '../helpers/spellFixtures';
import { personaBySlug } from '../helpers/builtInPersona';
import { clearDatabase } from '../db/helpers';

/**
 * THE PLAYER CHARACTER ASSISTANT (docs/17 row 373) THROUGH THE REAL ENGINE.
 *
 * The chat transport is mocked and nothing else is: the persona, the step plan,
 * the stat-block prompt, the reply contract, the spell boundary, the refill
 * merge and the Dexie write are the shipped ones. Every pin below has a
 * NON-VACUITY arm — the same library and the same inputs through the NPC lane
 * — because a green pin that cannot go red proves nothing. The corpus and the
 * prompt read come from the ONE shared harness (`tests/helpers/spellFixtures`),
 * which this row folded six private copies onto.
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
vi.mocked(searchRules).mockResolvedValue([]);

const lastPrompt = (callIndex: number): string =>
  userPromptOf(chatMock.mock.calls[callIndex]?.[0]);


const PC_DRAFT = {
  name: 'Lyra Vane',
  summary: 'A human wizard of the Ashen Vault.',
  suggestedTags: ['wizard'],
  body: '# Lyra Vane\nShe studied at the Vault.',
  notes: 'Carries a cracked orb and an unpaid debt.',
};

const NPC_DRAFT = {
  name: 'Grix',
  summary: 'A goblin alchemist boss.',
  suggestedTags: ['goblin', 'alchemist'],
  body: '# Grix\nShe brews. She throws.',
  appearance: 'Small, soot-stained.',
  personality: 'Manic, cheerful.',
  needsStatBlock: true,
};

function statBlockReply(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    system: 'pathfinder2e',
    level: '3',
    size: 'Medium',
    creatureType: 'humanoid (human)',
    ac: 18,
    acNote: '',
    hp: 32,
    hpFormula: '',
    speed: '25 feet',
    abilities: { str: 10, dex: 14, con: 12, int: 18, wis: 12, cha: 10 },
    saves: '',
    skills: '',
    senses: '',
    languages: 'Common',
    traits: [{ name: 'Arcane School', text: 'She specialises in evocation.' }],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
    ...over,
  };
}

const CAMPAIGN = (campaign: Campaign) => ({
  id: campaign.id,
  name: campaign.name,
  system: 'pathfinder2e' as const,
  description: '',
  coverImageId: null,
  createdAt: campaign.createdAt,
  updatedAt: campaign.updatedAt,
});

function inputFor(
  campaign: Campaign,
  persona: Persona,
  brief: string,
  targetArtifactId?: Id,
): StartRunInput {
  return {
    campaign: CAMPAIGN(campaign),
    persona,
    autonomy: 'auto',
    brief,
    pinnedChunkIds: [],
    ...(targetArtifactId === undefined ? {} : { targetArtifactId }),
  };
}

async function pcPersona(): Promise<Persona> {
  return addPersona(personaBySlug('pc-smith'));
}

async function npcPersona(): Promise<Persona> {
  return addPersona(personaBySlug('npc-smith'));
}

async function runAuto(input: StartRunInput): Promise<Id> {
  const runId = await runEngine.startRun(input);
  await waitFor(async () => {
    expect((await getRun(runId))?.status).toBe('completed');
  }, { timeout: 15000 });
  return runId;
}

/** A module whose BAND is 1–3 and which states no exact level for any name. */
function moduleRow(campaignId: Id, title: string): Module {
  const draft = createModule({
    campaignId,
    title,
    concept: '',
    levelMin: 1,
    levelMax: 3,
    sizeDial: 'sketch',
  });
  return moduleSchema.parse({
    ...draft,
    spine: {
      premise: 'The Ashen Vault keeps its own counsel.',
      themes: [],
      partPlan: [{ title: 'Part', levelBand: '1–3', synopsis: '', levelUpTrigger: '' }],
    },
    parts: [{ planIndex: 0, markdown: 'The vault antechamber.', status: 'ready' as const, errorMessage: '', edited: false }],
  });
}

beforeEach(async () => {
  await clearDatabase();
  chatMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the player character assistant (docs/17 row 373)', () => {
  // -------------------------------------------------------------------------
  // (c) ONE declared persona, and exactly one built-in produces `pc`.
  // -------------------------------------------------------------------------
  it('resolves the pc kind to pc-smith, and exactly one built-in persona produces a pc', () => {
    expect(resolveRefillPersona(BUILT_IN_PERSONAS, 'pc')?.slug).toBe('pc-smith');
    expect(BUILT_IN_PERSONAS.filter((persona) => persona.producesKind === 'pc')).toHaveLength(1);
    const pc = personaBySlug('pc-smith');
    expect(pc.mode).toBe('generate');
    expect(pc.postCreateExtras).toEqual([]);
    // It reads as PLAYER CHARACTERS, never as a mob smith, and it stays sparse:
    // the rules are the model's, the app explains only the format, and no count
    // may be invented — spells named explicitly.
    expect(pc.description.toLowerCase()).toContain('player character');
    expect(pc.description.toLowerCase()).not.toContain('npc');
    expect(pc.systemPrompt).toContain('you know them');
    expect(pc.systemPrompt).toContain('The app explains the FORMAT');
    expect(pc.systemPrompt).toContain('never invent a cap');
    expect(pc.systemPrompt).toContain('spell, cantrip and option');
    expect(pc.systemPrompt).toContain('Always answer in the exact JSON format requested.');
  });

  // -------------------------------------------------------------------------
  // (f) + (b) the statblock step exists for `pc`, states the format only, and
  // carries neither the corpus whitelist nor the "2 cantrips" caster clause.
  // -------------------------------------------------------------------------
  it('RUNS a statblock step for a pc and offers it the FORMAT — no corpus, no caster clause', async () => {
    await seedSpellCorpus('pathfinder2e');
    const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
    const persona = await pcPersona();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(PC_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({
        text: JSON.stringify(statBlockReply({ spells: [{ name: 'Flameball', castRank: 3 }, { name: 'Ignition' }] })),
        modelUsed: 'test-model',
        fallback: null,
      });

    const runId = await runAuto(inputFor(campaign, persona, 'Write this player character.'));
    const run = await getRun(runId);
    const statblock = run?.steps.find((step) => step.name === 'statblock');

    // (f) THE STEP EXISTS AND RAN: at the base tree a pc run has no statblock
    // step at all (the plan gave it to `producesKind === 'npc'` only).
    expect(statblock).toBeDefined();
    expect(statblock?.status).toBe('done');
    expect(run?.steps.map((step) => step.name)).toEqual(['retrieve', 'draft', 'statblock', 'finalize']);

    // (b) THE PROMPT: the format section is there, the NPC limits are not.
    const prompt = lastPrompt(1);
    expect(prompt).not.toContain(MOB_SPELL_SECTION_PREFIX);
    expect(prompt).not.toContain(MOB_SPELL_CASTER_CLAUSE);
    expect(prompt).not.toContain("copied EXACTLY from this prompt's spell list");
    expect(prompt).not.toContain('"extras": Record<string,string>');
    expect(prompt).toContain('Format for this player character');
    // The spell contract IS offered, with the system's own entry keys.
    expect(prompt).toContain('"spells": [');
    expect(prompt).toContain('"castRank"');
    // The format maps the sheet onto the fields the model can actually emit
    // (`extras` cannot exist in strict mode).
    expect(prompt).toContain('"creatureType"');
    expect(prompt).toContain('"traits"');
    // The level is asked for as a BARE NUMBER, which is what the app's own
    // cantrip rule can read (pin below).
    expect(prompt).toContain('as a bare number');
  }, 30000);

  // -------------------------------------------------------------------------
  // (a) A spell the library does NOT hold survives, un-repaired and un-noticed,
  // while the NPC lane with the SAME library and the SAME name repairs and
  // notices (the non-vacuity arm).
  // -------------------------------------------------------------------------
  it('keeps an unlisted PC spell with NO repair turn and NO "Unresolved mob spells" notice — and the NPC lane still does both', async () => {
    await seedSpellCorpus('pathfinder2e');
    const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });

    // THE PC ARM: 'Flameball' is not in the imported library.
    const pcRunId = await (async () => {
      const persona = await pcPersona();
      chatMock
        .mockResolvedValueOnce({ text: JSON.stringify(PC_DRAFT), modelUsed: 'test-model', fallback: null })
        .mockResolvedValueOnce({
          text: JSON.stringify(statBlockReply({ spells: [{ name: 'Flameball', castRank: 3 }, { name: 'Ignition' }] })),
          modelUsed: 'test-model',
          fallback: null,
        });
      return runAuto(inputFor(campaign, persona, 'Write this player character.'));
    })();

    // EXACTLY TWO CALLS: the draft and the stat block. A repair turn would be a
    // third, and the PC lane must not spend it on a name the app cannot find.
    expect(chatMock.mock.calls).toHaveLength(2);
    const pcRun = await getRun(pcRunId);
    const pcStatblockStep = pcRun?.steps.find((step) => step.name === 'statblock');
    const pcOutput = pcStatblockStep?.output as { notice?: string; spellIssues?: unknown } | null | undefined;
    expect(pcStatblockStep?.status).toBe('done');
    expect(pcOutput?.notice ?? '').not.toContain('Unresolved');
    expect(pcOutput?.notice ?? '').not.toContain('mob');
    expect(pcOutput?.spellIssues).toBeUndefined();
    // The name SURVIVES on the row (never dropped, never text): the chip can
    // still show it as unresolved on the character's card.
    const pcArtifact = await getArtifact(pcRun?.resultArtifactId ?? '');
    expect(pcArtifact?.kind).toBe('pc');
    if (pcArtifact?.kind !== 'pc') throw new Error('the pc run produced no pc');
    expect(pcArtifact.data.statBlock?.spells).toEqual([
      { name: 'Flameball', castRank: 3 },
      { name: 'Ignition' },
    ]);

    // THE NON-VACUITY ARM: the same library, the same absent name, the NPC lane
    // — where the boundary DOES run: one repair turn, then the notice.
    chatMock.mockReset();
    const npc = await npcPersona();
    const invented = statBlockReply({ spells: [{ name: 'Flameball', castRank: 3 }] });
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(NPC_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(invented), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(invented), modelUsed: 'test-model', fallback: null });
    const npcRunId = await runAuto(inputFor(campaign, npc, 'a goblin alchemist boss'));
    expect(chatMock.mock.calls).toHaveLength(3);
    expect(lastPrompt(2)).toContain('Flameball');
    const npcRun = await getRun(npcRunId);
    const npcStatblockStep = npcRun?.steps.find((step) => step.name === 'statblock');
    const npcOutput = npcStatblockStep?.output as { notice?: string } | null | undefined;
    expect(npcOutput?.notice ?? '').toContain('Unresolved mob spells');
    expect(npcOutput?.notice ?? '').toContain('Flameball');
  }, 30000);

  // -------------------------------------------------------------------------
  // (d) THE REFILL writes into the pc row and leaves the player's fields alone.
  // -------------------------------------------------------------------------
  it('refills INTO the pc row, preserves playerName/currentHp/initiativeOverride, and reads the description that is there', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
    const persona = await pcPersona();
    const target = await createArtifact({
      campaignId: campaign.id,
      kind: 'pc',
      name: 'Lyra Vane',
      summary: 'A young wizard from the Vault.',
      body: 'A young wizard from the Vault, sent away by her family.',
      tags: [],
      data: {
        playerName: 'Alice',
        statBlock: null,
        currentHp: 17,
        initiativeOverride: 3,
        notes: 'Old notes.',
      },
    });
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(PC_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(statBlockReply()), modelUsed: 'test-model', fallback: null });

    const runId = await runAuto(
      inputFor(campaign, persona, 'Generate the full content of this player character.', target.id),
    );

    // THE DESCRIPTION ON THE ROW IS THE INPUT (the owner's whole request): the
    // pc draft prompt renders the target's own summary/body/notes.
    const draftPrompt = lastPrompt(0);
    expect(draftPrompt).toContain("The player character's own description");
    expect(draftPrompt).toContain('A young wizard from the Vault, sent away by her family.');
    expect(draftPrompt).toContain('Old notes.');

    const after = await getArtifact(target.id);
    expect(after?.id).toBe(target.id);
    if (after?.kind !== 'pc') throw new Error('the refill target is not a pc');
    // The player's OWN fields are byte-identical across the refill.
    expect(after.data.playerName).toBe('Alice');
    expect(after.data.currentHp).toBe(17);
    expect(after.data.initiativeOverride).toBe(3);
    // …and the model's content landed, stat block included.
    expect(after.data.notes).toBe(PC_DRAFT.notes);
    expect(after.body).toBe(PC_DRAFT.body);
    expect(after.data.statBlock?.level).toBe('3');
    expect(after.data.statBlock?.spells).toBeUndefined();
    // One write, into the SAME row (no second PC was created).
    expect((await getRun(runId))?.resultArtifactId).toBe(target.id);
  }, 30000);

  // -------------------------------------------------------------------------
  // (g) A PC is neither BOUND nor REJECTED by a module level hint; the NPC lane
  // in the SAME module still is.
  // -------------------------------------------------------------------------
  it('a pc ignores a module level hint (no binding, no rejection) while the npc lane is still bound by it', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
    const module = moduleRow(campaign.id, 'Ashen Vault');
    await createModuleRow(module);

    // THE PC ARM: module-owned, band 1–3, and the reply prints level 9.
    const pcTarget = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'pc',
      name: 'Lyra Vane',
      summary: '',
      body: 'A wizard far above this vault.',
      tags: [`module:${module.title}`],
      data: { playerName: '', statBlock: null, currentHp: 20, initiativeOverride: null, notes: '' },
    });
    const persona = await pcPersona();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(PC_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(statBlockReply({ level: '9' })), modelUsed: 'test-model', fallback: null });
    const pcRunId = await runAuto(
      inputFor(campaign, persona, 'Generate the full content of this player character.', pcTarget.id),
    );
    const pcRun = await getRun(pcRunId);
    const pcStatblock = pcRun?.steps.find((step) => step.name === 'statblock');
    expect(pcStatblock?.status).toBe('done');
    const pcAfter = await getArtifact(pcTarget.id);
    if (pcAfter?.kind !== 'pc') throw new Error('the refill target is not a pc');
    // NOT BOUND: the character's own printed level survives.
    expect(pcAfter.data.statBlock?.level).toBe('9');
    // NO REPAIR: exactly draft + stat block (a bound lane would spend a third
    // call and then reject the block).
    expect(chatMock.mock.calls).toHaveLength(2);

    // THE NON-VACUITY ARM: the same module, the same band, an NPC target, the
    // same level-9 reply — bound, repaired, REJECTED.
    chatMock.mockReset();
    const npc = await npcPersona();
    const npcTarget = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Grix',
      summary: '',
      body: 'A goblin alchemist.',
      tags: [`module:${module.title}`],
      data: { appearance: '', personality: '', statBlock: null },
    });
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(NPC_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(statBlockReply({ level: '9' })), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(statBlockReply({ level: '9' })), modelUsed: 'test-model', fallback: null });
    const npcInput: StartRunInput = {
      ...inputFor(campaign, npc, 'Refill this NPC.', npcTarget.id),
      autonomy: 'manual',
    };
    const npcRunId = await runEngine.startRun(npcInput);
    await waitFor(async () => {
      expect((await getRun(npcRunId))?.status).toBe('awaiting_user');
    }, { timeout: 15000 });
    await runEngine.approve(npcRunId, npcInput);
    await waitFor(async () => {
      const step = (await getRun(npcRunId))?.steps.find((candidate) => candidate.name === 'statblock');
      expect(step?.status).toBe('rejected');
    }, { timeout: 15000 });
    const npcRun = await getRun(npcRunId);
    const npcStatblock = npcRun?.steps.find((step) => step.name === 'statblock');
    const npcOutput = npcStatblock?.output as { issues?: string[] } | null | undefined;
    expect(npcOutput?.issues?.join(' ')).toContain('level');
  }, 30000);

  // -------------------------------------------------------------------------
  // The two schema decisions of §4, by name.
  // -------------------------------------------------------------------------
  it('the pc draft has NO `concept` and NO `needsStatBlock`, and a player row without a stat block stays LEGAL', async () => {
    // The field that went nowhere is GONE (a required model output no reader
    // consumed was a field thrown away), and there is no veto to set because a
    // player character always runs the stat block step.
    expect(Object.keys(pcDraftSchema.shape)).toEqual(['name', 'summary', 'suggestedTags', 'body', 'notes']);
    const parsed = pcDraftSchema.parse({ ...PC_DRAFT, concept: 'ignored', needsStatBlock: false });
    expect('concept' in parsed).toBe(false);
    expect('needsStatBlock' in parsed).toBe(false);

    // A statless PC is LEGAL and creates fine (docs/17 row 308): the row is not
    // a loud error, it simply has no numbers yet.
    const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
    const statless = await createArtifact({
      campaignId: campaign.id,
      kind: 'pc',
      name: 'Statless Sam',
      summary: '',
      body: '',
      tags: [],
      data: { playerName: '', statBlock: null, currentHp: 20, initiativeOverride: null, notes: '' },
    });
    const after = await getArtifact(statless.id);
    if (after?.kind !== 'pc') throw new Error('not a pc');
    expect(after.data.statBlock).toBeNull();
    expect(after.data.currentHp).toBe(20);
  }, 30000);

  // -------------------------------------------------------------------------
  // The level FORMAT rule, grounded in the mechanism it protects.
  // -------------------------------------------------------------------------
  it('reads a BARE numeric level for the spell rule — a free-form level string would make every library cantrip a spurious issue', async () => {
    const ignition = await realSpell('ignition.json', 'spells/spells/cantrip/ignition.json');
    const index = mobSpellIndex([{ name: 'Ignition', spellData: ignition }]);

    const bare = mobSpellChips([{ name: 'Ignition' }], mobCasterLevel('3'), index);
    expect(bare[0]?.resolved).toBe(true);
    expect(bare[0]?.issues).toEqual([]);

    // The class+level string is why the pc format asks for a bare NUMBER: the
    // rule cannot read it, and an in-library cantrip would render as an issue.
    expect(mobCasterLevel('Wizard 3')).toBeNull();
    const freeForm = mobSpellChips([{ name: 'Ignition' }], mobCasterLevel('Wizard 3'), index);
    expect(freeForm[0]?.resolved).toBe(true);
    expect(freeForm[0]?.issues.length).toBeGreaterThan(0);
  }, 30000);
});
