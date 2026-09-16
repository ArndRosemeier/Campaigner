/**
 * MERGED same-background cluster (docs/17 row 177, extending row 176's pilot):
 * eight `tests/llm` files that share ONE background — fake-indexeddb +
 * `clearDatabase()` per test, the SAME identical `vi.mock` target set
 * (`@/llm/openrouter`, `@/lib/toast`), and Dexie-backed module generation /
 * provenance recording driven through the mocked `chat` seam — now run in ONE
 * file, so the import/transform/jsdom-environment/setup cost is paid once
 * instead of eight times.
 *
 * Merged from (one `describe` per original file, so each stays findable; test
 * names and every `expect` assertion site is byte-identical):
 *   - tests/llm/escapeDebris.test.ts (3)
 *   - tests/llm/module-edit-origin.test.ts (14)
 *   - tests/llm/moduleGen-floor-repair.test.ts (9)
 *   - tests/llm/moduleGen-party-exclusion.test.ts (11)
 *   - tests/llm/moduleGen-rewrite-context.test.ts (3)
 *   - tests/llm/moduleGenReconcile.test.ts (6)
 *   - tests/llm/provenance-recording.test.ts (9)
 *   - tests/llm/scaffoldingEcho.test.ts (15)
 *
 * `tests/llm/moduleGen.test.ts` (65) is deliberately NOT in this cluster: it
 * shares the target set but adding it would push the merged file to 135 tests,
 * past the ~120 cap in the sweep rule — the cap wins over including every file.
 * The `@/lib/toast` factory is the union of the originals (moduleGenReconcile
 * needed `toastInfo`; provenance-recording needed `toastErrorPersistent`); the
 * `MissingApiKeyError` constructor variant is kept (no test asserts its
 * message). `moduleGenReconcile`'s `vi.stubGlobal('navigator')` is undone by its
 * own `afterEach(vi.unstubAllGlobals)`, which stays inside its describe.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { createCampaign } from '@/db/campaignRepo';
import { createPersona } from '@/db/personaRepo';
import {
  listArtifactsByCampaign,
  createArtifact,
  getArtifact,
  updateArtifact,
} from '@/db/artifactRepo';
import { getRun } from '@/db/runRepo';
import {
  getModule,
  patchModule,
  saveModule,
  patchModulePartText,
  createModule as createModuleRow,
} from '@/db/moduleRepo';
import {
  createModule,
  moduleSpineSchema,
  modulePartSchema,
  textOriginIsMachineWritten,
  assembleModulePartsDocument,
  moduleCreationPool,
  MODULE_CREATION_EXCLUDED_KINDS,
  visibleToModuleCreation,
  moduleSchema,
  recordedWritingModel,
} from '@/domain';
import type { Id, Persona, Campaign, Module, ModulePart, TextOrigin } from '@/domain';
import { runEngine } from '@/llm/runEngine';
import type { StartRunInput } from '@/llm/runEngine';
import {
  runParts,
  approveSpineAndRun,
  normalizeModuleEntityNames,
  runSpine,
  floorRepairTargets,
  ModuleBusyError,
  repairModuleEncounterFloor,
  campaignCastContext,
  classifyNewModuleEntityNames,
  hasLiveModuleGen,
  parseSpine,
} from '@/llm/moduleGen';
import { clearDatabase } from '../db/helpers';
import { updateSettings } from '@/db/settingsRepo';
import { saveModulePartText } from '@/features/modules/partText';
import type { ChatResult } from '@/llm/openrouter';
import { listModuleVersions } from '@/db/moduleVersionRepo';
import { bumpStopEpoch } from '@/lib/stopEpoch';
import { useProgressStore } from '@/lib/progress';
import { buildEntityBrief } from '@/features/modules/persona-request';
import { fixedCastForEncounter, PARTY_SIZE, partyLevelLine } from '@/llm/roomBudget';
import { renderChatGrounding } from '@/llm/canvasChat';
import {
  INTERRUPTED_MODULE_GEN_MESSAGE,
  reconcileInterruptedModuleGen,
  reconcileInterruptedModuleGens,
} from '@/llm/moduleGenReconcile';
import { moduleGenLockName } from '@/lib/generationLocks';
import { createImage } from '@/db/imageRepo';
import { BUILT_IN_PERSONAS } from '@/llm/personas/builtins';
import { saveWholeModuleDocument } from '@/features/modules/canvas/saveDoc';
import { db } from '@/db/db';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GROUNDING_SECTION_HEADER } from '@/llm/campaignGrounding';
import { documentTextFields } from '@/llm/generatedTextHygiene';
import {
  ENCOUNTER_SOURCE_REPAIR_LEAD_IN,
  ENTITY_CONTEXT_LABEL,
  ENTITY_NAME_VERBATIM_PREFIX,
  ENTITY_NAME_VERBATIM_SUFFIX,
  ENTITY_LEVEL_HINT_HIERARCHY,
  ENTITY_LEVEL_HINT_LABEL,
  ENTITY_SCENE_CONTEXT_LABEL,
  ENTITY_SERVE_MODULE_TEXT,
  FACTION_OWNERSHIP_BOUNDARY,
  FIXED_CAST_SECTION_FOOTER,
  FIXED_CAST_SECTION_HEADER,
  INTENT_HIERARCHY,
  INTENT_LABEL,
  MODULE_PREMISE_LABEL,
  MOB_SPELL_CASTER_CLAUSE,
  MOB_SPELL_REPAIR_LEAD_IN,
  MOB_SPELL_SECTION_PREFIX,
  PART_TOO_SHORT_REPAIR_SENTENCE,
  PLACE_OWNERSHIP_BOUNDARY,
  SCHEMA_REPAIR_LEAD_IN,
  findScaffoldingEcho,
} from '@/llm/promptScaffolding';

const { chat } = await import('@/llm/openrouter');
const { toastError, toastSuccess } = await import('@/lib/toast');

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

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastErrorPersistent: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

/**
 * Cross-describe mock isolation for the merge: each original owned its own mock
 * instance, so its own teardown sufficed. A merged file shares ONE instance per
 * mocked module (the point of the merge), so a leftover `mockImplementation` or
 * call history from an earlier describe would answer a later test's `...Once`
 * queue overflow and change its call counts. Reset before every test; each
 * describe's own hooks then install what it needs.
 */
beforeEach(() => {
  vi.resetAllMocks();
});

