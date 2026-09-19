import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { createModule as createModuleSchema, moduleSchema, monsterEntrySchema, newId, ruleChunkSchema, stampNewEntity, statBlockSchema, blankStatBlock, type Persona, type StatBlock } from '@/domain';
import { resolveStoredMonsterEntry } from '@/domain/mobCopyLegacy';
import { createPersona } from '@/db/personaRepo';
import {
  createArtifact,
  getArtifact,
  listArtifactsByCampaign,
  publishToLibrary,
} from '@/db/artifactRepo';
import { getSettings, updateSettings } from '@/db/settingsRepo';
import { failRunningRuns, getRun, listRunsByCampaign, updateRun } from '@/db/runRepo';
import { createModule as createModuleRow, deleteModule } from '@/db/moduleRepo';
import { runEngine, rosterMobCopyFor } from '@/llm/runEngine';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { putChunks } from '@/db/chunkRepo';
import { sha256Hex } from '@/lib/hash';
import { BUILT_IN_PERSONAS } from '@/llm/personas/builtins';
import { act, waitFor } from '@testing-library/react';
import { clearDatabase, recentsAfterSettlingWrites } from '../db/helpers';

import type { Id } from '@/domain';

/**
 * Run engine (04-LLM-PERSONAS.md) with a mocked chat: happy manual path,
 * invalid-JSON retry, needs_review, auto mode, cancel.
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

const VALID_DRAFT = {
  name: 'Grix',
  summary: 'A goblin alchemist boss.',
  suggestedTags: ['goblin', 'alchemist'],
  body: '# Grix\nShe brews. She throws.',
  appearance: 'Small, soot-stained, goggles.',
  personality: 'Manic, cheerful, volatile.',
  needsStatBlock: true,
};

const VALID_STATBLOCK = {
  system: 'dnd5e',
  level: '3',
  size: 'Small',
  creatureType: 'humanoid (goblinoid)',
  ac: 14,
  acNote: 'leather armor',
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
  extras: { CR: '1' },
};

/** The same block at the module's own level — what a repair turn returns when
 * it honours the resolved level (docs/17 row 247). */
const VALID_STATBLOCK_AT_7 = { ...VALID_STATBLOCK, level: '7' };

/** …and at level 5, the owner's mob. */
const VALID_STATBLOCK_AT_5 = { ...VALID_STATBLOCK, level: '5' };

const VALID_ENCOUNTER_DRAFT = {
  name: 'Goblin Ambush at the Ford',
  summary: 'A goblin war band contests a river crossing.',
  suggestedTags: ['goblins', 'ambush'],
  body: '# Ambush at the ford',
  difficulty: 'easy',
  levelHint: '1-2',
  monsters: [
    {
      name: 'Goblin bully',
      count: 2,
      notes: 'lunges from the reeds',
      treasure: 'a pouch of teeth',
      statBlock: VALID_STATBLOCK,
    },
  ],
  terrain: 'shallow river ford',
  tactics: 'ambush from the reeds',
  treasure: 'none',
  locationKind: 'wilderness',
};

async function seed(): Promise<{ campaignId: Id; persona: Persona }> {
  const campaign = await createCampaign({ name: 'Test Campaign', system: 'dnd5e' });
  const persona = await createPersona({
    slug: 'npc-smith-test',
    name: 'NPC Smith',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    producesKind: 'npc',
    builtIn: true,
  });
  return { campaignId: campaign.id, persona };
}

