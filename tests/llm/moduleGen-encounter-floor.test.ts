import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import { createCampaign } from '@/db/campaignRepo';
import { createArtifact } from '@/db/artifactRepo';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { updateSettings } from '@/db/settingsRepo';
import {
  createModule,
  moduleSpineSchema,
  type Campaign,
  type Id,
  type Module,
  type ModuleEntityKind,
  type ModulePart,
} from '@/domain';
import {
  assertEncounterFloor,
  approveSpineAndRun,
  countModuleEncounters,
  createModuleAndRun,
  encounterFloorMessage,
  generateMissingParts,
  levelsInLevelBand,
  runParts,
  runSpine,
} from '@/llm/moduleGen';
import { clearDatabase } from '../db/helpers';
import type { ChatResult } from '@/llm/openrouter';

/**
 * The hard encounter floor (08-MODULE-DESIGNER M4-B): distinct canonical
 * encounter entities named in document text >= levelCount, allocated per
 * band. Counter units, the spine gate, the parts gate (fail-loud + bounded
 * repair), unattended tails skipping automation on failure, and the
 * backfill-is-prose pin (records/batches alone never satisfy the floor).
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

const runModulePostGenerationMock = mocks.runModulePostGeneration;

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

const TEST_MODEL = 'test/fixture-model';
const UUID = '123e4567-e89b-42d3-a456-426614174000';

function prose(marker: string, ...names: string[]): string {
  const links = names.length === 0 ? '' : ` Trials faced: ${names.map((name) => `[[${name}]]`).join(', ')}.`;
  return `${marker}: The tide withdraws and the streets shine wet under a pale sun. `.repeat(4) + links;
}

/** Part prose as a chat reply. */
function partReply(marker: string, ...names: string[]): ChatResult {
  return { text: prose(marker, ...names), modelUsed: 'test-model', fallback: null };
}

/** A normalization reply mapping every listed name to itself. */
function normReply(entries: { name: string; kind: string }[]): ChatResult {
  return {
    text: JSON.stringify({
      entities: entries.map((entry) => ({ name: entry.name, canonical: entry.name, kind: entry.kind })),
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
    premise: (options.premiseNames ?? []).length === 0
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
  }));
  return {
    ...base,
    spine,
    parts,
    entityKinds: options.entityKinds ?? [],
  };
}

const encounterKind = (name: string): ModuleEntityKind => ({ name, kind: 'encounter', absorbed: [] });

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

  it.each([[''], ['soon'], ['1-'], ['-3'], ['boss fight']])('counts unparseable %j as 1', (band) => {
    expect(levelsInLevelBand(band)).toBe(1);
  });
});

describe('countModuleEncounters (pure)', () => {
  const kinds = [encounterKind('Ember Trial'), encounterKind('Flood Trial'), encounterKind('Bell Trial')];

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
    expect(() => { assertEncounterFloor(module); }).not.toThrow();
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
    expect(() => { assertEncounterFloor(module); }).toThrow(/Beta.*band 2-3.*needs 2, names 0/);
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
    expect(() => { assertEncounterFloor(module); }).toThrow(/names repeat/);
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
    expect(() => { assertEncounterFloor(module); }).toThrow(/needs 3 distinct.*names 0/);
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
    expect(() => { assertEncounterFloor(module); }).not.toThrow();
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

  async function seedModule(levelMin = 1, levelMax = 3): Promise<{ campaign: Campaign; moduleId: Id }> {
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
    { title: 'The Sunken Quarter', levelBand: '1', synopsis: 'Arrival.', levelUpTrigger: 'Found.' },
    { title: 'The Drowned Cathedral', levelBand: '2', synopsis: 'Descent.', levelUpTrigger: 'Falls.' },
  ];

  function spineWith(entities: { name: string; kind: string }[]): object {
    return {
      premise: 'A harbor town raised its bell to warn of the drownings.',
      themes: ['duty'],
      partPlan: SPINE_PLAN,
      entities,
    };
  }

  it('spine prompt states the REQUIREMENT (never "advice, not a requirement")', async () => {
    const { campaign, moduleId } = await seedModule(1, 2);
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(spineWith([{ name: 'The Bells Below', kind: 'encounter' }])), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce(normReply([{ name: 'The Bells Below', kind: 'encounter' }]));

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
      .mockResolvedValueOnce({ text: JSON.stringify(spineWith([{ name: 'Warden Bellamy', kind: 'npc' }])), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce(normReply([{ name: 'Warden Bellamy', kind: 'npc' }]))
      // The repair retry names an encounter.
      .mockResolvedValueOnce({ text: JSON.stringify(spineWith([
        { name: 'Warden Bellamy', kind: 'npc' },
        { name: 'The Bells Below', kind: 'encounter' },
      ])), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce(normReply([
        { name: 'Warden Bellamy', kind: 'npc' },
        { name: 'The Bells Below', kind: 'encounter' },
      ]));

    const finished = await runSpine(moduleId, campaign);

    expect(chatMock).toHaveBeenCalledTimes(4);
    expect(finished.status).toBe('draft');
    expect(finished.entityKinds.some((entry) => entry.kind === 'encounter')).toBe(true);
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 20000);

  it('spine gate: still zero after the repair → loud spine failure', async () => {
    const { campaign, moduleId } = await seedModule(1, 2);
    const barren = { text: JSON.stringify(spineWith([{ name: 'Warden Bellamy', kind: 'npc' }])), modelUsed: 'test-model', fallback: null };
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
      .mockResolvedValueOnce(partReply('PART-ONE-FIXED', 'Ember Trial'))
      .mockResolvedValueOnce(partReply('PART-TWO-FIXED', 'Flood Trial'))
      // …which the re-normalization records.
      .mockResolvedValueOnce(normReply([
        { name: 'Ember Trial', kind: 'encounter' },
        { name: 'Flood Trial', kind: 'encounter' },
      ]));

    const finished = await runParts(moduleId, campaign);

    expect(chatMock).toHaveBeenCalledTimes(5);
    expect(finished.status).toBe('ready');
    expect(finished.errorMessage).toBe('');
    expect(finished.entityKinds).toEqual([
      { name: 'Ember Trial', kind: 'encounter', absorbed: [] },
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
      .mockResolvedValueOnce(normReply([
        { name: 'Kael', kind: 'npc' },
        { name: 'The Undercroft', kind: 'location' },
      ]))
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
        { planIndex: 0, markdown: prose('SEEDED'), status: 'ready', errorMessage: '', edited: false },
      ],
    });
    chatMock.mockResolvedValue(partReply('PART'));

    await generateMissingParts(moduleId, campaign);

    expect((await getModule(moduleId))?.status).toBe('failed');
    expect(runModulePostGenerationMock).not.toHaveBeenCalled();
  }, 20000);

  it('createModuleAndRun skips post-generation automation on gate failure', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const spine = spineWith([
      { name: 'Warden Bellamy', kind: 'npc' },
      { name: 'The Bells Below', kind: 'encounter' },
    ]);
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(spine), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce(normReply([
        { name: 'Warden Bellamy', kind: 'npc' },
        { name: 'The Bells Below', kind: 'encounter' },
      ]))
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
