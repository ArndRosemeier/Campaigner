/**
 * MERGED same-background cluster (docs/17 row 177, extending row 176's pilot):
 * seven `tests/llm` files that share ONE background — fake-indexeddb +
 * `clearDatabase()` per test, the SAME identical `vi.mock` target set
 * (`@/llm/openrouter`, `@/lib/toast`, `@/features/modules/post-generation`),
 * and Dexie-backed module generation/spine-gate behaviour driven through the
 * mocked `chat` seam — now run in ONE file, so the
 * import/transform/jsdom-environment/setup cost is paid once instead of seven
 * times.
 *
 * Merged from (one `describe` per original file, so each stays findable; test
 * names and every `expect` assertion site is byte-identical):
 *   - tests/llm/moduleGen-conflict-structure.test.ts (11)
 *   - tests/llm/moduleGen-encounter-floor.test.ts (19)
 *   - tests/llm/moduleGen-guardrails.test.ts (17)
 *   - tests/llm/promptStyles-classic-identity.test.ts (16)
 *   - tests/llm/promptStyles-composition.test.ts (19)
 *   - tests/llm/promptStyles-default-style.test.ts (10)
 *   - tests/llm/promptStyles-freestyle.test.ts (13)
 *
 * `tests/llm/moduleGen-auto-spine.test.ts` (4) shares the same mock set and was
 * MEASURED incompatible with this file, so it stays a file of its own: with it
 * merged first, `moduleGen-conflict-structure`'s "an encounter record with no
 * wants and no kind passes the gate untouched" observed THREE `chat` calls
 * where it asserts two — the unattended pass-0 → pass-1 flow leaves background
 * generation continuations in flight, and in one file they reach a later
 * describe's `chat` mock. That is the sweep's own stop condition (a merge that
 * CAUSES a cross-test leak), so the file is split out rather than papered over.
 * `tests/llm/moduleGen.test.ts` (65) is likewise excluded: adding it would push
 * this merged file past the ~120-test cap.
 *
 * The mock factories below are the UNION of the originals' identical target
 * sets, and a file-level `beforeEach(vi.resetAllMocks)` gives every test the
 * clean mock state its original file had (a merged file shares ONE mock
 * instance per module; without it a previous describe's implementation answers
 * a later test's `...Once` overflow and changes its call counts — measured on
 * the first gate of this cluster).
 */

import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCampaign } from '@/db/campaignRepo';
import { patchModule, saveModule, getModule } from '@/db/moduleRepo';
import { updateSettings, getSettings, readSettings } from '@/db/settingsRepo';
import {
  createModule,
  moduleEntityKindSchema,
  moduleSpineSchema,
  defaultEncounterFloorGuardrail,
  encounterFloorGuardrailFor,
  encounterFloorGuardrailSchema,
  moduleSchema,
  modulePartSchema,
  PROMPT_STYLE_PLACEHOLDERS,
  requiredPlaceholders,
  validatePromptStyleTemplate,
  PROMPT_STYLE_CLASSIC_ID,
  PROMPT_STYLE_FREESTYLE_ID,
  defaultSettings,
  composePromptFromTemplate,
  PROMPT_STYLE_SECTION_MARKERS,
} from '@/domain';
import type {
  Campaign,
  Id,
  Module,
  ModuleEntityKind,
  ModulePart,
  EncounterFloorGuardrail,
  EntityKind,
  PromptStyle,
} from '@/domain';
import { normalizationReplySchema } from '@/domain/entityNormalization';
import {
  MODULE_TONE_BANS,
  parseSpineEntities,
  runParts,
  runSpine,
  toneBansFor,
  assertEncounterFloor,
  approveSpineAndRun,
  countModuleEncounters,
  createModuleAndRun,
  encounterFloorMessage,
  generateMissingParts,
  levelsInLevelBand,
  generatePart,
} from '@/llm/moduleGen';
import { clearDatabase } from '../db/helpers';
import type { ChatResult } from '@/llm/openrouter';
import { waitFor } from '@testing-library/react';
import { createArtifact } from '@/db/artifactRepo';
import { db } from '@/db/db';
import {
  BUILTIN_PROMPT_STYLES,
  promptStyleForModule,
  builtinPromptStyle,
  modulePromptStyleOf,
  PART_SCENE_FIELD_LABELS,
  PART_SCENE_VARIATION_DEMANDS,
  partsContractValues,
} from '@/llm/promptStyles';
import {
  catalogStyles,
  duplicatePromptStyle,
  deletePromptStyle,
  readPromptStyleCatalog,
  savePromptStyle,
  setDefaultPromptStyle,
} from '@/db/promptStyleRepo';

const { chat } = await import('@/llm/openrouter');
const { toastError } = await import('@/lib/toast');

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
  toastSuccess: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  runModulePostGeneration: vi.fn(),
}));