/** A promise the test resolves by hand (the engine parked in a model call). */
function deferred(): {
  promise: Promise<{ text: string; modelUsed: string; fallback: null }>;
  resolve: (value: { text: string; modelUsed: string; fallback: null }) => void;
} {
  let resolve: (value: { text: string; modelUsed: string; fallback: null }) => void = () =>
    undefined;
  const promise = new Promise<{ text: string; modelUsed: string; fallback: null }>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A step output's `notice` sentence, or '' when it carries none. */
function stepNotice(output: unknown): string {
  if (typeof output !== 'object' || output === null) return '';
  const notice = (output as { notice?: unknown }).notice;
  return typeof notice === 'string' ? notice : '';
}

const INPUT = (campaignId: Id, persona: Persona) => ({
  campaign: {
    id: campaignId,
    name: 'Test Campaign',
    system: 'dnd5e' as const,
    description: '',
    coverImageId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  persona,
  autonomy: 'manual' as const,
  brief: 'a goblin alchemist boss for a level 3 party',
  pinnedChunkIds: [],
});

beforeEach(clearDatabase);
afterEach(() => {
  chatMock.mockReset();
  vi.restoreAllMocks();
});

describe('runEngine', () => {
  it('manual happy path: pauses after each step and completes on approval', async () => {
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaignId, persona));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
    });

    let run = await getRun(runId);
    expect(run?.steps.map((step) => step.name)).toEqual(['retrieve', 'draft']);
    expect(run?.steps[0]?.status).toBe('done');
    expect(run?.steps[1]?.status).toBe('done');

    await runEngine.approve(runId, INPUT(campaignId, persona));
    await waitFor(async () => {
      run = await getRun(runId);
      expect(run?.steps).toHaveLength(3);
      expect(run?.status).toBe('awaiting_user');
    });
    expect(run?.steps[2]?.name).toBe('statblock');

    await runEngine.approve(runId, INPUT(campaignId, persona));
    await waitFor(async () => {
      run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });
    expect(run?.resultArtifactId).not.toBeNull();
    const resultId = run?.resultArtifactId;
    if (resultId === null || resultId === undefined) throw new Error('run has no result artifact');

    const artifact = await getArtifact(resultId);
    expect(artifact?.kind).toBe('npc');
    expect(artifact?.name).toBe('Grix');
    if (artifact?.kind === 'npc') {
      expect(artifact.data.statBlock?.hp).toBe(22);
      expect(artifact.data.personality).toBe('Manic, cheerful, volatile.');
    }
    expect(chatMock).toHaveBeenCalledTimes(2);
  }, 20000);

  it('retries invalid JSON once automatically, then succeeds', async () => {
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: 'this is not json at all', modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaignId, persona));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
    });

    const run = await getRun(runId);
    expect(run?.steps[1]?.status).toBe('done');
    expect(chatMock).toHaveBeenCalledTimes(2);
  }, 20000);

  it('escalates the contract-repair attempt to the fallback model — and the recents keep the GLOBAL model, never the fallback', async () => {
    const { campaignId, persona } = await seed();
    await updateSettings({
      fallbackChatModel: 'potent/fallback',
      recentChatModels: ['older/model'],
    });
    const primary = 'anthropic/claude-sonnet-4.5'; // the seeded settings' default chat model
    chatMock
      .mockResolvedValueOnce({ text: 'this is not json at all', modelUsed: primary, fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'potent/fallback', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaignId, persona));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
    });

    // The repair attempt (the second call) went to the escalation tier.
    const models = chatMock.mock.calls.map(([, opts]) => (opts as { model: string }).model);
    expect(models).toEqual([primary, 'potent/fallback']);

    const run = await getRun(runId);
    const draft = run?.steps.find((step) => step.name === 'draft');
    expect((draft?.output as { notice?: string }).notice).toBe(
      `The reply contract failed on “${primary}” — the repair attempt ran on “potent/fallback”.`,
    );

    // The escalation tier is a NON-GLOBAL tier (docs/17 rows 198/203): the ONE
    // funnel record is the GLOBAL first-try model, and the fallback that
    // actually served the repair never enters the global recents. The WHOLE
    // list is asserted, after its fire-and-forget recorder had its chance to
    // land.
    expect(await recentsAfterSettlingWrites()).toEqual([primary, 'older/model']);
  }, 20000);

  it('marks the step needs_review after a second JSON failure (review autonomy)', async () => {
    const { campaignId, persona } = await seed();
    chatMock.mockResolvedValue({ text: 'still not json', modelUsed: 'test-model', fallback: null });

    const input = { ...INPUT(campaignId, persona), autonomy: 'review' as const };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('needs_review');
    });

    const run = await getRun(runId);
    expect(run?.steps[1]?.status).toBe('rejected');
    expect(chatMock).toHaveBeenCalledTimes(2);

    // The designed rescue path: the user EDITS the rejected draft step to
    // valid JSON (approve-without-edit now fails loudly in finalize — it
    // used to create an artifact named after the persona with empty data).
    chatMock.mockResolvedValue({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });
    await runEngine.editStep(runId, 1, { parsed: VALID_DRAFT }, input);
    await waitFor(async () => {
      const run2 = await getRun(runId);
      expect(run2?.status).toBe('completed');
    });
    const run2 = await getRun(runId);
    expect(run2?.resultArtifactId).not.toBeNull();
  }, 20000);

  it('auto mode with a never-parsing draft fails the run instead of saving an empty artifact', async () => {
    const { campaignId, persona } = await seed();
    chatMock.mockResolvedValue({ text: 'still not json', modelUsed: 'test-model', fallback: null });

    const input = { ...INPUT(campaignId, persona), autonomy: 'auto' as const };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
    });

    const run = await getRun(runId);
    expect(run?.errorMessage).toContain('Step "draft" rejected');
    expect(run?.steps[1]?.status).toBe('rejected');
    // Regression: this used to fall through to finalize and create an
    // artifact named after the persona ("NPC Smith") with empty content.
    expect(await listArtifactsByCampaign(campaignId)).toHaveLength(0);
    expect(chatMock).toHaveBeenCalledTimes(2); // one automatic JSON-fix retry
  }, 20000);

  it('auto NPC with a garbage statblock reply fails the run instead of dropping it silently', async () => {
    // Regression for the silent fallback: a rejected statblock step used to
    // be skipped and the NPC finalized WITHOUT its stat block.
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValue({ text: 'this is not a statblock', modelUsed: 'test-model', fallback: null });

    const input = { ...INPUT(campaignId, persona), autonomy: 'auto' as const };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
    });

    const run = await getRun(runId);
    expect(run?.errorMessage).toContain('Step "statblock" rejected');
    expect(await listArtifactsByCampaign(campaignId)).toHaveLength(0);
  }, 20000);

  /**
   * The ability convention (owner report, docs/17 row 95): a Pathfinder 2e
   * model prints ability MODIFIERS, `numericStat` coerces "+2" to the number 2,
   * and the app read that as a d20 score — the owner's generated mob rendered
   * "2 (−4)" while its real Strength bonus was +2. The check runs on the RAW,
   * pre-coercion reply (a sign is what no printed score carries), the prompt
   * states the convention, and the violation rides the step's existing
   * one-repair-then-loud path.
   *
   * Revert-proof: delete the `statblockSignedAbilityIssues` call in
   * `runStatblock` and this run COMPLETES on the second chat call with
   * `abilities.str === 2` (and the card then prints "-4" for Strength).
   */
  it('refuses a statblock reply that prints signed ability modifiers — one named repair, then the corrected score', async () => {
    const { campaignId, persona } = await seed();
    const signedBlock = {
      ...VALID_STATBLOCK,
      system: 'pathfinder2e',
      abilities: { ...VALID_STATBLOCK.abilities, str: '+2' },
    };
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(signedBlock), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          ...VALID_STATBLOCK,
          system: 'pathfinder2e',
          abilities: { ...VALID_STATBLOCK.abilities, str: 14 },
        }),
        modelUsed: 'test-model',
        fallback: null,
      });

    const runId = await runEngine.startRun({ ...INPUT(campaignId, persona), autonomy: 'auto' as const });
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    }, { timeout: 20000 });

    // The prompt states the convention it enforces (a bare `"str": number` is
    // what invited the slip) …
    const statblockPrompt = chatMock.mock.calls[1]?.[0].at(-1)?.content ?? '';
    expect(statblockPrompt).toContain('score = 10 + 2 × the printed modifier');
    expect(statblockPrompt).toContain('NEVER carries a sign');
    // … and the repair turn teaches the conversion it demands.
    const repair = chatMock.mock.calls[2]?.[0].at(-1)?.content ?? '';
    expect(repair).toContain('abilities.str is "+2"');
    expect(repair).toContain('a +2 modifier is 14');
    expect(chatMock).toHaveBeenCalledTimes(3);

    const run = await getRun(runId);
    const artifact = await getArtifact(run?.resultArtifactId ?? '');
    if (artifact?.kind !== 'npc') throw new Error('the run produced no npc artifact');
    // The score "+2" MEANS — never the coerced 2.
    expect(artifact.data.statBlock?.abilities.str).toBe(14);
    expect(artifact.data.statBlock?.abilities.dex).toBe(VALID_STATBLOCK.abilities.dex);
  }, 20000);

  /**
   * A signed reply that survives its one repair fails the run LOUDLY with the
   * named issue (never a persisted modifier-shaped "score"), and nothing is
   * written — the same shape as the garbage-statblock regression above.
   */
  it('fails the statblock step loudly when signed ability values survive the repair', async () => {
    const { campaignId, persona } = await seed();
    const signedBlock = {
      ...VALID_STATBLOCK,
      system: 'pathfinder2e',
      abilities: { ...VALID_STATBLOCK.abilities, dex: '+3' },
    };
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValue({ text: JSON.stringify(signedBlock), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({ ...INPUT(campaignId, persona), autonomy: 'auto' as const });
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    }, { timeout: 20000 });

    const run = await getRun(runId);
    expect(run?.errorMessage).toContain('abilities.dex is "+3"');
    expect(run?.errorMessage).toContain('a +3 modifier is 16');
    expect(run?.errorMessage).toContain('Step "statblock" rejected');
    expect(await listArtifactsByCampaign(campaignId)).toHaveLength(0);
    // One repair attempt, never a loop.
    expect(chatMock).toHaveBeenCalledTimes(3);
  }, 20000);

  /**
   * THE MODULE AUTHOR'S LEVEL, STRUCTURED (owner request, docs/17 row 197).
   * The entity batch hands the run a recorded `levelHint`; `runStatblock` reads
   * it EXPLICITLY, and it WINS over the `level N` sentence the brief carries —
   * the exact fragility that lost the owner's level-7 gnome (the old path
   * regexed `/level\\s*(\\d{1,2})/i` out of the brief).
   *
   * The reply prints level 3 against the hinted 7, so the same test proves the
   * NPC lane's DEVIATION route: the step's existing `notice` names both levels.
   */
  it('the structured level hint WINS over a conflicting `level N` sentence in the brief — AND BINDS it (docs/17 row 247)', async () => {
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      // The reply prints level 3 against the hinted 7 …
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null })
      // … so the step spends its ONE repair naming the deviation, and this
      // reply honours the level the module fixed.
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK_AT_7), modelUsed: 'test-model', fallback: null });

    // AUTO autonomy, exactly like the entity batch: the stat-block step runs off
    // the SAME input object that carried the hint, so this is the production path.
    const runId = await runEngine.startRun({
      ...INPUT(campaignId, persona),
      autonomy: 'auto' as const,
      // The brief SAYS level 3 — the regex's own food; the record says 7.
      brief: 'Kael the Grey, a gnome for a level 3 party',
      entityLevelHint: 7,
    });
    await waitFor(
      async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      },
      { timeout: 20000 },
    );

    const statblockPrompt = chatMock.mock.calls[1]?.[0].at(-1)?.content ?? '';
    expect(statblockPrompt).toContain('at level 7');
    expect(statblockPrompt).toContain("the module's author fixed this entity's level");
    expect(statblockPrompt).not.toContain('at level 3');
    // The one repair turn states the deviation in as many words.
    const repair = chatMock.mock.calls[2]?.[0].at(-1)?.content ?? '';
    expect(repair).toContain('written at level "3"');
    expect(repair).toContain('not the 7 this run resolved');

    // THE BLOCK ITSELF CARRIES THE RESOLVED LEVEL — a notice while the wrong
    // value persisted was the defect this replaces.
    const run = await getRun(runId);
    const artifact = await getArtifact(run?.resultArtifactId ?? '');
    if (artifact?.kind !== 'npc') throw new Error('the run produced no npc artifact');
    expect(artifact.data.statBlock?.level).toBe('7');
    // One repair attempt, never a loop.
    expect(chatMock).toHaveBeenCalledTimes(3);
  }, 20000);

  /**
   * COMPATIBILITY (docs/17 row 197): with no hint the stat-block prompt is the
   * one this step always built — the brief regex still supplies the level and no
   * hint sentence appears, so every pre-hint pin's bytes are untouched.
   */
  it('with NO hint the stat-block prompt is byte-identical: the brief-level regex still runs', async () => {
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      ...INPUT(campaignId, persona),
      autonomy: 'auto' as const,
    });
    await waitFor(
      async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      },
      { timeout: 20000 },
    );

    const statblockPrompt = chatMock.mock.calls[1]?.[0].at(-1)?.content ?? '';
    expect(statblockPrompt).toContain('at level 3, grounded in the rule excerpts.');
    expect(statblockPrompt).not.toContain("the module's author fixed this entity's level");

    const run = await getRun(runId);
    const notice = stepNotice(run?.steps[2]?.output);
    expect(notice).not.toContain('fixed this entity at level');
  }, 20000);

  /**
   * The OWNER'S REGRESSION (docs/17 row 206): the artifact editor's "Regenerate
   * with AI" rebuilds `StartRunInput` from scratch and carries NO
   * `entityLevelHint`, and its brief has no `level N` — so a module-owned NPC
   * whose record says 7 came back at 13 with NO notice, and the unfiltered spell
   * vocabulary offered high-rank spells. The engine ALREADY reads the target's
   * owning module for every targeted generate run (`targetModuleGrounding`), so
   * the recorded level rides that grounding and `runStatblock` resolves
   * `input.entityLevelHint ?? context.moduleGrounding?.entityLevelHint` — ONE
   * seam, never a per-caller patch (AGENTS rule 4).
   */

  /** A PF2e campaign + npc-smith persona (the rank cap is PF2e's rule). */
  async function seedPf2e(): Promise<{ campaignId: Id; persona: Persona }> {
    const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
    const persona = await createPersona({
      slug: 'npc-smith-level',
      name: 'NPC Smith',
      description: 'test',
      systemPrompt: 'You are a test persona. Reply with JSON only.',
      producesKind: 'npc',
      builtIn: true,
    });
    return { campaignId: campaign.id, persona };
  }

  /** The PF2e twin of INPUT — the level-hint vocabulary cap is PF2e's. */
  function PF2E_INPUT(campaignId: Id, persona: Persona) {
    return {
      ...INPUT(campaignId, persona),
      campaign: {
        ...INPUT(campaignId, persona).campaign,
        name: 'Ember',
        system: 'pathfinder2e' as const,
      },
    };
  }

  /**
   * A module row with ONE entity record (`levelHint` optional) and an npc
   * artifact it OWNS — exactly the row the artifact editor refills. The record's
   * name matches the artifact's so `entityLevelHintFor` resolves it.
   */
  async function seedModuleOwnedNpc(
    campaignId: Id,
    name: string,
    levelHint: number | undefined,
    // What the MODULE ITSELF states (docs/17 row 247): the premise's own level,
    // the band, and whether a part mentions the entity. Defaults keep the
    // pre-247 shape (an exact level-1 band, a level-free premise, a part
    // mention) so every existing caller is unchanged.
    options: {
      levelMax?: number;
      premise?: string;
      partMention?: boolean;
      statBlock?: StatBlock;
    } = {},
  ): Promise<Id> {
    const draft = createModuleSchema({
      campaignId,
      title: 'The Drowned Bell',
      concept: 'A harbor bell that rings by itself.',
      levelMin: 1,
      levelMax: options.levelMax ?? 1,
      sizeDial: 'standard',
    });
    const module = await createModuleRow(
      moduleSchema.parse({
        ...draft,
        entityKinds: [
          { name, kind: 'npc', absorbed: [], ...(levelHint === undefined ? {} : { levelHint }) },
        ],
        spine: {
          premise: options.premise ?? `The bell rings over [[${name}]].`,
          themes: [],
          partPlan: [{ title: 'One', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
          writerModel: '',
          origin: null,
        },
        parts: [
          {
            planIndex: 0,
            markdown:
              options.partMention === false
                ? 'The gate stands unguarded.'
                : `The gate is watched by [[${name}]].`,
            status: 'ready',
            errorMessage: '',
            edited: false,
            writerModel: '',
            origin: null,
          },
        ],
      }),
    );
    const artifact = await createArtifact({
      campaignId,
      moduleId: module.id,
      kind: 'npc',
      name,
      summary: '',
      body: '',
      // A row that ALREADY carries a block: the ordinary-refill arm keeps it,
      // and the explicit-instruction arm must replace it (docs/17 row 247).
      ...(options.statBlock === undefined
        ? {}
        : { data: { appearance: '', personality: '', statBlock: options.statBlock } }),
    });
    return artifact.id;
  }

  /**
   * The OWNER'S SHAPE (docs/17 row 247): a module whose BAND would cap the
   * figure (1–`levelMax`) and whose entity record fixes NO hint, but whose
   * PREMISE states the level in prose. Marten Graubruch came out at the band's
   * maximum (3) because nothing bound the model; this module is what the fix
   * must read.
   */
  async function seedPremiseLevelModule(
    campaignId: Id,
    name: string,
    premiseLevel: number,
    levelMax: number,
  ): Promise<Id> {
    const draft = createModuleSchema({
      campaignId,
      title: 'The Graubruch Forge',
      concept: 'A forge whose smith outlived his guild.',
      levelMin: 1,
      levelMax,
      sizeDial: 'standard',
    });
    const module = await createModuleRow(
      moduleSchema.parse({
        ...draft,
        entityKinds: [{ name, kind: 'npc', absorbed: [] }],
        spine: {
          premise: `The party reaches [[${name}]], a level ${String(premiseLevel)} smith who remembers the guild.`,
          themes: [],
          partPlan: [{ title: 'One', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
          writerModel: '',
          origin: null,
        },
        parts: [
          {
            planIndex: 0,
            markdown: `The forge of [[${name}]].`,
            status: 'ready',
            errorMessage: '',
            edited: false,
            writerModel: '',
            origin: null,
          },
        ],
      }),
    );
    return module.id;
  }

  /** A ready PF2e spell book with a cantrip, a rank-3 spell and a rank-6 spell. */
  let spellSeq = 0;
  async function seedSpellLibrary(): Promise<void> {
    const book = await createPackBook({
      title: 'PF2e Spells',
      system: 'pathfinder2e',
      filename: 'spells.json',
    });
    const finished = await finalizePackBook(book.id, {
      sourceId: 'test-spells',
      license: 'ORC',
      entriesImported: 3,
      entriesSkipped: 0,
      entriesFailed: 0,
    });
    const chunk = (name: string, rank: number, cantrip: boolean) => {
      spellSeq += 1;
      return ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: finished.id,
        pageStart: 1,
        pageEnd: 1,
        chunkType: 'spell',
        headingPath: ['Spells', name],
        text: `${name}\nSource: test`,
        statBlock: null,
        contentHash: 'c'.repeat(63) + String(spellSeq % 10),
        spellData: { system: 'pathfinder2e', rank, cantrip, cast: {} },
      });
    };
    await putChunks([
      chunk('Ignition', 0, true),
      chunk('Fireball', 3, false),
      chunk('Disintegrate', 6, false),
    ]);
  }

  function draftReply(name: string): string {
    return JSON.stringify({ ...VALID_DRAFT, name });
  }

  function statReply(weight: Record<string, unknown> = {}): string {
    return JSON.stringify({ ...VALID_STATBLOCK, ...weight });
  }

  it('a TARGETED refill of a module-owned npc resolves the recorded level through the engine grounding — clause, vocabulary cap and deviation notice', async () => {
    const { campaignId, persona } = await seedPf2e();
    await seedSpellLibrary();
    const targetId = await seedModuleOwnedNpc(campaignId, 'Kael the Grey', 7);
    chatMock
      .mockResolvedValueOnce({ text: draftReply('Kael the Grey'), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({
        text: statReply({ system: 'pathfinder2e', level: '13' }),
        modelUsed: 'test-model',
        fallback: null,
      })
      // The repair turn honours the level the record fixes.
      .mockResolvedValueOnce({
        text: statReply({ system: 'pathfinder2e', level: '7' }),
        modelUsed: 'test-model',
        fallback: null,
      });

    const input = {
      ...PF2E_INPUT(campaignId, persona),
      autonomy: 'auto' as const,
      // The artifact editor's refill brief — NO `level N` anywhere.
      brief:
        'Regenerate the full content of this npc — summary, body and details. Its name, relations and images are preserved.',
      targetArtifactId: targetId,
      // NO entityLevelHint: the panel rebuilt the input from scratch. The
      // engine must read the record off the grounding it already computed.
    };
    const runId = await runEngine.startRun(input);
    await waitFor(
      async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      },
      { timeout: 20000 },
    );

    const statblockPrompt = chatMock.mock.calls[1]?.[0].at(-1)?.content ?? '';
    expect(statblockPrompt).toContain('at level 7');
    expect(statblockPrompt).toContain("the module's author fixed this entity's level");
    expect(statblockPrompt).not.toContain('at level 13, grounded');
    // The RESOLVED level reached the vocabulary cap: `pf2eCantripRankFor(7)` is
    // 4, so the rank-3 spell is offered and the rank-6 spell is NOT — without
    // the resolution the whole corpus (and a high-rank spell) is offered.
    expect(statblockPrompt).toContain('Fireball — Rank 3');
    expect(statblockPrompt).not.toContain('Disintegrate — Rank 6');

    // The deviation was REPAIRED, and the persisted block is the module's level
    // (docs/17 row 247) — not a notice beside a level-13 row.
    const repaired = await getRun(runId);
    const artifact = await getArtifact(repaired?.resultArtifactId ?? '');
    if (artifact?.kind !== 'npc') throw new Error('the targeted refill produced no npc');
    expect(artifact.data.statBlock?.level).toBe('7');
    const repair = chatMock.mock.calls[2]?.[0].at(-1)?.content ?? '';
    expect(repair).toContain('written at level "13"');
  }, 20000);

  it('the PARTY-level line never satisfies the entity level: only it in the brief leaves the clause empty', async () => {
    const { campaignId, persona } = await seed();
    // A campaign-owned (NOT module-owned) npc: no grounding exists, so ONLY the
    // brief fallback could supply a level — and it must not read the party line.
    const target = await createArtifact({
      campaignId,
      kind: 'npc',
      name: 'Grix',
      summary: '',
      body: '',
    });
    chatMock
      .mockResolvedValueOnce({ text: draftReply('Grix'), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: statReply(), modelUsed: 'test-model', fallback: null });

    const input = {
      ...INPUT(campaignId, persona),
      autonomy: 'auto' as const,
      brief: 'Party of 4 adventurers at level 13.',
      targetArtifactId: target.id,
    };
    const runId = await runEngine.startRun(input);
    await waitFor(
      async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      },
      { timeout: 20000 },
    );

    const statblockPrompt = chatMock.mock.calls[1]?.[0].at(-1)?.content ?? '';
    // THE PARTY'S LEVEL IS NOT IN THE STAT-BLOCK PROMPT AT ALL (docs/17 row
    // 247): it is the PARTY's, and leaving it in is how the owner's premise-
    // stated level-5 smith came back at the band's level. The draft still gets
    // it (that is pinned in the entity-brief tests); this step does not.
    expect(statblockPrompt).not.toContain('Party of 4 adventurers at level 13.');
    // …and no LEVEL CLAUSE is built from it.
    expect(statblockPrompt).not.toContain('at level 13, grounded');
    expect(statblockPrompt).toContain(', grounded in the rule excerpts.');
    // Nothing resolved, so there is nothing to bind and no notice to write.
    const notice = stepNotice((await getRun(runId))?.steps[2]?.output);
    expect(notice).not.toContain('fixed this entity at level');
  }, 20000);

  it('a module that states no LEVEL still BOUNDS the reply with its band — the model may not pick freely', async () => {
    const { campaignId, persona } = await seed();
    // The module states no level anywhere: a 1–3 RANGE (not a level), a premise
    // with no `level N`, and no part mentioning the entity. The band is the
    // module's own statement, so the reply must fall inside it (docs/17 row 247)
    // — an exact statement, when one exists, always wins over it.
    const targetId = await seedModuleOwnedNpc(campaignId, 'Kael the Grey', undefined, {
      levelMax: 3,
      partMention: false,
    });
    chatMock
      .mockResolvedValueOnce({ text: draftReply('Kael the Grey'), modelUsed: 'test-model', fallback: null })
      // Both the first reply and the repair sit OUTSIDE the module's band.
      .mockResolvedValue({ text: statReply({ level: '5' }), modelUsed: 'test-model', fallback: null });

    const input = {
      ...INPUT(campaignId, persona),
      autonomy: 'auto' as const,
      brief: 'Regenerate the full content of this npc — summary, body and details.',
      targetArtifactId: targetId,
    };
    const runId = await runEngine.startRun(input);
    await waitFor(
      async () => {
        expect((await getRun(runId))?.status).toBe('failed');
      },
      { timeout: 20000 },
    );

    const statblockPrompt = chatMock.mock.calls[1]?.[0].at(-1)?.content ?? '';
    expect(statblockPrompt).toContain('at a level within 1–3');
    expect(statblockPrompt).toContain('this module covers levels 1–3');
    // The level is NOT left to the model: a reply outside the band is repaired
    // once and then REFUSED, and nothing is written onto the row.
    const run = await getRun(runId);
    expect(run?.errorMessage).toContain('outside the 1–3 this module covers');
    const artifact = await getArtifact(targetId);
    if (artifact?.kind !== 'npc') throw new Error('the refill target is not an npc');
    expect(artifact.data.statBlock).toBeNull();
    expect(chatMock).toHaveBeenCalledTimes(3);
  }, 20000);

  it('a module-owned entity whose module is GONE refuses loudly — nothing can bound the pick', async () => {
    const { campaignId, persona } = await seed();
    chatMock.mockResolvedValueOnce({
      text: JSON.stringify(VALID_DRAFT),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun({
      ...INPUT(campaignId, persona),
      autonomy: 'auto' as const,
      // A seed run placed into a module that does not exist: no owner, no band,
      // no statement — and a brief that states no level either.
      placementModuleId: newId(),
      brief: 'Detail the smith of the drowned forge.',
    });
    await waitFor(
      async () => {
        expect((await getRun(runId))?.status).toBe('failed');
      },
      { timeout: 20000 },
    );

    const run = await getRun(runId);
    expect(run?.errorMessage).toContain('states no level and no level band');
    expect(run?.errorMessage).toContain('Nothing was written');
    // No stat-block call was spent: the refusal happens before the model call.
    expect(chatMock).toHaveBeenCalledTimes(1);
  }, 20000);

  it('a stored grounding written BEFORE the field still parses and keeps the brief-regex fallback (compatibility)', async () => {
    const { campaignId, persona } = await seed();
    const targetId = await seedModuleOwnedNpc(campaignId, 'Kael the Grey', 7);
    chatMock
      .mockResolvedValueOnce({ text: draftReply('Kael the Grey'), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: statReply(), modelUsed: 'test-model', fallback: null });

    const input = {
      ...INPUT(campaignId, persona),
      brief: 'Kael the Grey for a level 3 party',
      targetArtifactId: targetId,
    };
    const runId = await runEngine.startRun(input);
    await waitFor(
      async () => {
        expect((await getRun(runId))?.status).toBe('awaiting_user');
      },
      { timeout: 20000 },
    );

    // Simulate a grounding persisted BEFORE row 206: strip the new field. The
    // stored schema must still parse it (an old store must keep working).
    const run = await getRun(runId);
    if (run === undefined) throw new Error('the run vanished before the grounding hand-edit');
    const steps = run.steps.map((step) => {
      if (step.name !== 'retrieve') return step;
      const output = step.output as { moduleGrounding?: Record<string, unknown> } | null;
      if (output?.moduleGrounding === undefined) return step;
      // EVERY level-bearing field is stripped: an old store has none of them
      // (docs/17 rows 206 and 247), and the module's level is NOT re-derived
      // from the stored premise — the grounding is the record, exactly as a
      // resume reads it.
      const {
        entityLevelHint: _dropped,
        statedLevel: _alsoDropped,
        levelMin: _min,
        levelMax: _max,
        ...legacy
      } = output.moduleGrounding;
      return { ...step, output: { ...output, moduleGrounding: legacy } };
    });
    await updateRun(runId, { steps });

    await runEngine.approve(runId, input);
    // Manual autonomy: approving the draft runs the statblock and pauses again.
    await waitFor(
      async () => {
        const next = await getRun(runId);
        expect(next?.steps).toHaveLength(3);
        expect(next?.status).toBe('awaiting_user');
      },
      { timeout: 20000 },
    );
    await runEngine.approve(runId, input);
    await waitFor(
      async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      },
      { timeout: 20000 },
    );

    // Behaves as before: the legacy brief regex supplies the level, no
    // structured instruction is emitted, and the record's 7 is NOT read from a
    // field the old store never wrote.
    const statblockPrompt = chatMock.mock.calls[1]?.[0].at(-1)?.content ?? '';
    expect(statblockPrompt).toContain('at level 3');
    expect(statblockPrompt).not.toContain('at level 7');
    expect(statblockPrompt).not.toContain("the module's author fixed this entity's level");
  }, 30000);

  /**
   * THE OWNER'S REPORT, ARM ONE (docs/17 row 247): a module-created mob must
   * carry the level the module actually states. His module's band was 1–3 and
   * its only statement of level 5 was the PREMISE — so the block came out at the
   * band's maximum. The premise's level must reach resolution and BIND.
   */
  it('a module-created mob takes the level the module STATES IN THE PREMISE, not the band', async () => {
    const { campaignId, persona } = await seed();
    const moduleId = await seedPremiseLevelModule(campaignId, 'Marten Graubruch', 5, 3);
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      // THE OWNER'S OBSERVED REPLY: the band's level, chosen because nothing
      // bound the model. The fix must repair it, not store it.
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK_AT_5), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      ...INPUT(campaignId, persona),
      autonomy: 'auto' as const,
      // A CREATE run placed into the module — the owner's autocreate path.
      placementModuleId: moduleId,
      brief: 'Detail the smith [[Marten Graubruch]].',
    });
    await waitFor(
      async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      },
      { timeout: 20000 },
    );

    const statblockPrompt = chatMock.mock.calls[1]?.[0].at(-1)?.content ?? '';
    expect(statblockPrompt).toContain('at level 5');
    expect(statblockPrompt).toContain("the module's author fixed this entity's level");
    // …and the PARTY's level (the part band, 1) is nowhere near the clause.
    expect(statblockPrompt).not.toContain('at level 1, grounded');

    // The level-3 reply was repaired once (the prompt named the resolved 5),
    // and the block that LANDED is the module's level — not a notice beside 3.
    const repair = chatMock.mock.calls[2]?.[0].at(-1)?.content ?? '';
    expect(repair).toContain('not the 5 this run resolved');
    const run = await getRun(runId);
    const artifact = await getArtifact(run?.resultArtifactId ?? '');
    if (artifact?.kind !== 'npc') throw new Error('the run produced no npc artifact');
    expect(artifact.data.statBlock?.level).toBe('5');
  }, 20000);

  /**
   * THE OWNER'S REPORT, ARM TWO (docs/17 row 247): "redo this completely, this
   * time making it level 5" on a row that already has a level-3 block. THREE
   * things must hold at once — the instruction outranks the recorded hint, the
   * draft's `needsStatBlock: false` may NOT veto the step (that veto is how
   * "everything recreated BUT the stat block" happened), and the block on the
   * row is genuinely replaced.
   */
  it('an explicit "redo completely, make it level 5" outranks the hint AND survives a `needsStatBlock:false` draft', async () => {
    const { campaignId, persona } = await seed();
    const targetId = await seedModuleOwnedNpc(campaignId, 'Kael the Grey', 3, {
      statBlock: statBlockSchema.parse(VALID_STATBLOCK),
    });
    chatMock
      // THE DRAFT DECLINES STATS — the answer that used to drop the whole step.
      .mockResolvedValueOnce({
        text: JSON.stringify({ ...VALID_DRAFT, name: 'Kael the Grey', needsStatBlock: false }),
        modelUsed: 'test-model',
        fallback: null,
      })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK_AT_5), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      ...INPUT(campaignId, persona),
      autonomy: 'auto' as const,
      brief:
        'Regenerate the full content of this npc.\n\nAdditional instruction: redo this completely, this time making it level 5',
      targetArtifactId: targetId,
    });
    await waitFor(
      async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      },
      { timeout: 20000 },
    );

    // The instruction's level, not the record's 3, and its own instruction
    // sentence (a user's instruction is not the module's author speaking).
    const statblockPrompt = chatMock.mock.calls[1]?.[0].at(-1)?.content ?? '';
    expect(statblockPrompt).toContain('at level 5');
    expect(statblockPrompt).toContain('the instruction for this change fixes');
    // The step RAN — the veto did not apply — and the row's block is the new one.
    const run = await getRun(runId);
    expect(run?.steps.find((step) => step.name === 'statblock')?.status).toBe('done');
    const artifact = await getArtifact(targetId);
    if (artifact?.kind !== 'npc') throw new Error('the refill target is not an npc');
    expect(artifact.data.statBlock?.level).toBe('5');
  }, 20000);

  /**
   * THE OWNER'S REPORT, ARM THREE (docs/17 row 247): a reply that deviates from
   * a RESOLVED level must FAIL LOUDLY rather than keep the deviating block. The
   * step spends its ONE repair naming the deviation; a reply that still
   * deviates is REJECTED, the run fails with the named reason, and NOTHING is
   * written onto the row.
   */
  it('a reply that deviates from a RESOLVED level is rejected loudly, never persisted', async () => {
    const { campaignId, persona } = await seed();
    const targetId = await seedModuleOwnedNpc(campaignId, 'Kael the Grey', 7);
    chatMock
      .mockResolvedValueOnce({ text: draftReply('Kael the Grey'), modelUsed: 'test-model', fallback: null })
      // Both the first reply and the repair print level 3 against the fixed 7.
      .mockResolvedValue({ text: statReply({ level: '3' }), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      ...INPUT(campaignId, persona),
      autonomy: 'auto' as const,
      brief: 'Regenerate the full content of this npc — summary, body and details.',
      targetArtifactId: targetId,
    });
    await waitFor(
      async () => {
        expect((await getRun(runId))?.status).toBe('failed');
      },
      { timeout: 20000 },
    );

    const run = await getRun(runId);
    expect(run?.errorMessage).toContain('Step "statblock" rejected');
    expect(run?.errorMessage).toContain('written at level "3"');
    expect(run?.errorMessage).toContain('not the 7 this run resolved');
    // The deviating block was NOT written onto the row.
    const artifact = await getArtifact(targetId);
    if (artifact?.kind !== 'npc') throw new Error('the refill target is not an npc');
    expect(artifact.data.statBlock).toBeNull();
    // One repair attempt, never a loop.
    expect(chatMock).toHaveBeenCalledTimes(3);
  }, 20000);

  it('reviews a global target with scope-gated global context and a campaign-anchored run', async () => {
    const editor = BUILT_IN_PERSONAS.find((persona) => persona.slug === 'continuity-editor');
    if (editor === undefined) throw new Error('continuity-editor persona missing');
    const campaign = await createCampaign({ name: 'Global Review', system: 'dnd5e' });
    const target = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Library Target',
      body: 'The target body.',
    });
    const context = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Library Context',
      body: 'The context body.',
    });
    await publishToLibrary(target.id);
    await publishToLibrary(context.id);
    await updateSettings({
      artifactScopes: {
        workspace: { global: true, campaign: true, module: true },
        moduleView: { global: true, campaign: true, module: true },
      },
    });
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({ verdict: 'consistent', summary: 'All consistent.', issues: [] }), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      campaign,
      persona: editor,
      autonomy: 'auto',
      brief: 'review the library target',
      pinnedChunkIds: [],
      targetArtifactId: target.id,
    });
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const run = await getRun(runId);
    expect(run?.campaignId).toBe(campaign.id);
    expect(JSON.stringify(chatMock.mock.calls[0])).toContain('Library Target');
    expect(JSON.stringify(chatMock.mock.calls[0])).toContain('Library Context');
    const report = (await listArtifactsByCampaign(campaign.id))[0];
    expect(report?.kind).toBe('note');
    expect(report?.links[0]?.targetId).toBe(target.id);
  });

  it('review finalize refuses placeholder output when step edits are garbage', async () => {
    // Editing the check step to garbage and approving used to produce a
    // 'no structured report' placeholder note naming an 'unknown artifact'.
    const editor = BUILT_IN_PERSONAS.find((persona) => persona.slug === 'continuity-editor');
    if (editor === undefined) throw new Error('continuity-editor persona missing');
    const fresh = await createCampaign({ name: 'Review Campaign', system: 'dnd5e' });
    const arc = await createArtifact({
      campaignId: fresh.id,
      kind: 'plotarc',
      name: 'The Drowned Bell',
      body: '# Arc',
    });

    const input = {
      campaign: fresh,
      persona: editor,
      autonomy: 'review' as const,
      brief: 'review the arc',
      pinnedChunkIds: [],
      targetArtifactId: arc.id,
    };
    chatMock.mockResolvedValue({ text: 'still not json', modelUsed: 'test-model', fallback: null });
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('needs_review');
    });

    // The user "edits" the check step to garbage and approves anyway.
    await runEngine.editStep(runId, 1, {}, input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
    });

    const run = await getRun(runId);
    expect(run?.errorMessage).toContain('no continuity report');
    // No placeholder report note was created.
    const artifacts = await listArtifactsByCampaign(fresh.id);
    expect(artifacts).toHaveLength(1); // just the target arc
  }, 20000);

  it('tolerates loose draft shapes (string list items, single-string tags)', async () => {
    const { campaignId } = await seed();
    const persona2 = await createPersona({
      slug: 'worldbuilder-test',
      name: 'Worldbuilder',
      description: 'test',
      systemPrompt: 'You are a test persona. Reply with JSON only.',
      producesKind: 'location',
      builtIn: true,
    });
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({
        name: 'Drowned Docks',
        summary: 'Flooded piers.',
        suggestedTags: 'harbour',
        body: '# Docks',
        locationType: 'district',
        inhabitants: 'Fishers',
        pointsOfInterest: ['Sunken bell tower', { name: 'Fish market', description: 'Stalls.' }],
        hooks: [{ title: 'Missing diver' }],
      }), modelUsed: 'test-model', fallback: null });

    const input = {
      ...INPUT(campaignId, persona2),
      brief: 'create a location',
      autonomy: 'auto' as const,
    };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });

    const run = await getRun(runId);
    const artifact = await getArtifact(run?.resultArtifactId ?? '');
    expect(artifact?.name).toBe('Drowned Docks');
    expect(artifact?.tags).toEqual(['harbour']);
    const data = artifact?.data as {
      pointsOfInterest?: { name: string; description: string }[];
      hooks?: string[];
    };
    expect(data.pointsOfInterest).toEqual([
      { name: 'Sunken bell tower', description: '' },
      { name: 'Fish market', description: 'Stalls.' },
    ]);
    expect(data.hooks).toEqual(['Missing diver']);
  }, 20000);

  it('auto mode runs to completion without pausing', async () => {
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

    const input = { ...INPUT(campaignId, persona), autonomy: 'auto' as const };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });
    expect(chatMock).toHaveBeenCalledTimes(2);
    const runs = await listRunsByCampaign(campaignId);
    expect(runs[0]?.resultArtifactId).not.toBeNull();
  }, 20000);

  it('cancel stops the run and no artifact is created', async () => {
    const { campaignId, persona } = await seed();
    chatMock.mockResolvedValue({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaignId, persona));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
    });

    await runEngine.cancel(runId);
    const run = await getRun(runId);
    expect(run?.status).toBe('cancelled');
    expect(run?.resultArtifactId).toBeNull();
  }, 20000);

  it('a run the owner STOPPED is not resurrected by the step that was already in flight (docs/17 row 115)', async () => {
    const { campaignId, persona } = await seed();
    const draft = deferred();
    chatMock.mockImplementation(() => draft.promise);

    // The run is genuinely LIVE and parked inside its draft model call — the
    // exact state a Stop meets (the engine drives the rest of the pipeline with
    // `void executeFrom(…).catch(fail)`, so startRun has long since resolved).
    const runId = await runEngine.startRun({ ...INPUT(campaignId, persona), autonomy: 'auto' as const });
    await waitFor(() => {
      expect(chatMock).toHaveBeenCalled();
    });
    expect((await getRun(runId))?.status).toBe('running');

    await runEngine.cancel(runId);
    expect((await getRun(runId))?.status).toBe('cancelled');

    // The model answers AFTER the stop: the step's result is the abort's tail,
    // so it is discarded — a step write would restore 'running' and then run the
    // whole remaining pipeline over a run the owner stopped.
    await act(() => {
      draft.resolve({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null });
      return Promise.resolve();
    });
    await new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
    const settled = await getRun(runId);
    expect(settled?.status).toBe('cancelled');
    expect(settled?.errorMessage).toBe('');
    // No artifact was minted by the discarded draft either (no silent fallback:
    // the stop wins over the work it interrupted).
    expect((await listRunsByCampaign(campaignId))[0]?.resultArtifactId).toBeNull();
  }, 20000);

  it('a stopped run still offers its Retry: the stop does not strand the row (docs/17 row 115)', async () => {
    const { campaignId, persona } = await seed();
    // A model call that never answers — why the owner stops a generation in the
    // first place. The engine stays parked on it, so the stop's intent has no
    // pipeline end to be consumed by; the ROW's own recovery door (docs/05:
    // cancelled rows keep their Retry) must still work.
    const parked = deferred();
    chatMock.mockImplementation(() => parked.promise);

    const input = INPUT(campaignId, persona);
    const runId = await runEngine.startRun(input);
    await waitFor(() => {
      expect(chatMock).toHaveBeenCalled();
    });
    await runEngine.cancel(runId);
    expect((await getRun(runId))?.status).toBe('cancelled');

    // Retry is NEW work on the row, so it supersedes the stop.
    chatMock.mockReset();
    chatMock.mockResolvedValue({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null });
    await runEngine.retryStep(runId, '', input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
    });
    const retried = await getRun(runId);
    expect(retried?.steps[1]?.status).toBe('done');
  }, 20000);

  it('resumeRun resumes a failed run from the failed step, preserving prior completed steps', async () => {
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockRejectedValueOnce(new Error('Model timeout 504'));

    const input = { ...INPUT(campaignId, persona), autonomy: 'auto' as const };
    const runId = await runEngine.startRun(input);

    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
      expect(run?.errorMessage).toContain('Model timeout 504');
    });

    const failedRun = await getRun(runId);
    expect(failedRun?.steps[0]?.status).toBe('done'); // retrieve
    expect(failedRun?.steps[1]?.status).toBe('done'); // draft
    expect(failedRun?.steps[1]?.output).not.toBeNull();

    // Now model recovers: resume the run
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });
    await runEngine.resumeRun(runId);

    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });

    const completedRun = await getRun(runId);
    expect(completedRun?.resultArtifactId).not.toBeNull();
    const artifact = await getArtifact(completedRun?.resultArtifactId ?? '');
    expect(artifact?.name).toBe('Grix');
    // Chat was called 3 times total: draft (initial), statblock (failed), statblock (recovered retry).
    // Draft was NOT re-executed!
    expect(chatMock).toHaveBeenCalledTimes(3);
  }, 20000);

  it('a mid-flight interruption does not survive into the live or completed row (docs/17 row 110)', async () => {
    const { campaignId, persona } = await seed();
    // The defect's real sequence, and why BOTH writes clear the verdict: a
    // re-render used to call `failRunningRuns()` (it lived in AppShell's RENDER
    // BODY), so a LIVE streaming run was marked 'failed' with 'Interrupted by
    // reload' by an unrelated UI change — repeatedly, on every render. The
    // engine's next step write restored 'running' but (at HEAD) left the stale
    // message, and the completion write did not clear it either, so a
    // 'completed' run told the owner it had been interrupted by a reload.
    //
    // Phase 1 pins the STEP write (the verdict is gone while the run is live)
    // and is injection-proven: removing that clearing fails this test. Phase 2
    // is a REGRESSION GUARD, not an independently proven pin, and the
    // measurement says so: removing the completion write's clearing leaves this
    // test green, because every path to completion passes a step write that
    // cleared the verdict already. It is asserted anyway so a future path that
    // completes without a step write cannot resurrect the defect silently.
    const draft = deferred();
    const statblock = deferred();
    let calls = 0;
    chatMock.mockImplementation(() => {
      calls += 1;
      return calls === 1 ? draft.promise : statblock.promise;
    });

    const runId = await runEngine.startRun({
      ...INPUT(campaignId, persona),
      autonomy: 'auto' as const,
    });
    // The run is genuinely live and parked in its draft model call.
    await waitFor(() => {
      expect(chatMock).toHaveBeenCalled();
    });

    // What the old render-body call site did to a live run.
    await failRunningRuns();
    const interrupted = await getRun(runId);
    expect(interrupted?.status).toBe('failed');
    expect(interrupted?.errorMessage).toBe('Interrupted by reload');

    // The draft lands: the run is live again and carries NO stale verdict.
    await act(() => {
      draft.resolve({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null });
      return Promise.resolve();
    });
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('running');
    });
    const live = await getRun(runId);
    expect(live?.errorMessage).toBe('');
    expect(live?.failureKind).toBeNull();

    // Phase 2: one MORE spurious reconcile, this time between the last step
    // write and the completion write (a re-render could land anywhere).
    await updateRun(runId, {
      status: 'running',
      errorMessage: 'Interrupted by reload',
      failureKind: 'cancelled',
    });
    await act(() => {
      statblock.resolve({
        text: JSON.stringify(VALID_STATBLOCK),
        modelUsed: 'test-model',
        fallback: null,
      });
      return Promise.resolve();
    });
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const completed = await getRun(runId);
    expect(completed?.errorMessage).toBe('');
    expect(completed?.failureKind).toBeNull();
  }, 20000);

  it('passes persona reasoningEffort to chat calls and falls back to settings', async () => {
    const { campaignId, persona } = await seed();
    const customPersona: Persona = {
      ...persona,
      model: 'openai/o3-mini',
      reasoningEffort: 'high',
    };

    chatMock.mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaignId, customPersona));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.steps[1]?.status).toBe('done');
    });

    expect(chatMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        model: 'openai/o3-mini',
        reasoningEffort: 'high',
      }),
    );
  });

  it('creates a module-placed artifact when the run carries placementModuleId', async () => {
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

    // A REAL module row — finalize re-checks existence loudly (AGENTS rule 1).
    const module = await createModuleRow(
      createModuleSchema({
        campaignId,
        title: 'Ember Crypt',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'sketch',
      }),
    );
    const input = { ...INPUT(campaignId, persona), autonomy: 'auto' as const, placementModuleId: module.id };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });

    const run = await getRun(runId);
    expect(run?.placementModuleId).toBe(module.id);
    const resultId = run?.resultArtifactId;
    if (resultId === null || resultId === undefined) throw new Error('run has no result artifact');
    const artifact = await getArtifact(resultId);
    expect(artifact?.moduleId).toBe(module.id);
  }, 20000);

  it('a targeted in-place run with placement set fails loudly (placement is fresh-create only)', async () => {
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null })
      .mockResolvedValue({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null });

    const target = await createArtifact({
      campaignId,
      kind: 'encounter',
      name: 'Ambush at the ford',
      summary: '',
      body: '',
      data: {
        difficulty: 'medium',
        levelHint: '3',
        monsters: [],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout: null,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      },
    });

    const input = {
      ...INPUT(campaignId, persona),
      autonomy: 'auto' as const,
      targetArtifactId: target.id,
      placementModuleId: '11111111-1111-4111-8111-111111111111',
    };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
    });
    const run = await getRun(runId);
    expect(run?.errorMessage).toContain('Module placement applies only to a newly created artifact');
  }, 20000);

  it('a run whose placement module is deleted mid-run fails loudly and leaves no dangling artifact', async () => {
    const { campaignId, persona } = await seed();
    const module = await createModuleRow(
      createModuleSchema({
        campaignId,
        title: 'Doomed Vault',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'sketch',
      }),
    );

    // Hold the statblock reply back so the delete lands while the run is
    // mid-pipeline — finalize (with the placement re-check) runs after it.
    type ChatReply = Awaited<ReturnType<typeof chat>>;
    let releaseStatblock: ((reply: ChatReply) => void) | undefined;
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockImplementationOnce(
        () =>
          new Promise<ChatReply>((resolve) => {
            releaseStatblock = resolve;
          }),
      );

    const input = { ...INPUT(campaignId, persona), autonomy: 'auto' as const, placementModuleId: module.id };
    const runId = await runEngine.startRun(input);
    await waitFor(() => {
      expect(chatMock).toHaveBeenCalledTimes(2);
    });
    if (releaseStatblock === undefined) throw new Error('the run never reached the statblock step');
    expect((await getRun(runId))?.status).toBe('running');

    // The module goes away while the run is in flight…
    await deleteModule(module.id, 'keep');
    // …the queued statblock reply lands, and finalize now hits the missing module.
    releaseStatblock({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    });
    const run = await getRun(runId);
    expect(run?.errorMessage).toContain('was deleted while the run was running');
    expect(run?.resultArtifactId).toBeNull();
    // Zero dangling rows: nothing owns the removed module id.
    const artifacts = await listArtifactsByCampaign(campaignId);
    expect(artifacts.filter((artifact) => artifact.moduleId === module.id)).toEqual([]);
    expect(artifacts).toHaveLength(0);
  }, 20000);

  it('resumeRun without explicit input rebuilds placement and extras from the run row', async () => {
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValue({ text: 'this is not a statblock', modelUsed: 'test-model', fallback: null });

    // A REAL module row — finalize re-checks existence loudly (AGENTS rule 1).
    const module = await createModuleRow(
      createModuleSchema({
        campaignId,
        title: 'Tide Gate',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'sketch',
      }),
    );
    const input = {
      ...INPUT(campaignId, persona),
      autonomy: 'auto' as const,
      placementModuleId: module.id,
      extras: { image: false, statBlock: false, mobPortraits: false, battlemap: false },
    };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
    });
    expect((await getRun(runId))?.placementModuleId).toBe(module.id);

    chatMock.mockReset();
    chatMock.mockResolvedValue({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

    await runEngine.resumeRun(runId);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });
    const resumed = await getRun(runId);
    const resumedId = resumed?.resultArtifactId;
    if (resumedId === null || resumedId === undefined) throw new Error('resumed run has no result artifact');
    const artifact = await getArtifact(resumedId);
    expect(artifact?.moduleId).toBe(module.id);
  }, 20000);

  it('resumeRun without explicit input rebuilds the unattended mode and chain grounding from the run row (F8)', async () => {
    const { campaignId, persona } = await seed();
    // An earlier chain step's produce — the draft prompt grounds on it.
    const contextArtifact = await createArtifact({
      campaignId,
      kind: 'npc',
      name: 'Kael',
      summary: 'The gate warden.',
      body: 'Kael keeps the gate at dusk.',
    });
    // Auto mode: the draft step rejects twice (initial + repair retry) and
    // fails the run — the resume then re-runs the DRAFT step, so its prompt
    // proves the context threading.
    chatMock
      .mockResolvedValueOnce({ text: 'not a draft at all', modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: 'still not a draft', modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      ...INPUT(campaignId, persona),
      autonomy: 'auto' as const,
      // F8: both fields used to be in-memory only — the row never carried
      // them, so a resume silently dropped the mode and the grounding.
      unattended: true,
      contextArtifactIds: [contextArtifact.id],
    });
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
    });
    const failed = await getRun(runId);
    expect(failed?.unattended).toBe(true);
    expect(failed?.contextArtifactIds).toEqual([contextArtifact.id]);

    chatMock.mockReset();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

    await runEngine.resumeRun(runId);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });
    // The resumed draft prompt carries the chain grounding ("Artifacts
    // created earlier in this pipeline") from the persisted ids.
    const resumedDraftCall = chatMock.mock.calls[0];
    if (resumedDraftCall === undefined) throw new Error('the resumed draft never called chat');
    const prompt = resumedDraftCall.map((part) => JSON.stringify(part)).join('\n');
    expect(prompt).toContain('Artifacts created earlier in this pipeline');
    expect(prompt).toContain('Kael');
    expect(prompt).toContain('The gate warden.');
    // The rebuilt input kept the run's mode: the row carries it through.
    const resumed = await getRun(runId);
    expect(resumed?.unattended).toBe(true);
    expect(resumed?.contextArtifactIds).toEqual([contextArtifact.id]);
  }, 20000);
  it('pilot (strict structured outputs): the encounter draft step sends a strict json_schema responseFormat', async () => {
    const { campaignId } = await seed();
    const encounterPersona = await createPersona({
      slug: 'encounter-smith-test',
      name: 'Encounter Smith',
      description: 'test',
      systemPrompt: 'You are a test persona. Reply with JSON only.',
      producesKind: 'encounter',
      builtIn: true,
    });
    chatMock.mockResolvedValue({
      text: JSON.stringify(VALID_ENCOUNTER_DRAFT),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun(INPUT(campaignId, encounterPersona));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
    });

    const run = await getRun(runId);
    expect(run?.steps.map((step) => step.name)).toEqual(['retrieve', 'draft']);
    expect(run?.steps[1]?.status).toBe('done');
    expect(chatMock).toHaveBeenCalledTimes(1);
    const opts = chatMock.mock.calls[0]?.[1] as {
      responseFormat?: { kind?: string; name?: string; jsonSchema?: Record<string, unknown> };
    };
    expect(opts.responseFormat).toMatchObject({ kind: 'schema', name: 'encounter-draft' });
    expect(opts.responseFormat?.jsonSchema?.additionalProperties).toBe(false);
    const required = opts.responseFormat?.jsonSchema?.required as string[] | undefined;
    expect(required).toContain('monsters');
    expect(required).toContain('locationKind');
  }, 20000);

  it('rollout: the npc draft and statblock steps send their strict json_schema responseFormats', async () => {
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaignId, persona));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
    });
    await runEngine.approve(runId, INPUT(campaignId, persona)); // draft approved -> statblock runs
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.steps.map((step) => step.name)).toContain('statblock');
    });

    const draftFormat = (chatMock.mock.calls[0]?.[1] as { responseFormat?: { kind?: string; name?: string } })
      .responseFormat;
    expect(draftFormat).toMatchObject({ kind: 'schema', name: 'npc-draft' });
    const statblockFormat = (chatMock.mock.calls[1]?.[1] as { responseFormat?: { kind?: string; name?: string } })
      .responseFormat;
    expect(statblockFormat).toMatchObject({ kind: 'schema', name: 'statblock' });
    // The statblock contract drops the free-form extras record (strict subset).
    const statblockSchema = (chatMock.mock.calls[1]?.[1] as {
      responseFormat?: { jsonSchema?: { properties?: Record<string, unknown> } };
    }).responseFormat?.jsonSchema;
    expect(statblockSchema?.properties?.extras).toBeUndefined();
    // PROVENANCE (docs/17 row 93): the draft contract the MODEL is asked to
    // fill carries no `writerModel` — the run records which model served the
    // reply, it never asks the model to name itself (and a `.default('')`
    // field would come out REQUIRED in the strict subset, forcing an invented
    // id). The draft contract is a separate schema from the artifact row for
    // exactly this reason; this pins that they never get merged.
    const draftSchema = (chatMock.mock.calls[0]?.[1] as {
      responseFormat?: { jsonSchema?: { properties?: Record<string, unknown> } };
    }).responseFormat?.jsonSchema;
    expect(draftSchema?.properties).toBeDefined();
    expect(draftSchema?.properties?.writerModel).toBeUndefined();
    expect(Object.keys(draftSchema?.properties ?? {})).not.toContain('writerModel');
  }, 20000);

  it('rollout: the continuity check step sends its strict json_schema responseFormat', async () => {    const editor = BUILT_IN_PERSONAS.find((persona) => persona.slug === 'continuity-editor');
    if (editor === undefined) throw new Error('continuity-editor persona missing');
    const { campaignId, persona } = await seed();
    const editorPersona = persona.mode === 'review' ? persona : editor;
    chatMock.mockResolvedValueOnce({
      text: JSON.stringify({ verdict: 'consistent', summary: 'All consistent.', issues: [] }),
      modelUsed: 'test-model',
      fallback: null,
    });
    const target = await createArtifact({
      campaignId,
      kind: 'npc',
      name: 'Review Target',
      body: 'The target body.',
    });

    const input = { ...INPUT(campaignId, editorPersona), targetArtifactId: target.id, autonomy: 'auto' as const };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    const checkFormat = (chatMock.mock.calls[0]?.[1] as { responseFormat?: { kind?: string; name?: string } })
      .responseFormat;
    expect(checkFormat).toMatchObject({ kind: 'schema', name: 'continuity-report' });
  }, 20000);

});