describe('escapeDebris.test.ts', () => {
  /**
   * Escape-debris hygiene backstop (detection for the UTF-8 contract):
   * debris in a persona draft rejects finalize with nothing persisted, and
   * debris in module part prose fails that part while the chain continues.
   */

  const chatMock = vi.mocked(chat);

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

  async function seedPersona(): Promise<{ campaignId: Id; persona: Persona }> {
    const campaign = await createCampaign({ name: 'Test Campaign', system: 'dnd5e' });
    const persona = await createPersona({
      slug: 'npc-smith-debris-test',
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

  const VALID_SPINE = {
    premise:
      'A harbor town raised its bell to warn of the drownings; now the bell rings by itself.',
    themes: ['duty', 'decay'],
    partPlan: [
      {
        title: 'The Sunken Quarter',
        levelBand: '1',
        synopsis: 'The party arrives with the low tide and finds the first bodies.',
        levelUpTrigger: 'The bell is found.',
      },
      {
        title: 'The Drowned Cathedral',
        levelBand: '2',
        synopsis: 'Descent beneath the harbor to the flooded nave.',
        levelUpTrigger: 'The warden falls.',
      },
    ],
    entities: [],
  };

  /** Module prose well above the 100-char floor, with a findable marker. */
  function partMarkdown(marker: string): string {
    return `${marker}: The tide withdraws and the streets shine wet under a pale sun. `.repeat(4);
  }

  beforeEach(clearDatabase);
  afterEach(() => {
    chatMock.mockReset();
    vi.restoreAllMocks();
  });

  describe('escape debris in persona finalize', () => {
    it('rejects the finalize step with the debris named and persists nothing', async () => {
      const { campaignId, persona } = await seedPersona();
      const debrisDraft = {
        name: 'Grix',
        summary: 'A goblin alchemist boss.',
        suggestedTags: ['goblin'],
        body: '# Grix\nShe brews by the Flussm?fcndung. She throws.',
        appearance: 'Small, soot-stained, goggles.',
        personality: 'Manic, cheerful, volatile.',
        needsStatBlock: true,
      };
      chatMock
        .mockResolvedValueOnce({
          text: JSON.stringify(debrisDraft),
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce({
          text: JSON.stringify(VALID_STATBLOCK),
          modelUsed: 'test-model',
          fallback: null,
        });

      const runId = await runEngine.startRun(INPUT(campaignId, persona));
      await waitFor(async () => {
        expect((await getRun(runId))?.status).toBe('awaiting_user');
      });
      await runEngine.approve(runId, INPUT(campaignId, persona));
      await waitFor(async () => {
        expect((await getRun(runId))?.status).toBe('awaiting_user');
      });
      await runEngine.approve(runId, INPUT(campaignId, persona));
      await waitFor(async () => {
        const run = await getRun(runId);
        expect(run?.status).toBe('awaiting_user');
        expect(run?.steps.at(-1)?.name).toBe('finalize');
      });

      const run = await getRun(runId);
      const finalize = run?.steps.at(-1);
      expect(finalize?.status).toBe('rejected');
      const issues = (finalize?.output as { issues?: unknown }).issues;
      expect(Array.isArray(issues)).toBe(true);
      expect((issues as string[]).join('\n')).toContain('"?fc"');
      expect((issues as string[]).join('\n')).toContain('draft.body');
      // Nothing persisted: no artifact, no result link.
      expect(run?.resultArtifactId).toBeNull();
      expect(await listArtifactsByCampaign(campaignId)).toHaveLength(0);
    }, 20000);

    it('rejects debris hidden in a literal \\uXXXX escape', async () => {
      const { campaignId, persona } = await seedPersona();
      const debrisDraft = {
        name: 'Grix',
        summary: 'Die K\\u00fcche des Alchemisten.',
        suggestedTags: [],
        body: '# Grix\nShe brews. She throws.',
        appearance: 'Small.',
        personality: 'Manic.',
        needsStatBlock: false,
      };
      chatMock.mockResolvedValueOnce({
        text: JSON.stringify(debrisDraft),
        modelUsed: 'test-model',
        fallback: null,
      });

      const runId = await runEngine.startRun(INPUT(campaignId, persona));
      await waitFor(async () => {
        expect((await getRun(runId))?.status).toBe('awaiting_user');
      });
      // needsStatBlock: false skips the statblock step — approve straight into finalize.
      await runEngine.approve(runId, INPUT(campaignId, persona));
      await waitFor(async () => {
        expect((await getRun(runId))?.steps.at(-1)?.name).toBe('finalize');
      });

      const run = await getRun(runId);
      expect(run?.steps.at(-1)?.status).toBe('rejected');
      const issues = (run?.steps.at(-1)?.output as { issues?: unknown }).issues;
      expect((issues as string[]).join('\n')).toContain('"\\u00fc"');
      expect(await listArtifactsByCampaign(campaignId)).toHaveLength(0);
    }, 20000);
  });

  describe('escape debris in module parts', () => {
    it('fails the debris part with the debris named and continues the chain', async () => {
      const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
      const saved = await saveModule(
        createModule({
          campaignId: campaign.id,
          title: 'The Drowned Bell',
          concept: 'A harbor bell that rings by itself beneath the water.',
          levelMin: 1,
          levelMax: 3,
          tone: 'eerie',
          sizeDial: 'standard',
        }),
      );
      await patchModule(saved.id, { spine: moduleSpineSchema.parse(VALID_SPINE) });
      const encounterVerdict = {
        text: JSON.stringify({
          entities: [{ name: 'Ember Trial', canonical: 'Ember Trial', kind: 'encounter' }],
        }),
        modelUsed: 'test-model',
        fallback: null,
      };
      chatMock
        .mockResolvedValueOnce({
          text: `${partMarkdown('PART-ONE')} Trial faced: [[Ember Trial]].`,
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce({
          text: `${partMarkdown('PART-TWO')} The chapel stands by the Flussm?fcndung.`,
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce(encounterVerdict) // post-parts normalization
        // The floor gate's ONE repair rewrite for the debris-failed part comes
        // back with debris again — the part stays failed, the module fails loud.
        .mockResolvedValueOnce({
          text: `${partMarkdown('PART-TWO-REPAIR')} The chapel stands by the Flussm?fcndung.`,
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce(encounterVerdict); // re-normalization

      const finished = await runParts(saved.id, campaign, { planIndexes: [0, 1] });

      // The encounter floor cannot pass with the debris part missing — the
      // module fails LOUDLY naming the part instead of shipping ready.
      expect(finished.status).toBe('failed');
      expect(finished.errorMessage).toContain('Encounter floor not met');
      expect(finished.errorMessage).toContain('The Drowned Cathedral');
      const [one, two] = finished.parts;
      expect(one?.status).toBe('ready');
      expect(one?.markdown).toContain('PART-ONE');
      expect(two?.status).toBe('failed');
      expect(two?.markdown).toBe('');
      expect(two?.errorMessage).toContain('?fc');
      // The debris is never persisted as ready prose.
      const stored = await getModule(saved.id);
      const storedTwo = stored?.parts.find((part) => part.planIndex === 1);
      expect(storedTwo?.status).toBe('failed');
      expect(storedTwo?.markdown).not.toContain('?fc');
    }, 20000);
  });
});

describe('module-edit-origin.test.ts', () => {
  /**
   * AUTHORSHIP vs `edited` (owner report, docs/17 row 113).
   *
   * The owner's bug, verbatim: *"Module creation after creating parts when
   * normalizing now ALWAYS brings up this: 'Normalization wants to update
   * hand-edited text ? review the proposed rewrites.' There is actually nothing
   * hand written."*
   *
   * Two independent causes fed that one banner, and neither was authorship:
   *
   *  1. the premise took the proposal path UNCONDITIONALLY, so a module he never
   *     touched raised the banner whenever its premise named a variant;
   *  2. `edited` was stamped by the one part-text save seam on EVERY write
   *     through it — including model text the canvas auto-accepted — and the
   *     banner read `edited` as "hand-written".
   *
   * This suite pins the fix at every load-bearing line: the origin is recorded
   * at THE ONE save seam (a write that supplies `writerModel` is a MODEL write),
   * the consent rule reads ONE authorship accessor, machine-written text
   * normalizes immediately (the generated premise included), human-authored text
   * still holds, and a row written before the field keeps asking (the
   * conservative default — the origin is NOT recoverable, because a hand edit
   * deliberately carries the previous model id forward).
   *
   * The normalization reply contract is satisfied honestly here: a canonical
   * must be the name itself, ANOTHER LISTED NAME that maps to itself, or an
   * existing artifact (`validateNormalizationReply`) — so the variant and its
   * canonical BOTH appear in the module text, which is exactly how the real
   * prompt gets its vocabulary.
   */

  const chatMock = vi.mocked(chat);

  const TEST_MODEL = 'test/fixture-model';

  /** Module prose well above the 100-char floor. */
  const PROSE =
    'The tide withdraws down the spiral stair and leaves salt on every stone, ' +
    'and the bell above the harbor answers a question nobody asked aloud. ';

  /** The variant name and its canonical, both present in the text. */
  const VARIANT = 'Guard Halmund';
  const CANONICAL = 'Halmund';

  /** The one valid verdict for this suite: the variant folds onto the listed
   * canonical, which maps to itself. */
  function foldVerdict(): ChatResult {
    return {
      text: JSON.stringify({
        entities: [
          { name: VARIANT, canonical: CANONICAL, kind: 'npc' },
          { name: CANONICAL, canonical: CANONICAL, kind: 'npc' },
        ],
      }),
      modelUsed: TEST_MODEL,
      fallback: null,
    };
  }

  /** A generator part reply: real prose plus the names the floor/verdicts need. */
  function partReply(names: readonly string[]): ChatResult {
    return {
      text:
        `${PROSE}${PROSE}` +
        (names.length === 0
          ? 'Nothing else is named here.'
          : `Named here: ${names.map((name) => `[[${name}]]`).join(' and ')}.`),
      modelUsed: 'staged/part-model',
      fallback: null,
    };
  }

  async function seedModule(
    levelMin = 1,
    levelMax = 1,
  ): Promise<{ campaign: Campaign; moduleId: Id }> {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const saved = await saveModule(
      createModule({
        campaignId: campaign.id,
        title: 'The Drowned Bell',
        concept: 'A harbor bell that rings by itself beneath the water.',
        levelMin,
        levelMax,
        tone: 'eerie',
        sizeDial: 'standard',
      }),
    );
    await updateSettings({ defaultChatModel: TEST_MODEL });
    return { campaign, moduleId: saved.id };
  }

  async function seedSpine(
    moduleId: Id,
    premise: string,
    origin: TextOrigin | null,
  ): Promise<void> {
    await patchModule(moduleId, {
      spine: moduleSpineSchema.parse({
        premise,
        themes: [],
        partPlan: [
          {
            title: 'The Sunken Quarter',
            levelBand: '1',
            synopsis: '',
            levelUpTrigger: 'The bell is found.',
          },
        ],
        origin,
        writerModel: origin === 'model' ? TEST_MODEL : '',
      }),
    });
  }

  /** Writes ONE part straight onto the row. These tests are about what a WRITE
   * records, so they set the pre-state explicitly rather than going through a
   * seam whose behavior is itself under test. */
  async function seedPart(
    moduleId: Id,
    part: {
      planIndex: number;
      markdown: string;
      edited: boolean;
      origin: TextOrigin | null;
      writerModel?: string;
    },
  ): Promise<void> {
    const current = await getModule(moduleId);
    if (current === undefined) throw new Error('seed module is missing');
    const parts = current.parts.filter((entry) => entry.planIndex !== part.planIndex);
    parts.push(
      modulePartSchema.parse({
        planIndex: part.planIndex,
        markdown: part.markdown,
        status: 'ready',
        errorMessage: '',
        edited: part.edited,
        writerModel: part.writerModel ?? '',
        origin: part.origin,
      }),
    );
    parts.sort((a, b) => a.planIndex - b.planIndex);
    await patchModule(moduleId, { parts });
  }

  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(() => {
    chatMock.mockReset();
    vi.restoreAllMocks();
  });

  describe('the one part-text save seam records the ORIGIN, not just `edited`', () => {
    it('a write that supplies a writerModel is a MODEL write (edited stays true)', async () => {
      const { moduleId } = await seedModule();

      await patchModulePartText(moduleId, 0, 'Model-written prose.', 'staged/canvas-model');

      const part = (await getModule(moduleId))?.parts[0];
      expect(part?.origin).toBe('model');
      expect(part?.writerModel).toBe('staged/canvas-model');
      // `edited` keeps its old meaning — "written outside the generator" — so no
      // other surface's reading of it changes.
      expect(part?.edited).toBe(true);
      // And the ONE accessor agrees with the record.
      expect(textOriginIsMachineWritten(part?.origin)).toBe(true);
    });

    it('a write that omits it is a HUMAN write, and carries the recorded model id forward', async () => {
      const { moduleId } = await seedModule();
      await patchModulePartText(moduleId, 0, 'Model-written prose.', 'staged/canvas-model');

      // The owner's hand edit through the sanctioned feature seam: no id.
      await saveModulePartText(moduleId, 0, 'The owner rewrote this passage by hand.');

      const part = (await getModule(moduleId))?.parts[0];
      expect(part?.origin).toBe('human');
      // The provenance of the text they edited SURVIVES (docs/17 row 93).
      expect(part?.writerModel).toBe('staged/canvas-model');
      expect(part?.edited).toBe(true);
      expect(textOriginIsMachineWritten(part?.origin)).toBe(false);
    });

    it('a first human write on a part with no recorded id stays empty and reads as human', async () => {
      const { moduleId } = await seedModule();

      await saveModulePartText(moduleId, 0, 'Typed straight into the reader.');

      const part = (await getModule(moduleId))?.parts[0];
      expect(part?.writerModel).toBe('');
      expect(part?.origin).toBe('human');
    });
  });

  describe('the generated PREMISE normalizes automatically; a hand-edited one holds', () => {
    it('rewrites a machine-written premise in place and keeps its model origin', async () => {
      const { moduleId } = await seedModule();
      await seedSpine(moduleId, `The bell tolls for [[${VARIANT}]] and [[${CANONICAL}]].`, 'model');
      chatMock.mockResolvedValueOnce(foldVerdict());

      await normalizeModuleEntityNames(moduleId);

      const after = await getModule(moduleId);
      // Applied, display text preserved — no proposal, so no banner.
      expect(after?.spine?.premise).toBe(
        `The bell tolls for [[${CANONICAL}|${VARIANT}]] and [[${CANONICAL}]].`,
      );
      expect(after?.spine?.origin).toBe('model');
      expect(after?.entityRewriteProposals).toBeNull();
    });

    it('HOLDS a premise the owner wrote — the consent protection is unchanged', async () => {
      const { moduleId } = await seedModule();
      await seedSpine(moduleId, `The bell tolls for [[${VARIANT}]] and [[${CANONICAL}]].`, 'human');
      chatMock.mockResolvedValueOnce(foldVerdict());

      await normalizeModuleEntityNames(moduleId);

      const after = await getModule(moduleId);
      expect(after?.spine?.premise).toBe(`The bell tolls for [[${VARIANT}]] and [[${CANONICAL}]].`);
      expect(after?.spine?.origin).toBe('human');
      expect(after?.entityRewriteProposals).toEqual([
        { planIndex: -1, replacements: [{ from: VARIANT, to: CANONICAL }] },
      ]);
    });
  });

  describe('the consent rule reads AUTHORSHIP, not `edited`', () => {
    it('applies the rewrite to a canvas-applied MODEL part (which is `edited: true`)', async () => {
      const { moduleId } = await seedModule();
      await seedSpine(moduleId, 'A quiet harbor town.', 'model');
      await seedPart(moduleId, {
        planIndex: 0,
        markdown: `${PROSE}${PROSE}Here lives [[${VARIANT}]] near [[${CANONICAL}]].`,
        edited: true,
        origin: 'model',
        writerModel: 'staged/canvas-model',
      });
      chatMock.mockResolvedValueOnce(foldVerdict());

      await normalizeModuleEntityNames(moduleId);

      const after = await getModule(moduleId);
      expect(after?.parts[0]?.markdown).toContain(`[[${CANONICAL}|${VARIANT}]]`);
      expect(after?.parts[0]?.edited).toBe(true);
      expect(after?.parts[0]?.origin).toBe('model');
      // The whole point of the owner's report: NOTHING is held, so no banner.
      expect(after?.entityRewriteProposals).toBeNull();
    });

    it('HOLDS the rewrite of a part the owner wrote, and rewrites the generated one beside it', async () => {
      const { moduleId } = await seedModule();
      await seedSpine(moduleId, 'A quiet harbor town.', 'model');
      await seedPart(moduleId, {
        planIndex: 0,
        markdown: `${PROSE}${PROSE}The owner typed [[${VARIANT}]] and [[${CANONICAL}]].`,
        edited: true,
        origin: 'human',
        writerModel: 'staged/canvas-model',
      });
      await seedPart(moduleId, {
        planIndex: 1,
        markdown: `${PROSE}${PROSE}The generator wrote [[${VARIANT}]] and [[${CANONICAL}]].`,
        edited: false,
        origin: 'model',
      });
      chatMock.mockResolvedValueOnce(foldVerdict());

      await normalizeModuleEntityNames(moduleId);

      const after = await getModule(moduleId);
      expect(after?.parts.find((part) => part.planIndex === 0)?.markdown).toContain(
        `[[${VARIANT}]]`,
      );
      expect(after?.parts.find((part) => part.planIndex === 1)?.markdown).toContain(
        `[[${CANONICAL}|${VARIANT}]]`,
      );
      expect(after?.entityRewriteProposals).toEqual([
        { planIndex: 0, replacements: [{ from: VARIANT, to: CANONICAL }] },
      ]);
    });

    it('the GENERATOR writes `origin: model` on the spine it generates, so its own premise never asks', async () => {
      const { campaign, moduleId } = await seedModule();
      // The spine pass: the model reply, then the pass's own normalization call.
      chatMock
        .mockResolvedValueOnce({
          text: JSON.stringify({
            premise: `The bell tolls for [[${VARIANT}]] and [[${CANONICAL}]].`,
            themes: ['duty'],
            partPlan: [
              {
                title: 'The Sunken Quarter',
                levelBand: '1',
                synopsis: '',
                levelUpTrigger: 'The bell is found.',
              },
            ],
            entities: [
              { name: VARIANT, kind: 'npc' },
              { name: CANONICAL, kind: 'npc' },
              // The pass-0 spine gate reads the DECLARED kinds: one named
              // encounter record keeps it quiet (08 §M4-B).
              { name: 'The Bells Below', kind: 'encounter' },
            ],
          }),
          modelUsed: 'staged/spine-model',
          fallback: null,
        })
        .mockResolvedValueOnce({
          text: JSON.stringify({
            entities: [
              { name: VARIANT, canonical: VARIANT, kind: 'npc' },
              { name: CANONICAL, canonical: CANONICAL, kind: 'npc' },
              // The pass's own normalizer answers the DECLARED records too.
              { name: 'The Bells Below', canonical: 'The Bells Below', kind: 'encounter' },
            ],
          }),
          modelUsed: TEST_MODEL,
          fallback: null,
        });

      await runSpine(moduleId, campaign);

      const generated = await getModule(moduleId);
      // The generator's own premise is the MODEL's text, recorded as such — not
      // a `null` that would read as the owner's and make the pass ask him about
      // a premise he never saw (the owner's report, exactly).
      expect(generated?.spine?.origin).toBe('model');
      expect(generated?.spine?.writerModel).toBe('staged/spine-model');

      // …and the NEXT normalization pass rewrites that premise in place: no
      // proposal, no banner.
      await patchModule(moduleId, {
        entityKinds: [
          { name: VARIANT, kind: 'npc', absorbed: [] },
          { name: CANONICAL, kind: 'npc', absorbed: [] },
        ],
      });
      chatMock.mockReset();
      chatMock.mockResolvedValueOnce(foldVerdict());

      await normalizeModuleEntityNames(moduleId);

      const after = await getModule(moduleId);
      expect(after?.spine?.premise).toBe(
        `The bell tolls for [[${CANONICAL}|${VARIANT}]] and [[${CANONICAL}]].`,
      );
      expect(after?.entityRewriteProposals).toBeNull();
    }, 20000);

    it('the GENERATOR writes `origin: model` and `edited: false` on a part it generates', async () => {
      const { campaign, moduleId } = await seedModule();
      await seedSpine(moduleId, 'A quiet harbor town.', 'model');
      await patchModule(moduleId, {
        entityKinds: [{ name: CANONICAL, kind: 'npc', absorbed: [] }],
      });
      chatMock
        // The parts pass's own post-pass normalization call…
        .mockResolvedValueOnce({
          text: JSON.stringify({ entities: [] }),
          modelUsed: TEST_MODEL,
          fallback: null,
        })
        // …then the single part call.
        .mockResolvedValue(partReply([CANONICAL]));

      await runParts(moduleId, campaign);

      const after = await getModule(moduleId);
      expect(after?.parts).toHaveLength(1);
      expect(after?.parts[0]?.edited).toBe(false);
      expect(after?.parts[0]?.origin).toBe('model');
      expect(after?.parts[0]?.writerModel).toBe('staged/part-model');
    });
  });

  describe('the legacy default: a row with NO origin keeps asking', () => {
    it('holds a rewrite when the origin is not recorded, and the accessor says so', async () => {
      const { moduleId } = await seedModule();
      // A row from before the field: `edited` with `origin: null`. The origin is
      // NOT recoverable — a hand edit carries the previous `writerModel` forward,
      // which is exactly why the recorded id below proves nothing.
      await seedSpine(moduleId, 'A quiet harbor town.', null);
      await seedPart(moduleId, {
        planIndex: 0,
        markdown: `${PROSE}${PROSE}Legacy text names [[${VARIANT}]] and [[${CANONICAL}]].`,
        edited: true,
        origin: null,
        writerModel: 'some/model-from-before',
      });
      chatMock.mockResolvedValueOnce(foldVerdict());

      await normalizeModuleEntityNames(moduleId);

      const after = await getModule(moduleId);
      expect(after?.parts[0]?.markdown).toContain(`[[${VARIANT}]]`);
      expect(after?.entityRewriteProposals).toEqual([
        { planIndex: 0, replacements: [{ from: VARIANT, to: CANONICAL }] },
      ]);
      // The conservative default, pinned: an unrecorded origin is NEVER
      // machine-written, and a recorded model id never makes it so (there is no
      // `writerModel`-shaped input to this function at all).
      expect(textOriginIsMachineWritten(null)).toBe(false);
      expect(textOriginIsMachineWritten(undefined)).toBe(false);
      expect(textOriginIsMachineWritten('human')).toBe(false);
      expect(textOriginIsMachineWritten('model')).toBe(true);
    });

    it('holds a legacy premise too (it is not the generated one)', async () => {
      const { moduleId } = await seedModule();
      await seedSpine(moduleId, `The bell tolls for [[${VARIANT}]] and [[${CANONICAL}]].`, null);
      chatMock.mockResolvedValueOnce(foldVerdict());

      await normalizeModuleEntityNames(moduleId);

      const after = await getModule(moduleId);
      expect(after?.spine?.premise).toBe(`The bell tolls for [[${VARIANT}]] and [[${CANONICAL}]].`);
      expect(after?.entityRewriteProposals).toEqual([
        { planIndex: -1, replacements: [{ from: VARIANT, to: CANONICAL }] },
      ]);
    });

    it('an UNCHANGED approved premise keeps the model origin (clicking through the checkpoint claims nothing)', async () => {
      const { campaign, moduleId } = await seedModule();
      await seedSpine(moduleId, 'A quiet harbor town.', 'model');
      const stored = await getModule(moduleId);
      if (stored?.spine === null || stored?.spine === undefined) {
        throw new Error('seed spine missing');
      }
      await patchModule(moduleId, {
        entityKinds: [{ name: CANONICAL, kind: 'npc', absorbed: [] }],
      });
      chatMock
        .mockResolvedValueOnce({
          text: JSON.stringify({ entities: [] }),
          modelUsed: TEST_MODEL,
          fallback: null,
        })
        .mockResolvedValue(partReply([CANONICAL]));

      await approveSpineAndRun(moduleId, campaign, stored.spine);

      const after = await getModule(moduleId);
      expect(after?.spine?.origin).toBe('model');
      expect(after?.spine?.writerModel).toBe(TEST_MODEL);
    });

    it('a premise the owner REWROTE at the checkpoint is stamped human', async () => {
      const { campaign, moduleId } = await seedModule();
      await seedSpine(moduleId, 'A quiet harbor town.', 'model');
      const stored = await getModule(moduleId);
      if (stored?.spine === null || stored?.spine === undefined) {
        throw new Error('seed spine missing');
      }
      await patchModule(moduleId, {
        entityKinds: [{ name: CANONICAL, kind: 'npc', absorbed: [] }],
      });
      chatMock
        .mockResolvedValueOnce({
          text: JSON.stringify({ entities: [] }),
          modelUsed: TEST_MODEL,
          fallback: null,
        })
        .mockResolvedValue(partReply([CANONICAL]));

      await approveSpineAndRun(moduleId, campaign, {
        ...stored.spine,
        premise: 'The owner rewrote the premise himself before generating.',
      });

      const after = await getModule(moduleId);
      expect(after?.spine?.origin).toBe('human');
      // The recorded writing model is untouched: it still answers "which model
      // wrote this", and it does NOT make the text machine-written.
      expect(after?.spine?.writerModel).toBe(TEST_MODEL);
    });
  });

  describe('the stored-shape contract', () => {
    it('parses a part and a spine written before the field as `origin: null` (no Dexie version)', async () => {
      const { moduleId } = await seedModule();
      const raw = await getModule(moduleId);
      if (raw === undefined) throw new Error('seed module missing');
      // Write the PRE-FIELD shape straight into the row, exactly as a row
      // persisted before this change carries it (no `origin` key at all).
      await saveModule({
        ...raw,
        spine: {
          premise: 'A quiet harbor town.',
          themes: [],
          partPlan: [{ title: 'One', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
          writerModel: 'old/model',
        } as unknown as Module['spine'],
        parts: [
          {
            planIndex: 0,
            markdown: 'Old text.',
            status: 'ready',
            errorMessage: '',
            edited: true,
            writerModel: 'old/model',
          } as unknown as ModulePart,
        ],
      });

      const parsed = await getModule(moduleId);
      expect(parsed?.spine?.origin).toBeNull();
      expect(parsed?.parts[0]?.origin).toBeNull();
      // The conservative default applies to both.
      expect(textOriginIsMachineWritten(parsed?.spine?.origin)).toBe(false);
      expect(textOriginIsMachineWritten(parsed?.parts[0]?.origin)).toBe(false);
    });
  });
});

describe('moduleGen-floor-repair.test.ts', () => {
  /**
   * "Fix module problems" — the snapshot-scoped repair (docs/08 §M4-B-3).
   *
   * What is pinned here is BEHAVIOR, not implementation: the confirmation's scope
   * comes from the repair seam's own derivation, the rewrite carries the floor
   * repair's instruction (scoped to that one check), a durable version snapshot
   * exists before the write and restores the pre-repair text, a failing rewrite
   * fails LOUDLY and leaves the text byte-identical, and one attempt per part is
   * attempted — never a retry loop. Only the model call and the toasts are mocked.
   */

  const chatMock = vi.mocked(chat);

  const toastErrorMock = vi.mocked(toastError);
  const toastSuccessMock = vi.mocked(toastSuccess);

  const TEST_MODEL = 'test/fixture-model';

  /** The mocked chat result shape (the model is mocked, the seams are real). */
  interface ChatReply {
    text: string;
    modelUsed: string;
    fallback: null;
  }

  const PART_PLAN = [
    { title: 'The Sunken Quarter', levelBand: '1', synopsis: '', levelUpTrigger: '' },
    { title: 'The Drowned Cathedral', levelBand: '2', synopsis: '', levelUpTrigger: '' },
  ];

  /** Module prose well above the 100-char floor, with a findable marker. */
  function prose(marker: string, names: string[]): ChatReply {
    return {
      text:
        `${marker}: The tide withdraws and the streets shine wet under a pale sun. `.repeat(4) +
        `Mentioned here: ${names.map((name) => `[[${name}]]`).join(' and ')}.`,
      modelUsed: 'test-model',
      fallback: null,
    };
  }

  /** The normalization reply recording every listed name as an encounter. */
  function encounterReply(...names: string[]): ChatReply {
    return {
      text: JSON.stringify({
        entities: names.map((name) => ({ name, canonical: name, kind: 'encounter' })),
      }),
      modelUsed: 'test-model',
      fallback: null,
    };
  }

  /** A module whose part 1 names nothing (the deficient part). */
  async function seedShortModule(): Promise<{ campaign: Campaign; moduleId: Id }> {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const draft = createModule({
      campaignId: campaign.id,
      title: 'The Drowned Bell',
      concept: 'A harbor bell that rings by itself beneath the water.',
      levelMin: 1,
      levelMax: 2,
      tone: 'eerie',
      sizeDial: 'standard',
    });
    const saved = await saveModule({
      ...draft,
      status: 'failed',
      errorMessage: 'Encounter floor not met',
      entityNamesNormalized: true,
      entityKinds: [{ name: 'Bell Trial', kind: 'encounter', absorbed: [] }],
      spine: moduleSpineSchema.parse({
        premise: 'The bell rings.',
        themes: [],
        partPlan: PART_PLAN,
      }),
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          markdown: prose('PART-ONE', ['Bell Trial']).text,
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
        modulePartSchema.parse({
          planIndex: 1,
          markdown: 'PART-TWO: The drowned cathedral waits in the dark, silent and cold. '.repeat(
            4,
          ),
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
      ],
    });
    return { campaign, moduleId: saved.id };
  }

  beforeEach(async () => {
    await clearDatabase();
    chatMock.mockReset();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
    useProgressStore.getState().reset();
    await updateSettings({ defaultChatModel: TEST_MODEL });
  });

  afterEach(() => {
    chatMock.mockReset();
    useProgressStore.getState().reset();
    vi.restoreAllMocks();
  });

  describe('floorRepairTargets (the repair scope the confirmation lists)', () => {
    it('names the deficient parts, and every part when names repeat', async () => {
      const { moduleId } = await seedShortModule();

      const short = await getModule(moduleId);
      expect(short).toBeDefined();
      expect(floorRepairTargets(short ?? ({} as never)).map((entry) => entry.planIndex)).toEqual([
        1,
      ]);
    }, 20_000);
  });

  describe('repairModuleEncounterFloor', () => {
    it('rewrites only the deficient part, snapshots before the write, and returns the module to ready', async () => {
      const { campaign, moduleId } = await seedShortModule();
      const before = await getModule(moduleId);
      const originalPartTwo = before?.parts.find((part) => part.planIndex === 1)?.markdown ?? '';
      chatMock
        .mockResolvedValueOnce(prose('PART-TWO-REPAIRED', ['Flood Trial']))
        .mockResolvedValueOnce(encounterReply('Bell Trial', 'Flood Trial'));

      const outcome = await repairModuleEncounterFloor(moduleId, campaign, [1]);

      expect(outcome.attempted.map((entry) => entry.planIndex)).toEqual([1]);
      expect(outcome.rewritten.map((entry) => entry.planIndex)).toEqual([1]);
      expect(outcome.failed).toEqual([]);
      expect(outcome.skipped).toEqual([]);
      expect(outcome.met).toBe(true);
      expect(outcome.stopped).toBe(false);
      const after = await getModule(moduleId);
      expect(after?.parts.find((part) => part.planIndex === 1)?.markdown).toContain(
        'PART-TWO-REPAIRED',
      );
      // Part 1 was NOT touched (the rewrite is scoped to the failing check's part).
      expect(after?.parts.find((part) => part.planIndex === 0)?.markdown).toContain('PART-ONE');
      expect(after?.status).toBe('ready');
      expect(after?.errorMessage).toBe('');
      // The instruction is the floor repair's own — scoped to that check.
      const repairPrompt = userMessagesOf(0).join('\n');
      expect(repairPrompt).toContain('Encounter floor repair');
      expect(repairPrompt).toContain('keep the part');
      // One model call for the rewrite + one for the existing normalization pass
      // (the new encounter has no recorded kind until it runs) — and NO retry.
      expect(chatMock).toHaveBeenCalledTimes(2);
      expect(toastErrorMock).not.toHaveBeenCalled();
      expect(toastSuccessMock).toHaveBeenCalledWith(
        expect.stringContaining('Fixed the encounter floor'),
      );
      expect(originalPartTwo).not.toContain('PART-TWO-REPAIRED');
    }, 30_000);

    it('takes a durable snapshot BEFORE the write, and restoring it brings the pre-repair text back', async () => {
      const { campaign, moduleId } = await seedShortModule();
      const before = await getModule(moduleId);
      const preRepairDoc = assembleModulePartsDocument({
        partPlan: before?.spine?.partPlan ?? [],
        parts: before?.parts ?? [],
      }).document;
      chatMock
        .mockResolvedValueOnce(prose('PART-TWO-REPAIRED', ['Flood Trial']))
        .mockResolvedValueOnce(encounterReply('Bell Trial', 'Flood Trial'));

      await repairModuleEncounterFloor(moduleId, campaign, [1]);

      const versions = await listModuleVersions(moduleId);
      const repairVersion = versions.find((version) =>
        version.label.includes('Fix module problems'),
      );
      expect(repairVersion?.source).toBe('generation');
      // Byte-exact pre-change document, in the ONE parts-document format — the
      // same seam the Versions menu restores from.
      expect(repairVersion?.docText).toBe(preRepairDoc);
      expect(repairVersion?.docText).toContain('PART-TWO: The drowned cathedral');
      // The snapshot is the PRE-state: the repair's result is not in it.
      expect(repairVersion?.docText).not.toContain('PART-TWO-REPAIRED');
      // The name-normalization pass took its own snapshot, exactly as it does
      // inside every parts pass (it is a separate AI change of the same doc).
      expect(versions.map((version) => version.source)).toContain('normalization');
    }, 30_000);

    it('fails LOUDLY and writes nothing when the rewrite call fails', async () => {
      const { campaign, moduleId } = await seedShortModule();
      const before = await getModule(moduleId);
      const preRepair = before?.parts.find((part) => part.planIndex === 1);
      chatMock.mockRejectedValueOnce(new Error('provider exploded mid-rewrite'));

      const outcome = await repairModuleEncounterFloor(moduleId, campaign, [1]);

      expect(outcome.failed.map((entry) => entry.planIndex)).toEqual([1]);
      expect(outcome.rewritten).toEqual([]);
      expect(outcome.met).toBe(false);
      expect(outcome.remaining.map((entry) => entry.planIndex)).toEqual([1]);
      const after = await getModule(moduleId);
      const part = after?.parts.find((entry) => entry.planIndex === 1);
      // The pre-repair prose is back, byte-identical, with its own status.
      expect(part?.markdown).toBe(preRepair?.markdown);
      expect(part?.status).toBe('ready');
      expect(part?.errorMessage).toBe('');
      // The module is left failed with the floor's own verdict named loudly.
      expect(after?.status).toBe('failed');
      const failedToast = toastErrorMock.mock.calls.find((call) =>
        call[0].includes('could not be rewritten'),
      );
      expect(failedToast).toBeDefined();
      expect(failedToast?.[0]).toContain('their text was left as it was');
      expect(toastErrorMock).toHaveBeenCalledWith(
        'The module still falls short of its encounter floor',
        expect.any(Error),
      );
      // ONE attempt: no retry, and the normalization pass never ran (nothing was
      // rewritten).
      expect(chatMock).toHaveBeenCalledTimes(1);
    }, 30_000);

    it('reports a still-short floor loudly after the attempt, keeping what was written', async () => {
      const { campaign, moduleId } = await seedShortModule();
      // The rewrite lands prose that still names no encounter.
      chatMock
        .mockResolvedValueOnce({
          text: 'PART-TWO-REPAIRED: still no fight here, only fog and waiting. '.repeat(4),
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce(encounterReply('Bell Trial'));

      const outcome = await repairModuleEncounterFloor(moduleId, campaign, [1]);

      expect(outcome.met).toBe(false);
      expect(outcome.rewritten.map((entry) => entry.planIndex)).toEqual([1]);
      expect(outcome.remaining.map((entry) => entry.planIndex)).toEqual([1]);
      const after = await getModule(moduleId);
      expect(after?.status).toBe('failed');
      expect(after?.errorMessage).toContain('Encounter floor not met');
      // The rewrite is NOT rolled back (the version snapshot is the undo) — but
      // the failure is loud and names the one-attempt bound.
      expect(after?.parts.find((part) => part.planIndex === 1)?.markdown).toContain(
        'PART-TWO-REPAIRED',
      );
      const loud = toastErrorMock.mock.calls.find(
        (call) => call[0] === 'The module still falls short of its encounter floor',
      );
      expect(loud).toBeDefined();
      expect((loud?.[1] as Error).message).toContain('One rewrite attempt per part was made');
      expect(toastSuccessMock).not.toHaveBeenCalled();
    }, 30_000);

    it('skips a part that is no longer short (the text changed while the confirmation was open)', async () => {
      const { campaign, moduleId } = await seedShortModule();
      // The owner fixed part 1 by hand (the one part-text save path stamps
      // `ready`) and the module is no longer short of anything.
      await patchModule(moduleId, {
        status: 'ready',
        errorMessage: '',
        entityKinds: [
          { name: 'Bell Trial', kind: 'encounter', absorbed: [] },
          { name: 'Flood Trial', kind: 'encounter', absorbed: [] },
        ],
        parts: [
          modulePartSchema.parse({
            planIndex: 0,
            markdown: prose('PART-ONE', ['Bell Trial']).text,
            status: 'ready',
            errorMessage: '',
            edited: false,
          }),
          modulePartSchema.parse({
            planIndex: 1,
            markdown: prose('PART-TWO', ['Flood Trial']).text,
            status: 'ready',
            errorMessage: '',
            edited: true,
          }),
        ],
      });

      const beforeCall = await getModule(moduleId);
      const outcome = await repairModuleEncounterFloor(moduleId, campaign, [1]);

      expect(outcome.attempted).toEqual([]);
      expect(outcome.skipped.map((entry) => entry.planIndex)).toEqual([1]);
      expect(outcome.met).toBe(true);
      // No model call, no rewrite, no snapshot of a change that never happened,
      // and not one byte written to the row.
      expect(chatMock).not.toHaveBeenCalled();
      expect(await listModuleVersions(moduleId)).toHaveLength(0);
      const after = await getModule(moduleId);
      expect(after?.parts.find((part) => part.planIndex === 1)?.markdown).toContain('PART-TWO');
      expect(after?.status).toBe('ready');
      // Not one write: the row is untouched, timestamp included.
      expect(after?.updatedAt).toBe(beforeCall?.updatedAt);
    }, 30_000);

    it('stops between parts when a Stop all lands, and writes nothing further', async () => {
      const { campaign, moduleId } = await seedShortModule();
      // The first rewrite itself trips the stop (the owner pressing Stop all
      // while the model is writing): the run must not start the next part.
      chatMock.mockImplementationOnce(() => {
        bumpStopEpoch();
        return Promise.resolve(prose('PART-TWO-REPAIRED', ['Flood Trial']));
      });
      // A second part is requested too, so "did not start its next unit" is real.
      await patchModule(moduleId, {
        spine: moduleSpineSchema.parse({
          premise: 'The bell rings.',
          themes: [],
          partPlan: [
            ...PART_PLAN,
            { title: 'The Bell Tower', levelBand: '2', synopsis: '', levelUpTrigger: '' },
          ],
        }),
      });

      const outcome = await repairModuleEncounterFloor(moduleId, campaign, [1, 2]);

      expect(outcome.stopped).toBe(true);
      expect(outcome.attempted.map((entry) => entry.planIndex)).toEqual([1]);
      expect(chatMock).toHaveBeenCalledTimes(1);
      // A stopped run reaches no verdict about the text: the row keeps the status
      // it had at entry.
      const after = await getModule(moduleId);
      expect(after?.status).toBe('failed');
      expect(after?.errorMessage).toBe('Encounter floor not met');
      expect(toastErrorMock).not.toHaveBeenCalled();
    }, 30_000);

    it('refuses a second run while this module already has one in flight', async () => {
      const { campaign, moduleId } = await seedShortModule();
      let release: (() => void) | undefined;
      chatMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => {
              resolve(prose('PART-TWO-REPAIRED', ['Flood Trial']));
            };
          }),
      );
      chatMock.mockResolvedValueOnce(encounterReply('Bell Trial', 'Flood Trial'));

      const first = repairModuleEncounterFloor(moduleId, campaign, [1]);
      await waitFor(() => {
        expect(chatMock).toHaveBeenCalledTimes(1);
      });

      await expect(repairModuleEncounterFloor(moduleId, campaign, [1])).rejects.toBeInstanceOf(
        ModuleBusyError,
      );

      release?.();
      const outcome = await first;
      expect(outcome.met).toBe(true);
    }, 30_000);

    it('is a no-op for an empty request', async () => {
      const { campaign, moduleId } = await seedShortModule();

      const outcome = await repairModuleEncounterFloor(moduleId, campaign, []);

      expect(outcome).toEqual({
        attempted: [],
        rewritten: [],
        failed: [],
        skipped: [],
        remaining: [],
        met: false,
        stopped: false,
      });
      expect(chatMock).not.toHaveBeenCalled();
    }, 20_000);
  });

  /** The user-message text of the Nth chat call (the prompt is the behavior). */
  function userMessagesOf(index: number): string[] {
    const call = chatMock.mock.calls[index];
    if (call === undefined) return [];
    return call[0].map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'),
    );
  }
});

describe('moduleGen-party-exclusion.test.ts', () => {
  /**
   * The Party is invisible to module creation (owner-ratified rule, docs/17 row
   * 69, verbatim: "The creator is referring to players in the party. The party
   * should not be visible to module creation.").
   *
   * `campaignCastContext` used to list every campaign-scoped row — PCs ARE
   * campaign-scoped by definition — so the spine and parts prompts told the
   * model to REUSE the players' characters. The exclusion is ONE domain
   * constant (`MODULE_CREATION_EXCLUDED_KINDS` → `visibleToModuleCreation` /
   * `moduleCreationPool`), never a scattered `kind !== 'pc'`.
   *
   * This file pins BOTH halves: the Party is gone from every module-creation
   * list, and the reuse feature (the whole point of the cast block) survives.
   */

  const chatMock = vi.mocked(chat);

  const toastErrorMock = vi.mocked(toastError);

  const TEST_MODEL = 'test/fixture-model';

  /** The players' characters — the two names module creation must never see. */
  const PC_NAME = 'Kael Ashbound';
  const SECOND_PC_NAME = 'Mira Vane';
  /** The owner's own setting prose: it MAY name the party (boundary, docs/17 row 69). */
  const CAMPAIGN_DESCRIPTION =
    'Kael and Mira are hunting whatever rings the submerged bell on the flood tide.';

  /** A campaign-scoped entity the reuse feature exists for. */
  const SHARED_NPC = 'Bell Warden Ilse';
  /** A module-owned row: never in the campaign cast (moduleId is set). */
  const OWNED_NPC = 'Owned Cave Sage';

  const SPINE_ENTITIES = [
    { name: SHARED_NPC, kind: 'npc' },
    { name: 'The Ringing Below', kind: 'encounter' },
    { name: 'The Flooded Stair', kind: 'encounter' },
    { name: 'The Wardens Confession', kind: 'encounter' },
  ] as const;

  const SPINE_REPLY = {
    premise: 'The bell rings beneath the harbor and nobody admits to ringing it.',
    themes: ['duty'],
    partPlan: [
      {
        title: 'The Sunken Quarter',
        levelBand: '1',
        synopsis: 'The party arrives on the low tide and finds the first bodies.',
        levelUpTrigger: 'The bell is found.',
      },
    ],
    entities: SPINE_ENTITIES,
  };

  const SELF_NORMALIZATION = {
    entities: SPINE_ENTITIES.map((entity) => ({
      name: entity.name,
      canonical: entity.name,
      kind: entity.kind,
    })),
  };

  const PART_TEXT =
    'The tide pulls back and the bell answers. [[The Ringing Below]] waits under the nave. ' +
    'Lanterns gutter along the flooded stair while the water climbs another step. '.repeat(3);

  function partReply(): ChatResult {
    return { text: PART_TEXT, modelUsed: 'test-model', fallback: null };
  }

  /** The post-parts pass answers every wiki-link name of the module text. */
  function partNormalizationReply(): ChatResult {
    return {
      text: JSON.stringify({
        entities: [
          {
            name: 'The Ringing Below',
            canonical: 'The Ringing Below',
            kind: 'encounter',
          },
        ],
      }),
      modelUsed: 'test-model',
      fallback: null,
    };
  }

  async function seedWorld(): Promise<{ campaign: Campaign; moduleId: Id }> {
    const campaign = await createCampaign({
      name: 'Bellweather',
      system: 'dnd5e',
      description: CAMPAIGN_DESCRIPTION,
    });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: SHARED_NPC });
    await createArtifact({ campaignId: campaign.id, kind: 'pc', name: PC_NAME });
    await createArtifact({ campaignId: campaign.id, kind: 'pc', name: SECOND_PC_NAME });
    const owned = createModule({
      campaignId: campaign.id,
      title: 'An Earlier Module',
      concept: 'earlier',
      levelMin: 1,
      levelMax: 1,
      sizeDial: 'standard',
    });
    await saveModule(owned);
    await createArtifact({
      campaignId: campaign.id,
      moduleId: owned.id,
      kind: 'npc',
      name: OWNED_NPC,
    });
    const draft = createModule({
      campaignId: campaign.id,
      title: 'The Drowned Bell',
      concept: 'A harbor bell that rings by itself beneath the water.',
      levelMin: 1,
      levelMax: 1,
      sizeDial: 'standard',
      includePriorModules: true,
    });
    const saved = await saveModule(draft);
    await updateSettings({ defaultChatModel: TEST_MODEL });
    return { campaign, moduleId: saved.id };
  }

  /** The user prompt of the chat call whose text contains `marker`. */
  function promptContaining(marker: string): string {
    for (const [messages] of chatMock.mock.calls) {
      const user = messages.find(
        (message) => message.role === 'user' && typeof message.content === 'string',
      );
      const text = typeof user?.content === 'string' ? user.content : '';
      if (text.includes(marker)) return text;
    }
    throw new Error(`no chat call carried "${marker}"`);
  }

  /**
   * The artifact lines of a normalization prompt's "Existing campaign artifacts"
   * index. The whole prompt also carries the names being classified (they are
   * the module's own text), so the exclusion has to be read off the INDEX — the
   * list of entities the model is told a name may refer to.
   */
  function artifactIndexOf(prompt: string): string[] {
    const marker =
      'Existing campaign artifacts (a name matching one of these refers to that artifact):\n';
    const start = prompt.indexOf(marker);
    if (start === -1) throw new Error('the prompt carries no artifact index');
    const rest = prompt.slice(start + marker.length);
    return (rest.split('\n\n')[0] ?? '').split('\n');
  }

  beforeEach(async () => {
    await clearDatabase();
    chatMock.mockReset();
  });

  describe('the module-creation pool', () => {
    it('keeps every kind except the Party — the one domain constant is the only exclusion', () => {
      expect(MODULE_CREATION_EXCLUDED_KINDS).toEqual(['pc']);
      const pc = { name: PC_NAME, kind: 'pc', moduleId: null } as never;
      const npc = { name: SHARED_NPC, kind: 'npc', moduleId: null } as never;
      expect(visibleToModuleCreation(pc)).toBe(false);
      expect(visibleToModuleCreation(npc)).toBe(true);
      expect(moduleCreationPool([pc, npc])).toEqual([npc]);
    });
  });

  describe('campaignCastContext', () => {
    it('drops the Party and keeps the campaign-scoped rows the cast block exists for', async () => {
      const { campaign } = await seedWorld();
      const { listArtifactsByCampaign } = await import('@/db/artifactRepo');

      const cast = campaignCastContext(await listArtifactsByCampaign(campaign.id));

      expect(cast).toContain(`${SHARED_NPC} (npc)`);
      expect(cast).not.toContain(PC_NAME);
      expect(cast).not.toContain(SECOND_PC_NAME);
      // Module-owned rows were never in the campaign cast.
      expect(cast).not.toContain(OWNED_NPC);
    });

    it('is null when the campaign has nothing but the Party', () => {
      const cast = campaignCastContext([
        { name: PC_NAME, kind: 'pc', moduleId: null } as never,
        { name: SECOND_PC_NAME, kind: 'pc', moduleId: null } as never,
      ]);

      expect(cast).toBeNull();
    });
  });

  describe('rendered module-creation prompts', () => {
    it('the spine request carries no party member, and still reuses shared campaign names', async () => {
      const { campaign, moduleId } = await seedWorld();
      chatMock
        .mockResolvedValueOnce({
          text: JSON.stringify(SPINE_REPLY),
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce({
          text: JSON.stringify(SELF_NORMALIZATION),
          modelUsed: 'test-model',
          fallback: null,
        });

      await runSpine(moduleId, campaign);

      const spine = promptContaining('Design the module spine');
      // The Party is invisible in BOTH lists the spine request carries.
      expect(spine).toContain('Existing campaign entities');
      expect(spine).toContain(`${SHARED_NPC} (npc)`);
      expect(spine).toContain('Shared campaign cast');
      expect(spine).not.toContain(PC_NAME);
      expect(spine).not.toContain(SECOND_PC_NAME);
      expect(spine).not.toContain('(pc)');
      // Boundary: the owner's own setting prose is untouched — it MAY name the party.
      expect(spine).toContain(CAMPAIGN_DESCRIPTION);
    }, 30000);

    it('the parts request carries no party member, and still reuses shared campaign names', async () => {
      const { campaign, moduleId } = await seedWorld();
      chatMock
        .mockResolvedValueOnce({
          text: JSON.stringify(SPINE_REPLY),
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce({
          text: JSON.stringify(SELF_NORMALIZATION),
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce(partReply())
        .mockResolvedValueOnce(partNormalizationReply());

      await runSpine(moduleId, campaign);
      await runParts(moduleId, campaign);

      const part = promptContaining('Write part 1');
      expect(part).toContain('Existing campaign entities');
      expect(part).toContain(`${SHARED_NPC} (npc)`);
      expect(part).toContain('Shared campaign cast');
      expect(part).not.toContain(PC_NAME);
      expect(part).not.toContain(SECOND_PC_NAME);
      expect(part).not.toContain('(pc)');
      expect(part).toContain(CAMPAIGN_DESCRIPTION);
    }, 30000);
  });

  describe('party-derived context that must not regress', () => {
    it('keeps the encounter LEVEL line — encounter difficulty is about levels, not players', () => {
      expect(partyLevelLine(3)).toBe(`Party of ${String(PARTY_SIZE)} adventurers at level 3.`);
      expect(buildEntityBrief('The Ringing Below', 'scene', 'premise', 3, [])).toContain(
        'Party of 4 adventurers at level 3.',
      );
    });

    it('keeps the fixed cast npc-only — a party member named in the scene is not cast', async () => {
      const pool = [
        {
          id: 'pc-1',
          campaignId: 'campaign-1',
          moduleId: null,
          kind: 'pc',
          name: PC_NAME,
          aliases: [],
          updatedAt: 2,
          data: {},
        },
        {
          id: 'npc-1',
          campaignId: 'campaign-1',
          moduleId: null,
          kind: 'npc',
          name: SHARED_NPC,
          aliases: [],
          updatedAt: 1,
          data: { statBlock: null },
        },
      ] as never;

      const cast = await fixedCastForEncounter(
        'The Ringing Below',
        `[[${PC_NAME}]] argues with [[${SHARED_NPC}]] beside the bell.`,
        pool,
        null,
      );

      expect(cast.map((member) => member.name)).toEqual([SHARED_NPC]);
    });

    it('keeps the module chat grounding on the owner prose + prior modules', () => {
      const block = renderChatGrounding({
        campaignName: 'Bellweather',
        campaignDescription: CAMPAIGN_DESCRIPTION,
        systemLabel: 'D&D 5e',
        priorModules: [
          {
            title: 'An Earlier Module',
            premise: 'The first module premise.',
            parts: [{ label: '[Part 1 of 1 — Old]', markdown: 'Old part text.' }],
          },
        ],
      });

      expect(block).toContain(CAMPAIGN_DESCRIPTION);
      expect(block).toContain('Previous modules of this campaign');
      expect(block).toContain('Old part text.');
    });
  });

  /** A normalized module whose text mentions the given wiki-link names. */
  async function seedNormalizedModule(moduleId: Id, names: readonly string[]): Promise<void> {
    const links = names.map((name) => `[[${name}]]`).join(' and ');
    await patchModule(moduleId, {
      status: 'ready',
      entityNamesNormalized: true,
      entityKinds: [],
      entityRewriteProposals: null,
      spine: moduleSpineSchema.parse({
        premise: 'The bell rings beneath the harbor and nobody admits to ringing it.',
        themes: [],
        partPlan: [
          { title: 'The Sunken Quarter', levelBand: '1', synopsis: '', levelUpTrigger: '' },
        ],
      }),
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          markdown: `The tide pulls back and ${links} wait under the flooded nave, counting the steps down.`,
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
      ],
    });
  }

  describe('name classification never resolves onto the Party', () => {
    it('an incremental run classifies a PC-named mention instead of treating it as resolved', async () => {
      const { campaign, moduleId } = await seedWorld();
      await seedNormalizedModule(moduleId, [PC_NAME]);
      chatMock.mockResolvedValueOnce({
        text: JSON.stringify({
          entities: [{ name: PC_NAME, canonical: PC_NAME, kind: 'npc' }],
        }),
        modelUsed: 'test-model',
        fallback: null,
      });

      const report = await classifyNewModuleEntityNames(moduleId);

      // Before the exclusion this name resolved to the PC artifact, so the run
      // had nothing to classify and no record was ever written for it.
      expect(report).toEqual({ classified: [PC_NAME], failed: false });
      const row = await getModule(moduleId);
      expect(row?.entityKinds.map((entry) => `${entry.name}:${entry.kind}`)).toEqual([
        `${PC_NAME}:npc`,
      ]);
      // The candidate list the model saw carried no party member.
      expect(artifactIndexOf(promptContaining('Existing campaign artifacts'))).not.toContain(
        PC_NAME,
      );
      // What happened instead: a NEW module-owned entity record. The player's
      // character is untouched — no alias, no revision.
      const { listArtifactsByCampaign } = await import('@/db/artifactRepo');
      const pc = (await listArtifactsByCampaign(campaign.id)).find(
        (artifact) => artifact.kind === 'pc' && artifact.name === PC_NAME,
      );
      expect(pc?.aliases).toEqual([]);
      expect(pc?.currentRevision).toBe(1);
      expect(pc?.moduleId).toBeNull();
    }, 30000);

    it('the full pass keeps the Party out of its artifact index and records the name as its own entity', async () => {
      const { campaign, moduleId } = await seedWorld();
      await seedNormalizedModule(moduleId, [PC_NAME]);
      chatMock.mockResolvedValueOnce({
        text: JSON.stringify({
          entities: [{ name: PC_NAME, canonical: PC_NAME, kind: 'npc' }],
        }),
        modelUsed: 'test-model',
        fallback: null,
      });

      await normalizeModuleEntityNames(moduleId);

      const index = artifactIndexOf(promptContaining('Existing campaign artifacts'));
      expect(index).toContain(SHARED_NPC);
      expect(index).not.toContain(PC_NAME);
      const row = await getModule(moduleId);
      expect(row?.entityNamesNormalized).toBe(true);
      expect(row?.entityKinds.map((entry) => entry.name)).toContain(PC_NAME);
      expect(row?.entityRewriteProposals).toBeNull();
      const { listArtifactsByCampaign } = await import('@/db/artifactRepo');
      const pc = (await listArtifactsByCampaign(campaign.id)).find(
        (artifact) => artifact.kind === 'pc' && artifact.name === PC_NAME,
      );
      expect(pc?.aliases).toEqual([]);
    }, 30000);

    it('a verdict that tries to fold a name onto a party member fails LOUDLY, writing no alias', async () => {
      const { campaign, moduleId } = await seedWorld();
      await seedNormalizedModule(moduleId, ['Serren']);
      // The PC's full name is not in the module text: this verdict tries to make
      // the player's character the canonical target — the pre-exclusion behavior
      // accepted it (the name was an artifact), added the alias and rewrote the
      // link onto the party.
      const foldOntoPc = {
        text: JSON.stringify({
          entities: [{ name: 'Serren', canonical: SECOND_PC_NAME, kind: 'npc' }],
        }),
        modelUsed: 'test-model',
        fallback: null,
      };
      chatMock.mockResolvedValue(foldOntoPc);

      const report = await classifyNewModuleEntityNames(moduleId);

      expect(report).toEqual({ classified: [], failed: true });
      // Two calls: the verdict + the one stated repair retry — then the loud
      // failure path the repo already has (recorded on the row + toasted).
      expect(chatMock).toHaveBeenCalledTimes(2);
      const row = await getModule(moduleId);
      expect(row?.entityNamesNormalized).toBe(false);
      expect(row?.entityNormalizationError).not.toBe('');
      expect(row?.entityKinds).toEqual([]);
      expect(toastErrorMock).toHaveBeenCalled();
      const { listArtifactsByCampaign } = await import('@/db/artifactRepo');
      const pc = (await listArtifactsByCampaign(campaign.id)).find(
        (artifact) => artifact.name === SECOND_PC_NAME,
      );
      expect(pc?.aliases).toEqual([]);
    }, 30000);
  });
});

describe('moduleGen-rewrite-context.test.ts', () => {
  /**
   * The per-run prior-modules override (08-MODULE-DESIGNER §Module canvas):
   * the canvas rewrite dialog can turn the continuity context on or off for
   * ONE run without touching the module row's `includePriorModules` flag. The
   * context itself is the engine's verbatim `priorModulesContext` (caps 4k/8k/
   * 24k untouched); only the flag's source gains a per-run override.
   */

  const chatMock = vi.mocked(chat);

  const TEST_MODEL = 'test/fixture-model';

  function partReply(): ChatResult {
    return {
      text:
        'The ambush springs at the ford. The party fights through. '.repeat(6) +
        ' Trials faced: [[Ember Ambush]].',
      modelUsed: 'test-model',
      fallback: null,
    };
  }

  function normReply(): ChatResult {
    return {
      text: JSON.stringify({
        entities: [
          {
            name: 'Ember Ambush',
            canonical: 'Ember Ambush',
            kind: 'encounter',
          },
        ],
      }),
      modelUsed: 'test-model',
      fallback: null,
    };
  }

  async function seedWorld(): Promise<{ campaign: Campaign; targetId: Id; priorId: Id }> {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const priorDraft = createModule({
      campaignId: campaign.id,
      title: 'The Earlier Module',
      concept: 'earlier',
      levelMin: 1,
      levelMax: 2,
      sizeDial: 'standard',
    });
    const prior = await saveModule({
      ...priorDraft,
      spine: moduleSpineSchema.parse({
        premise: 'The prior module premise with [[Ember Ambush]] history.',
        themes: [],
        partPlan: [{ title: 'Old', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
      }),
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          markdown: 'The prior part text that continuity context must carry.',
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
      ],
    });
    const targetDraft = createModule({
      campaignId: campaign.id,
      title: 'The Target',
      concept: 'target',
      levelMin: 1,
      levelMax: 2,
      sizeDial: 'standard',
      includePriorModules: false,
    });
    const target = await saveModule({
      ...targetDraft,
      spine: moduleSpineSchema.parse({
        premise: 'The target premise.',
        themes: [],
        // TWO plan entries: a subset run [0] stays a subset (bands only) and
        // never owns the whole-module floor total or the declared mix.
        partPlan: [
          { title: 'First', levelBand: '1', synopsis: '', levelUpTrigger: '' },
          { title: 'Second', levelBand: '2', synopsis: '', levelUpTrigger: '' },
        ],
      }),
      parts: [],
    });
    await updateDefaultModel();
    return { campaign, targetId: target.id, priorId: prior.id };
  }

  async function updateDefaultModel(): Promise<void> {
    const { updateSettings } = await import('@/db/settingsRepo');
    await updateSettings({ defaultChatModel: TEST_MODEL });
  }

  async function seedReadyPart(moduleId: Id): Promise<void> {
    await patchModule(moduleId, {
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          markdown: 'Old ready text. '.repeat(20),
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
      ],
    });
  }

  function partCallText(): string {
    const call = chatMock.mock.calls.find((messages) =>
      messages[0].some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('Write part'),
      ),
    );
    if (call === undefined) throw new Error('no part call made');
    const user = call[0].find((message) => message.role === 'user');
    return typeof user?.content === 'string' ? user.content : '';
  }

  beforeEach(async () => {
    await clearDatabase();
    chatMock.mockReset();
  });

  describe('prior-modules per-run override', () => {
    it('includePriorModules: true on the run includes prior context while the row flag stays false', async () => {
      const { campaign, targetId } = await seedWorld();
      await seedReadyPart(targetId);
      chatMock.mockResolvedValueOnce(partReply()).mockResolvedValueOnce(normReply());

      await runParts(targetId, campaign, { planIndexes: [0], includePriorModules: true });

      expect(partCallText()).toContain('Previous modules of this campaign');
      // The run lands ready: the subset owns its band only (part 1 is out of
      // scope), and the declared encounter satisfies band 1.
      const row = await getModule(targetId);
      if (row?.status !== 'ready') {
        throw new Error(`status=${String(row?.status)} error=${row?.errorMessage}`);
      }
      // The ROW is untouched by the override.
      expect(row.includePriorModules).toBe(false);
    }, 30000);

    it('includePriorModules: false on the run omits prior context even when the row flag is on', async () => {
      const { campaign, targetId, priorId } = await seedWorld();
      await patchModule(targetId, { includePriorModules: true });
      void priorId;
      await seedReadyPart(targetId);
      chatMock.mockResolvedValueOnce(partReply()).mockResolvedValueOnce(normReply());

      await runParts(targetId, campaign, { planIndexes: [0], includePriorModules: false });

      expect(partCallText()).not.toContain('Previous modules of this campaign');
      expect((await getModule(targetId))?.includePriorModules).toBe(true);
    }, 30000);

    it('no override reads the row flag (subset rewrite default — byte-for-byte)', async () => {
      const { campaign, targetId } = await seedWorld();
      await patchModule(targetId, { includePriorModules: true });
      await seedReadyPart(targetId);
      chatMock.mockResolvedValueOnce(partReply()).mockResolvedValueOnce(normReply());

      await runParts(targetId, campaign, { planIndexes: [0] });

      expect(partCallText()).toContain('Previous modules of this campaign');
    }, 30000);
  });
});

describe('moduleGenReconcile.test.ts', () => {
  /**
   * Interrupted module-generation reconciliation (docs/17 row 110, docs/18 §2.2).
   *
   * The launched defect: a module row left at `status: 'generating'` by a
   * reloaded/discarded tab had NO reconciliation anywhere — a permanent spinner,
   * a Stop button that was a silent no-op, every retry affordance gated on
   * `!busy`, and "Stop all generations" counting the dead row as stopped. The
   * status is a LEASE, so the fix is a liveness guard plus a LOUD failed state
   * whose part slots rewind, which is what re-opens the EXISTING recovery path.
   *
   * Both guard directions are pinned: a row with a live pass in THIS page is
   * never touched, and a row whose generation lock another tab holds is never
   * touched either.
   */

  const chatMock = vi.mocked(chat);

  const toastErrorMock = vi.mocked(toastError);

  const PART_ZERO_TEXT = 'The party reaches the [[Flooded Crypt]] and bargains.';

  const SPINE = moduleSpineSchema.parse({
    premise: 'A drowned vault under the mill.',
    themes: ['bargains'],
    partPlan: [
      { title: 'The Mill', levelBand: '1', synopsis: 'Arrival.', levelUpTrigger: 'Opened.' },
      { title: 'The Vault', levelBand: '2', synopsis: 'Descent.', levelUpTrigger: 'Answered.' },
    ],
  });

  /** A module whose LAST part is mid-write and whose first part is finished. */
  async function seedInterruptedModule(): Promise<{ campaign: Campaign; moduleId: Id }> {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const draft = createModule({
      campaignId: campaign.id,
      title: 'The Drowned Vault',
      concept: 'A vault under the mill.',
      levelMin: 1,
      levelMax: 2,
      tone: '',
      sizeDial: 'sketch',
    });
    const saved = await saveModule({
      ...draft,
      status: 'generating',
      spine: SPINE,
      entityKinds: [
        { name: 'Flooded Crypt', kind: 'encounter', absorbed: [] },
        { name: 'Sunken Trial', kind: 'encounter', absorbed: [] },
      ],
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          markdown: PART_ZERO_TEXT,
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
        modulePartSchema.parse({
          planIndex: 1,
          markdown: '',
          status: 'generating',
          errorMessage: '',
          edited: false,
        }),
      ],
    });
    return { campaign, moduleId: saved.id };
  }

  /** Holds a chat call open until its abort signal fires (the stop-all recipe). */
  function holdUntilAborted(_messages: unknown, opts: unknown): Promise<never> {
    const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
    if (signal === undefined) return Promise.reject(new Error('no abort signal passed'));
    if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
  }

  beforeEach(async () => {
    await clearDatabase();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('reconcileInterruptedModuleGen', () => {
    it('fails an unclaimed generating row LOUDLY and rewinds only its unfinished part slots', async () => {
      const { moduleId } = await seedInterruptedModule();

      expect(await reconcileInterruptedModuleGen(moduleId)).toBe(true);

      const row = await getModule(moduleId);
      expect(row?.status).toBe('failed');
      expect(row?.errorMessage).toBe(INTERRUPTED_MODULE_GEN_MESSAGE);
      // The named sentence says what happened AND which control recovers.
      expect(row?.errorMessage).toContain('"Resume module generation"');
      // The slot that was mid-write is back to 'pending' — the status
      // `generateMissingParts` re-runs; the finished part is untouched.
      const zero = row?.parts.find((part) => part.planIndex === 0);
      const one = row?.parts.find((part) => part.planIndex === 1);
      expect(zero?.status).toBe('ready');
      expect(zero?.markdown).toBe(PART_ZERO_TEXT);
      expect(one?.status).toBe('pending');
      expect(one?.errorMessage).toBe('');
    });

    it('is idempotent: a second pass writes nothing at all', async () => {
      const { moduleId } = await seedInterruptedModule();
      expect(await reconcileInterruptedModuleGen(moduleId)).toBe(true);
      const after = await getModule(moduleId);

      expect(await reconcileInterruptedModuleGen(moduleId)).toBe(false);

      expect(await getModule(moduleId)).toEqual(after);
    });

    it('never touches a module a live parts pass owns in THIS page (the guard)', async () => {
      const { campaign, moduleId } = await seedInterruptedModule();
      chatMock.mockImplementation(holdUntilAborted);
      // A REAL held pass: `runParts` registers the controller, marks the module
      // 'generating' and parks in the model call.
      void runParts(moduleId, campaign, { planIndexes: [1] }).catch(() => undefined);
      await vi.waitFor(() => {
        expect(hasLiveModuleGen(moduleId)).toBe(true);
      });
      const live = await getModule(moduleId);
      expect(live?.status).toBe('generating');

      expect(await reconcileInterruptedModuleGen(moduleId)).toBe(false);
      expect(await reconcileInterruptedModuleGens()).toEqual([]);
      expect(toastErrorMock).not.toHaveBeenCalled();

      const still = await getModule(moduleId);
      expect(still?.status).toBe('generating');
      expect(still?.errorMessage).not.toBe(INTERRUPTED_MODULE_GEN_MESSAGE);
      expect(still?.parts.find((part) => part.planIndex === 1)?.status).toBe('generating');
    }, 30_000);

    it('never touches a module another tab is generating (the held generation lock)', async () => {
      const { moduleId } = await seedInterruptedModule();
      const held: { name: string }[] = [{ name: moduleGenLockName(moduleId) }];
      vi.stubGlobal('navigator', {
        locks: {
          request: (_name: string, _options: unknown, callback: () => Promise<unknown>) =>
            callback(),
          query: () => Promise.resolve({ held, pending: [] }),
        },
      });
      expect(hasLiveModuleGen(moduleId)).toBe(false);

      expect(await reconcileInterruptedModuleGen(moduleId)).toBe(false);
      expect((await getModule(moduleId))?.status).toBe('generating');

      // …and with the lock released the very same row IS reconciled: the lock is
      // the only reason it survived.
      held.length = 0;
      expect(await reconcileInterruptedModuleGen(moduleId)).toBe(true);
      expect((await getModule(moduleId))?.status).toBe('failed');
    });

    it('reports a batch loudly, and stays silent when asked to', async () => {
      const first = await seedInterruptedModule();
      const second = await seedInterruptedModule();

      const reconciled = await reconcileInterruptedModuleGens();
      expect(reconciled.sort()).toEqual([first.moduleId, second.moduleId].sort());
      expect(toastErrorMock).toHaveBeenCalledTimes(1);
      expect(String(toastErrorMock.mock.calls[0]?.[0])).toContain(
        'Interrupted 2 module generations',
      );

      toastErrorMock.mockClear();
      await patchModule(first.moduleId, { status: 'generating' });
      const quiet = await reconcileInterruptedModuleGens([first.moduleId], { notify: false });
      expect(quiet).toEqual([first.moduleId]);
      expect(toastErrorMock).not.toHaveBeenCalled();
    });

    it('re-opens the EXISTING recovery path: the rewound part is written by generateMissingParts', async () => {
      const { campaign, moduleId } = await seedInterruptedModule();
      const NEW_PART_TEXT = [
        'The vault door is the [[Sunken Trial]], and it answers once when the party knocks.',
        '',
        'The keeper of the mill left three rules on the lintel: pay in salt, never count the bells',
        'aloud, and leave the lamp burning while the water climbs the stair.',
      ].join('\n');
      chatMock.mockImplementation((_messages, opts) => {
        const format = (opts as { responseFormat?: { name?: string } }).responseFormat;
        if (format?.name === 'entity-normalization') {
          return Promise.resolve({
            text: JSON.stringify({
              entities: [
                { name: 'Flooded Crypt', canonical: 'Flooded Crypt', kind: 'encounter' },
                { name: 'Sunken Trial', canonical: 'Sunken Trial', kind: 'encounter' },
              ],
            }),
            modelUsed: 'test-model',
            fallback: null,
          });
        }
        return Promise.resolve({ text: NEW_PART_TEXT, modelUsed: 'test-model', fallback: null });
      });

      await reconcileInterruptedModuleGen(moduleId);
      const { generateMissingParts } = await import('@/llm/moduleGen');
      await generateMissingParts(moduleId, campaign);

      const row = await getModule(moduleId);
      // The part the reconcile rewound was written; the finished part was not
      // re-run (the pass is scoped to the non-ready slots).
      expect(row?.parts.find((part) => part.planIndex === 1)?.markdown).toBe(NEW_PART_TEXT);
      expect(row?.parts.find((part) => part.planIndex === 0)?.markdown).toBe(PART_ZERO_TEXT);
      // One part call — the recovery wrote exactly what was missing.
      const partCalls = chatMock.mock.calls.filter(
        (call) => (call[1] as { responseFormat?: unknown }).responseFormat === undefined,
      );
      expect(partCalls).toHaveLength(1);
      expect(row?.status).toBe('ready');
    }, 30_000);
  });
});

describe('provenance-recording.test.ts', () => {
  /**
   * PROVENANCE (owner request, docs/17 row 93): "put a very small id below
   * generated texts … indicating which model wrote this. And a small id below
   * images indicating the image model."
   *
   * This file pins the RECORDING half — the value written at every seam — and
   * the two owner decisions that decide what a row may show:
   *
   *   1. text written before the field shows NOTHING (never a settings-derived
   *      guess, never a backfill);
   *   2. a hand edit KEEPS the writing model's id;
   *   3. (the third decision — never in an export — is pinned by
   *      `tests/lib/provenance-export.test.ts`).
   *
   * The load-bearing case is the FALLBACK: the model that served the call is
   * not the model the settings name, so a settings lookup would print a
   * different id than the text in front of the owner.
   */

  const chatMock = vi.mocked(chat);

  const CONFIGURED_MODEL = 'anthropic/claude-sonnet-4.5';
  const FALLBACK_MODEL = 'potent/fallback';
  const CHAT_MODEL = 'owner/experiment-model';

  const VALID_REPORT = { verdict: 'consistent', summary: 'Nothing conflicts.', issues: [] };

  /** A generate-persona draft with no stat block, so one chat call writes the
   * artifact's whole text. */
  const VALID_DRAFT = {
    name: 'Grix',
    summary: 'A goblin alchemist boss.',
    suggestedTags: ['goblin'],
    body: '# Grix\nShe brews. She throws.',
    appearance: 'Small, soot-stained.',
    personality: 'Manic, cheerful.',
    needsStatBlock: false,
  };

  async function seedModule(
    premise: string,
    parts: { planIndex: number; markdown: string }[],
  ): Promise<Module> {
    const campaign = await createCampaign({ name: 'Provenance', system: 'dnd5e' });
    const draft = createModule({
      campaignId: campaign.id,
      title: 'The Salt Road',
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'sketch',
    });
    const row = moduleSchema.parse({
      ...draft,
      spine: {
        premise,
        themes: [],
        partPlan: [{ title: 'Part', levelBand: '1–3', synopsis: '', levelUpTrigger: '' }],
      },
      parts: parts.map((part) => ({
        planIndex: part.planIndex,
        markdown: part.markdown,
        status: 'ready' as const,
        errorMessage: '',
        edited: false,
      })),
    });
    await createModuleRow(row);
    return (await getModule(row.id)) ?? row;
  }

  async function seedReviewRun(): Promise<{
    campaignId: Id;
    persona: Persona;
    input: StartRunInput;
  }> {
    const campaign = await createCampaign({ name: 'Review Land', system: 'dnd5e' });
    const target = await createArtifact({
      campaignId: campaign.id,
      kind: 'plotarc',
      name: 'The Drowned Bell',
      body: '# Arc',
    });
    const persona = BUILT_IN_PERSONAS.find((entry) => entry.slug === 'continuity-editor');
    if (persona === undefined) throw new Error('continuity-editor persona missing');
    await updateSettings({ defaultChatModel: CONFIGURED_MODEL, fallbackChatModel: FALLBACK_MODEL });
    return {
      campaignId: campaign.id,
      persona,
      input: {
        campaign: { ...campaign },
        persona,
        autonomy: 'auto' as const,
        brief: 'review the arc',
        pinnedChunkIds: [],
        targetArtifactId: target.id,
      },
    };
  }

  /**
   * A generate persona run (the ordinary "write me an NPC" flow). Manual
   * autonomy so a REPAIRED draft can still be approved — the repair turn is the
   * one that escalates to the fallback tier, and the artifact is created at
   * finalize from the step that ran.
   */
  async function seedGenerateRun(): Promise<{ campaignId: Id; input: StartRunInput }> {
    const campaign = await createCampaign({ name: 'Generate Land', system: 'dnd5e' });
    const persona = await createPersona({
      slug: 'provenance-npc-smith',
      name: 'NPC Smith',
      description: 'test',
      systemPrompt: 'You are a test persona. Reply with JSON only.',
      producesKind: 'npc',
      builtIn: true,
    });
    await updateSettings({ defaultChatModel: CONFIGURED_MODEL, fallbackChatModel: FALLBACK_MODEL });
    return {
      campaignId: campaign.id,
      input: {
        campaign: { ...campaign },
        persona,
        autonomy: 'manual' as const,
        brief: 'a goblin alchemist boss for a level 3 party',
        pinnedChunkIds: [],
      },
    };
  }

  beforeEach(clearDatabase);
  afterEach(() => {
    chatMock.mockReset();
    vi.restoreAllMocks();
  });

  describe('recording the model that served the write', () => {
    it('records the FALLBACK model when an escalation served the text', async () => {
      const { campaignId, input } = await seedGenerateRun();
      // The first reply fails its contract, so the repair turn escalates to the
      // fallback tier — and THAT reply is the text that gets saved.
      chatMock
        .mockResolvedValueOnce({ text: 'not json', modelUsed: CONFIGURED_MODEL, fallback: null })
        .mockResolvedValueOnce({
          text: JSON.stringify(VALID_DRAFT),
          modelUsed: FALLBACK_MODEL,
          fallback: null,
        });

      const runId = await runEngine.startRun(input);
      await waitFor(async () => {
        const run = await db.runs.get(runId);
        expect(run?.status).toBe('awaiting_user');
      });

      // The repair really did escalate — otherwise the claim below is vacuous.
      const models = chatMock.mock.calls.map(([, opts]) => (opts as { model: string }).model);
      expect(models).toEqual([CONFIGURED_MODEL, FALLBACK_MODEL]);

      await runEngine.approve(runId, input);
      await waitFor(async () => {
        const run = await db.runs.get(runId);
        expect(run?.status).toBe('completed');
      });

      const artifact = (await listArtifactsByCampaign(campaignId))[0];
      expect(artifact?.name).toBe(VALID_DRAFT.name);
      // THE pin: the id is the model that served the call. A settings lookup
      // (or any "read the configured model" shortcut) would have written
      // `CONFIGURED_MODEL` and lied about the text in front of the owner.
      expect(artifact?.writerModel).toBe(FALLBACK_MODEL);
      expect(artifact?.writerModel).not.toBe(CONFIGURED_MODEL);
    }, 20000);

    it('records the serving model when the first try answers (no escalation)', async () => {
      const { campaignId, input } = await seedReviewRun();
      chatMock.mockResolvedValue({
        text: JSON.stringify(VALID_REPORT),
        modelUsed: CONFIGURED_MODEL,
        fallback: null,
      });

      const runId = await runEngine.startRun(input);
      await waitFor(async () => {
        const run = await db.runs.get(runId);
        expect(run?.status).toBe('completed');
      });

      const report = (await listArtifactsByCampaign(campaignId)).find((row) => row.kind === 'note');
      expect(report?.writerModel).toBe(CONFIGURED_MODEL);
    }, 20000);
  });

  describe('legacy rows and the empty-means-not-recorded rule', () => {
    it('a row written before the field parses with an empty id and displays nothing', async () => {
      const campaign = await createCampaign({ name: 'Legacy', system: 'dnd5e' });
      const artifact = await createArtifact({
        campaignId: campaign.id,
        kind: 'location',
        name: 'Old Keep',
        body: 'Written before provenance existed.',
      });
      // Simulate a pre-arc row: the stored object has NO `writerModel` key at
      // all (the additive `.default('')` is what makes it parse).
      const stored = await db.artifacts.get(artifact.id);
      if (stored === undefined) throw new Error('artifact row missing');
      const { writerModel: _dropped, ...legacy } = stored as Record<string, unknown> & {
        writerModel: string;
      };
      await db.artifacts.put(legacy as typeof stored);

      // Parse-on-read: no Dexie version, no migration — the row reads back.
      const read = await getArtifact(artifact.id);
      expect(read).toBeDefined();
      expect(read?.writerModel).toBe('');
      // Empty means NOT RECORDED: nothing is displayed, and nothing is invented
      // from the settings the campaign happens to have today.
      await updateSettings({ defaultChatModel: CONFIGURED_MODEL });
      expect(recordedWritingModel(read?.writerModel)).toBeNull();
    });

    it('leaves the id empty on rows a model never wrote (stubs, seeds, uploads)', async () => {
      const campaign = await createCampaign({ name: 'Handmade', system: 'dnd5e' });
      const stub = await createArtifact({
        campaignId: campaign.id,
        kind: 'note',
        name: 'My own note',
      });
      expect(stub.writerModel).toBe('');
      const image = await createImage({
        campaignId: campaign.id,
        blob: new Blob(['hand-uploaded'], { type: 'image/webp' }),
        mimeType: 'image/webp',
        width: 4,
        height: 4,
        prompt: '',
        model: '',
        source: 'uploaded',
      });
      expect(recordedWritingModel(image.model)).toBeNull();
    });
  });

  describe('hand edits keep the id; a chat rewrite records the chat model', () => {
    it('a hand edit of a part KEEPS the writing model', async () => {
      const module = await seedModule('A premise written by a model.', [
        { planIndex: 0, markdown: 'Original generated prose, long enough to be a part.' },
      ]);
      const planned = (await getModule(module.id))?.parts[0];
      if (planned === undefined) throw new Error('seeded part missing');
      const spine = (await getModule(module.id))?.spine;
      if (spine === undefined || spine === null) throw new Error('seeded spine missing');
      await patchModule(module.id, {
        spine: { ...spine, writerModel: CONFIGURED_MODEL },
        parts: [{ ...planned, writerModel: CONFIGURED_MODEL }],
      });

      // The reader's hand edit: `saveModulePartText` with NO writerModel.
      await saveModulePartText(module.id, 0, 'The owner rewrote this passage by hand.');
      const after = await getModule(module.id);
      expect(after?.parts[0]?.markdown).toBe('The owner rewrote this passage by hand.');
      expect(after?.parts[0]?.edited).toBe(true);
      // Decision 2: the owner's edits must not erase which model wrote the text.
      expect(after?.parts[0]?.writerModel).toBe(CONFIGURED_MODEL);
      // The premise's id is untouched by a part write, too.
      expect(after?.spine?.writerModel).toBe(CONFIGURED_MODEL);
    });

    it('a chat-applied rewrite records the CHAT model (the last writer)', async () => {
      const module = await seedModule('A premise.', [
        { planIndex: 0, markdown: 'Original generated prose, long enough to be a part.' },
      ]);
      const planned = (await getModule(module.id))?.parts[0];
      if (planned === undefined) throw new Error('seeded part missing');
      await patchModule(module.id, {
        parts: [{ ...planned, writerModel: CONFIGURED_MODEL }],
      });

      const row = await getModule(module.id);
      if (row === undefined) throw new Error('seeded module missing');
      // The canvas chat applies its rewrite by saving the WHOLE parts document
      // (the same call `chatController` makes), so the seam under test is the
      // one the chat really goes through.
      const assembled = assembleModulePartsDocument({
        partPlan: row.spine?.partPlan ?? [],
        parts: [{ planIndex: 0, markdown: 'Rewritten by the chat model.' }],
      });
      await saveWholeModuleDocument({
        moduleId: module.id,
        doc: assembled.document,
        module: row,
        origin: 'ai',
        label: 'Chat: rewrite the opening',
        version: { source: 'chat', label: 'Chat: rewrite the opening' },
        writerModel: CHAT_MODEL,
      });

      const after = await getModule(module.id);
      expect(after?.parts[0]?.markdown).toContain('Rewritten by the chat model.');
      expect(after?.parts[0]?.writerModel).toBe(CHAT_MODEL);
    });

    it('an artifact edit that omits the field keeps it; a persona refill rewrites it', async () => {
      const campaign = await createCampaign({ name: 'Artifacts', system: 'dnd5e' });
      const npc = await createArtifact({
        campaignId: campaign.id,
        kind: 'npc',
        name: 'Grix',
        summary: 'Model-written.',
        writerModel: CONFIGURED_MODEL,
      });

      // The artifact editor's autosave: a body patch with NO writerModel.
      await updateArtifact(npc.id, { body: 'The owner typed this.' });
      const edited = await getArtifact(npc.id);
      expect(edited?.body).toBe('The owner typed this.');
      expect(edited?.writerModel).toBe(CONFIGURED_MODEL);

      // A model write DOES move it: the last writer owns the row.
      await updateArtifact(npc.id, { body: 'Refilled by a model.', writerModel: FALLBACK_MODEL });
      expect((await getArtifact(npc.id))?.writerModel).toBe(FALLBACK_MODEL);
    });

    it('an attachment/scope write never blanks a recorded id', async () => {
      const campaign = await createCampaign({ name: 'Scoped', system: 'dnd5e' });
      const npc = await createArtifact({
        campaignId: campaign.id,
        kind: 'npc',
        name: 'Vexra',
        writerModel: CONFIGURED_MODEL,
      });
      // A patch that touches only unrelated fields (the shape the image attach,
      // the rename helper and the encounter reset all use).
      await updateArtifact(npc.id, { tags: ['cult'] });
      expect((await getArtifact(npc.id))?.writerModel).toBe(CONFIGURED_MODEL);
    });
  });

  describe('recordedWritingModel — the one display rule', () => {
    it('maps only a non-blank value to an id to show', () => {
      expect(recordedWritingModel('anthropic/claude-sonnet-4.5')).toBe(
        'anthropic/claude-sonnet-4.5',
      );
      expect(recordedWritingModel('  spaced/model  ')).toBe('spaced/model');
      expect(recordedWritingModel('')).toBeNull();
      expect(recordedWritingModel('   ')).toBeNull();
      expect(recordedWritingModel(null)).toBeNull();
      expect(recordedWritingModel(undefined)).toBeNull();
    });
  });
});

describe('scaffoldingEcho.test.ts', () => {
  /**
   * Prompt-scaffolding echo (docs/17 row 142, AGENTS rules 1-4).
   *
   * The owner found OUR OWN brief printed into his module: *"The artifact \"name\"
   * field must be exactly \"Nisselkraut\" — verbatim, with no epithets, titles, or
   * additions (put those in the body). Do not invent unrelated sub-plots; make
   * this entity serve the module text. Campaign grounding (derived from
   * wiki-links): -"*. A model echoed the instructions it was handed, and nothing
   * detected the echo, so it was written to a reader-facing document.
   *
   * WHAT THESE PINS ARE. The detector is a full-literal string comparison over
   * strings WE wrote, so it is decidable — the `encounterSourceIssues` /
   * escape-debris pattern, not a gate over prose (docs/18 §4). The pins below
   * assert (i) the reported markers are caught at the REAL persisting boundaries
   * of BOTH generation paths, (ii) the literals come from ONE source shared with
   * the composers, and (iii) ordinary prose that merely talks about the same
   * things passes.
   *
   * WHAT NO TEST HERE CAN PROVE. That a model stops echoing. This seam CATCHES an
   * echo and refuses to persist it; whether the failure rate in real runs is
   * tolerable is something only the owner's runs can show.
   */

  const chatMock = vi.mocked(chat);

  async function seedPersona(): Promise<{ campaignId: Id; persona: Persona }> {
    const campaign = await createCampaign({ name: 'Test Campaign', system: 'dnd5e' });
    const persona = await createPersona({
      slug: 'npc-smith-scaffolding-echo-test',
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

  const VALID_SPINE = {
    premise:
      'A harbor town raised its bell to warn of the drownings; now the bell rings by itself.',
    themes: ['duty', 'decay'],
    partPlan: [
      {
        title: 'The Sunken Quarter',
        levelBand: '1',
        synopsis: 'The party arrives with the low tide and finds the first bodies.',
        levelUpTrigger: 'The bell is found.',
      },
      {
        title: 'The Drowned Cathedral',
        levelBand: '2',
        synopsis: 'Descent beneath the harbor to the flooded nave.',
        levelUpTrigger: 'The warden falls.',
      },
    ],
    entities: [],
  };

  /** Module prose well above the 100-char floor, with a findable marker. */
  function partMarkdown(marker: string): string {
    return `${marker}: The tide withdraws and the streets shine wet under a pale sun. `.repeat(4);
  }

  beforeEach(clearDatabase);
  afterEach(() => {
    chatMock.mockReset();
    vi.restoreAllMocks();
  });

  describe("the marker set is the composers' own bytes (one source)", () => {
    it('the literals the OWNER saw are markers, byte-exact', () => {
      // The report's own strings — if one of these moves, the detector is
      // watching something the model was never sent.
      expect(ENTITY_SERVE_MODULE_TEXT).toBe(
        'Do not invent unrelated sub-plots; make this entity serve the module text.',
      );
      expect(GROUNDING_SECTION_HEADER).toBe('Campaign grounding (derived from wiki-links):');
      expect(ENTITY_CONTEXT_LABEL).toBe('Where it is mentioned:');
      expect(MODULE_PREMISE_LABEL).toBe('Module premise for context:');
      expect(SCHEMA_REPAIR_LEAD_IN).toBe('Your previous reply was invalid JSON for the schema:');
      expect(ENCOUNTER_SOURCE_REPAIR_LEAD_IN).toBe(
        'Your previous reply left monsters without a resolvable stat-block source:',
      );
      expect(PART_TOO_SHORT_REPAIR_SENTENCE).toBe(
        'Your previous reply was too short. Write the full part now.',
      );
    });

    it('the brief we SEND is itself scaffolding — the composer and the detector read the SAME constants', () => {
      // THE one-source pin (AGENTS rule 4). The expected label set is every
      // marker this argument list renders; if a composer stops reading a shared
      // constant and inlines its own wording, the detector no longer matches what
      // was sent, this set loses that label, and THIS test fails — which is the
      // whole point of centralizing the literals.
      const brief = buildEntityBrief(
        'Nisselkraut',
        'The party passes [[Nisselkraut]] on the way inland.',
        'A drowned bell rings on its own.',
        3,
        [{ name: 'Halvar', level: '3', summary: 'Halvar (level 3)', statBlock: null }],
        false,
        'location',
      );
      const found = findScaffoldingEcho(brief)
        .map((hit) => hit.label)
        .sort();
      expect(found).toEqual(
        [
          'the "do not invent unrelated sub-plots" rule',
          'the "Where it is mentioned:" context label',
          'the entity-brief intro line',
          'the fixed-cast section footer',
          'the fixed-cast section header',
          'the location/event ownership boundary',
          'the module-premise label',
          'the verbatim-name rule',
        ].sort(),
      );
    });

    it('the OTHER brief shapes are detected too: the encounter scene label and the faction boundary', () => {
      const scene = 'Two risen lumberjacks stand motionless on the footbridge.';
      const sceneBrief = findScaffoldingEcho(
        buildEntityBrief('The Sunken Bridge', scene, 'premise', 3, [], true, 'encounter'),
      ).map((hit) => hit.label);
      expect(sceneBrief).toContain('the encounter-scene context label');
      expect(sceneBrief).not.toContain('the "Where it is mentioned:" context label');

      const factionBrief = findScaffoldingEcho(
        buildEntityBrief(
          'The Ember Council',
          'It holds the harbor.',
          'premise',
          undefined,
          [],
          false,
          'faction',
        ),
      ).map((hit) => hit.label);
      expect(factionBrief).toContain('the faction ownership boundary');
      expect(factionBrief).not.toContain('the location/event ownership boundary');
    });

    it.each([
      ['the "Where it is mentioned:" context label', ENTITY_CONTEXT_LABEL],
      ['the encounter-scene context label', ENTITY_SCENE_CONTEXT_LABEL],
      ['the module-premise label', MODULE_PREMISE_LABEL],
      ['the "do not invent unrelated sub-plots" rule', ENTITY_SERVE_MODULE_TEXT],
      ['the location/event ownership boundary', PLACE_OWNERSHIP_BOUNDARY],
      ['the faction ownership boundary', FACTION_OWNERSHIP_BOUNDARY],
      ['the entity-intent label', INTENT_LABEL],
      ['the entity-intent hierarchy sentence', INTENT_HIERARCHY],
      ['the entity-level-hint label', ENTITY_LEVEL_HINT_LABEL],
      ['the entity-level-hint hierarchy sentence', ENTITY_LEVEL_HINT_HIERARCHY],
      ['the grounding section header', GROUNDING_SECTION_HEADER],
      ['the fixed-cast section header', FIXED_CAST_SECTION_HEADER],
      ['the fixed-cast section footer', FIXED_CAST_SECTION_FOOTER],
      ['the schema-repair lead-in', SCHEMA_REPAIR_LEAD_IN],
      ['the encounter-source repair lead-in', ENCOUNTER_SOURCE_REPAIR_LEAD_IN],
      ['the part-too-short repair sentence', PART_TOO_SHORT_REPAIR_SENTENCE],
      ['the mob-spells section header', MOB_SPELL_SECTION_PREFIX],
      ['the mob-spells repair lead-in', MOB_SPELL_REPAIR_LEAD_IN],
      ['the caster-awareness clause', MOB_SPELL_CASTER_CLAUSE],
    ])('every shared literal is DETECTED on its own, as %s', (label, literal) => {
      // A marker that cannot fire is a marker nobody would notice going dead —
      // and this is also the shortest statement of the one-source rule: the
      // literal here IS the constant the composer renders.
      expect(findScaffoldingEcho(literal).map((hit) => hit.label)).toEqual([label]);
    });

    it('a brief CARRYING AN INTENT is detected, both of its literals included (docs/17 row 145)', () => {
      // The gap this pin closes: row 142's detector could not mark the
      // intent paragraph, because its two constants lived in
      // `features/modules/persona-request` and importing them into this seam would
      // have been an import cycle. They moved DOWN to `llm/promptScaffolding`
      // (where the composer now imports them back), and the composed paragraph is
      // byte-identical — `tests/features/entity-intent-brief.test.tsx` transcribes
      // it and stays green UNCHANGED.
      const brief = buildEntityBrief(
        'The Salt Market',
        'The party crosses [[The Salt Market]] at dusk.',
        'A harbor town raised its bell.',
        2,
        [],
        false,
        'location',
        'Park her at the docks.',
        'The market is a front for the smugglers.',
      );
      const found = findScaffoldingEcho(brief).map((hit) => hit.label);
      expect(found).toContain('the entity-intent label');
      expect(found).toContain('the entity-intent hierarchy sentence');
    });

    it('a brief CARRYING A LEVEL HINT is detected, both of its literals included (docs/17 row 197)', () => {
      // The level-hint paragraph is a fixed sentence the generators are handed,
      // so the detector must read the SAME bytes the composer renders — an
      // undetected echo would be a brief instruction written into an artifact.
      const brief = buildEntityBrief(
        'Kael the Grey',
        'The party meets [[Kael the Grey]] at the gate.',
        'A harbor town raised its bell.',
        1,
        [],
        false,
        'npc',
        '',
        null,
        7,
      );
      const found = findScaffoldingEcho(brief).map((hit) => hit.label);
      expect(found).toContain('the entity-level-hint label');
      expect(found).toContain('the entity-level-hint hierarchy sentence');
      expect(brief).toContain(`${ENTITY_LEVEL_HINT_LABEL}7.${ENTITY_LEVEL_HINT_HIERARCHY}`);
    });

    it('a brief with NO level hint carries NEITHER literal (the compatibility rule)', () => {
      const brief = buildEntityBrief(
        'Kael the Grey',
        'The party meets [[Kael the Grey]] at the gate.',
        'A harbor town raised its bell.',
        1,
        [],
        false,
        'npc',
      );
      const found = findScaffoldingEcho(brief).map((hit) => hit.label);
      expect(found).not.toContain('the entity-level-hint label');
      expect(found).not.toContain('the entity-level-hint hierarchy sentence');
      expect(brief).not.toContain(ENTITY_LEVEL_HINT_LABEL);
    });

    it('…and a note containing a QUOTE is still detected — the reason the markers are literals', () => {
      // A SLOTTED marker cannot see this note: its slot is `[^\n"]+`, because the
      // entity-brief intro's own slot is a quoted name. The intent note is free
      // prose and legitimately carries quotes, so a slotted form would be silently
      // DEAD here — the exact failure mode the marker set exists to prevent.
      const brief = buildEntityBrief(
        'The Salt Market',
        'The party crosses [[The Salt Market]] at dusk.',
        'A harbor town raised its bell.',
        2,
        [],
        false,
        'location',
        'Park her at the docks.',
        'The "bustle" is a cover; play the stalls as fear.',
      );
      expect(findScaffoldingEcho(brief).map((hit) => hit.label)).toContain(
        'the entity-intent label',
      );
      expect(brief).toContain('The "bustle" is a cover; play the stalls as fear.');
    });

    it('matches the FULL literal, never a fragment — a truncated run of the same words passes', () => {
      // Not a false-positive guard on its own (the next pin is): this is the
      // reason the detector compares whole sentences. Each fragment below is a
      // literal prefix of a real marker and must NOT fire.
      expect(findScaffoldingEcho('Campaign grounding (derived from wiki-links)')).toEqual([]);
      expect(findScaffoldingEcho('Do not invent unrelated sub-plots')).toEqual([]);
      expect(findScaffoldingEcho(`${ENTITY_NAME_VERBATIM_PREFIX}Nisselkraut`)).toEqual([]);
      expect(findScaffoldingEcho('Your previous reply was invalid JSON')).toEqual([]);
    });

    it("a generically similar sentence in the GM's OWN prose stays GREEN (no false positive)", () => {
      // The brief's rule 4: ordinary words about the same subjects are not an
      // echo. Every line here uses the vocabulary of a marker without being one.
      const prose = [
        'The GM should not invent new factions for this part; the module already names two.',
        'Do not invent unrelated sub-plots for the party to chase between sessions.',
        'The party is level 3, and the mill is where it is mentioned in the old ledger.',
        'Campaign grounding from wiki-links is what the settings toggle controls.',
        'Where it is mentioned twice, link the name only once.',
        'The artifact name must be exactly as the wiki-link spells it, epithets and all.',
        'Write the full part now that the tide has turned.',
      ].join('\n\n');
      expect(findScaffoldingEcho(prose)).toEqual([]);
    });

    it("identity fields are NOT this seam's business: names, aliases and tags are out of the scan", () => {
      const fields = documentTextFields(
        {
          name: ENTITY_SERVE_MODULE_TEXT,
          aliases: [ENTITY_CONTEXT_LABEL],
          suggestedTags: [GROUNDING_SECTION_HEADER],
          body: 'She brews by the tide gate.',
          monsters: [{ name: 'Grix', notes: 'Keeps the ledger.' }],
        },
        'draft',
      );
      expect(fields.map((field) => field.field)).toEqual(['draft.body', 'draft.monsters[0].notes']);
    });
  });

  describe('the clean brief is byte-identical to before the constants moved', () => {
    // FROZEN BYTES, captured from the BASE COMMIT (`git show HEAD:…` at
    // d94d4e9) by running THAT module: the refactor moved the literals into
    // `llm/promptScaffolding` and changed no byte the model receives. Each string
    // below is `JSON.stringify` of the base output.
    it('npc (context + premise + level)', () => {
      expect(buildEntityBrief('The Gray Nun', '', '', undefined)).toBe(
        'Detail the entity "The Gray Nun" for this module. It appears in the module text below — match it exactly by name.\n\nThe artifact "name" field must be exactly "The Gray Nun" — verbatim, with no epithets, titles, or additions (put those in the body).\n\nDo not invent unrelated sub-plots; make this entity serve the module text.',
      );
    });

    it('encounter (the scene framing, no kind boundary)', () => {
      expect(
        buildEntityBrief(
          'Drowned Warden',
          'The party meets Harbormaster Ilse at the tide gate.\nShe warns of the cult.',
          'A flooded chapel hides a cult.',
          3,
          [],
          true,
          'encounter',
        ),
      ).toBe(
        'Detail the entity "Drowned Warden" for this module. It appears in the module text below — match it exactly by name.\n\nThe scene this encounter must stage — whatever it states about the opposition and the place is FIXED, and the roster and the map must match it:\n\nThe party meets Harbormaster Ilse at the tide gate.\nShe warns of the cult.\n\nModule premise for context:\n\nA flooded chapel hides a cult.\n\nParty of 4 adventurers at level 3.\n\nThe artifact "name" field must be exactly "Drowned Warden" — verbatim, with no epithets, titles, or additions (put those in the body).\n\nDo not invent unrelated sub-plots; make this entity serve the module text.',
      );
    });

    it('location (the ownership boundary included)', () => {
      expect(
        buildEntityBrief(
          'The Tide Gate',
          'The party meets Harbormaster Ilse at the tide gate.\nShe warns of the cult.',
          'A flooded chapel hides a cult.',
          undefined,
          [],
          false,
          'location',
        ),
      ).toBe(
        'Detail the entity "The Tide Gate" for this module. It appears in the module text below — match it exactly by name.\n\nWhere it is mentioned:\n\nThe party meets Harbormaster Ilse at the tide gate.\nShe warns of the cult.\n\nModule premise for context:\n\nA flooded chapel hides a cult.\n\nThe artifact "name" field must be exactly "The Tide Gate" — verbatim, with no epithets, titles, or additions (put those in the body).\n\nDo not invent unrelated sub-plots; make this entity serve the module text.\n\nWhat this artifact OWNS — one fact, one owner: the module prose draws this line itself ("encounters live in separate encounter artifacts"), so the OPPOSITION belongs to the encounter artifact — its creatures, their counts, its tactics and how the fight is run are that artifact\'s content, and that is where a GM gets them. If the story needs the opposition, point at where it is fought by the name the module text\'s own wiki-link uses instead of describing the opposition here, and write no tactics, no encounter-handling advice and no GM guidance on running the fight. "inhabitants" means the people and factions who are here — never monsters. And when the module text you are given is written from the encounter\'s point of view (fields such as "If the party acts", "Secrets" or "Outcome"), that material belongs to that encounter: do not restate it, do not extend it, and do not turn it into this artifact\'s own detail.',
      );
    });
  });

  describe('the ENTITY path: finalize refuses an echoed brief', () => {
    /**
     * (a) and (b): a draft whose PROSE contains the verbatim-name rule, the
     * grounding section header, the "do not invent unrelated sub-plots" rule, the
     * module-premise label or the ownership boundary is rejected loudly, the
     * marker is NAMED with the field it was found in, and nothing persists.
     *
     * The marker strings come from the exported constants — the composer's own
     * bytes — so this cannot pass against a detector watching something else.
     */
    it.each([
      [
        'the verbatim-name rule',
        `${ENTITY_NAME_VERBATIM_PREFIX}Nisselkraut${ENTITY_NAME_VERBATIM_SUFFIX}`,
      ],
      ['the grounding section header', GROUNDING_SECTION_HEADER],
      ['the "do not invent unrelated sub-plots" rule', ENTITY_SERVE_MODULE_TEXT],
      ['the module-premise label', MODULE_PREMISE_LABEL],
      ['the location/event ownership boundary', PLACE_OWNERSHIP_BOUNDARY],
    ])(
      'rejects a draft body carrying %s, naming the marker and persisting nothing',
      async (label, marker) => {
        const { campaignId, persona } = await seedPersona();
        const echoedDraft = {
          name: 'Grix',
          summary: 'A goblin alchemist boss.',
          suggestedTags: ['goblin'],
          body: `# Grix\nShe brews by the tide gate.\n\n${marker}`,
          appearance: 'Small, soot-stained, goggles.',
          personality: 'Manic, cheerful, volatile.',
          needsStatBlock: false,
        };
        chatMock.mockResolvedValueOnce({
          text: JSON.stringify(echoedDraft),
          modelUsed: 'test-model',
          fallback: null,
        });

        const runId = await runEngine.startRun(INPUT(campaignId, persona));
        await waitFor(async () => {
          expect((await getRun(runId))?.status).toBe('awaiting_user');
        });
        await runEngine.approve(runId, INPUT(campaignId, persona));
        await waitFor(async () => {
          expect((await getRun(runId))?.steps.at(-1)?.name).toBe('finalize');
        });

        const run = await getRun(runId);
        const finalize = run?.steps.at(-1);
        expect(finalize?.status).toBe('rejected');
        const issues = ((finalize?.output as { issues?: unknown }).issues as string[]).join('\n');
        expect(issues).toContain('prompt scaffolding');
        expect(issues).toContain(label);
        expect(issues).toContain('draft.body');
        expect(issues).toContain(marker);
        // Nothing persisted: no artifact, no result link.
        expect(run?.resultArtifactId).toBeNull();
        expect(await listArtifactsByCampaign(campaignId)).toHaveLength(0);
      },
      20000,
    );
  });

  describe('the MODULE path reaches the SAME seam', () => {
    it('the SPINE boundary refuses a premise that echoes the scaffolding (parseSpine, called by runSpine at 3 sites)', () => {
      const echoed = JSON.stringify({
        ...VALID_SPINE,
        premise: `The bell rings.\n\n${ENTITY_SERVE_MODULE_TEXT}`,
      });
      expect(() => parseSpine(echoed)).toThrow(/prompt scaffolding/);
      expect(() => parseSpine(echoed)).toThrow(/spine\.premise/);
      expect(() => parseSpine(echoed)).toThrow(new RegExp('do not invent unrelated sub-plots'));
      // A CLEAN spine is untouched — parsed, premise byte-identical.
      expect(parseSpine(JSON.stringify(VALID_SPINE)).premise).toBe(VALID_SPINE.premise);
    });

    it('a PART whose prose echoes the scaffolding fails the part, named, and is never persisted', async () => {
      const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
      const saved = await saveModule(
        createModule({
          campaignId: campaign.id,
          title: 'The Drowned Bell',
          concept: 'A harbor bell that rings by itself beneath the water.',
          levelMin: 1,
          levelMax: 3,
          tone: 'eerie',
          sizeDial: 'standard',
        }),
      );
      await patchModule(saved.id, { spine: moduleSpineSchema.parse(VALID_SPINE) });
      const encounterVerdict = {
        text: JSON.stringify({
          entities: [{ name: 'Ember Trial', canonical: 'Ember Trial', kind: 'encounter' }],
        }),
        modelUsed: 'test-model',
        fallback: null,
      };
      chatMock
        .mockResolvedValueOnce({
          text: `${partMarkdown('PART-ONE')} ${GROUNDING_SECTION_HEADER}`,
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce(encounterVerdict) // post-parts normalization
        .mockResolvedValueOnce({
          text: `${partMarkdown('PART-ONE-REPAIR')} ${GROUNDING_SECTION_HEADER}`,
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce(encounterVerdict); // re-normalization

      await runParts(saved.id, campaign, { planIndexes: [0] });

      const stored = await getModule(saved.id);
      const part = stored?.parts.find((entry) => entry.planIndex === 0);
      expect(part?.status).toBe('failed');
      expect(part?.markdown).toBe('');
      expect(part?.errorMessage).toContain('prompt scaffolding');
      expect(part?.errorMessage).toContain('the grounding section header');
      expect(part?.errorMessage).not.toContain('PART-ONE');
    }, 20000);
  });

  describe('SCAN — every boundary that persists generated text runs the ONE scan', () => {
    /**
     * SOURCE scan (not a behavioural pin): the rule-4 half of row 142. The two
     * defect classes ride ONE function, so a boundary that calls the debris half
     * directly would silently lose the scaffolding half — the "bug waiting at the
     * fourth caller" AGENTS rule 4 names. `debrisIssuesForFields(` may appear
     * ONLY inside `lib/encodingHygiene` (its definition) and inside the aggregate.
     */
    it('no boundary calls the debris half directly', async () => {
      const offenders: string[] = [];
      for (const file of await listSourceFiles('src')) {
        const text = await readFile(file, 'utf8');
        if (!text.includes('debrisIssuesForFields(')) continue;
        if (file.endsWith('lib/encodingHygiene.ts') || file.endsWith('llm/generatedTextHygiene.ts'))
          continue;
        offenders.push(file);
      }
      expect(offenders).toEqual([]);
    });

    it('the boundaries that persist reader-visible text all call the aggregate', async () => {
      const boundaries = [
        'src/llm/runEngine.ts', // finalize: artifact body/prose + statblock strings
        'src/llm/moduleGen.ts', // the spine save and every part's markdown
        'src/llm/modulePlan.ts', // the document plan's section titles
        'src/llm/canvasRefine.ts', // a selection/part rewrite's replacement
        // ONE applier serves BOTH chat routes since docs/17 row 150: the
        // preview's copy — whose own entry this list used to carry — is
        // deleted, so its scan IS this one. The second half of this test holds
        // the two surface wrappers to that applier, so the preview route
        // cannot lose the aggregate by losing its entry here.
        'src/features/modules/canvas/chatApply.ts', // a chat command's replacement
      ];
      for (const file of boundaries) {
        const text = await readFile(join(process.cwd(), file), 'utf8');
        expect(text, file).toContain('generatedTextScanForFields(');
      }
      // THE ROUTING PIN that replaces the deleted `snapshotChat.ts` entry: each
      // chat surface hands ITS document to the one applier, so neither route
      // can reach a text write without passing the aggregate above.
      const routes: [string, string][] = [
        ['src/features/modules/canvas/chatController.ts', 'editorChatHandle('],
        ['src/features/modules/canvas/snapshotChat.ts', 'stringChatHandle('],
      ];
      for (const [file, handle] of routes) {
        const text = await readFile(join(process.cwd(), file), 'utf8');
        expect(text, file).toContain(handle);
        expect(text, `${file} must not apply text itself`).not.toContain(
          'generatedTextScanForFields(',
        );
      }
    });
  });

  async function listSourceFiles(dir: string): Promise<string[]> {
    const entries = await readdir(join(process.cwd(), dir), { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await listSourceFiles(path)));
      else if (/\.tsx?$/.test(entry.name)) files.push(join(process.cwd(), path));
    }
    return files;
  }
});
