import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodError } from 'zod';

import { createCampaign } from '@/db/campaignRepo';
import { createArtifact, getArtifact, listRevisions } from '@/db/artifactRepo';
import { createPersona } from '@/db/personaRepo';
import { createRun, getRun, updateRun } from '@/db/runRepo';
import { composedFailureMessage, runEngine, type StartRunInput } from '@/llm/runEngine';
import {
  npcDataSchema,
  newId,
  type Campaign,
  type Id,
  type Persona,
  type StatBlock,
} from '@/domain';
import { clearDatabase } from '../db/helpers';

/**
 * A REFILL OF A ROW THAT CITES A LIBRARY CREATURE never touches its stats (the
 * Aunt Agatha rule, docs/11 §A cited row's REFILL, docs/17 row 112).
 *
 * The owner's report, verbatim: *"One other thing that currently fails often is
 * NPC generation. My first theory was that it always fails on npc that need a
 * stat block, but i found 1 that successfully has one. Still, there seems to be
 * a connection though its not 100%. Unfortunately i do not see the failures as
 * failed runs. There is a warning message shown briefly with tons of text, but
 * its only shown briefly and looked like lots of json (not sure though). This
 * worked before the refactor."*
 *
 * The mechanism, MEASURED before this file existed: a cast creature row is born
 * `statBlock: null` + `creatureRef` (`db/creatureRepo.castCreatureAsNpc`), so
 * the draft pipeline ASKED the model `needsStatBlock` — and a zombie is a
 * character who fights, so the model wrote a block. `mergeRefillData` then
 * merged `draftData.statBlock` while preserving the citation, `updateArtifact`'s
 * `anyArtifactSchema.parse` refused the pair by name, and `runEngine.fail`
 * toasted `ZodError.message` — a JSON dump of issues, which is the owner's
 * "tons of text ... lots of json".
 *
 * Three rules are pinned here: the model is NEVER asked (no call, not a
 * discarded reply); a block that arrives anyway is REFUSED BY NAME and writes
 * nothing; a non-cited row is unchanged.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

vi.mock('@/search', () => ({
  searchRules: vi.fn(),
}));

// The toast seam is mocked so the two surfaces a refusal must reach (AGENTS
// rule 2: the run row AND the toast) are both asserted — and so "the toast
// carries a readable sentence, never a zod issue dump" is a measured claim
// rather than a reading of `lib/toast`.
vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastErrorPersistent: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { searchRules } = await import('@/search');
const searchMock = vi.mocked(searchRules);
const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

const NPC_DRAFT = {
  name: 'Goblin Warrior',
  summary: 'A refilled cast creature.',
  suggestedTags: [],
  body: '# Goblin Warrior\nNow with prose.',
  appearance: 'Green, wiry.',
  personality: 'Craven.',
  // The model's own call: a goblin warrior fights, so its stats matter.
  needsStatBlock: true,
};

/** A location draft that the draft contract accepts (the sentence test's
 * pre-edit reply; the human's edit below is what the stored shape refuses). */
const LOCATION_DRAFT = {
  name: 'The Drowned Chapel',
  summary: 'A flooded chapel below the causeway.',
  suggestedTags: [],
  body: '# The Drowned Chapel\nKnee-deep in black water.',
  locationType: 'dungeon',
  inhabitants: 'Drowned choristers.',
  pointsOfInterest: [{ name: 'The font', description: 'Brimming with brine.' }],
  hooks: ['The bell rings at midnight.'],
};

const NPC_STATBLOCK: StatBlock = {
  system: 'dnd5e',
  level: '3',
  size: 'Small',
  creatureType: 'humanoid (goblinoid)',
  ac: 14,
  acNote: '',
  hp: 22,
  hpFormula: '5d6 + 5',
  speed: '30 ft.',
  abilities: { str: 8, dex: 16, con: 13, int: 14, wis: 10, cha: 12 },
  saves: '',
  skills: '',
  senses: '',
  languages: 'Common, Goblin',
  traits: [],
  actions: [],
  reactions: [],
  legendary: [],
  extras: {},
};

async function seedPersona(): Promise<Persona> {
  return createPersona({
    slug: 'npc-smith-refill-cited',
    name: 'NPC Smith',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    producesKind: 'npc',
    builtIn: true,
  });
}

const INPUT = (
  campaign: Campaign,
  persona: Persona,
  targetArtifactId: Id | undefined,
  autonomy: 'auto' | 'manual' = 'auto',
): StartRunInput => ({
  campaign: {
    id: campaign.id,
    name: campaign.name,
    system: 'dnd5e' as const,
    description: '',
    coverImageId: null,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  },
  persona,
  autonomy,
  brief: 'Refill this NPC with real prose.',
  pinnedChunkIds: [],
  ...(targetArtifactId === undefined ? {} : { targetArtifactId }),
});