/**
 * WRITE-TIME COPY-ON-WRITE (docs/17 row 255a): the encounter generator used to
 * mint a `rulebook` POINTER on every generated roster entry
 * (`rulebookSourceFor`), and the v24 migration's one-shot backfill could never
 * catch those fresh pointers. The generator now COPIES — the library block, the
 * STAMPED origin line, the opaque `chunk:<id>` token — through the ONE copy
 * operation the migration also calls.
 */
describe('rosterMobCopyFor', () => {
  beforeEach(clearDatabase);

  async function installChunk(): Promise<{ chunkId: string; statBlock: StatBlock }> {
    const book = await createPackBook({
      title: 'Monster Core',
      system: 'pathfinder2e',
      filename: 'monster-core.zip',
    });
    await finalizePackBook(book.id, {
      sourceId: 'foundry-pf2e',
      license: 'Community Use Policy',
      entriesImported: 1,
      entriesSkipped: 0,
      entriesFailed: 0,
    });
    const statBlock = statBlockSchema.parse({ ...blankStatBlock('pathfinder2e'), hp: 20 });
    const text = 'Goblin Warrior stat block';
    const contentHash = await sha256Hex(text);
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 1,
        pageEnd: 1,
        chunkType: 'statblock',
        headingPath: ['Goblin Warrior'],
        text,
        statBlock,
        contentHash,
      }),
    ]);
    const { db } = await import('@/db/db');
    const [chunk] = await db.chunks.toArray();
    if (chunk === undefined) throw new Error('chunk missing');
    return { chunkId: chunk.id, statBlock };
  }

  it('COPIES the block, the STAMPED pack line and the opaque chunk token — and writes NO pointer', async () => {
    const { chunkId, statBlock } = await installChunk();

    const fields = await rosterMobCopyFor(chunkId, 'Goblin Warrior');
    // The library bytes, copied in full.
    expect(fields.source).toEqual({ type: 'inline', statBlock });
    // The label `creatureOriginLabel` used to compose at READ time is STAMPED:
    // a pack book has no page numbers, so it names the creature.
    expect(fields.sourceLine).toBe('Monster Core: Goblin Warrior');
    // The opaque identity token keeps the creature's portrait slot (no
    // `mobPortraits`/`creatureImages` remap).
    expect(fields.originToken).toBe(`chunk:${chunkId}`);
    // The minted fields carry no citation spelling at all.
    expect(JSON.stringify(fields)).not.toContain('rulebook');
    expect(JSON.stringify(fields)).not.toContain('contentHash');
    // Creating the copy created NOTHING: no artifact is a creature.
    const { db } = await import('@/db/db');
    expect(await db.artifacts.count()).toBe(0);
  });

  it('reads back without the library: the stamped copy is the row (every lookup can throw)', async () => {
    const { chunkId, statBlock } = await installChunk();
    const fields = await rosterMobCopyFor(chunkId, 'Goblin Warrior');
    const entry = monsterEntrySchema.parse({
      name: 'Goblin Warrior',
      count: 1,
      notes: '',
      treasure: '',
      ...fields,
    });
    // Delete the pack the copy came from: the row still resolves in full.
    const { db } = await import('@/db/db');
    await db.rulebooks.clear();
    await db.chunks.clear();
    const resolved = await resolveStoredMonsterEntry(entry, {
      getArtifact: () => Promise.reject(new Error('library read attempted')),
      getChunk: () => Promise.reject(new Error('library read attempted')),
      getChunkByContentHash: () => Promise.reject(new Error('library read attempted')),
      getRulebook: () => Promise.reject(new Error('library read attempted')),
    });
    expect(resolved.statBlock).toEqual(statBlock);
    expect(resolved.origin).toBe('Monster Core: Goblin Warrior');
  });

  it('refuses to copy a vanished chunk — never a minted pointer or a placeholder block', async () => {
    await expect(rosterMobCopyFor(newId(), 'Goblin Warrior')).rejects.toThrow(
      /not in this workspace/,
    );
  });
});