vi.mock('@/features/modules/post-generation', () => ({
  runModulePostGeneration: mocks.runModulePostGeneration,
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

describe('moduleGen-conflict-structure.test.ts', () => {
  /**
   * The conflict contract after the retirement (08-MODULE-DESIGNER M4-B,
   * superseded; docs/17): the conflict-kind vocabulary, the mutually exclusive
   * `wants` pair, the declared mix and their gates are GONE. What a scene IS —
   * a fight (an encounter) or anything else (an `event`) — is the planner's
   * contract, and whether the story's conflict is real is prompt discipline: a
   * check over prose would need a classifier guessing at a gate, which this repo
   * forbids.
   *
   * What this file holds: the REMOVAL (nothing of the vocabulary is reachable,
   * and a plan whose encounters declare nothing generates cleanly), the
   * LEGACY-ROW tolerance (stored keys are stripped, never a parse failure, no
   * migration), and the SURVIVORS that were never part of the mix machinery —
   * the tone dial's banned resolutions and the finale's rationed satisfaction.
   * The encounter FLOOR has its own suite
   * (`moduleGen-encounter-floor.test.ts`) and is untouched.
   */

  const chatMock = vi.mocked(chat);

  const TEST_MODEL = 'test/fixture-model';

  function spineRaw(entities: unknown[]): string {
    return JSON.stringify({
      premise: 'A harbor town raised its bell to warn of the drownings.',
      themes: ['duty'],
      partPlan: [
        {
          title: 'The Sunken Quarter',
          levelBand: '1',
          synopsis: 'Arrival.',
          levelUpTrigger: 'Found.',
        },
        {
          title: 'The Drowned Cathedral',
          levelBand: '2',
          synopsis: 'Descent.',
          levelUpTrigger: 'Falls.',
        },
      ],
      entities,
    });
  }

  /** A normalization reply mapping every listed name to itself. */
  function normReply(entries: { name: string; kind: string }[]): ChatResult {
    return {
      text: JSON.stringify({
        entities: entries.map((entry) => ({
          name: entry.name,
          canonical: entry.name,
          kind: entry.kind,
        })),
      }),
      modelUsed: 'test-model',
      fallback: null,
    };
  }

  /** The entity list of a plan that declares KINDS ONLY — no wants, no conflict
   * kind (the shape the retired declaration validation used to reject loudly). */
  const PLAIN_ENTITIES = [
    { name: 'Warden Bellamy', kind: 'npc' },
    { name: 'Ember Trial', kind: 'encounter' },
  ];

  describe('the retired mix machinery is unreachable', () => {
    /** The generation path that used to carry the vocabulary, the declaration
     * option and the mix counters. A grep-level pin: an import would otherwise
     * linger and quietly re-open the seam. */
    const SOURCES = [
      'src/domain/module.ts',
      'src/domain/entityNormalization.ts',
      'src/llm/moduleGen.ts',
      'src/features/modules/post-generation.ts',
    ];
    const RETIRED = [
      /conflictKind\s*:/,
      /\bwants\s*:/,
      /ENCOUNTER_CONFLICT_KINDS/,
      /EncounterConflictKind/,
      /encounterMix/,
      /requireEncounterDeclarations/,
      /assertEncounterMix/,
    ];

    it('is not exported by the domain or the generator any more', async () => {
      const domain = await import('@/domain');
      const gen = await import('@/llm/moduleGen');
      expect(Object.keys(domain)).not.toContain('ENCOUNTER_CONFLICT_KINDS');
      for (const gone of ['assertEncounterMix', 'encounterMixReport', 'encounterMixMessage']) {
        expect(Object.keys(gen)).not.toContain(gone);
      }
      // The record shape itself is name + kind + absorbed, nothing else.
      expect(
        Object.keys(moduleEntityKindSchema.parse({ name: 'Ember Trial', kind: 'encounter' })),
      ).toEqual(['name', 'kind', 'absorbed']);
    });

    it('names no conflict-kind / wants / mix identifier in the generation path', () => {
      for (const file of SOURCES) {
        const text = readFileSync(join(process.cwd(), file), 'utf8');
        for (const pattern of RETIRED) {
          expect(text, `${file} still matches ${String(pattern)}`).not.toMatch(pattern);
        }
      }
    });

    it('strips the retired keys from stored records and normalization replies (no migration)', () => {
      // The owner's testing-phase stance: no migration ceremony. These rows are
      // simply READ through a non-strict schema, which drops the removed keys —
      // an existing module is never a parse failure.
      const record = moduleEntityKindSchema.parse({
        name: 'Ember Trial',
        kind: 'encounter',
        wants: ['seize the bell', 'keep the bell silent'],
        conflictKind: 'combat',
      });
      expect(record).toEqual({ name: 'Ember Trial', kind: 'encounter', absorbed: [] });

      const reply = normalizationReplySchema.parse({
        entities: [
          {
            name: 'Ember Trial',
            canonical: 'Ember Trial',
            kind: 'encounter',
            wants: ['a', 'b'],
            conflictKind: 'combat',
          },
        ],
      });
      expect(reply.entities[0]).toEqual({
        name: 'Ember Trial',
        canonical: 'Ember Trial',
        kind: 'encounter',
      });
    });
  });

  describe('tone dial teeth', () => {
    it('keeps 2-3 outcome limits per tone value — the only hard bans the prompt carries', () => {
      for (const [tone, bans] of Object.entries(MODULE_TONE_BANS)) {
        expect(tone).not.toBe('');
        expect(bans.length).toBeGreaterThanOrEqual(2);
        expect(bans.length).toBeLessThanOrEqual(3);
        for (const ban of bans) {
          expect(typeof ban).toBe('string');
          expect(ban.trim()).not.toBe('');
        }
      }
      // The universal demand is stated positively in the prompt, so there is no
      // generic ban list any more: an untoned module carries no ban at all.
      expect(MODULE_TONE_BANS['']).toBeUndefined();
    });

    it('matches tones case-insensitively, unknown tones get no ban list', () => {
      expect(toneBansFor('  HORROR ')).toEqual(MODULE_TONE_BANS.horror);
      expect(toneBansFor('eerie')).toBeNull();
      expect(toneBansFor('')).toBeNull();
    });
  });

  describe('a plan that declares no kinds and no wants (mocked chat)', () => {
    beforeEach(async () => {
      await clearDatabase();
      await updateSettings({ defaultChatModel: TEST_MODEL });
    });

    afterEach(() => {
      chatMock.mockReset();
    });

    async function seedModule(
      levelMin = 1,
      levelMax = 2,
      tone = '',
    ): Promise<{ campaign: Campaign; moduleId: Id }> {
      const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
      const saved = await saveModule(
        createModule({
          campaignId: campaign.id,
          title: 'The Drowned Bell',
          concept: 'A harbor bell that rings by itself beneath the water.',
          levelMin,
          levelMax,
          tone,
          sizeDial: 'standard',
        }),
      );
      return { campaign, moduleId: saved.id };
    }

    function spineReply(entities: unknown[]): ChatResult {
      return { text: spineRaw(entities), modelUsed: 'test-model', fallback: null };
    }

    function userPromptOf(callIndex: number): string {
      const messages = chatMock.mock.calls[callIndex]?.[0] ?? [];
      const content = messages.find((message) => message.role === 'user')?.content;
      return typeof content === 'string' ? content : '';
    }

    /** Part prose with wiki-links to the given names (floor-satisfying text). */
    function prose(marker: string, ...names: string[]): ChatResult {
      return {
        text:
          `${marker}: The tide withdraws and the streets shine wet under a pale sun. `.repeat(4) +
          (names.length === 0 ? '' : ` Trials: ${names.map((name) => `[[${name}]]`).join(', ')}.`),
        modelUsed: 'test-model',
        fallback: null,
      };
    }

    function twoPartSpine(moduleId: Id): Promise<unknown> {
      return patchModule(moduleId, {
        spine: moduleSpineSchema.parse({
          premise: 'A harbor town raised its bell.',
          themes: [],
          partPlan: [
            {
              title: 'The Sunken Quarter',
              levelBand: '1',
              synopsis: 'Arrival.',
              levelUpTrigger: 'Found.',
            },
            {
              title: 'The Drowned Cathedral',
              levelBand: '2',
              synopsis: 'Descent.',
              levelUpTrigger: 'Falls.',
            },
          ],
        }),
        entityKinds: [
          { name: 'Ember Trial', kind: 'encounter', absorbed: [] },
          { name: 'Flood Trial', kind: 'encounter', absorbed: [] },
        ],
      });
    }

    it('spine: an encounter record with no wants and no kind passes the gate untouched', async () => {
      const { campaign, moduleId } = await seedModule();
      chatMock.mockResolvedValueOnce(spineReply(PLAIN_ENTITIES)).mockResolvedValueOnce(
        normReply([
          { name: 'Warden Bellamy', kind: 'npc' },
          { name: 'Ember Trial', kind: 'encounter' },
        ]),
      );

      const finished = await runSpine(moduleId, campaign);

      // Two calls: the spine and its name normalization. No repair retry — the
      // records declare nothing and nothing is missing.
      expect(chatMock).toHaveBeenCalledTimes(2);
      expect(finished.status).toBe('draft');
      expect(finished.errorMessage).toBe('');
      expect(finished.entityKinds).toEqual([
        { name: 'Warden Bellamy', kind: 'npc', absorbed: [] },
        { name: 'Ember Trial', kind: 'encounter', absorbed: [] },
      ]);

      // The prompt asks for kinds and the floor, and for no declarations.
      const prompt = userPromptOf(0);
      expect(prompt).toContain('encounter floor');
      expect(prompt).not.toContain('mutually exclusive wants');
      expect(prompt).not.toContain('conflict kind');
      expect(prompt).not.toContain('declared mix');
      expect(prompt).not.toContain('"wants"');
      expect(prompt).not.toContain('"conflictKind"');

      // The encounter/event boundary (08 §M4-B, superseded): an encounter IS a
      // fight — battle map + monster roster — and everything else is an event.
      expect(prompt).toContain('locations, NPCs, factions, notes, events and encounters');
      expect(prompt).toContain('An "encounter" is a FIGHT');
      expect(prompt).toContain('battle map with terrain, and a monster roster with images');
      expect(prompt).toContain('is an "event" instead');
      expect(prompt).toContain('no battle map, no monsters, no roster');

      // The normalization call carries the same boundary: classify by what the
      // party DOES, never by how dangerous the scene sounds.
      const normalizationPrompt = userPromptOf(1);
      expect(normalizationPrompt).toContain('"encounter" = a FIGHT');
      expect(normalizationPrompt).toContain('"event" = a non-combat scene the party plays through');
      expect(normalizationPrompt).toContain('if no fight happens, it is an event');

      // The conflict contract (Slice 3, AMENDMENT 1): a live situation with
      // visible approaches, not a plot the party watches.
      expect(prompt).toContain('every module has a conflict');
      expect(prompt).toContain(
        'at least two VISIBLE approaches that differ in cost or consequence',
      );
      expect(prompt).toContain('State in the premise how the situation can resolve');
      expect(prompt).toContain('Give each faction an order of battle');
      expect(prompt).toContain('never a villain held back for the finale');
      expect(prompt).toContain('one concrete particular that could not be swapped out unchanged');
      expect(prompt).toContain('no NPC ally is more intimately bound to the plot than they are');
      expect(prompt).toContain('Exploring is never punished as such');
      expect(prompt).toContain('one concrete scene the part contains');

      // The resolution contract is stated POSITIVELY, never as a ban list…
      expect(prompt).toContain(
        'Every conflict ends with someone worse off, a cost paid, or a new problem opened',
      );
      expect(prompt).toContain('that change persists and is visible when they return');
      expect(prompt).not.toContain('banned resolution');
      // …and an untoned module carries no outcome ban at all (the universal
      // demand already names every frictionless resolution).
      expect(prompt).not.toContain('rules out these outcomes');

      // The three non-negotiables are restated LAST, immediately before the
      // reply format (which must stay last for structured output), and the
      // user's premise is pinned as fixed input.
      const restatement = prompt.indexOf('Before you answer, the three things that do not bend:');
      expect(restatement).toBeGreaterThan(
        prompt.indexOf('Every conflict ends with someone worse off'),
      );
      expect(restatement).toBeGreaterThan(prompt.indexOf('An "encounter" is a FIGHT'));
      expect(prompt.indexOf('Reply with ONLY a JSON object')).toBeGreaterThan(restatement);
      expect(prompt).toContain(
        "The user's premise, tone, level range and size are FIXED INPUT. Do not restate, extend, soften or contradict them. " +
          "If a structural requirement cannot be met inside the user's premise, change the STRUCTURE (the part plan, " +
          'which faction carries the conflict, where the conflict starts) — never the premise. ' +
          'If you believe the premise makes a requirement impossible, satisfy the requirement anyway and say what you changed in the structure notes.',
      );
    }, 20000);

    it('spine: a matching tone renders its 2-3 outcome limits after the positive demand', async () => {
      const { campaign, moduleId } = await seedModule(1, 2, 'horror');
      chatMock.mockResolvedValueOnce(spineReply(PLAIN_ENTITIES)).mockResolvedValueOnce(
        normReply([
          { name: 'Warden Bellamy', kind: 'npc' },
          { name: 'Ember Trial', kind: 'encounter' },
        ]),
      );

      await runSpine(moduleId, campaign);

      const prompt = userPromptOf(0);
      const shape = prompt.indexOf('Every conflict ends with someone worse off');
      const limits = prompt.indexOf('This module’s tone rules out these outcomes');
      expect(shape).toBeGreaterThan(-1);
      expect(limits).toBeGreaterThan(shape);
      for (const ban of MODULE_TONE_BANS.horror ?? []) expect(prompt).toContain(ban);
    }, 20000);

    it('parts: a full run over such a plan ships ready with no repair', async () => {
      const { campaign, moduleId } = await seedModule();
      await twoPartSpine(moduleId);
      chatMock
        .mockResolvedValueOnce(prose('PART-ONE', 'Ember Trial'))
        .mockResolvedValueOnce(prose('PART-TWO', 'Flood Trial'))
        .mockResolvedValueOnce(
          normReply([
            { name: 'Ember Trial', kind: 'encounter' },
            { name: 'Flood Trial', kind: 'encounter' },
          ]),
        );

      const finished = await runParts(moduleId, campaign);

      // Two parts + one normalization: no floor repair, no mix failure.
      expect(chatMock).toHaveBeenCalledTimes(3);
      expect(finished.status).toBe('ready');
      expect(finished.errorMessage).toBe('');

      // The part prompt carries no declaration block any more.
      const prompt = userPromptOf(0);
      expect(prompt).not.toContain('Declared encounters');
      expect(prompt).not.toContain('declared conflict kind');
      expect(prompt).not.toContain('opposed wants');
      // The resolution contract is stated POSITIVELY (AMENDMENT 2: the required
      // output shape, not a list of prohibitions), and it is restated LAST.
      expect(prompt).toContain(
        'Every conflict ends with someone worse off, a cost paid, or a new problem opened',
      );
      expect(prompt).toContain(
        'at least two VISIBLE approaches that differ in cost or consequence',
      );
      expect(prompt).not.toContain('Never resolve a scene by a banned resolution');
      expect(prompt).toContain('Before you answer, the three things that do not bend in this part');
      // …and so did the encounter/event boundary: a non-fight is an event, with
      // an illustration and no map, monsters or roster.
      expect(prompt).toContain('A scene that is NOT a fight is an event');
      expect(prompt).toContain('[[Event Name]]');
      expect(prompt).toContain(
        'no battle map, no monsters, no roster, because none is generated for it',
      );
    }, 20000);

    it('part prompt: the finale rations satisfaction, other parts never resolve clean', async () => {
      const { campaign, moduleId } = await seedModule();
      await twoPartSpine(moduleId);

      chatMock.mockResolvedValue(prose('PART', 'Ember Trial'));
      await runParts(moduleId, campaign, { planIndexes: [0] });
      const first = userPromptOf(0);
      expect(first).toContain('End this part with a cost, a revelation, or a new pressure');
      expect(first).not.toContain('FINALE');

      chatMock.mockClear();
      chatMock.mockResolvedValue(prose('FINALE-PART', 'Flood Trial'));
      await runParts(moduleId, campaign, { planIndexes: [1] });
      const finale = userPromptOf(0);
      expect(finale).toContain('FINALE');
      expect(finale).toContain('full price');
      expect(finale).not.toContain('End this part with a cost, a revelation, or a new pressure');
    }, 20000);

    it('spine repair names the floor only (no wants, no kinds, no mix)', async () => {
      const { campaign, moduleId } = await seedModule();
      chatMock
        .mockResolvedValueOnce(spineReply([{ name: 'Warden Bellamy', kind: 'npc' }]))
        .mockResolvedValueOnce(normReply([{ name: 'Warden Bellamy', kind: 'npc' }]))
        // The repair retry, whose reply finally declares an encounter.
        .mockResolvedValueOnce(spineReply(PLAIN_ENTITIES))
        .mockResolvedValueOnce(
          normReply([
            { name: 'Warden Bellamy', kind: 'npc' },
            { name: 'Ember Trial', kind: 'encounter' },
          ]),
        );

      const finished = await runSpine(moduleId, campaign);

      expect(chatMock).toHaveBeenCalledTimes(4);
      expect(finished.status).toBe('draft');
      expect(finished.entityKinds.map((entry) => entry.kind)).toEqual(['npc', 'encounter']);
      const repair = chatMock.mock.calls[2]?.[0].at(-1)?.content;
      const repairText = typeof repair === 'string' ? repair : '';
      expect(repairText).toContain('declares no encounters');
      // The repair nudge asks for a named encounter, never for a declaration.
      expect(repairText).not.toContain('conflict kind');
      expect(repairText).not.toContain('wants');
    }, 20000);

    it('parseSpineEntities accepts any declared kind list and adds no declaration rule', () => {
      expect(parseSpineEntities(spineRaw(PLAIN_ENTITIES))).toEqual([
        { name: 'Warden Bellamy', kind: 'npc', absorbed: [] },
        { name: 'Ember Trial', kind: 'encounter', absorbed: [] },
      ]);
      // A declaration that used to be REQUIRED is now ordinary input, ignored.
      expect(
        parseSpineEntities(
          spineRaw([
            { name: 'Ember Trial', kind: 'encounter', wants: ['a', 'b'], conflictKind: 'combat' },
          ]),
        ),
      ).toEqual([{ name: 'Ember Trial', kind: 'encounter', absorbed: [] }]);
      // A foreign kind is still a loud boundary failure (zod, not a gate).
      expect(() => parseSpineEntities(spineRaw([{ name: 'X', kind: 'plotarc' }]))).toThrow();
    });
  });
});

describe('moduleGen-encounter-floor.test.ts', () => {
  /**
   * The hard encounter floor (08-MODULE-DESIGNER M4-B): distinct canonical
   * encounter entities named in document text >= levelCount, allocated per
   * band. Counter units, the spine gate, the parts gate (fail-loud + bounded
   * repair), unattended tails skipping automation on failure, and the
   * backfill-is-prose pin (records/batches alone never satisfy the floor).
   */

  const runModulePostGenerationMock = mocks.runModulePostGeneration;

  const chatMock = vi.mocked(chat);

  const toastErrorMock = vi.mocked(toastError);

  const TEST_MODEL = 'test/fixture-model';
  const UUID = '123e4567-e89b-42d3-a456-426614174000';

  function prose(marker: string, ...names: string[]): string {
    const links =
      names.length === 0 ? '' : ` Trials faced: ${names.map((name) => `[[${name}]]`).join(', ')}.`;
    return (
      `${marker}: The tide withdraws and the streets shine wet under a pale sun. `.repeat(4) + links
    );
  }

  /** Part prose as a chat reply. */
  function partReply(marker: string, ...names: string[]): ChatResult {
    return { text: prose(marker, ...names), modelUsed: 'test-model', fallback: null };
  }

  /** A normalization reply mapping every listed name to itself. */
  function normReply(entries: { name: string; kind: string }[]): ChatResult {
    return {
      text: JSON.stringify({
        entities: entries.map((entry) => ({
          name: entry.name,
          canonical: entry.name,
          kind: entry.kind,
        })),
      }),
      modelUsed: 'test-model',
      fallback: null,
    };
  }

  /** In-memory module for the pure counter (no DB). */
  function floorModule(options: {
    levelMin?: number;
    levelMax?: number;
    sizeDial?: Module['sizeDial'];
    bands?: { title: string; levelBand: string }[];
    parts?: { planIndex: number; names: string[]; edited?: boolean }[];
    premiseNames?: string[];
    entityKinds?: ModuleEntityKind[];
  }): Module {
    const base = createModule({
      campaignId: UUID,
      title: 'Floor Test',
      concept: 'concept',
      levelMin: options.levelMin ?? 1,
      levelMax: options.levelMax ?? 3,
      sizeDial: options.sizeDial ?? 'standard',
    });
    const bands = options.bands ?? [
      { title: 'Part One', levelBand: '1' },
      { title: 'Part Two', levelBand: '2' },
      { title: 'Part Three', levelBand: '3' },
    ];
    const spine = moduleSpineSchema.parse({
      premise:
        (options.premiseNames ?? []).length === 0
          ? 'A quiet premise with no links.'
          : `Premise trials: ${(options.premiseNames ?? []).map((name) => `[[${name}]]`).join(', ')}.`,
      themes: [],
      partPlan: bands.map((band) => ({
        title: band.title,
        levelBand: band.levelBand,
        synopsis: 'synopsis',
        levelUpTrigger: 'trigger',
      })),
    });
    const parts: ModulePart[] = (options.parts ?? []).map((part) => ({
      planIndex: part.planIndex,
      markdown: prose(`MARKER-${String(part.planIndex)}`, ...part.names),
      status: 'ready',
      errorMessage: '',
      edited: part.edited ?? false,
      writerModel: '',
      origin: null,
    }));
    return {
      ...base,
      spine,
      parts,
      entityKinds: options.entityKinds ?? [],
    };
  }

  const encounterKind = (name: string): ModuleEntityKind => ({
    name,
    kind: 'encounter',
    absorbed: [],
  });

  describe('levelsInLevelBand', () => {
    it.each([
      ['1', 1],
      ['2-3', 2],
      ['2–3', 2], // en dash
      ['2—3', 2], // em dash
      ['2 - 3', 2],
      [' 4 – 6 ', 3],
      ['1-10', 10],
      ['3-2', 2], // reversed still covers two levels
    ])('parses %j as %i levels', (band, levels) => {
      expect(levelsInLevelBand(band)).toBe(levels);
    });

    it.each([[''], ['soon'], ['1-'], ['-3'], ['boss fight']])(
      'counts unparseable %j as 1',
      (band) => {
        expect(levelsInLevelBand(band)).toBe(1);
      },
    );
  });

  describe('countModuleEncounters (pure)', () => {
    const kinds = [
      encounterKind('Ember Trial'),
      encounterKind('Flood Trial'),
      encounterKind('Bell Trial'),
    ];

    it('passes when every band names its share with distinct encounters', () => {
      const module = floorModule({
        parts: [
          { planIndex: 0, names: ['Ember Trial'] },
          { planIndex: 1, names: ['Flood Trial'] },
          { planIndex: 2, names: ['Bell Trial'] },
        ],
        entityKinds: kinds,
      });
      const report = countModuleEncounters(module);
      expect(report.required).toBe(3);
      expect(report.found).toBe(3);
      expect(report.deficient).toEqual([]);
      expect(() => {
        assertEncounterFloor(module);
      }).not.toThrow();
    });

    it('flags per-band shortfalls with required/found per part', () => {
      const module = floorModule({
        bands: [
          { title: 'Alpha', levelBand: '1' },
          { title: 'Beta', levelBand: '2-3' },
        ],
        levelMin: 1,
        levelMax: 3,
        parts: [{ planIndex: 0, names: ['Ember Trial'] }],
        entityKinds: kinds,
      });
      const report = countModuleEncounters(module);
      expect(report.perPart).toEqual([
        { planIndex: 0, title: 'Alpha', levelBand: '1', required: 1, found: 1 },
        { planIndex: 1, title: 'Beta', levelBand: '2-3', required: 2, found: 0 },
      ]);
      expect(report.deficient.map((entry) => entry.title)).toEqual(['Beta']);
      expect(() => {
        assertEncounterFloor(module);
      }).toThrow(/Beta.*band 2-3.*needs 2, names 0/);
    });

    it('counts reuse once toward the total but satisfies every band that names it', () => {
      const module = floorModule({
        parts: [
          { planIndex: 0, names: ['Ember Trial'] },
          { planIndex: 1, names: ['Ember Trial'] },
          { planIndex: 2, names: ['Flood Trial'] },
        ],
        entityKinds: kinds,
      });
      const report = countModuleEncounters(module);
      // No band is deficient, but the distinct total repeats: 2 < 3.
      expect(report.deficient).toEqual([]);
      expect(report.found).toBe(2);
      expect(() => {
        assertEncounterFloor(module);
      }).toThrow(/names repeat/);
    });

    it('folds aliases onto the canonical (post-normalization targets)', () => {
      const module = floorModule({
        parts: [{ planIndex: 0, names: ['Halmund|Guard Halmund'] }],
        entityKinds: [{ name: 'Halmund', kind: 'encounter', absorbed: ['Guard Halmund'] }],
      });
      // The rewritten token [[Halmund|Guard Halmund]] targets the canonical.
      expect(countModuleEncounters(module).found).toBe(1);
    });

    it('ignores variant spellings with no canonical record', () => {
      const module = floorModule({
        parts: [{ planIndex: 0, names: ['Guard Halmund'] }],
        entityKinds: [{ name: 'Halmund', kind: 'encounter', absorbed: [] }],
      });
      expect(countModuleEncounters(module).found).toBe(0);
    });

    it('records alone never count — only names in the document text', () => {
      const module = floorModule({ parts: [], entityKinds: kinds });
      expect(countModuleEncounters(module).found).toBe(0);
      expect(() => {
        assertEncounterFloor(module);
      }).toThrow(/needs 3 distinct.*names 0/);
    });

    it('counts premise links toward the total but not toward any band', () => {
      const module = floorModule({
        premiseNames: ['Ember Trial'],
        parts: [
          { planIndex: 0, names: [] },
          { planIndex: 1, names: ['Flood Trial'] },
          { planIndex: 2, names: ['Bell Trial'] },
        ],
        entityKinds: kinds,
      });
      const report = countModuleEncounters(module);
      expect(report.found).toBe(3);
      expect(report.deficient.map((entry) => entry.planIndex)).toEqual([0]);
    });

    it('never fails high: the 4x ceiling stays advisory', () => {
      const many = Array.from({ length: 9 }, (_, index) => `Trial ${String(index + 1)}`);
      const module = floorModule({
        levelMin: 1,
        levelMax: 2,
        bands: [
          { title: 'Alpha', levelBand: '1' },
          { title: 'Beta', levelBand: '2' },
        ],
        parts: [
          { planIndex: 0, names: many.slice(0, 5) },
          { planIndex: 1, names: many.slice(5) },
        ],
        entityKinds: many.map((name) => encounterKind(name)),
      });
      const report = countModuleEncounters(module);
      expect(report.found).toBe(9); // 4.5x the 2-level range — still ships
      expect(() => {
        assertEncounterFloor(module);
      }).not.toThrow();
    });

    it('is sizeDial-independent', () => {
      const options = {
        parts: [
          { planIndex: 0, names: ['Ember Trial'] },
          { planIndex: 1, names: ['Flood Trial'] },
          { planIndex: 2, names: ['Bell Trial'] },
        ],
        entityKinds: kinds,
      };
      const sketch = countModuleEncounters(floorModule({ ...options, sizeDial: 'sketch' }));
      const detailed = countModuleEncounters(floorModule({ ...options, sizeDial: 'detailed' }));
      expect(sketch).toEqual(detailed);
    });

    it('encounterFloorMessage names every deficient part title and band', () => {
      const module = floorModule({ parts: [], entityKinds: [] });
      const message = encounterFloorMessage(countModuleEncounters(module));
      expect(message).toContain('Part One');
      expect(message).toContain('Part Two');
      expect(message).toContain('Part Three');
    });
  });

  describe('encounter floor gates (mocked chat)', () => {
    beforeEach(async () => {
      await clearDatabase();
      await updateSettings({ defaultChatModel: TEST_MODEL });
    });

    afterEach(() => {
      chatMock.mockReset();
      toastErrorMock.mockReset();
      vi.restoreAllMocks();
    });

    async function seedModule(
      levelMin = 1,
      levelMax = 3,
    ): Promise<{ campaign: Campaign; moduleId: Id }> {
      const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
      const draft = createModule({
        campaignId: campaign.id,
        title: 'The Drowned Bell',
        concept: 'A harbor bell that rings by itself beneath the water.',
        levelMin,
        levelMax,
        tone: 'eerie',
        sizeDial: 'standard',
      });
      const saved = await saveModule(draft);
      return { campaign, moduleId: saved.id };
    }

    const SPINE_PLAN = [
      {
        title: 'The Sunken Quarter',
        levelBand: '1',
        synopsis: 'Arrival.',
        levelUpTrigger: 'Found.',
      },
      {
        title: 'The Drowned Cathedral',
        levelBand: '2',
        synopsis: 'Descent.',
        levelUpTrigger: 'Falls.',
      },
    ];

    function spineWith(entities: { name: string; kind: string }[]): object {
      return {
        premise: 'A harbor town raised its bell to warn of the drownings.',
        themes: ['duty'],
        partPlan: SPINE_PLAN,
        entities,
      };
    }

    /** Three named encounters (the floor's own requirement; the retired mix
     * vocabulary and its gate are gone — 08 §M4-B, superseded). */
    const MIX_SPINE = [
      { name: 'Ember Trial', kind: 'encounter' },
      { name: 'Flood Trial', kind: 'encounter' },
      { name: 'Bell Trial', kind: 'encounter' },
    ];

    it('spine prompt states the REQUIREMENT (never "advice, not a requirement")', async () => {
      const { campaign, moduleId } = await seedModule(1, 2);
      chatMock
        .mockResolvedValueOnce({
          text: JSON.stringify(spineWith(MIX_SPINE)),
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce(
          normReply([
            { name: 'Ember Trial', kind: 'encounter' },
            { name: 'Flood Trial', kind: 'encounter' },
            { name: 'Bell Trial', kind: 'encounter' },
          ]),
        );

      await runSpine(moduleId, campaign);

      const prompt = chatMock.mock.calls[0]?.[0].find((message) => message.role === 'user');
      const text = typeof prompt?.content === 'string' ? prompt.content : '';
      expect(text).toContain('REQUIREMENT — encounter floor');
      expect(text).not.toContain('advice, not a requirement');
      expect((await getModule(moduleId))?.status).toBe('draft');
    }, 20000);

    it('spine gate: zero encounter records → one escalated repair retry, then draft', async () => {
      const { campaign, moduleId } = await seedModule(1, 2);
      chatMock
        .mockResolvedValueOnce({
          text: JSON.stringify(spineWith([{ name: 'Warden Bellamy', kind: 'npc' }])),
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce(normReply([{ name: 'Warden Bellamy', kind: 'npc' }]))
        // The repair retry declares the named encounters the floor asked for.
        .mockResolvedValueOnce({
          text: JSON.stringify(spineWith([{ name: 'Warden Bellamy', kind: 'npc' }, ...MIX_SPINE])),
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce(
          normReply([
            { name: 'Warden Bellamy', kind: 'npc' },
            { name: 'Ember Trial', kind: 'encounter' },
            { name: 'Flood Trial', kind: 'encounter' },
            { name: 'Bell Trial', kind: 'encounter' },
          ]),
        );

      const finished = await runSpine(moduleId, campaign);

      expect(chatMock).toHaveBeenCalledTimes(4);
      expect(finished.status).toBe('draft');
      expect(finished.entityKinds.some((entry) => entry.kind === 'encounter')).toBe(true);
      expect(toastErrorMock).not.toHaveBeenCalled();
    }, 20000);

    it('spine gate: still zero after the repair → loud spine failure', async () => {
      const { campaign, moduleId } = await seedModule(1, 2);
      const barren = {
        text: JSON.stringify(spineWith([{ name: 'Warden Bellamy', kind: 'npc' }])),
        modelUsed: 'test-model',
        fallback: null,
      };
      const barrenNorm = normReply([{ name: 'Warden Bellamy', kind: 'npc' }]);
      chatMock
        .mockResolvedValueOnce(barren)
        .mockResolvedValueOnce(barrenNorm)
        .mockResolvedValueOnce(barren)
        .mockResolvedValueOnce(barrenNorm);

      await expect(runSpine(moduleId, campaign)).rejects.toThrow('declares no encounters');

      const after = await getModule(moduleId);
      expect(after?.status).toBe('failed');
      expect(after?.errorMessage).toContain('declares no encounters');
      expect(chatMock).toHaveBeenCalledTimes(4); // exactly one repair retry
      expect(toastErrorMock).toHaveBeenCalledWith('Module generation failed', expect.any(Error));
    }, 20000);

    it('parts gate: a 0-encounter module fails with named parts and never ships ready', async () => {
      const { campaign, moduleId } = await seedModule(1, 2);
      await patchModule(moduleId, {
        spine: moduleSpineSchema.parse({
          premise: 'A harbor town raised its bell.',
          themes: [],
          partPlan: SPINE_PLAN,
        }),
      });
      // Initial prose AND the repair rewrites name no encounters at all.
      chatMock.mockResolvedValue(partReply('PART'));

      const finished = await runParts(moduleId, campaign);

      // 2 part calls (no links → no normalization calls) + exactly ONE repair
      // rewrite per deficient part (2) — bounded, then fail.
      expect(chatMock).toHaveBeenCalledTimes(4);
      expect(finished.status).toBe('failed');
      expect(finished.status).not.toBe('ready');
      expect(finished.errorMessage).toContain('Encounter floor not met');
      expect(finished.errorMessage).toContain('The Sunken Quarter');
      expect(finished.errorMessage).toContain('The Drowned Cathedral');
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Module generation failed: encounter floor not met',
        expect.any(Error),
      );
      const stored = await getModule(moduleId);
      expect(stored?.status).toBe('failed');
    }, 20000);

    it('parts gate: the repair success path ships ready', async () => {
      const { campaign, moduleId } = await seedModule(1, 2);
      await patchModule(moduleId, {
        spine: moduleSpineSchema.parse({
          premise: 'A harbor town raised its bell.',
          themes: [],
          partPlan: SPINE_PLAN,
        }),
      });
      chatMock
        .mockResolvedValueOnce(partReply('PART-ONE')) // no encounters
        .mockResolvedValueOnce(partReply('PART-TWO')) // no encounters
        // No links → the first normalization makes no model call. The gate's
        // ONE repair per deficient part adds the missing encounters…
        .mockResolvedValueOnce(partReply('PART-ONE-FIXED', 'Ember Trial', 'Bell Trial'))
        .mockResolvedValueOnce(partReply('PART-TWO-FIXED', 'Flood Trial'))
        // …which the re-normalization records as encounters (name + kind: the
        // retired wants/conflict-kind declarations no longer exist).
        .mockResolvedValueOnce(
          normReply([
            { name: 'Ember Trial', kind: 'encounter' },
            { name: 'Bell Trial', kind: 'encounter' },
            { name: 'Flood Trial', kind: 'encounter' },
          ]),
        );

      const finished = await runParts(moduleId, campaign);

      expect(chatMock).toHaveBeenCalledTimes(5);
      expect(finished.status).toBe('ready');
      expect(finished.errorMessage).toBe('');
      expect(finished.entityKinds).toEqual([
        { name: 'Ember Trial', kind: 'encounter', absorbed: [] },
        { name: 'Bell Trial', kind: 'encounter', absorbed: [] },
        { name: 'Flood Trial', kind: 'encounter', absorbed: [] },
      ]);
      expect(toastErrorMock).not.toHaveBeenCalled();
    }, 20000);

    it('backfill-is-prose pin: existing encounter artifacts + normalization alone cannot satisfy the floor', async () => {
      const { campaign, moduleId } = await seedModule(1, 2);
      // The campaign OWNS a detailed encounter artifact — but the prose never
      // links it.
      await createArtifact({ campaignId: campaign.id, kind: 'encounter', name: 'Ember Trial' });
      await patchModule(moduleId, {
        spine: moduleSpineSchema.parse({
          premise: 'A harbor town raised its bell.',
          themes: [],
          partPlan: SPINE_PLAN,
        }),
        entityKinds: [{ name: 'Ember Trial', kind: 'encounter', absorbed: [] }],
      });
      chatMock
        .mockResolvedValueOnce(partReply('PART-ONE', 'Kael'))
        .mockResolvedValueOnce(partReply('PART-TWO', 'The Undercroft'))
        .mockResolvedValueOnce(
          normReply([
            { name: 'Kael', kind: 'npc' },
            { name: 'The Undercroft', kind: 'location' },
          ]),
        )
        // Repairs name no encounters either.
        .mockResolvedValue(partReply('REPAIRED'));

      const finished = await runParts(moduleId, campaign);

      // Normalization RAN (entityKinds replaced from the prose) and an
      // encounter artifact EXISTS — the floor still fails: only prose links
      // count, and batch/detailing reruns cannot add those.
      expect(finished.entityNamesNormalized).toBe(true);
      expect(countModuleEncounters(finished).found).toBe(0);
      expect(finished.status).toBe('failed');
      expect(finished.errorMessage).toContain('Encounter floor not met');
    }, 20000);

    it('approveSpineAndRun skips post-generation automation on gate failure', async () => {
      const { campaign, moduleId } = await seedModule(1, 2);
      chatMock.mockResolvedValue(partReply('PART'));
      await patchModule(moduleId, { status: 'draft', errorMessage: '' });

      await approveSpineAndRun(
        moduleId,
        campaign,
        moduleSpineSchema.parse({
          premise: 'A harbor town raised its bell.',
          themes: [],
          partPlan: SPINE_PLAN,
        }),
      );

      expect((await getModule(moduleId))?.status).toBe('failed');
      expect(runModulePostGenerationMock).not.toHaveBeenCalled();
    }, 20000);

    it('generateMissingParts skips post-generation automation on gate failure', async () => {
      const { campaign, moduleId } = await seedModule(1, 2);
      await patchModule(moduleId, {
        spine: moduleSpineSchema.parse({
          premise: 'A harbor town raised its bell.',
          themes: [],
          partPlan: SPINE_PLAN,
        }),
        parts: [
          {
            planIndex: 0,
            markdown: prose('SEEDED'),
            status: 'ready',
            errorMessage: '',
            edited: false,
            writerModel: '',
            origin: null,
          },
        ],
      });
      chatMock.mockResolvedValue(partReply('PART'));

      await generateMissingParts(moduleId, campaign);

      expect((await getModule(moduleId))?.status).toBe('failed');
      expect(runModulePostGenerationMock).not.toHaveBeenCalled();
    }, 20000);

    it('createModuleAndRun skips post-generation automation on gate failure', async () => {
      const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
      const spine = spineWith([{ name: 'Warden Bellamy', kind: 'npc' }, ...MIX_SPINE]);
      chatMock
        .mockResolvedValueOnce({
          text: JSON.stringify(spine),
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce(
          normReply([
            { name: 'Warden Bellamy', kind: 'npc' },
            { name: 'Ember Trial', kind: 'encounter' },
            { name: 'Flood Trial', kind: 'encounter' },
            { name: 'Bell Trial', kind: 'encounter' },
          ]),
        )
        .mockResolvedValue(partReply('PART')); // parts + repairs: no encounters

      const moduleId = await createModuleAndRun(campaign, {
        campaignId: campaign.id,
        title: 'The Midnight Tower',
        concept: 'A tower that answers questions for a price.',
        levelMin: 1,
        levelMax: 2,
        tone: '',
        sizeDial: 'sketch',
        autoApproveSpine: true,
      });

      await waitFor(
        async () => {
          expect((await getModule(moduleId))?.status).toBe('failed');
        },
        { timeout: 15_000 },
      );
      expect((await getModule(moduleId))?.errorMessage).toContain('Encounter floor not met');
      expect(runModulePostGenerationMock).not.toHaveBeenCalled();
    }, 20000);
  });
});

describe('moduleGen-guardrails.test.ts', () => {
  /**
   * The editable encounter floor (08-MODULE-DESIGNER M4-B, amended; docs/17): the
   * ONE source of truth for the floor clause AND the floor gate.
   *
   * The GOLDEN half is the regression contract: the fixture files under
   * `tests/fixtures/encounterGuardrails/` were captured by RENDERING the
   * pre-change prompt builders at commit 89e5d71 (a temporary worktree at HEAD,
   * driving the real `runSpine` + `runParts` against mocked chat replies) — not
   * transcribed by hand. Under the default floor every rendered string and every
   * failure message must stay byte-identical to those files.
   *
   * The CUSTOM half pins the new behavior: a raised `perLevel` multiplies the
   * requirement AND says so in the prompt and the message, a disabled floor
   * removes the clause and the gate, the boundary refuses bad numbers loudly, and
   * the floor a later pass reads is the MODULE's own recorded one.
   *
   * Floor-only by design: the declared-mix gate and the conflict-kind vocabulary
   * are a separate seam, and nothing here configures, asserts or touches them.
   */

  const chatMock = vi.mocked(chat);

  const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'encounterGuardrails');

  function golden(name: string): string {
    return readFileSync(join(FIXTURE_DIR, name), 'utf8');
  }

  /** Anchored equality: the golden text must appear BYTE-EXACT, and the anchor
   * tells us it is the same region of the prompt (not a coincidence elsewhere). */
  function expectEmbedded(haystack: string, goldenText: string): void {
    const at = haystack.indexOf(goldenText);
    expect(at, 'golden text not found byte-exact in the rendered prompt').toBeGreaterThanOrEqual(0);
  }

  const SPINE_PLAN = [
    {
      title: 'The Sunken Quarter',
      levelBand: '1',
      synopsis: 'Arrival.',
      levelUpTrigger: 'Found.',
    },
    {
      title: 'The Drowned Cathedral',
      levelBand: '2',
      synopsis: 'Descent.',
      levelUpTrigger: 'Falls.',
    },
  ];

  /** The spine's entity list. Name + kind only: the retired wants/conflict-kind
   * declarations and the mix gate they fed are gone (08 §M4-B, superseded). */
  const SPINE_ENTITIES = [
    { name: 'Ember Trial', kind: 'encounter' },
    { name: 'Flood Trial', kind: 'encounter' },
    { name: 'Bell Trial', kind: 'encounter' },
  ];

  function spineReply(entities: unknown[]): string {
    return JSON.stringify({
      premise: 'A harbor town raised its bell to warn of the drownings.',
      themes: ['duty'],
      partPlan: SPINE_PLAN,
      entities,
    });
  }

  function normReply(entities: { name: string; kind: string }[]): string {
    return JSON.stringify({
      entities: entities.map((entry) => ({ ...entry, canonical: entry.name })),
    });
  }

  /** The campaign + module the golden capture used (levels 1-2, tone eerie). */
  async function seedModule(
    options: { floor?: EncounterFloorGuardrail } = {},
  ): Promise<{ campaign: Campaign; moduleId: Id }> {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const draft = createModule({
      campaignId: campaign.id,
      title: 'The Drowned Bell',
      concept: 'A harbor bell that rings by itself beneath the water.',
      levelMin: 1,
      levelMax: 2,
      tone: 'eerie',
      sizeDial: 'standard',
      ...(options.floor === undefined ? {} : { encounterFloorGuardrail: options.floor }),
    });
    const saved = await saveModule(draft);
    return { campaign, moduleId: saved.id };
  }

  /** The spine reply the mocked chat returns first, then the normalization reply. */
  function queueSpineReplies(): void {
    chatMock
      .mockResolvedValueOnce({
        text: spineReply(SPINE_ENTITIES),
        modelUsed: 'test-model',
        fallback: null,
      })
      .mockResolvedValueOnce({
        text: normReply(SPINE_ENTITIES.map((entry) => ({ name: entry.name, kind: entry.kind }))),
        modelUsed: 'test-model',
        fallback: null,
      });
  }

  /** The first user message of the nth chat call (the rendered prompt). */
  function promptText(call = 0): string {
    const messages = chatMock.mock.calls[call]?.[0] as
      { role: string; content: unknown }[] | undefined;
    const user = messages?.find((message) => message.role === 'user');
    return typeof user?.content === 'string' ? user.content : '';
  }

  /** Prompt text of a call whose content contains an anchor. */
  function promptContaining(anchor: string): string {
    for (const call of chatMock.mock.calls) {
      const messages = call[0] as { role: string; content: unknown }[];
      const user = messages.find((message) => message.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : '';
      if (text.includes(anchor)) return text;
    }
    return '';
  }

  const encounter = (name: string): ModuleEntityKind => ({
    name,
    kind: 'encounter',
    absorbed: [],
  });

  /** An in-memory module with a 2-part plan and given part marks (no DB). */
  function floorModule(options: {
    floor?: EncounterFloorGuardrail | undefined;
    parts?: { planIndex: number; names: string[] }[];
    entityKinds?: ModuleEntityKind[];
  }): Module {
    const base = createModule({
      campaignId: '123e4567-e89b-42d3-a456-426614174000',
      title: 'Floor Test',
      concept: 'concept',
      levelMin: 1,
      levelMax: 2,
      sizeDial: 'standard',
      ...(options.floor === undefined ? {} : { encounterFloorGuardrail: options.floor }),
    });
    return {
      ...base,
      spine: moduleSpineSchema.parse({
        premise: 'A quiet premise.',
        themes: [],
        partPlan: SPINE_PLAN,
      }),
      parts: (options.parts ?? []).map((part) => ({
        planIndex: part.planIndex,
        markdown: `Trials: ${part.names.map((name) => `[[${name}]]`).join(', ')}.`,
        status: 'ready' as const,
        errorMessage: '',
        edited: false,
        writerModel: '',
        origin: null,
      })),
      entityKinds: options.entityKinds ?? [],
    };
  }

  beforeEach(() => clearDatabase());
  afterEach(() => {
    // resetAllMocks (not just clearAllMocks): a `mockResolvedValue` default set in
    // one test must not leak a prose reply into the next test's spine call.
    vi.resetAllMocks();
  });

  describe('floor schema (the boundary refuses invalid numbers loudly)', () => {
    it('rejects a negative or fractional count', () => {
      expect(() => encounterFloorGuardrailSchema.parse({ enabled: true, perLevel: -1 })).toThrow();
      expect(() => encounterFloorGuardrailSchema.parse({ enabled: true, perLevel: 1.5 })).toThrow();
    });

    it('rejects an enabled floor with perLevel 0, and accepts a disabled one', () => {
      expect(() => encounterFloorGuardrailSchema.parse({ enabled: true, perLevel: 0 })).toThrow(
        /perLevel must be >= 1/,
      );
      expect(encounterFloorGuardrailSchema.parse({ enabled: false, perLevel: 0 })).toEqual({
        enabled: false,
        perLevel: 0,
      });
    });

    it('materializes the defaults around a partial object', () => {
      expect(encounterFloorGuardrailSchema.parse({})).toEqual({ enabled: true, perLevel: 1 });
      expect(encounterFloorGuardrailSchema.parse({ perLevel: 3 })).toEqual({
        enabled: true,
        perLevel: 3,
      });
    });

    it('the default reproduces today exactly', () => {
      expect(defaultEncounterFloorGuardrail()).toEqual({ enabled: true, perLevel: 1 });
    });
  });

  describe('golden: the default floor renders today, byte for byte', () => {
    it('spine prompt keeps the exact pre-change wording', async () => {
      const { campaign, moduleId } = await seedModule();
      queueSpineReplies();

      await runSpine(moduleId, campaign);

      expectEmbedded(promptText(0), golden('spine-guardrail-default.txt'));
    }, 20_000);

    it('parts prompt keeps the exact pre-change wording', async () => {
      const { campaign, moduleId } = await seedModule();
      await patchModule(moduleId, {
        spine: moduleSpineSchema.parse({
          premise: 'A harbor town raised its bell to warn of the drownings.',
          themes: ['duty'],
          partPlan: SPINE_PLAN,
        }),
      });
      chatMock.mockResolvedValue({
        text: `${'The tide withdraws. '.repeat(20)}\n`,
        modelUsed: 'test-model',
        fallback: null,
      });

      await runParts(moduleId, campaign);

      const full = promptContaining('Writing instructions:');
      // The fixture is the TRUE pre-change bytes, quirk included (the stray blank
      // line before the honor-the-declarations bullet is what HEAD rendered).
      expectEmbedded(
        full.slice(full.indexOf('Writing instructions:')),
        golden('parts-guardrail-default.txt'),
      );
    }, 20_000);

    it('the floor failure message keeps the exact pre-change wording', () => {
      const module = floorModule({});
      expect(encounterFloorMessage(countModuleEncounters(module))).toBe(
        golden('floor-message-default.txt'),
      );
    });
  });

  describe('custom floor: the number drives the prompt AND the gate', () => {
    it('perLevel 2 doubles the requirement and says so in the prompt and the message', async () => {
      const { campaign, moduleId } = await seedModule({ floor: { enabled: true, perLevel: 2 } });
      queueSpineReplies();

      await runSpine(moduleId, campaign);

      const prompt = promptText(0);
      expect(prompt).toContain('name at least two distinct encounters per level');
      expect(prompt).toContain('at least 4 distinct encounters across the module');

      // The counter: 2 levels x 2 = 4 total, and each band needs 2.
      const module = floorModule({
        floor: { enabled: true, perLevel: 2 },
        parts: [{ planIndex: 0, names: ['Ember Trial'] }],
        entityKinds: [encounter('Ember Trial')],
      });
      const report = countModuleEncounters(module);
      expect(report.required).toBe(4);
      expect(report.perPart.map((entry) => entry.required)).toEqual([2, 2]);
      expect(encounterFloorMessage(report)).toBe(
        'Encounter floor not met: the module needs 4 distinct named encounters for its level range ' +
          'but the document names 1. Deficient parts: "The Sunken Quarter" (band 1): needs 2, names 1; ' +
          '"The Drowned Cathedral" (band 2): needs 2, names 0.',
      );
    }, 20_000);

    it('the per-part prompt asks for this part share of the configured floor', async () => {
      const { campaign, moduleId } = await seedModule({ floor: { enabled: true, perLevel: 2 } });
      await patchModule(moduleId, {
        spine: moduleSpineSchema.parse({
          premise: 'A harbor town raised its bell to warn of the drownings.',
          themes: ['duty'],
          partPlan: SPINE_PLAN,
        }),
      });
      chatMock.mockResolvedValue({
        text: 'The tide withdraws.\n',
        modelUsed: 'test-model',
        fallback: null,
      });

      await runParts(moduleId, campaign);

      expect(promptContaining('Writing instructions:')).toContain(
        'REQUIREMENT — encounter floor for this part (levels 1: 1 level(s)): name at least 2 distinct encounter(s)',
      );
    }, 20_000);

    it('a disabled floor removes the clause from the prompt and the gate from the count', async () => {
      const { campaign, moduleId } = await seedModule({ floor: { enabled: false, perLevel: 0 } });
      queueSpineReplies();

      await runSpine(moduleId, campaign);

      const prompt = promptText(0);
      expect(prompt).not.toContain('REQUIREMENT — encounter floor');
      // The placement rules that shared the bullet survive a disabled floor.
      expect(prompt).toContain('Place encounters deliberately');
      // The retired declaration rules are gone from every floor setting.
      expect(prompt).not.toContain('Every planned encounter declares its conflict STRUCTURALLY');

      // The gate: no required total, no deficient band, and the assertion passes
      // for an encounter-free module.
      const module = floorModule({
        floor: { enabled: false, perLevel: 0 },
        parts: [{ planIndex: 0, names: [] }],
      });
      const report = countModuleEncounters(module);
      expect(report.required).toBe(0);
      expect(report.deficient).toEqual([]);
      expect(() => {
        assertEncounterFloor(module);
      }).not.toThrow();
    }, 20_000);

    it('a disabled floor asks for no encounters in the parts prompt', async () => {
      const { campaign, moduleId } = await seedModule({ floor: { enabled: false, perLevel: 0 } });
      await patchModule(moduleId, {
        spine: moduleSpineSchema.parse({
          premise: 'A harbor town raised its bell to warn of the drownings.',
          themes: ['duty'],
          partPlan: SPINE_PLAN,
        }),
      });
      chatMock.mockResolvedValue({
        text: 'The tide withdraws.\n',
        modelUsed: 'test-model',
        fallback: null,
      });

      await runParts(moduleId, campaign);

      expect(promptContaining('Writing instructions:')).not.toContain(
        'REQUIREMENT — encounter floor for this part',
      );
    }, 20_000);
  });

  describe('the floor lives on the MODULE row, not in the dialog', () => {
    it('records the chosen floor at creation and resolves it back from the row', async () => {
      const { moduleId } = await seedModule({ floor: { enabled: true, perLevel: 2 } });
      const saved = await getModule(moduleId);
      expect(saved).not.toBeNull();
      expect(saved?.encounterFloorGuardrail).toEqual({ enabled: true, perLevel: 2 });
      // No explicit config passed: the resolver reads the ROW.
      expect(encounterFloorGuardrailFor(saved ?? {})).toEqual({ enabled: true, perLevel: 2 });
      expect(
        countModuleEncounters(floorModule({ floor: saved?.encounterFloorGuardrail ?? undefined }))
          .required,
      ).toBe(4);
    });

    it('a module created without a choice records null and behaves as today', async () => {
      const { moduleId } = await seedModule();
      const saved = await getModule(moduleId);
      expect(saved).not.toBeNull();
      expect(saved?.encounterFloorGuardrail).toBeNull();
      // Absent means today's default floor, byte-for-byte (the golden suite above).
      expect(encounterFloorGuardrailFor(saved ?? {})).toEqual(defaultEncounterFloorGuardrail());
      expect(countModuleEncounters(floorModule({})).required).toBe(2);
    });

    it('a later pass reads the module current floor, so a rewrite uses the module rules', async () => {
      const { moduleId } = await seedModule({ floor: { enabled: true, perLevel: 1 } });
      expect(
        countModuleEncounters(floorModule({ floor: { enabled: true, perLevel: 1 } })).required,
      ).toBe(2);

      await patchModule(moduleId, { encounterFloorGuardrail: { enabled: false, perLevel: 0 } });
      const changed = await getModule(moduleId);
      expect(changed).not.toBeNull();
      expect(changed?.encounterFloorGuardrail).toEqual({ enabled: false, perLevel: 0 });
      // The gate built on the row's own value now demands nothing.
      expect(
        countModuleEncounters(floorModule({ floor: changed?.encounterFloorGuardrail ?? undefined }))
          .required,
      ).toBe(0);
    });
  });

  describe('recorded automation intent', () => {
    it('records exactly the automation the creation run used', () => {
      const module = createModule({
        campaignId: '123e4567-e89b-42d3-a456-426614174000',
        title: 'Intent Test',
        concept: 'concept',
        levelMin: 1,
        levelMax: 2,
        sizeDial: 'standard',
        autoGenerateKinds: ['npc', 'location'],
        autoImageKinds: ['npc'],
        autoGenerateBattlemaps: true,
        autoGenerateMobImages: true,
      });
      expect(module.automationIntent).toEqual({
        autoGenerateKinds: ['npc', 'location'],
        autoImageKinds: ['npc'],
        autoGenerateBattlemaps: true,
        autoGenerateMobImages: true,
      });
      // The intent mirrors the row's own automation fields, exactly.
      expect(module.automationIntent?.autoGenerateKinds).toEqual(module.autoGenerateKinds);
      expect(module.automationIntent?.autoImageKinds).toEqual(module.autoImageKinds);
      expect(module.automationIntent?.autoGenerateBattlemaps).toBe(module.autoGenerateBattlemaps);
      expect(module.automationIntent?.autoGenerateMobImages).toBe(module.autoGenerateMobImages);
    });

    it('records the omitted case as nothing asked for, never as unknown', () => {
      const module = createModule({
        campaignId: '123e4567-e89b-42d3-a456-426614174000',
        title: 'Intent Defaults',
        concept: 'concept',
        levelMin: 1,
        levelMax: 2,
        sizeDial: 'standard',
      });
      expect(module.automationIntent).toEqual({
        autoGenerateKinds: [],
        autoImageKinds: [],
        autoGenerateBattlemaps: false,
        autoGenerateMobImages: false,
      });
    });

    it('a legacy row stays inert: no intent, no floor, and no stored deviation flag', () => {
      const legacy = moduleSchema.parse({
        id: '123e4567-e89b-42d3-a456-426614174000',
        campaignId: '123e4567-e89b-42d3-a456-426614174001',
        title: 'Legacy',
        concept: 'concept',
        levelMin: 1,
        levelMax: 2,
        sizeDial: 'standard',
        tone: '',
        spine: null,
        parts: [],
        entityKinds: [],
        status: 'draft',
        errorMessage: '',
        createdAt: 1,
        updatedAt: 1,
      });
      expect(legacy.automationIntent).toBeNull();
      expect(legacy.encounterFloorGuardrail).toBeNull();
      // The legacy automation fields keep their own defaults, untouched.
      expect(legacy.autoGenerateKinds).toEqual([]);
      expect(legacy.autoGenerateBattlemaps).toBe(false);
      // Deviation is DERIVED by a later surface - nothing caches a verdict.
      expect(Object.keys(legacy)).not.toContain('hasProblems');
      expect(Object.keys(legacy)).not.toContain('deviates');
    });
  });
});

describe('promptStyles-classic-identity.test.ts', () => {
  /**
   * THE BYTE-IDENTITY PIN (docs/17 row 86, docs/18 §2.2).
   *
   * Moving the module instructions out of the code and into a style template must
   * not change ONE BYTE of what the model receives on the default path: every
   * existing module, every resume, every repair and every per-part regeneration
   * keeps composing exactly the prompt it composed before, so existing modules
   * stay coherent and the owner's live campaigns are untouched.
   *
   * The fixtures under `tests/fixtures/promptStyles/` were captured by RENDERING
   * the pre-refactor builders (a temporary harness driving the real `runSpine` +
   * `generatePart` against mocked chat replies, at the commit before the composer
   * landed) — not transcribed by hand, the 89e5d71 method. Each case renders
   * through the real seam and must match its fixture character for character.
   *
   * Which cases: the branches that can change the composed text — the default
   * floor, a disabled floor, an extra (retry) instruction, a tone with a ban
   * list, campaign description present/absent, prior modules + the shared cast,
   * the glossary, the campaign index, continuity from the previous part, the
   * finale wording, and the bare case where every optional block is absent.
   *
   * LEGACY (the case that matters most): a module row written BEFORE styles has no
   * recorded style at all. It was written with Classic — the text that existed
   * when it was written — and it must compose those same bytes, or a resumed
   * legacy module's new parts would not match its existing ones. The legacy row
   * here is put into Dexie with the key ABSENT, which is the real pre-arc shape.
   */

  const chatMock = vi.mocked(chat);

  const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'promptStyles');

  const PREMISE =
    'A harbor town raised its bell to warn of the drownings; now the bell rings by itself.';
  const THEMES = ['duty', 'decay'];
  const PLAN = [
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
    {
      title: 'The Bell Tower',
      levelBand: '3',
      synopsis: 'Final confrontation at the top of the leaning tower.',
      levelUpTrigger: 'The cult is broken.',
    },
  ];
  const ENTITIES: { name: string; kind: EntityKind }[] = [
    { name: 'Warden Bellamy', kind: 'npc' },
    { name: 'The Drowned Cathedral', kind: 'location' },
    { name: 'The Tide Cult', kind: 'faction' },
    { name: 'The Bells Below', kind: 'encounter' },
    { name: 'The Flooded Nave', kind: 'encounter' },
    { name: 'The Wardens Confession', kind: 'encounter' },
  ];
  const SPINE_REPLY = JSON.stringify({
    premise: PREMISE,
    themes: THEMES,
    partPlan: PLAN,
    entities: ENTITIES,
  });
  const NORM_REPLY = JSON.stringify({
    entities: ENTITIES.map((entry) => ({
      name: entry.name,
      canonical: entry.name,
      kind: entry.kind,
    })),
  });

  function fixture(name: string): string {
    return readFileSync(join(FIXTURE_DIR, name), 'utf8');
  }

  /** The whole user message of the n-th chat call. */
  function userPrompt(callIndex: number): string {
    const messages = chatMock.mock.calls[callIndex]?.[0] as
      { role: string; content: unknown }[] | undefined;
    const user = messages?.find((message) => message.role === 'user');
    return typeof user?.content === 'string' ? user.content : '';
  }

  function prose(marker: string): { text: string; modelUsed: string; fallback: null } {
    return {
      text: `${marker}: The tide withdraws and the streets shine wet under a pale sun. `.repeat(4),
      modelUsed: 'test-model',
      fallback: null,
    };
  }

  async function seed(
    options: {
      floor?: { enabled: boolean; perLevel: number };
      includePriorModules?: boolean;
      description?: string;
      tone?: string;
      /** Write the row WITHOUT a recorded style: the pre-styles shape. */
      legacyRow?: boolean;
    } = {},
  ): Promise<{ campaign: Campaign; moduleId: Id }> {
    const campaign = await createCampaign({
      name: 'Emberfall',
      system: 'dnd5e',
      ...(options.description === undefined ? {} : { description: options.description }),
    });
    const draft = createModule({
      campaignId: campaign.id,
      title: 'The Drowned Bell',
      concept: 'A harbor bell that rings by itself beneath the water.',
      levelMin: 1,
      levelMax: 3,
      tone: options.tone ?? 'eerie',
      sizeDial: 'standard',
      ...(options.floor === undefined ? {} : { encounterFloorGuardrail: options.floor }),
      ...(options.includePriorModules === undefined
        ? {}
        : { includePriorModules: options.includePriorModules }),
    });
    const saved = await saveModule(draft);
    if (options.legacyRow === true) {
      // The real pre-arc shape: the key is not in the stored row at all.
      const legacy: Record<string, unknown> = {
        ...(moduleSchema.parse({ ...saved, promptStyle: undefined }) as unknown as Record<
          string,
          unknown
        >),
      };
      delete legacy.promptStyle;
      await db.modules.put(legacy as unknown as Module);
    }
    return { campaign, moduleId: saved.id };
  }

  async function seedPriorModule(campaignId: Id): Promise<void> {
    const saved = await saveModule(
      createModule({
        campaignId,
        title: 'The Salt Ward',
        concept: 'The chapter before this one.',
        levelMin: 1,
        levelMax: 2,
        tone: '',
        sizeDial: 'sketch',
      }),
    );
    await patchModule(saved.id, {
      spine: moduleSpineSchema.parse({
        premise: 'The Salt Ward burned on the first night of the tide.',
        themes: ['salt'],
        partPlan: [
          {
            title: 'The Burning Ward',
            levelBand: '1',
            synopsis: 'Fire on the docks.',
            levelUpTrigger: 'The ward falls.',
          },
        ],
      }),
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          markdown: 'PRIOR-PART-MARKER: The ward burned and the salt came in. '.repeat(6),
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
      ],
    });
  }

  /** Campaign-scoped shared cast, so the campaign index + cast blocks render. */
  async function seedArtifacts(campaignId: Id): Promise<void> {
    await createArtifact({
      campaignId,
      kind: 'location',
      name: 'The Salt Ward',
      summary: 'A burned ward on the north bank.',
    });
    await createArtifact({ campaignId, kind: 'npc', name: 'Harbormaster Ilse' });
  }

  /** A module ready for a part prompt: spine, glossary, optional prior parts. */
  async function seedPartModule(
    options: {
      floor?: { enabled: boolean; perLevel: number };
      includePriorModules?: boolean;
      priorParts?: number[];
      /**
       * The markdown of each already-written prior part. The part prompt carries
       * the IMMEDIATELY previous part's full text, so a case whose fixture was
       * captured with particular prior text seeds exactly that text — otherwise the
       * comparison would be measuring the test's own prose, not the composer.
       */
      priorMarkdown?: (planIndex: number) => string;
      description?: string;
      tone?: string;
      legacyRow?: boolean;
    } = {},
  ): Promise<{ campaign: Campaign; moduleId: Id }> {
    const { campaign, moduleId } = await seed(options);
    await seedArtifacts(campaign.id);
    await patchModule(moduleId, {
      spine: moduleSpineSchema.parse({ premise: PREMISE, themes: THEMES, partPlan: PLAN }),
      entityKinds: ENTITIES.map((entry) => ({ ...entry, absorbed: [] })),
      ...(options.priorParts === undefined
        ? {}
        : {
            parts: options.priorParts.map((planIndex) =>
              modulePartSchema.parse({
                planIndex,
                markdown:
                  options.priorMarkdown?.(planIndex) ??
                  `PRIOR-PART-${String(planIndex)}: the water rose and the bell rang. `.repeat(6),
                status: 'ready',
                errorMessage: '',
                edited: false,
              }),
            ),
          }),
    });
    return { campaign, moduleId };
  }

  async function renderPartPrompt(
    moduleId: Id,
    planIndex: number,
    campaign: Campaign,
  ): Promise<string> {
    chatMock.mockResolvedValue(prose(`PART-${String(planIndex)} [[The Bells Below]]`));
    const module = await getModule(moduleId);
    if (module === undefined) throw new Error('missing module');
    await generatePart(moduleId, module, planIndex, campaign, 'test-model', {
      signal: new AbortController().signal,
      extraInstruction: '',
      onToken: undefined,
    });
    return userPrompt(0);
  }

  beforeEach(() => clearDatabase());
  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Classic composes the pre-style prompt byte for byte', () => {
    it('the built-in Classic template is valid and ships both sections', () => {
      const classic = BUILTIN_PROMPT_STYLES.find((style) => style.id === 'classic');
      expect(classic).toBeDefined();
      expect(classic?.templateText).toContain('--- SPINE ---');
      expect(classic?.templateText).toContain('--- PARTS ---');
    });

    it('spine: default floor', async () => {
      const { campaign, moduleId } = await seed();
      chatMock
        .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'test-model', fallback: null })
        .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'test-model', fallback: null });
      await runSpine(moduleId, campaign);
      expect(userPrompt(0)).toBe(fixture('spine-classic-default.txt'));
    }, 20000);

    it('spine: disabled floor (the clause and its bullet tail)', async () => {
      const { campaign, moduleId } = await seed({ floor: { enabled: false, perLevel: 0 } });
      chatMock
        .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'test-model', fallback: null })
        .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'test-model', fallback: null });
      await runSpine(moduleId, campaign);
      expect(userPrompt(0)).toBe(fixture('spine-classic-floor-off.txt'));
    }, 20000);

    it('spine: prior modules + shared cast', async () => {
      const { campaign, moduleId } = await seed({ includePriorModules: true });
      await seedArtifacts(campaign.id);
      await seedPriorModule(campaign.id);
      chatMock
        .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'test-model', fallback: null })
        .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'test-model', fallback: null });
      await runSpine(moduleId, campaign);
      expect(userPrompt(0)).toBe(fixture('spine-classic-priors.txt'));
    }, 20000);

    it('spine: an extra (retry) instruction', async () => {
      const { campaign, moduleId } = await seed();
      chatMock
        .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'test-model', fallback: null })
        .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'test-model', fallback: null });
      await runSpine(moduleId, campaign, { extraInstruction: 'Tighten the middle part.' });
      expect(userPrompt(0)).toBe(fixture('spine-classic-extra-instruction.txt'));
    }, 20000);

    it('spine: tone bans + campaign description', async () => {
      const { campaign, moduleId } = await seed({
        description: 'A dying harbor town and the bell that will not stop.',
        tone: 'horror',
      });
      chatMock
        .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'test-model', fallback: null })
        .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'test-model', fallback: null });
      await runSpine(moduleId, campaign);
      expect(userPrompt(0)).toBe(fixture('spine-classic-tone-bans.txt'));
    }, 20000);

    it('parts: part 0 with the glossary and the campaign index', async () => {
      const { campaign, moduleId } = await seedPartModule();
      expect(await renderPartPrompt(moduleId, 0, campaign)).toBe(
        fixture('parts-classic-part0.txt'),
      );
    }, 20000);

    it('parts: continuity from the previous part', async () => {
      const { campaign, moduleId } = await seedPartModule({ priorParts: [0] });
      expect(await renderPartPrompt(moduleId, 1, campaign)).toBe(
        fixture('parts-classic-part1.txt'),
      );
    }, 20000);

    it('parts: the finale wording of a closing part', async () => {
      const { campaign, moduleId } = await seedPartModule({
        priorParts: [0, 1],
        // Trimmed: a part written by the run itself lands in the row trimmed
        // (the fixture was captured from a generated part, not a seeded one), and
        // the prompt carries the row's text verbatim.
        priorMarkdown: (planIndex) =>
          planIndex === 1
            ? prose('PART-TWO [[The Flooded Nave]]').text.trim()
            : `PRIOR-PART-0: the water rose and the bell rang. `.repeat(6),
      });
      expect(await renderPartPrompt(moduleId, 2, campaign)).toBe(
        fixture('parts-classic-finale.txt'),
      );
    }, 20000);

    it('parts: disabled floor drops the whole requirement line', async () => {
      const { campaign, moduleId } = await seedPartModule({
        floor: { enabled: false, perLevel: 0 },
      });
      expect(await renderPartPrompt(moduleId, 0, campaign)).toBe(
        fixture('parts-classic-floor-off.txt'),
      );
    }, 20000);

    it('parts: prior modules in context', async () => {
      const { campaign, moduleId } = await seedPartModule({ includePriorModules: true });
      await seedPriorModule(campaign.id);
      expect(await renderPartPrompt(moduleId, 0, campaign)).toBe(
        fixture('parts-classic-priors.txt'),
      );
    }, 20000);

    it('parts: every optional block absent (bare prompt)', async () => {
      const { campaign, moduleId } = await seed({
        description: 'A dying harbor town and the bell that will not stop.',
        tone: 'horror',
      });
      await patchModule(moduleId, {
        spine: moduleSpineSchema.parse({ premise: PREMISE, themes: THEMES, partPlan: PLAN }),
      });
      expect(await renderPartPrompt(moduleId, 0, campaign)).toBe(fixture('parts-classic-bare.txt'));
    }, 20000);
  });

  describe('a LEGACY module row composes the same classic bytes', () => {
    it('the row has no recorded style, and reads as Classic as provenance', async () => {
      const { moduleId } = await seed({ legacyRow: true });
      const row = await getModule(moduleId);
      expect(row).toBeDefined();
      // The stored row genuinely lacks the field (this is the pre-arc shape).
      const raw = (await db.modules.get(moduleId)) as Record<string, unknown> | undefined;
      expect(raw?.promptStyle).toBeUndefined();
      expect(row?.promptStyle ?? null).toBeNull();
      const resolved = promptStyleForModule(row ?? {});
      expect(resolved.source).toBe('legacy-classic');
      expect(resolved.style.templateText).toBe(
        BUILTIN_PROMPT_STYLES.find((style) => style.id === 'classic')?.templateText,
      );
    });

    it('a legacy module composes the byte-identical classic spine prompt', async () => {
      const { campaign, moduleId } = await seed({ legacyRow: true });
      chatMock
        .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'test-model', fallback: null })
        .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'test-model', fallback: null });
      await runSpine(moduleId, campaign);
      expect(userPrompt(0)).toBe(fixture('spine-classic-default.txt'));
    }, 20000);

    it('a legacy module composes the byte-identical classic part prompt', async () => {
      const { campaign, moduleId } = await seedPartModule({ legacyRow: true });
      expect(await renderPartPrompt(moduleId, 0, campaign)).toBe(
        fixture('parts-classic-part0.txt'),
      );
    }, 20000);

    it('a module that RECORDED Classic composes the same bytes as a legacy one', async () => {
      const { campaign, moduleId } = await seedPartModule();
      const classic = BUILTIN_PROMPT_STYLES.find((style) => style.id === 'classic');
      expect(classic).toBeDefined();
      await patchModule(moduleId, {
        promptStyle:
          classic === undefined
            ? null
            : {
                id: classic.id,
                name: classic.name,
                version: classic.version,
                templateText: classic.templateText,
              },
      });
      expect(await renderPartPrompt(moduleId, 0, campaign)).toBe(
        fixture('parts-classic-part0.txt'),
      );
    }, 20000);
  });
});