beforeEach(async () => {
  await clearDatabase();
  searchMock.mockReset();
  searchMock.mockResolvedValue([]);
  chatMock.mockReset();
  toastErrorMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A cast creature npc: an AUTHORED row (the owner's Aunt Agatha) whose numbers
 * are the library creature's — born `statBlock: null` + `creatureRef`. */
async function seedCitedNpc(campaign: Campaign, name = 'Goblin Warrior'): Promise<{ id: Id; chunkId: Id }> {
  const chunkId = newId();
  const creature = await createArtifact({
    campaignId: campaign.id,
    kind: 'npc',
    name,
    summary: '',
    body: '',
    data: { appearance: '', personality: '', statBlock: null, creatureRef: { chunkId } },
  });
  return { id: creature.id, chunkId };
}

describe('the refused pair, by the schema\u2019s own name', () => {
  it('npcDataSchema refuses a citation beside an authored stat block', () => {
    const parsed = npcDataSchema.safeParse({
      appearance: '',
      personality: '',
      statBlock: NPC_STATBLOCK,
      creatureRef: { chunkId: newId() },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('the pair parsed');
    expect(JSON.stringify(parsed.error.issues)).toContain(
      'an npc carries either an authored stat block or a library creatureRef to derive one from, never both',
    );
  });
});

describe('a cited row is never asked for a stat block', () => {
  it('never spends the statblock call on a cited row, and the citation survives the refill', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const persona = await seedPersona();
    const creature = await seedCitedNpc(campaign);
    const revisionsBefore = await listRevisions(creature.id);
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(NPC_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({
        text: JSON.stringify(NPC_STATBLOCK),
        modelUsed: 'test-model',
        fallback: null,
      });

    const runId = await runEngine.startRun(INPUT(campaign, persona, creature.id));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    // THE MODEL WAS NOT OFFERED THE STEP: one call (the draft), not two.
    expect(chatMock).toHaveBeenCalledTimes(1);
    const run = await getRun(runId);
    const statblockStep = run?.steps.find((step) => step.name === 'statblock');
    expect(statblockStep?.status).toBe('skipped');
    expect((statblockStep?.output as { skipped?: string }).skipped).toContain('library creature');

    const after = await getArtifact(creature.id);
    if (after?.kind !== 'npc') throw new Error('the refill target is not an npc');
    // The prose landed (a refill IS the writing-in) …
    expect(after.summary).toBe(NPC_DRAFT.summary);
    expect(after.body).toBe(NPC_DRAFT.body);
    expect(after.data.appearance).toBe(NPC_DRAFT.appearance);
    // … the citation is byte-identical …
    expect(after.data.creatureRef).toEqual({ chunkId: creature.chunkId });
    // … and no block was authored beside it (the numbers are the library's).
    expect(after.data.statBlock).toBeNull();
    expect((await listRevisions(creature.id)).length).toBeGreaterThan(revisionsBefore.length);
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 30000);

  it('still asks a NON-cited row for its stat block, and writes the block it produces', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const persona = await seedPersona();
    // The shape `materializeMonsterNpc` births: an authored block, no citation.
    const authored = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Materialized Marla',
      summary: 'A drafted scene member.',
      body: '',
      data: { appearance: '', personality: '', statBlock: null },
    });
    chatMock
      .mockResolvedValueOnce({
        text: JSON.stringify({ ...NPC_DRAFT, name: 'Materialized Marla' }),
        modelUsed: 'test-model',
        fallback: null,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify(NPC_STATBLOCK),
        modelUsed: 'test-model',
        fallback: null,
      });

    const runId = await runEngine.startRun(INPUT(campaign, persona, authored.id));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    // Unchanged behaviour: the step RAN (two calls) and the block landed.
    expect(chatMock).toHaveBeenCalledTimes(2);
    const after = await getArtifact(authored.id);
    if (after?.kind !== 'npc') throw new Error('the refill target is not an npc');
    expect(after.data.statBlock?.hp).toBe(22);
    expect(after.data.creatureRef).toBeUndefined();
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 30000);
});

describe('a block that arrives anyway is refused by name, and nothing is written', () => {
  /**
   * The reachable shape of "a draft produced a block anyway": a run whose
   * statblock step ALREADY carries a block — a run persisted before the
   * statblock step learned to skip a cited row, resumed from the Runs tab after
   * the fix. Resuming it lands on finalize with that block on the step, which
   * is exactly the merged pair `mergeRefillData` must refuse instead of
   * building.
   */
  it('refuses at the merge, by name, leaving the artifact byte-identical', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const persona = await seedPersona();
    const creature = await seedCitedNpc(campaign);
    const before = await getArtifact(creature.id);
    const run = await createRun({
      campaignId: campaign.id,
      personaId: persona.id,
      autonomy: 'auto',
      userBrief: 'Refill this NPC with real prose.',
      pinnedChunkIds: [],
      targetArtifactId: creature.id,
    });
    // A pre-fix run row: retrieve + draft done, the statblock step carrying a
    // block it was once allowed to produce, finalize still to run.
    await updateRun(run.id, {
      status: 'awaiting_user',
      steps: [
        { index: 0, name: 'retrieve', status: 'done', input: {}, output: {}, userEdit: null },
        {
          index: 1,
          name: 'draft',
          status: 'done',
          input: {},
          output: { parsed: NPC_DRAFT, writerModel: 'test-model' },
          userEdit: null,
        },
        {
          index: 2,
          name: 'statblock',
          status: 'done',
          input: {},
          output: { statBlock: NPC_STATBLOCK },
          userEdit: null,
        },
        { index: 3, name: 'finalize', status: 'pending', input: {}, output: null, userEdit: null },
      ],
    });

    await runEngine.resumeRun(run.id, '', INPUT(campaign, persona, creature.id));
    await waitFor(async () => {
      expect((await getRun(run.id))?.status).toBe('failed');
    });

    const failed = await getRun(run.id);
    // THE REFUSAL IS NAMED: what happened, and that nothing was written.
    expect(failed?.errorMessage).toContain('Refusing to write');
    expect(failed?.errorMessage).toContain('Nothing was written');
    expect(failed?.errorMessage).toContain('creatureRef');
    // THE TOAST'S HEADLINE IS THAT SENTENCE — never the zod issue dump.
    const toastTitle = toastErrorMock.mock.calls[0]?.[0] ?? '';
    expect(toastTitle).toBe(failed?.errorMessage);
    expect(toastTitle).not.toContain('"code"');
    expect(toastTitle).not.toContain('invalid_type');
    expect(toastTitle.startsWith('[')).toBe(false);

    // NOTHING WAS WRITTEN: the row is byte-identical, citation and all.
    const after = await getArtifact(creature.id);
    expect(after).toEqual(before);
  }, 30000);
});

describe('a data-check failure reaches the owner as a sentence', () => {
  /**
   * The same failure surface, from the other direction: an OWNER-EDITED draft
   * (edits are deliberately not schema-validated — the step is the model's
   * reply, the editor is the human's) whose detail entry the stored shape
   * refuses. The write is still refused loudly and nothing is written; what
   * this pins is that the RUN MESSAGE and the TOAST HEADLINE are a composed
   * sentence, not `ZodError.message`'s issue dump (which is what the owner
   * read: "tons of text ... looked like lots of json").
   */
  it('composes the run message and the toast headline a zod refusal reaches the owner with', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const persona = await createPersona({
      slug: 'location-smith-refill-sentence',
      name: 'Worldbuilder',
      description: 'test',
      systemPrompt: 'You are a test persona. Reply with JSON only.',
      producesKind: 'location',
      builtIn: true,
    });
    const target = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'The Drowned Chapel',
      summary: 'Authored summary.',
      body: '# The Drowned Chapel\nHand-written.',
      data: { locationType: 'dungeon', inhabitants: '', pointsOfInterest: [], hooks: [] },
    });
    chatMock.mockResolvedValue({
      text: JSON.stringify(LOCATION_DRAFT),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun(INPUT(campaign, persona, target.id, 'manual'));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
    });
    // The human's edit: a point of interest with no `description`, which the
    // artifact's own data schema requires.
    await runEngine.editStep(
      runId,
      1,
      { parsed: { ...LOCATION_DRAFT, pointsOfInterest: [{ name: 'The font' }] } },
      INPUT(campaign, persona, target.id, 'manual'),
    );
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    });

    const failed = await getRun(runId);
    expect(failed?.errorMessage).toContain('Refused by a data check');
    expect(failed?.errorMessage).toContain('pointsOfInterest');
    expect(failed?.errorMessage).toContain('Nothing was written');
    expect(failed?.errorMessage).not.toContain('"code"');
    // The toast HEADLINE is the same sentence — `lib/toast` humanizes only the
    // description, so a raw dump here is what the owner actually reads.
    const toastTitle = toastErrorMock.mock.calls[0]?.[0] ?? '';
    expect(toastTitle).toBe(failed?.errorMessage);
    expect(toastTitle).not.toContain('"code"');
    // Refused, not half-applied: the authored content survived.
    const after = await getArtifact(target.id);
    expect(after?.body).toBe('# The Drowned Chapel\nHand-written.');
    expect(after?.summary).toBe('Authored summary.');
  }, 30000);

  it('composes the message a toast headline and the run row carry, never the issue dump', () => {
    const refused = npcDataSchema.safeParse({
      appearance: '',
      personality: '',
      statBlock: NPC_STATBLOCK,
      creatureRef: { chunkId: newId() },
    });
    if (refused.success) throw new Error('the pair parsed');
    const error: ZodError = refused.error;

    // The raw message IS the dump (zod 4) — measured, not assumed.
    expect(error.message).toContain('"code"');
    const composed = composedFailureMessage(error);
    expect(composed).toContain('Refused by a data check');
    expect(composed).toContain('Nothing was written');
    // The composed sentence NAMES the field the check refused (the path zod
    // already knows) instead of dumping the issue array.
    expect(composed).toContain('creatureRef: an npc carries either an authored stat block');
    expect(composed).not.toContain('"code"');
    expect(composed).not.toContain('\\n');
    // A named refusal (not a zod error) keeps its own sentence verbatim.
    const named = new Error('Refusing to write «Goblin Warrior»: it cites a library creature.');
    expect(composedFailureMessage(named)).toBe(named.message);
  });
});