/**
 * Recently-used chat models (docs/17 row 193): the engine's ONE recording call
 * at the point every run path funnels through. The GLOBAL first-try default is
 * recorded; a persona override, the fallback/escalation tier and an image run
 * are not — recording any of them would put a model in the picker's list that
 * the owner did not run on. Each exclusion asserts the WHOLE `recentChatModels`
 * array is unchanged, drained of the fire-and-forget recorder first (docs/17
 * row 203).
 */
describe('recently used chat models (docs/17 row 193)', () => {
  it('records the GLOBAL first-try model when a run resolves it', async () => {
    const { campaignId, persona } = await seed();
    await updateSettings({ defaultChatModel: 'global/used', recentChatModels: [] });
    chatMock.mockResolvedValue({
      text: JSON.stringify(VALID_DRAFT),
      modelUsed: 'global/used',
      fallback: null,
    });

    const runId = await runEngine.startRun(INPUT(campaignId, persona));

    await waitFor(async () => {
      expect((await getSettings()).recentChatModels).toEqual(['global/used']);
    });
    // Let the pipeline reach its manual pause so nothing is left in flight
    // when the next test clears the database.
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
    });
  });

  it('does NOT record a persona override: the whole recents list is unchanged', async () => {
    const { campaignId, persona } = await seed();
    await updateSettings({ defaultChatModel: 'global/unused', recentChatModels: ['older/model'] });
    chatMock.mockResolvedValue({
      text: JSON.stringify(VALID_DRAFT),
      modelUsed: 'persona/override',
      fallback: null,
    });

    const runId = await runEngine.startRun(
      INPUT(campaignId, { ...persona, model: 'persona/override' }),
    );

    // The run really started and reached its manual pause…
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
    });
    expect(chatMock).toHaveBeenCalled();
    // …and the recents list is UNCHANGED. The list is compared WHOLE, after the
    // fire-and-forget recorder had its chance to land (docs/17 row 203): "the
    // global id is absent" would pass while a wrongly scheduled write of the
    // persona model was still in flight.
    expect(await recentsAfterSettlingWrites()).toEqual(['older/model']);
  });
});