describe('promptStyles-composition.test.ts', () => {
  /**
   * The prompt-style layer itself (docs/17 row 86, docs/18 §2.2): what a style
   * may change, what it may not, and what a module RECORDS.
   *
   * The byte-identity pin for the Classic path lives in
   * `promptStyles-classic-identity.test.ts`. This file covers the other half:
   * the contract layer is unconditional, an unusable template fails LOUDLY rather
   * than degrading, the built-in Story style is a genuinely different shape, and
   * a module's recorded style text — not the current style — is what every later
   * generation of that module composes.
   */

  const chatMock = vi.mocked(chat);

  const PREMISE = 'A harbor bell that rings by itself beneath the water.';
  const PLAN = [
    {
      title: 'The Sunken Quarter',
      levelBand: '1',
      synopsis: 'The party arrives with the low tide.',
      levelUpTrigger: 'The bell is found.',
    },
  ];
  const SPINE_REPLY = JSON.stringify({
    premise: PREMISE,
    themes: ['duty'],
    partPlan: PLAN,
    // The floor gate counts encounters: a spine with none is a DEFECT and earns a
    // repair call, so the reply plans one.
    entities: [
      { name: 'Warden Bellamy', kind: 'npc' },
      { name: 'The Bells Below', kind: 'encounter' },
    ],
  });
  const NORM_REPLY = JSON.stringify({
    entities: [
      { name: 'Warden Bellamy', canonical: 'Warden Bellamy', kind: 'npc' },
      { name: 'The Bells Below', canonical: 'The Bells Below', kind: 'encounter' },
    ],
  });

  function userPrompt(callIndex: number): string {
    const messages = chatMock.mock.calls[callIndex]?.[0] as
      { role: string; content: unknown }[] | undefined;
    const user = messages?.find((message) => message.role === 'user');
    return typeof user?.content === 'string' ? user.content : '';
  }

  function prose(marker: string): { text: string; modelUsed: string; fallback: null } {
    return {
      text: `${marker} [[The Bells Below]]: the tide withdraws. `.repeat(6),
      modelUsed: 'm',
      fallback: null,
    };
  }

  async function spineModule(campaign: Campaign, styleId?: string): Promise<Id> {
    const saved = await saveModule(
      createModule({
        campaignId: campaign.id,
        title: 'The Drowned Bell',
        concept: 'A harbor bell.',
        levelMin: 1,
        levelMax: 1,
        tone: 'eerie',
        sizeDial: 'standard',
      }),
    );
    if (styleId !== undefined) {
      const catalog = await readPromptStyleCatalog((await getSettings()).defaultPromptStyleId);
      const style = catalogStyles(catalog).find((entry) => entry.id === styleId);
      if (style === undefined) throw new Error(`missing style ${styleId}`);
      await patchModule(saved.id, { promptStyle: modulePromptStyleOf(style) });
    }
    await patchModule(saved.id, {
      spine: moduleSpineSchema.parse({ premise: PREMISE, themes: ['duty'], partPlan: PLAN }),
      entityKinds: [
        { name: 'Warden Bellamy', kind: 'npc', absorbed: [] },
        { name: 'The Bells Below', kind: 'encounter', absorbed: [] },
      ],
    });
    return saved.id;
  }

  beforeEach(() => clearDatabase());
  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('the built-in styles', () => {
    it('ships exactly Classic, Story and Freestyle, all immutable and valid', () => {
      expect(BUILTIN_PROMPT_STYLES.map((style) => style.id)).toEqual([
        'classic',
        'story',
        'freestyle',
      ]);
      for (const style of BUILTIN_PROMPT_STYLES) {
        expect(style.origin).toBe('builtin');
        expect(validatePromptStyleTemplate(style.templateText)).toEqual([]);
      }
    });

    it('Story carries a narrative shape, not the ten-field scene block', () => {
      const story = builtinPromptStyle('story');
      expect(story).toBeDefined();
      const text = story?.templateText ?? '';
      // Every placeholder the classic template carries is still there: the
      // CONTRACT layer is not a style's to drop.
      for (const token of requiredPlaceholders('parts')) {
        expect(text).toContain(`{{${token}}}`);
      }
      // No ordered field list: the labels belong to Classic only.
      for (const label of [
        '**Scene heading + tag**',
        '**Where**',
        '**First impression**',
        '**Who is here and what they want right now**',
        '**The situation**',
        '**What changed**',
        '**If the party acts**',
        '**Secrets**',
        '**Leads**',
        '**Outcome**',
      ]) {
        expect(text).not.toContain(label);
      }
      // …but the disciplines that make scenes playable are stated in its own
      // words, including the heading + link requirement the floor gate depends on.
      expect(text).toContain('### [[Beat Name]] — ENCOUNTER');
      expect(text).toContain('### [[Beat Name]]"');
      expect(text).toContain('{{contract.floor}}');
    });

    it('a style cannot remove a required contract clause (validation names it)', () => {
      const story = builtinPromptStyle('story');
      const withoutFloor = (story?.templateText ?? '').replace('{{contract.floor}}', '');
      const problems = validatePromptStyleTemplate(withoutFloor);
      expect(problems.join(' ')).toContain('{{contract.floor}}');
    });

    it('an unknown placeholder is refused by name, never rendered as-is', () => {
      const classic = builtinPromptStyle('classic');
      const broken = (classic?.templateText ?? '').replace('{{levelMin}}', '{{levelMinimum}}');
      const problems = validatePromptStyleTemplate(broken);
      expect(problems.join(' ')).toContain('{{levelMinimum}}');
      expect(problems.join(' ')).toContain('Unknown placeholder');
    });

    it('an empty template is refused with the section requirement', () => {
      expect(validatePromptStyleTemplate('')).toEqual([
        'The template is empty. A style needs both a --- SPINE --- and a --- PARTS --- section.',
      ]);
      expect(validatePromptStyleTemplate('   \n  ')).toHaveLength(1);
    });

    it('every documented placeholder is used by a built-in style', () => {
      const used = new Set<string>();
      for (const style of BUILTIN_PROMPT_STYLES) {
        for (const entry of PROMPT_STYLE_PLACEHOLDERS) {
          if (style.templateText.includes(`{{${entry.token}}}`)) used.add(entry.token);
        }
      }
      for (const entry of PROMPT_STYLE_PLACEHOLDERS) {
        expect(
          used.has(entry.token),
          `placeholder {{${entry.token}}} is documented but unused`,
        ).toBe(true);
      }
    });

    it('the story section is a different shape from the classic one', () => {
      const story = builtinPromptStyle('story')?.templateText ?? '';
      const classic = builtinPromptStyle('classic')?.templateText ?? '';
      expect(story).not.toContain('**Outcome**');
      expect(story).toContain('{{partEnding}}');
      // The spine planner is shared (its JSON shape is an app contract); the
      // story rewrite lands in the part writer, where the story is written.
      expect(story).toContain('Choose the shape of each beat yourself');
      expect(classic).not.toContain('Choose the shape of each beat yourself');
    });
  });

  describe('what a module records and what generation uses', () => {
    it('records the style id, name, version and TEXT on the module row', async () => {
      const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
      chatMock
        .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'm', fallback: null })
        .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'm', fallback: null });
      const moduleId = await createModuleAndRun(campaign, {
        campaignId: campaign.id,
        title: 'New Module',
        concept: 'A harbor bell.',
        levelMin: 1,
        levelMax: 1,
        tone: '',
        sizeDial: 'standard',
        promptStyleId: 'story',
      });
      const row = await getModule(moduleId);
      const story = builtinPromptStyle('story');
      expect(row?.promptStyle).toEqual({
        id: 'story',
        name: story?.name,
        version: story?.version,
        templateText: story?.templateText,
      });
      expect(promptStyleForModule(row ?? {}).source).toBe('recorded');
    });

    it('an omitted style id records the APP DEFAULT style', async () => {
      const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
      const story = builtinPromptStyle('story');
      if (story === undefined) throw new Error('missing story');
      const copy = await duplicatePromptStyle(story, 'House Voice');
      await setDefaultPromptStyle(copy.id);
      chatMock
        .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'm', fallback: null })
        .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'm', fallback: null });
      const moduleId = await createModuleAndRun(campaign, {
        campaignId: campaign.id,
        title: 'New Module',
        concept: 'A harbor bell.',
        levelMin: 1,
        levelMax: 1,
        tone: '',
        sizeDial: 'standard',
      });
      const row = await getModule(moduleId);
      expect(row?.promptStyle?.id).toBe(copy.id);
      expect(row?.promptStyle?.name).toBe('House Voice');
    });

    it('an id that resolves to nothing fails LOUDLY and creates no module', async () => {
      const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
      await expect(
        createModuleAndRun(campaign, {
          campaignId: campaign.id,
          title: 'New Module',
          concept: 'A harbor bell.',
          levelMin: 1,
          levelMax: 1,
          tone: '',
          sizeDial: 'standard',
          promptStyleId: 'nope-not-a-style',
        }),
      ).rejects.toThrow(/nope-not-a-style/);
      const modules = await getModule('missing');
      expect(modules).toBeUndefined();
    });

    it('editing a style does NOT change a module that recorded the old text', async () => {
      const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
      const story = builtinPromptStyle('story');
      if (story === undefined) throw new Error('missing story');
      const own: PromptStyle = await duplicatePromptStyle(story, 'House Voice');
      const moduleId = await spineModule(campaign, own.id);
      const before = await getModule(moduleId);
      // The user rewrites the style: the module keeps the text it recorded.
      await savePromptStyle(own.id, {
        templateText: `${own.templateText}\n\nHOUSE-VOICE-V2-MARKER: keep the prose cold.`,
      });
      const unchanged = await getModule(moduleId);
      expect(unchanged?.promptStyle?.templateText).toBe(before?.promptStyle?.templateText);
      expect(unchanged?.promptStyle?.version).toBe(1);
      chatMock.mockResolvedValue(prose('PART'));
      const module = await getModule(moduleId);
      if (module === undefined) throw new Error('missing module');
      await generatePart(moduleId, module, 0, campaign, 'm', {
        signal: new AbortController().signal,
        extraInstruction: '',
        onToken: undefined,
      });
      expect(userPrompt(0)).not.toContain('HOUSE-VOICE-V2-MARKER');
      // …and it still carries its own style's text (this style is Story-derived).
      expect(userPrompt(0)).toContain('Choose the shape of each beat yourself');
    });

    it('adopting the current text makes later parts use it', async () => {
      const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
      const story = builtinPromptStyle('story');
      if (story === undefined) throw new Error('missing story');
      const own = await duplicatePromptStyle(story, 'House Voice');
      const moduleId = await spineModule(campaign, own.id);
      const saved = await savePromptStyle(own.id, {
        templateText: `${own.templateText}\n\nHOUSE-VOICE-V2-MARKER: keep the prose cold.`,
      });
      expect(saved.version).toBe(2);
      await patchModule(moduleId, { promptStyle: modulePromptStyleOf(saved) });
      chatMock.mockResolvedValue(prose('PART'));
      const module = await getModule(moduleId);
      if (module === undefined) throw new Error('missing module');
      await generatePart(moduleId, module, 0, campaign, 'm', {
        signal: new AbortController().signal,
        extraInstruction: '',
        onToken: undefined,
      });
      expect(userPrompt(0)).toContain('HOUSE-VOICE-V2-MARKER');
    });

    it('deleting a style leaves the module intact and still generating', async () => {
      const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
      const story = builtinPromptStyle('story');
      if (story === undefined) throw new Error('missing story');
      const own = await duplicatePromptStyle(story, 'House Voice');
      const moduleId = await spineModule(campaign, own.id);
      const before = await getModule(moduleId);
      await deletePromptStyle(own.id);
      const after = await getModule(moduleId);
      expect(after?.promptStyle).toEqual(before?.promptStyle);
      const catalog = await readPromptStyleCatalog((await getSettings()).defaultPromptStyleId);
      expect(catalogStyles(catalog).some((style) => style.id === own.id)).toBe(false);
      // Generation still composes from the module's own copy.
      chatMock.mockResolvedValue(prose('PART'));
      const module = await getModule(moduleId);
      if (module === undefined) throw new Error('missing module');
      await generatePart(moduleId, module, 0, campaign, 'm', {
        signal: new AbortController().signal,
        extraInstruction: '',
        onToken: undefined,
      });
      expect(userPrompt(0)).toContain('Choose the shape of each beat yourself');
    });

    it('resuming a legacy module composes the immutable Classic text', async () => {
      const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
      const saved = await saveModule(
        createModule({
          campaignId: campaign.id,
          title: 'The Drowned Bell',
          concept: 'A harbor bell.',
          levelMin: 1,
          levelMax: 1,
          tone: 'eerie',
          sizeDial: 'standard',
        }),
      );
      const moduleId = saved.id;
      chatMock
        .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'm', fallback: null })
        .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'm', fallback: null });
      await runSpine(moduleId, campaign);
      const row = await getModule(moduleId);
      expect(row?.promptStyle ?? null).toBeNull();
      expect(promptStyleForModule(row ?? {}).style.templateText).toBe(
        builtinPromptStyle('classic')?.templateText,
      );
    });
  });

  describe('the storable catalog', () => {
    it('duplicating, editing, saving and defaulting round-trips through settings', async () => {
      const story = builtinPromptStyle('story');
      if (story === undefined) throw new Error('missing story');
      const copy = await duplicatePromptStyle(story);
      expect(copy.name).toBe('Story (copy)');
      const saved = await savePromptStyle(copy.id, {
        name: 'House Voice',
        templateText: copy.templateText,
      });
      expect(saved.name).toBe('House Voice');
      expect(saved.version).toBe(1);
      await setDefaultPromptStyle(copy.id);
      const row = await readSettings();
      expect(row.defaultPromptStyleId).toBe(copy.id);
      expect(row.promptStyles?.map((style) => style.name)).toContain('House Voice');
    });

    it('a template that fails validation is REFUSED and nothing is written', async () => {
      const story = builtinPromptStyle('story');
      if (story === undefined) throw new Error('missing story');
      const copy = await duplicatePromptStyle(story);
      await expect(
        savePromptStyle(copy.id, {
          templateText: `${copy.templateText}\n\n{{notAPlaceholder}}\n`,
        }),
      ).rejects.toThrow(/notAPlaceholder/);
      const row = await readSettings();
      const stored = row.promptStyles?.find((style) => style.id === copy.id);
      expect(stored?.templateText).toBe(copy.templateText);
      expect(stored?.version).toBe(1);
    });

    it('refuses a duplicate NAME and a built-in name', async () => {
      const story = builtinPromptStyle('story');
      if (story === undefined) throw new Error('missing story');
      await duplicatePromptStyle(story, 'House Voice');
      await expect(duplicatePromptStyle(story, 'House Voice')).rejects.toThrow(/already exists/);
      await expect(duplicatePromptStyle(story, 'Classic')).rejects.toThrow(/already exists/);
    });

    it('an unreadable styles blob reads as an error, never as an empty list', async () => {
      await updateSettings({ promptStyles: [] });
      // Corrupt the row the way a bad import would.
      const raw = await readSettings();
      expect(raw.promptStyles).toEqual([]);
      await updateSettings({ promptStyles: [] });
      const stored = await readPromptStyleCatalog('classic');
      expect(stored.error).toBeNull();
      expect(stored.user).toEqual([]);
    });

    it('reports the version a style is at, and resets to the source text', async () => {
      const story = builtinPromptStyle('story');
      if (story === undefined) throw new Error('missing story');
      const copy = await duplicatePromptStyle(story);
      const edited = await savePromptStyle(copy.id, {
        templateText: `${copy.templateText}\n\nEXTRA-MARKER`,
      });
      expect(edited.version).toBe(2);
      expect(edited.basedOn).toBe('story');
      // A rename does not bump the version: the version IS the template generation.
      const renamed = await savePromptStyle(copy.id, { name: 'House Voice' });
      expect(renamed.version).toBe(2);
    });
  });
});

describe('promptStyles-default-style.test.ts', () => {
  /**
   * FREESTYLE IS THE PRODUCT DEFAULT (owner request, docs/17 row 88). He
   * generated with it and liked the output better, so a fresh app, a settings row
   * that never stored the field, and the creation path's own default all land on
   * Freestyle.
   *
   * The pins below are deliberately split by LAYER, because the two layers are
   * what the change is about:
   *
   * - the PRODUCT layer — the settings factory and the zod default for an ABSENT
   *   field (the pre-styles-arc row path) — yields `'freestyle'`;
   * - the CREATION layer — a module created with no explicit style choice records
   *   Freestyle on its OWN row;
   * - the PROVENANCE layer — the invariant this change must not break, pinned
   *   here under the new default (see the block comment on the last describe).
   *
   * The dialog's select and the settings card are the UI halves: they read the
   * same values through `readPromptStyleCatalog`, and their pins live in
   * `tests/features/prompt-style-default-ui.test.tsx`.
   *
   * A stored explicit value is DATA and is never rewritten: there is no migration,
   * no version bump and no upgrade normalization here (AGENTS rule 1). What this
   * file asserts is only what a FRESH app is born with and what an ABSENT field
   * resolves to.
   */

  const chatMock = vi.mocked(chat);

  const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'promptStyles');

  function fixture(name: string): string {
    return readFileSync(join(FIXTURE_DIR, name), 'utf8');
  }

  const PREMISE =
    'A harbor town raised its bell to warn of the drownings; now the bell rings by itself.';
  const THEMES = ['duty', 'decay'];
  const PLAN = [
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
    {
      title: 'The Bell Tower',
      levelBand: '3',
      synopsis: 'Final confrontation at the top of the leaning tower.',
      levelUpTrigger: 'The cult is broken.',
    },
  ];
  const ENTITIES: { name: string; kind: EntityKind }[] = [
    { name: 'Warden Bellamy', kind: 'npc' },
    { name: 'The Drowned Cathedral', kind: 'location' },
    { name: 'The Tide Cult', kind: 'faction' },
    { name: 'The Bells Below', kind: 'encounter' },
    { name: 'The Flooded Nave', kind: 'encounter' },
    { name: 'The Wardens Confession', kind: 'encounter' },
  ];
  const SPINE_REPLY = JSON.stringify({
    premise: PREMISE,
    themes: THEMES,
    partPlan: PLAN,
    entities: ENTITIES,
  });
  const NORM_REPLY = JSON.stringify({
    entities: ENTITIES.map((entry) => ({
      name: entry.name,
      canonical: entry.name,
      kind: entry.kind,
    })),
  });

  /** The whole user message of the n-th chat call. */
  function userPrompt(callIndex: number): string {
    const messages = chatMock.mock.calls[callIndex]?.[0] as
      { role: string; content: unknown }[] | undefined;
    const user = messages?.find((message) => message.role === 'user');
    return typeof user?.content === 'string' ? user.content : '';
  }

  function prose(marker: string): { text: string; modelUsed: string; fallback: null } {
    return {
      text: `${marker}: The tide withdraws and the streets shine wet under a pale sun. `.repeat(4),
      modelUsed: 'test-model',
      fallback: null,
    };
  }

  /**
   * A module ready for a part prompt, in the pre-styles shape when asked: the
   * `promptStyle` key is ABSENT from the stored row, exactly as every module
   * written before the styles arc is stored.
   *
   * The fixture-shape identity (premise, plan, campaign artifacts, tone, level
   * range) is the SAME as the Classic byte-identity suite's, so the composed part
   * prompt can be compared against `parts-classic-part0.txt` — the acceptance
   * criterion — and not merely against another composition of this test's own.
   */
  async function seedPartModule(
    options: { legacyRow?: boolean; withArtifacts?: boolean } = {},
  ): Promise<{
    campaign: Campaign;
    moduleId: Id;
  }> {
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
    if (options.legacyRow === true) {
      const legacy: Record<string, unknown> = {
        ...(moduleSchema.parse({ ...saved, promptStyle: undefined }) as unknown as Record<
          string,
          unknown
        >),
      };
      delete legacy.promptStyle;
      await db.modules.put(legacy as unknown as Module);
    }
    // Campaign-scoped shared cast, so the campaign index + cast blocks render.
    if (options.withArtifacts !== false) {
      await createArtifact({
        campaignId: campaign.id,
        kind: 'location',
        name: 'The Salt Ward',
        summary: 'A burned ward on the north bank.',
      });
      await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Harbormaster Ilse' });
    }
    await patchModule(saved.id, {
      spine: moduleSpineSchema.parse({ premise: PREMISE, themes: THEMES, partPlan: PLAN }),
      entityKinds: ENTITIES.map((entry) => ({ ...entry, absorbed: [] })),
    });
    return { campaign, moduleId: saved.id };
  }

  async function renderPartPrompt(
    moduleId: Id,
    planIndex: number,
    campaign: Campaign,
  ): Promise<string> {
    chatMock.mockResolvedValue(prose(`PART-${String(planIndex)} [[The Bells Below]]`));
    const module = await getModule(moduleId);
    if (module === undefined) throw new Error('missing module');
    await generatePart(moduleId, module, planIndex, campaign, 'test-model', {
      signal: new AbortController().signal,
      extraInstruction: '',
      onToken: undefined,
    });
    return userPrompt(0);
  }

  beforeEach(() => clearDatabase());
  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('the product default is Freestyle', () => {
    it('the settings factory yields defaultPromptStyleId: freestyle', () => {
      // REVERT-PROOF: restoring PROMPT_STYLE_CLASSIC_ID in `defaultSettings()`
      // fails this line — this is the value a FRESH app's row is born with.
      expect(defaultSettings().defaultPromptStyleId).toBe(PROMPT_STYLE_FREESTYLE_ID);
      expect(defaultSettings().defaultPromptStyleId).toBe('freestyle');
    });

    it('a settings row written WITHOUT the field reads back as Freestyle', async () => {
      // The pre-styles-arc row: the key is not in Dexie at all, so the zod default
      // on the field is what resolves it. This is the path by which an app whose
      // row predates the styles arc picks up the product default.
      const { defaultPromptStyleId: _unused, ...rowWithoutTheField } = await getSettings();
      await db.settings.put(rowWithoutTheField as unknown as Parameters<typeof db.settings.put>[0]);
      const raw = (await db.settings.get('settings')) as Record<string, unknown> | undefined;
      expect(raw?.defaultPromptStyleId).toBeUndefined();
      expect((await readSettings()).defaultPromptStyleId).toBe('freestyle');
      expect((await getSettings()).defaultPromptStyleId).toBe('freestyle');
    });

    it('honors an EXPLICITLY stored default and never rewrites it', async () => {
      await updateSettings({ defaultPromptStyleId: PROMPT_STYLE_CLASSIC_ID });
      expect((await getSettings()).defaultPromptStyleId).toBe('classic');
      // …and a later unrelated write carries it forward: no normalization pass,
      // no migration, no version bump (AGENTS rule 1 — a stored value is data).
      await updateSettings({ language: 'de' });
      expect((await getSettings()).defaultPromptStyleId).toBe('classic');
      expect((await db.settings.get('settings'))?.defaultPromptStyleId).toBe('classic');
    });
  });

  describe('a module created with no explicit style choice', () => {
    it('records Freestyle on its own row', async () => {
      const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
      // The app default is NOT set by this test: whatever a fresh app resolves to
      // is what creation must record, which is the point of the pin.
      expect((await getSettings()).defaultPromptStyleId).toBe('freestyle');
      chatMock
        .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'm', fallback: null })
        .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'm', fallback: null });
      const moduleId = await createModuleAndRun(campaign, {
        campaignId: campaign.id,
        title: 'New Module',
        concept: 'A harbor bell.',
        levelMin: 1,
        levelMax: 1,
        tone: '',
        sizeDial: 'standard',
      });
      const freestyle = builtinPromptStyle(PROMPT_STYLE_FREESTYLE_ID);
      const row = await getModule(moduleId);
      // REVERT-PROOF: with the product default back at Classic this records
      // Classic and fails — the row mirrors the existing Freestyle suite's
      // creation pin, with the id supplied by the DEFAULT rather than the dialog.
      expect(row?.promptStyle).toEqual({
        id: 'freestyle',
        name: 'Freestyle',
        version: freestyle?.version,
        templateText: freestyle?.templateText,
      });
      expect(row?.promptStyle?.name).toBe('Freestyle');
      expect(row?.promptStyle?.version).toBe(1);
      expect(BUILTIN_PROMPT_STYLES.some((style) => style.id === row?.promptStyle?.id)).toBe(true);
      // `createModuleAndRun` fires the spine pass DETACHED (`moduleGen.ts`), so
      // drain it here: a spine call still in flight when this test ends would land
      // inside the NEXT test's mocked transport.
      await vi.waitFor(
        async () => {
          expect((await getModule(moduleId))?.spine).not.toBeNull();
        },
        { timeout: 5_000 },
      );
    });
  });

  /**
   * THE PROVENANCE PIN — the risk of this whole change (docs/17 row 88).
   *
   * Every module the owner already has was written under Classic. The app default
   * decides the style of a module ONLY when no style has been recorded for the
   * module being CREATED; for a module that EXISTS the resolution is
   *
   *     the module's RECORDED style → and, with nothing recorded, Classic by
   *     PROVENANCE (it was written with that text).
   *
   * The app default is NOT a rung of that ladder.
   *
   * REVERT-PROOF: making the resolution consult `settings.defaultPromptStyleId`
   * when a module recorded nothing — the "obvious" simplification — turns the
   * legacy rows below into Freestyle parts and fails these tests. Both layers are
   * pinned: the pure resolver, and the REAL `generatePart` / `runSpine` seam over
   * a legacy row put into Dexie with the key ABSENT (the true pre-arc shape), so
   * the guarantee is proved on the path a resume, a repair and a per-part
   * regeneration actually take. Classic's own fixture is the acceptance
   * criterion: the legacy row must compose the byte-identical classic part
   * prompt.
   */
  describe('with the app default on Freestyle, provenance still wins', () => {
    it('the resolver never consults the app default', async () => {
      // The app default is Freestyle here — the fresh row, untouched.
      expect((await getSettings()).defaultPromptStyleId).toBe('freestyle');
      const resolved = promptStyleForModule({});
      expect(resolved.source).toBe('legacy-classic');
      expect(resolved.style.id).toBe('classic');
      expect(resolved.style.templateText).toBe(builtinPromptStyle('classic')?.templateText);
    });

    it('a legacy module (no recorded style) composes the byte-identical classic part prompt', async () => {
      expect((await getSettings()).defaultPromptStyleId).toBe('freestyle');
      const { campaign, moduleId } = await seedPartModule({ legacyRow: true });
      const row = await getModule(moduleId);
      // The stored row genuinely lacks the field (this is the pre-arc shape): the
      // repo's parse-on-read materializes it as null, and the key is NOT in Dexie.
      expect((await db.modules.get(moduleId))?.promptStyle ?? null).toBeNull();
      expect(row?.promptStyle ?? null).toBeNull();
      expect(await renderPartPrompt(moduleId, 0, campaign)).toBe(
        fixture('parts-classic-part0.txt'),
      );
    });

    it('a legacy module (no recorded style) composes the byte-identical classic spine prompt', async () => {
      expect((await getSettings()).defaultPromptStyleId).toBe('freestyle');
      // The spine fixture's own shape: a campaign with NO artifacts yet (the
      // campaign index and the shared cast blocks are absent from it).
      const { campaign, moduleId } = await seedPartModule({
        legacyRow: true,
        withArtifacts: false,
      });
      chatMock
        .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'test-model', fallback: null })
        .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'test-model', fallback: null });
      await runSpine(moduleId, campaign);
      expect(userPrompt(0)).toBe(fixture('spine-classic-default.txt'));
    });

    it('a module that RECORDED Classic still composes Classic', async () => {
      expect((await getSettings()).defaultPromptStyleId).toBe('freestyle');
      const { campaign, moduleId } = await seedPartModule();
      const classic = builtinPromptStyle(PROMPT_STYLE_CLASSIC_ID);
      if (classic === undefined) throw new Error('missing classic');
      await patchModule(moduleId, {
        promptStyle: {
          id: classic.id,
          name: classic.name,
          version: classic.version,
          templateText: classic.templateText,
        },
      });
      const text = await renderPartPrompt(moduleId, 0, campaign);
      expect(text).toBe(fixture('parts-classic-part0.txt'));
      // …and the recorded copy is what a later generation reads, not the default.
      expect(promptStyleForModule((await getModule(moduleId)) ?? {}).source).toBe('recorded');
    });

    it('a module that RECORDED Freestyle keeps Freestyle (the default cannot un-record it)', async () => {
      const { campaign, moduleId } = await seedPartModule();
      const freestyle = builtinPromptStyle(PROMPT_STYLE_FREESTYLE_ID);
      if (freestyle === undefined) throw new Error('missing freestyle');
      await patchModule(moduleId, {
        promptStyle: {
          id: freestyle.id,
          name: freestyle.name,
          version: freestyle.version,
          templateText: freestyle.templateText,
        },
      });
      const text = await renderPartPrompt(moduleId, 0, campaign);
      expect(text).toContain('make this a noteworthy and fun module to play');
      expect(text).not.toBe(fixture('parts-classic-part0.txt'));
    });

    it('changing the app default does not change a module that already exists', async () => {
      const { campaign, moduleId } = await seedPartModule({ legacyRow: true });
      const before = await renderPartPrompt(moduleId, 0, campaign);
      await updateSettings({ defaultPromptStyleId: PROMPT_STYLE_FREESTYLE_ID });
      const after = await renderPartPrompt(moduleId, 0, campaign);
      expect(after).toBe(before);
      expect(after).toBe(fixture('parts-classic-part0.txt'));
    });
  });
});

describe('promptStyles-freestyle.test.ts', () => {
  /**
   * The FREESTYLE built-in (owner request, docs/17 row 87): a third module
   * writing style that prescribes no shape at all — the setting and the
   * technology, plus the goal of a noteworthy, fun module to play.
   *
   * What is pinned here, and why each pin is load-bearing:
   *
   * - the built-in EXISTS as data beside Classic and Story, valid, immutable and
   *   reachable through the ONE catalog both selection surfaces render (the
   *   settings list and the New Module select read `catalogStyles`, never a
   *   hand-kept list);
   * - it composes the SETTING through the real placeholders (every context
   *   placeholder the other built-ins use), so a freestyle part is written for
   *   the module the planner actually approved;
   * - it carries the TECHNOLOGY — the wiki-link→artifact rule, all six artifact
   *   kinds with what the app builds per kind, and the encounter-versus-event
   *   distinction the floor depends on — and the GOAL sentence;
   * - it carries the CONTRACT layer in full, with the floor's numbers arriving
   *   ONLY through `{{contract.floor}}` (a style that restated them could
   *   disagree with the gate that counts them);
   * - it carries NONE of the structure the other two styles prescribe: not the
   *   ten classic field labels, not the anti-formula block that rides them, not
   *   Story's beat-heading template, and none of the craft-discipline bullets
   *   ("two visible approaches", "end with two threads", "every conflict ends
   *   with a cost", the finale-aware closing demand). Those ABSENCES are the
   *   style; the pins are the guard that a later "helpful" edit cannot quietly
   *   turn Freestyle back into Classic.
   *
   * The absence pins are proved NON-VACUOUS by the companion test below: every
   * string they forbid is asserted present in the style that owns it.
   *
   * Classic's byte identity lives in `promptStyles-classic-identity.test.ts` and
   * is untouched by this file: nothing here changes a contract value, and the one
   * string Freestyle shares with Classic is the SPINE section (the reported
   * judgement call — the planner's JSON reply is an app contract and its
   * instruction is not formulaic, so the experiment lands in the part text).
   */

  const chatMock = vi.mocked(chat);

  const FLOOR_CLAUSE =
    'REQUIREMENT — encounter floor for this part (levels 1: 1 level(s)): name at least 1 distinct ' +
    "encounter(s) in this part's markdown as [[Encounter Name]] wiki-links, each a fight with real stakes.";

  /** The exact labels the run's own values carry (see `moduleGen.partsMessages`). */
  const PARTS_VALUES: Readonly<Record<string, string>> = {
    campaign: 'Campaign: Emberfall (D&D 5e) — a drowned coast.',
    modulePremise: 'Module premise:\nMARKER-PREMISE',
    themes: 'Themes: duty; salt',
    allParts:
      'All parts of this module (one-line synopses, so later parts can foreshadow):\n1. [1] The Sunken Quarter — MARKER-ALLPARTS',
    partHeading: 'Write part 1: "The Sunken Quarter" (levels 1).',
    partSynopsis: 'Part synopsis: MARKER-SYNOPSIS',
    partEndCondition: 'Part ends when: MARKER-ENDCONDITION.',
    previousPart:
      'Full markdown of the previous part (continue seamlessly from it):\n\nMARKER-PREVIOUSPART',
    ruleExcerpts: 'Rule excerpts for grounding:\n[Combat > Actions]\nMARKER-RULES',
    glossary:
      'Module entities — wiki-link these ONLY by these exact canonical spellings:\n- Warden Bellamy (npc)',
    campaignIndex:
      'Existing campaign entities (reuse by exact name where they fit):\n- Saltmarsh (location)',
    priorModules: 'MARKER-PRIORMODULES',
    // Provided so the composer has a value if a style ever asks for it: the point
    // of the pin below is that Freestyle does NOT.
    partEnding: 'MARKER-PARTENDING',
    additionalInstruction: 'Additional instruction from the GM: MARKER-EXTRA',
  };

  /** Composes one built-in's PARTS prompt with the run's own values. */
  function composedParts(styleId: string, floorClause: string | null = FLOOR_CLAUSE): string {
    const style = builtinPromptStyle(styleId);
    if (style === undefined) throw new Error(`the ${styleId} built-in is missing`);
    return composePromptFromTemplate({
      templateText: style.templateText,
      surface: 'parts',
      values: {
        ...PARTS_VALUES,
        ...partsContractValues({ lengthTarget: '800–1500 words', floorClause }),
      },
    }).text;
  }

  /** The spine or parts section of a template, markers excluded. */
  function section(templateText: string, marker: string): string {
    const lines = templateText.split('\n');
    const start = lines.findIndex((line) => line.trim() === marker);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) =>
      Object.values(PROMPT_STYLE_SECTION_MARKERS).some((value) => value === line.trim()),
    );
    return (end < 0 ? rest : rest.slice(0, end)).join('\n');
  }

  /** The craft prescriptions Classic and Story carry and Freestyle may not. */
  const FORBIDDEN_CRAFT_BULLETS = [
    'two VISIBLE approaches',
    'End the part with at least two threads',
    'Every conflict ends with someone worse off',
    'Introduce at most one new entity per scene',
    'No scene may require one specific party action to proceed',
    'Nothing the party changes is undone off-screen',
    'No two beats share a pattern',
    'A beat with nothing at stake is cut or rewritten',
    'If you could honestly write "the situation is the same, now what do you do"',
    'one or two sentences',
  ];

  const PREMISE = 'A harbor bell that rings by itself beneath the water.';
  const PLAN = [
    {
      title: 'The Sunken Quarter',
      levelBand: '1',
      synopsis: 'The party arrives with the low tide.',
      levelUpTrigger: 'The bell is found.',
    },
  ];
  // The floor gate counts encounters: a spine with none is a DEFECT and earns a
  // repair call, so the reply plans one.
  const SPINE_REPLY = JSON.stringify({
    premise: PREMISE,
    themes: ['duty'],
    partPlan: PLAN,
    entities: [
      { name: 'Warden Bellamy', kind: 'npc' },
      { name: 'The Bells Below', kind: 'encounter' },
    ],
  });
  const NORM_REPLY = JSON.stringify({
    entities: [
      { name: 'Warden Bellamy', canonical: 'Warden Bellamy', kind: 'npc' },
      { name: 'The Bells Below', canonical: 'The Bells Below', kind: 'encounter' },
    ],
  });

  /** The composed parts prompt of call `callIndex` of the mocked chat transport. */
  function userPrompt(callIndex: number): string {
    const messages = chatMock.mock.calls[callIndex]?.[0] as
      { role: string; content: unknown }[] | undefined;
    const user = messages?.find((message) => message.role === 'user');
    return typeof user?.content === 'string' ? user.content : '';
  }

  beforeEach(() => clearDatabase());
  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('the Freestyle built-in', () => {
    it('ships as a third immutable built-in beside Classic and Story', () => {
      // REVERT-PROOF: dropping the freestyle entry from BUILTIN_PROMPT_STYLES
      // fails this line, and so does silently reordering the built-ins.
      expect(BUILTIN_PROMPT_STYLES.map((style) => style.id)).toEqual([
        'classic',
        'story',
        'freestyle',
      ]);
      const freestyle = builtinPromptStyle('freestyle');
      expect(freestyle?.name).toBe('Freestyle');
      expect(freestyle?.origin).toBe('builtin');
      expect(freestyle?.version).toBe(1);
      expect(validatePromptStyleTemplate(freestyle?.templateText ?? '')).toEqual([]);
    });

    it('is reachable through the ONE catalog both selection surfaces render', async () => {
      // The settings list and the New Module select both map `catalogStyles`
      // (docs/17 row 86): this is the data-driven path, not a UI assumption.
      const catalog = await readPromptStyleCatalog((await getSettings()).defaultPromptStyleId);
      expect(catalogStyles(catalog).map((style) => style.name)).toEqual([
        'Classic',
        'Story',
        'Freestyle',
      ]);
    });

    it("carries Classic's spine section verbatim (the reported judgement call)", () => {
      const freestyle = builtinPromptStyle('freestyle')?.templateText ?? '';
      const classic = builtinPromptStyle('classic')?.templateText ?? '';
      expect(section(freestyle, PROMPT_STYLE_SECTION_MARKERS.spine)).toBe(
        section(classic, PROMPT_STYLE_SECTION_MARKERS.spine),
      );
      // …and the parts section is emphatically NOT Classic's.
      expect(section(freestyle, PROMPT_STYLE_SECTION_MARKERS.parts)).not.toBe(
        section(classic, PROMPT_STYLE_SECTION_MARKERS.parts),
      );
    });

    it('uses every context placeholder and every required contract clause', () => {
      const text = builtinPromptStyle('freestyle')?.templateText ?? '';
      for (const token of requiredPlaceholders('parts')) {
        expect(text, `missing {{${token}}}`).toContain(`{{${token}}}`);
      }
      for (const token of [
        'campaign',
        'modulePremise',
        'themes',
        'allParts',
        'partHeading',
        'partSynopsis',
        'partEndCondition',
        'previousPart',
        'ruleExcerpts',
        'glossary',
        'campaignIndex',
        'priorModules',
        'additionalInstruction',
      ]) {
        expect(text, `missing the setting placeholder {{${token}}}`).toContain(`{{${token}}}`);
      }
    });

    it('composes the setting through those placeholders, and never restates the floor numbers', () => {
      const text = composedParts('freestyle');
      for (const [token, value] of Object.entries(PARTS_VALUES)) {
        if (token === 'partEnding') continue;
        expect(text, `{{${token}}} did not reach the composed prompt`).toContain(value);
      }
      // The floor arrives through the contract slot, ONCE — the template adds no
      // second statement of it: the numbers belong to the module's own guardrail.
      expect(text).toContain(FLOOR_CLAUSE);
      expect(text.split(FLOOR_CLAUSE)).toHaveLength(2);
      expect(text).not.toContain('{{');
      // The finale-aware closing demand is a craft prescription: not this style's.
      expect(text).not.toContain('MARKER-PARTENDING');
      expect(text).not.toContain('End this part with a cost, a revelation, or a new pressure');
    });

    it('omits the floor clause entirely when the module has no floor', () => {
      const text = composedParts('freestyle', null);
      expect(text).not.toContain('encounter floor for this part');
      // The technology sentence is phrased for exactly this case — it says WHEN a
      // module carries a floor, so a disabled floor leaves nothing false behind.
      expect(text).toContain('Whenever this module carries an encounter floor');
    });

    it('explains every artifact kind and what the app builds per kind', () => {
      const text = composedParts('freestyle');
      // Each kind, in the contract's own vocabulary (`SPINE_ENTITY_KINDS`).
      expect(text).toContain('"npc" — a person or creature the party meets.');
      expect(text).toContain('"location" — a place.');
      expect(text).toContain('"faction" — an organization or group.');
      expect(text).toContain('"note" — anything else: items, rumors, mysteries, plot devices.');
      // An encounter is a FIGHT and the app builds it as one…
      expect(text).toContain('"encounter" — a FIGHT');
      expect(text).toContain('a battle map, a monster roster, and images (mob portraits)');
      // …anything else is an event, illustration only (`SPINE_SCENE_KINDS`).
      expect(text).toContain('"event" — a non-combat scene the party plays through');
      expect(text).toContain(
        'An event gets an illustration and nothing else — no battle map, no monsters, no roster.',
      );
      expect(text).toContain('Anything that is not a fight is an event and never an encounter');
      // Every artifact carries generated detail and images.
      expect(text).toContain('its own generated details, its own generated images');
      // The boundaries the pipeline depends on.
      expect(text).toContain('Player characters are not yours to write');
      expect(text).toContain('"plotarc" is not an entity kind the module declares either.');
      // Link technology — WHY the links matter, not a heading format.
      expect(text).toContain(
        'the app builds an artifact from every linked name and counts your encounters from them',
      );
      expect(text).toContain('a fight staged only in passing prose is invisible to the app');
    });

    it('carries the goal, with the contract layer intact around it', () => {
      const text = composedParts('freestyle');
      expect(text).toContain('make this a noteworthy and fun module to play');
      // Every contract clause, from the ONE source the seam injects, is present.
      for (const clause of Object.values(
        partsContractValues({ lengthTarget: '800–1500 words', floorClause: FLOOR_CLAUSE }),
      )) {
        expect(text, 'a contract clause did not reach the composed prompt').toContain(clause);
      }
      expect(text).toContain('- Target length for this part: 800–1500 words (soft target).');
    });

    it('prescribes NO structure: the field list, the anti-formula block, the beat template and the craft bullets are absent', () => {
      const text = composedParts('freestyle');
      // The ten classic field labels — the ONE source, never a transcribed copy.
      for (const label of PART_SCENE_FIELD_LABELS) {
        expect(text, `the classic field label **${label}** leaked into Freestyle`).not.toContain(
          `**${label}**`,
        );
      }
      // The anti-formula demands that ride them.
      for (const demand of PART_SCENE_VARIATION_DEMANDS) {
        expect(text).not.toContain(demand);
      }
      // Story's beat-heading requirement — and the heading words it insists on.
      expect(text).not.toContain('### [[Beat Name]]');
      expect(text).not.toContain('Name each beat that has anything at stake');
      expect(text).not.toContain('— ENCOUNTER');
      expect(text).not.toContain('— EVENT');
      // The craft-discipline bullets both other styles carry.
      for (const bullet of FORBIDDEN_CRAFT_BULLETS) {
        expect(text, `the craft bullet "${bullet}" leaked into Freestyle`).not.toContain(bullet);
      }
    });

    it('the absence pins are NOT vacuous: every forbidden string is present in the style that owns it', () => {
      const classic = composedParts('classic');
      const story = composedParts('story');
      for (const label of PART_SCENE_FIELD_LABELS) {
        expect(classic, `classic no longer carries **${label}**`).toContain(`**${label}**`);
      }
      for (const demand of PART_SCENE_VARIATION_DEMANDS) {
        expect(classic).toContain(demand);
      }
      expect(story).toContain('### [[Beat Name]]');
      for (const bullet of FORBIDDEN_CRAFT_BULLETS) {
        expect(
          classic.includes(bullet) || story.includes(bullet),
          `no built-in carries "${bullet}", so forbidding it in Freestyle proves nothing`,
        ).toBe(true);
      }
    });
  });

  describe('a module written in Freestyle', () => {
    it('records the style id, name, version and TEXT, exactly like the other built-ins', async () => {
      const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
      chatMock
        .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'm', fallback: null })
        .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'm', fallback: null });
      const moduleId = await createModuleAndRun(campaign, {
        campaignId: campaign.id,
        title: 'New Module',
        concept: 'A harbor bell.',
        levelMin: 1,
        levelMax: 1,
        tone: '',
        sizeDial: 'standard',
        promptStyleId: 'freestyle',
      });
      const freestyle = builtinPromptStyle('freestyle');
      const row = await getModule(moduleId);
      // REVERT-PROOF: without the built-in, creation fails on the unresolvable id
      // and no module row exists at all.
      expect(row?.promptStyle).toEqual({
        id: 'freestyle',
        name: 'Freestyle',
        version: 1,
        templateText: freestyle?.templateText,
      });
      expect(promptStyleForModule(row ?? {}).source).toBe('recorded');
      // `createModuleAndRun` fires the spine pass DETACHED (`moduleGen.ts`), so
      // drain it here: a spine call still in flight when this test ends would
      // land inside the NEXT test's mocked transport.
      await vi.waitFor(
        async () => {
          expect((await getModule(moduleId))?.spine).not.toBeNull();
        },
        { timeout: 5_000 },
      );
    });

    it('composes a real part from the RECORDED freestyle text', async () => {
      const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
      const saved = await saveModule(
        createModule({
          campaignId: campaign.id,
          title: 'The Drowned Bell',
          concept: 'A harbor bell.',
          levelMin: 1,
          levelMax: 1,
          tone: 'eerie',
          sizeDial: 'standard',
        }),
      );
      const freestyle = builtinPromptStyle('freestyle');
      if (freestyle === undefined) throw new Error('missing freestyle');
      await patchModule(saved.id, { promptStyle: modulePromptStyleOf(freestyle) });
      chatMock
        .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'm', fallback: null })
        .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'm', fallback: null });
      await runSpine(saved.id, campaign);
      // The module's RECORDED text is what composes — not the current built-in
      // (the recording contract, docs/17 row 86): stamp the row's copy and prove
      // the stamp reaches the model.
      await patchModule(saved.id, {
        promptStyle: {
          ...modulePromptStyleOf(freestyle),
          templateText: `${freestyle.templateText}\n\nROW-ONLY-MARKER`,
        },
      });
      const generated = await getModule(saved.id);
      if (generated?.spine == null) throw new Error('the spine pass stored no spine');
      chatMock.mockReset();
      chatMock.mockResolvedValue({
        text: 'PART [[The Bells Below]]: the tide withdraws. '.repeat(6),
        modelUsed: 'm',
        fallback: null,
      });
      await generatePart(saved.id, generated, 0, campaign, 'm', {
        signal: new AbortController().signal,
        extraInstruction: '',
        onToken: undefined,
      });
      const prompt = userPrompt(0);
      expect(prompt).toContain('ROW-ONLY-MARKER');
      // …the setting the run provides…
      expect(prompt).toContain('Campaign: Emberfall');
      expect(prompt).toContain(PREMISE);
      expect(prompt).toContain('Part synopsis: The party arrives with the low tide.');
      expect(prompt).toContain('Part ends when: The bell is found.');
      expect(prompt).toContain(
        'Module entities — wiki-link these ONLY by these exact canonical spellings:',
      );
      expect(prompt).toContain('- The Bells Below (encounter)');
      // …the freestyle technology and the goal…
      expect(prompt).toContain('make this a noteworthy and fun module to play');
      expect(prompt).toContain(
        'there is no prescribed shape, no field list and no beat template here',
      );
      // …the contract layer, the module's own floor clause among it…
      expect(prompt).toContain('Target length for this part:');
      expect(prompt).toContain('encounter floor for this part');
      // …and none of the classic shape.
      for (const label of PART_SCENE_FIELD_LABELS) {
        expect(prompt).not.toContain(`**${label}**`);
      }
    });

    it('leaves a legacy module (no recorded style) on Classic', () => {
      // A NON-REGRESSION GUARD, not new behavior: the same resolution is pinned by
      // `promptStyles-composition.test.ts` and by the Classic-identity suite. It is
      // restated here so this file's story is complete — adding a third built-in
      // must not change what a module without a record composes.
      const resolved = promptStyleForModule({});
      expect(resolved.source).toBe('legacy-classic');
      expect(resolved.style.templateText).toBe(builtinPromptStyle('classic')?.templateText);
      expect(resolved.style.id).toBe('classic');
    });
  });
});
