import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getAnyArtifact, getArtifact, updateArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { getRun, listRunsByCampaign } from '@/db/runRepo';
import { saveSettings } from '@/db/settingsRepo';
import {
  createModule,
  createPersona,
  defaultSettings,
  newId,
  resolveEncounterBudgetPolicy,
  resolveModuleDifficulty,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
  type Artifact,
  type Id,
  type Persona,
} from '@/domain';
import { getModule, saveModule } from '@/db/moduleRepo';
import { sha256Hex } from '@/lib/hash';
import { encounterBudgetFor, moduleDifficultyGuidanceFor, partyLevelLine } from '@/llm/roomBudget';
import { encounterRunAdapters, runEngine, type StartRunInput } from '@/llm/runEngine';
import { rejectionIssues } from '@/llm/rejectionReason';
import { chat } from '@/llm/openrouter';
import { repopulateEncounter, regenerateEncounterEverything } from '@/features/campaign/encounterRegen';
import { clearDatabase, expectCopiedRosterEntry } from '../db/helpers';
import { generatedImagesFor } from '../helpers/imageRunFixtures';
import { useProgressStore } from '@/lib/progress';

/**
 * Two-button encounter regeneration (docs/11): Repopulate (roster-only
 * Cartographer pass for complexes, today's Smith fill for singles) and
 * Regenerate everything (reset + full pipeline), plus the prose checkbox.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
}));

vi.mock('@/search', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), searchRules: vi.fn() };
});

import type * as domainArtifact from '@/domain/artifact';

vi.mock('@/domain/artifact', async (importOriginal) => {
  const actual = await importOriginal<typeof domainArtifact>();
  return { ...actual, drawFillGrade: vi.fn(actual.drawFillGrade) };
});

const chatMock = vi.mocked(chat);
const { searchRules } = await import('@/search');
const searchRulesMock = vi.mocked(searchRules);
const { drawFillGrade } = await import('@/domain/artifact');
const drawFillGradeMock = vi.mocked(drawFillGrade);

function waitForRun(assertion: () => void | Promise<void>) {
  return waitFor(assertion, { timeout: 15000 });
}

const INLINE_STATBLOCK = {
  system: 'dnd5e', level: '1', size: 'Medium', creatureType: 'humanoid', ac: 12,
  acNote: '', hp: 7, hpFormula: '2d6', speed: '30 ft.',
  abilities: { str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 10 },
  saves: '', skills: '', senses: '', languages: '', traits: [], actions: [], reactions: [], legendary: [], extras: {},
};

/** A repopulation brief: four sourced fights, one per mirrored room. */
const REPOPULATE_BRIEF = {
  name: 'Ash Temple Undercroft',
  summary: 'A four-room crypt under the ash temple.',
  body: '# Ash Temple\nFour rooms of cultists.',
  difficulty: 'hard',
  levelHint: '', partyLevel: 4,
  terrain: 'crypt stone',
  tactics: 'hold the lines',
  treasure: 'cult hoard',
  theme: 'ash-choked crypt',
  styleNotes: 'inked fantasy map',
  negative: 'text, labels, tokens',
  environment: 'dungeon',
  monsters: [
    { name: 'Goblin Boss', count: 2, notes: 'entry guards', treasure: '', sourceName: 'Goblin Boss' },
    { name: 'Goblin Boss', count: 2, notes: 'ossuary pack', treasure: '', sourceName: 'Goblin Boss' },
    { name: 'Goblin Boss', count: 2, notes: 'ritual circle', treasure: '', sourceName: 'Goblin Boss' },
    { name: 'Goblin Boss', count: 2, notes: 'sanctum guard', treasure: '', sourceName: 'Goblin Boss' },
  ],
  rooms: [
    { name: 'Entry', description: '', size: 'medium', monsterIndexes: [0], adjacentRoomIndexes: [1], key: '', keyTreasure: '', targetLevel: 4 },
    { name: 'Ossuary', description: '', size: 'medium', monsterIndexes: [1], adjacentRoomIndexes: [0, 2], key: '', keyTreasure: '', targetLevel: 4 },
    { name: 'Ritual Chamber', description: '', size: 'large', monsterIndexes: [2], adjacentRoomIndexes: [1, 3], key: '', keyTreasure: '', targetLevel: 4 },
    { name: 'Sanctum', description: '', size: 'large', monsterIndexes: [3], adjacentRoomIndexes: [2], key: '', keyTreasure: '', targetLevel: 4 },
  ],
  entryRoomIndex: 0,
};

function cartographerPersona(): Persona {
  return createPersona({
    slug: 'encounter-cartographer',
    name: 'Encounter Cartographer',
    description: '',
    systemPrompt: 'Return encounter JSON.',
    mode: 'encounter',
    producesKind: 'encounter',
    builtIn: true,
  });
}

function smithPersona(): Persona {
  return createPersona({
    slug: 'encounter-smith',
    name: 'Encounter Smith',
    description: '',
    systemPrompt: 'Return encounter JSON.',
    mode: 'generate',
    producesKind: 'encounter',
    builtIn: true,
  });
}

async function setup(
  system: 'dnd5e' | 'pathfinder2e' = 'dnd5e',
): Promise<{ campaign: Awaited<ReturnType<typeof createCampaign>> }> {
  const campaign = await createCampaign({ name: 'Regen Campaign', system });
  const { db } = await import('@/db');
  await db.personas.put(cartographerPersona());
  await db.personas.put(smithPersona());
  await saveSettings({ ...defaultSettings(), openRouterApiKey: 'test-key', imagesEnabled: true });
  return { campaign };
}

async function seedPackBook(): Promise<string> {
  const book = await createPackBook({ title: 'Dnd5e Bestiary Pack', system: 'dnd5e', filename: 'pack.zip' });
  await finalizePackBook(book.id, {
    sourceId: 'foundry-pf2e',
    license: 'Community Use Policy',
    entriesImported: 1,
    entriesSkipped: 0,
    entriesFailed: 0,
  });
  const text = 'Goblin Boss, humanoid, agile commander.';
  await putChunks([
    ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: book.id,
      pageStart: 1,
      pageEnd: 1,
      chunkType: 'statblock',
      headingPath: ['Goblin Boss'],
      text,
      statBlock: statBlockSchema.parse({
        system: 'dnd5e',
        level: '1',
        size: 'Small',
        creatureType: 'humanoid (goblinoid)',
        ac: 17,
        acNote: '',
        hp: 21,
        hpFormula: '3d6 + 11',
        speed: '30 ft.',
        abilities: { str: 14, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
        saves: '',
        skills: '',
        senses: 'darkvision 60 ft.',
        languages: 'Common, Goblin',
        traits: [],
        actions: [],
        reactions: [],
        legendary: [],
        extras: { Traits: 'humanoid, goblinoid' },
      }),
      contentHash: await sha256Hex(text),
    }),
  ]);
  const { db } = await import('@/db');
  const chunk = await db.chunks.where('bookId').equals(book.id).first();
  return chunk?.id ?? '';
}

/** A valid persisted 4-room complex layout (rooms on file to restock). */
function complexLayoutFixture() {
  const ids = [newId(), newId(), newId(), newId()];
  const names = ['Entry', 'Ossuary', 'Ritual Chamber', 'Sanctum'];
  return {
    gridW: 40,
    gridH: 12,
    theme: 'ash temple',
    rooms: ids.map((id, index) => ({
      id,
      name: names[index] ?? `Room ${String(index)}`,
      rects: [{ x: 2 + index * 10, y: 2, w: 6, h: 6 }],
      mobsRect: { x: 3 + index * 10, y: 3, w: 3, h: 3 },
      description: '',
      monsterIndexes: index === 0 ? [0] : [],
      spawn: index === 0,
      key: index === 1 ? 'A cracked altar.' : '',
      keyTreasure: '',
    })),
    corridors: [
      { a: ids[0] ?? newId(), b: ids[1] ?? newId(), rects: [{ x: 8, y: 5, w: 4, h: 1 }] },
      { a: ids[1] ?? newId(), b: ids[2] ?? newId(), rects: [{ x: 18, y: 5, w: 4, h: 1 }] },
      { a: ids[2] ?? newId(), b: ids[3] ?? newId(), rects: [{ x: 28, y: 5, w: 4, h: 1 }] },
    ],
    path: ids,
  };
}

/** The owner's OLD dungeon row: a complex battlemap on file, ONE stale
 *  monster, owner-set fill grade, a stale advisory, preset 'dungeon'. */
async function seedComplexTarget(
  campaignId: Id,
  _goblinChunkId: Id,
  overrides: Record<string, unknown> = {},
  moduleId?: Id,
): Promise<Artifact & { kind: 'encounter' }> {
  const mapImageId = newId();
  const target = await createArtifact({
    campaignId,
    ...(moduleId === undefined ? {} : { moduleId }),
    kind: 'encounter',
    name: 'Old Undercroft',
    summary: 'Old summary.',
    body: 'Existing prose.',
    links: [],
    data: {
      difficulty: 'old', levelHint: '', partyLevel: 4,
      monsters: [{ name: 'Tomb Ogre', count: 4, notes: 'keep', treasure: 'Ogre pocket: 4 gp', source: { type: 'none' as const } }],
      terrain: '', tactics: '', treasure: '',
      mapImageId, preset: 'dungeon', locationKind: 'dungeon',
      siteShape: 'complex', budgetAdvisory: 'STALE ADVISORY',
      layout: complexLayoutFixture(),
      fillGrade: 100,
      ...overrides,
    },
  });
  if (target.kind !== 'encounter') throw new Error('encounter target missing');
  return target;
}

/** A valid persisted SINGLE-room layout (one arena on file). Its room carries
 *  no `targetLevel`, so the finalize stamps the encounter's OWN level — the
 *  input the reported bug overwrote. */
function singleRoomLayoutFixture() {
  const id = newId();
  return {
    gridW: 24,
    gridH: 18,
    theme: 'gatehouse',
    rooms: [
      {
        id,
        name: 'Gate',
        rects: [{ x: 2, y: 2, w: 8, h: 6 }],
        mobsRect: { x: 3, y: 3, w: 4, h: 4 },
        description: '',
        monsterIndexes: [0],
        spawn: true,
        key: '',
        keyTreasure: '',
      },
    ],
    corridors: [],
    path: [id],
  };
}

async function seedSingleTarget(
  campaignId: Id,
  _goblinChunkId: Id,
  overrides: Record<string, unknown> = {},
  moduleId?: Id,
): Promise<Artifact & { kind: 'encounter' }> {
  const target = await createArtifact({
    campaignId,
    ...(moduleId === undefined ? {} : { moduleId }),
    kind: 'encounter',
    name: 'Gate Ambush',
    summary: 'Gate summary.',
    body: 'Gate prose.',
    links: [],
    data: {
      difficulty: 'old', levelHint: '', partyLevel: 3,
      monsters: [{ name: 'Tomb Ogre', count: 4, notes: 'keep', treasure: '', source: { type: 'none' as const } }],
      terrain: '', tactics: '', treasure: '',
      mapImageId: newId(), preset: 'standard', locationKind: 'other',
      siteShape: 'single', budgetAdvisory: '', layout: null,
      ...overrides,
    },
  });
  if (target.kind !== 'encounter') throw new Error('encounter target missing');
  return target;
}

/** The user-content of ONE chat call (the model prompt), by index. */
function userPrompt(callIndex = 0): string {
  const content =
    chatMock.mock.calls[callIndex]?.[0].find((message) => message.role === 'user')?.content ?? '';
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function smithDraft(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Ambush at the ford',
    summary: 'A bridge ambush.',
    suggestedTags: ['ambush'],
    body: '# Ambush at the ford',
    difficulty: 'deadly',
    levelHint: '', partyLevel: 3,
    monsters: [
      { name: 'Ash Cultist', count: 2, notes: 'cut off the retreat', treasure: '', statBlock: INLINE_STATBLOCK },
    ],
    terrain: 'river crossing',
    tactics: 'hit and run',
    treasure: 'none',
    locationKind: 'other',
    ...overrides,
  };
}

beforeEach(async () => {
  await clearDatabase();
  useProgressStore.getState().reset();
  chatMock.mockReset();
  searchRulesMock.mockReset();
  searchRulesMock.mockResolvedValue([]);
  drawFillGradeMock.mockReset();
  drawFillGradeMock.mockReturnValue(70);
  vi.spyOn(encounterRunAdapters, 'renderSchematic').mockReturnValue({ dataUrl: 'data:image/png;base64,schematic', width: 2304, height: 1728 });
  // Honors the requested count (docs/17 row 307): the map path asks for ONE
  // candidate, and a mock that always answered two would hide the request.
  vi.spyOn(encounterRunAdapters, 'generateImages').mockImplementation((_prompt, n) =>
    Promise.resolve(generatedImagesFor(n, 'map')),
  );
  vi.spyOn(encounterRunAdapters, 'normalizeImageAspect').mockImplementation((blob) => Promise.resolve({ blob, width: 1200, height: 900, action: 'none' }));
  vi.spyOn(encounterRunAdapters, 'intakeImage').mockImplementation((blob) => Promise.resolve({ blob, width: 1200, height: 900, mimeType: 'image/webp' }));
});

describe('complex Repopulate (roster-only Cartographer pass)', () => {
  it('replaces the roster for ALL rooms via the repair loop; layout/map byte-identical, advisory recomputed, fill grade honored', async () => {
    const { campaign } = await setup();
    const goblinChunkId = await seedPackBook();
    const target = await seedComplexTarget(campaign.id, goblinChunkId);
    const beforeLayout = JSON.stringify(target.data.layout);
    const beforeMap = target.data.mapImageId;

    // First reply leaves the Sanctum empty — the 'empty' repair loop must
    // force a fully stocked roster (this is what kills pile-ups
    // structurally). The repair reply stocks every room.
    const emptyReply = {
      ...REPOPULATE_BRIEF,
      rooms: REPOPULATE_BRIEF.rooms.map((room, index) =>
        index === 3 ? { ...room, monsterIndexes: [] } : room,
      ),
    };
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(emptyReply), modelUsed: 'test-model', fallback: null })
      .mockResolvedValue({ text: JSON.stringify(REPOPULATE_BRIEF), modelUsed: 'test-model', fallback: null });

    await repopulateEncounter(target.id, { redesignProse: false });

    // The repair turn fired: the empty room was not silently accepted.
    expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    const after = await getArtifact(target.id);
    if (after?.kind !== 'encounter') throw new Error('encounter missing');

    // The roster is REPLACED (no verbatim pin — the old spawn was wrong).
    expect(after.data.monsters).toHaveLength(4);
    expect(after.data.monsters.map((monster) => monster.name)).toEqual(
      ['Goblin Boss', 'Goblin Boss', 'Goblin Boss', 'Goblin Boss'],
    );
    for (const monster of after.data.monsters) {
      await expectCopiedRosterEntry(monster, goblinChunkId, 'Goblin Boss');
    }

    // EVERY room covered: each room holds exactly one roster entry, each
    // entry belongs to exactly one room.
    const layout = after.data.layout;
    if (layout === null) throw new Error('layout missing after repopulate');
    expect(layout.rooms.map((room) => room.monsterIndexes)).toEqual([[0], [1], [2], [3]]);

    // Rooms, layout and map PRESERVED: geometry, keys, corridors, path and
    // the battlemap are byte-identical (only monsterIndexes/targetLevels
    // move with the new roster).
    const stripAssignment = (stored: unknown) => {
      const parsed = JSON.parse(JSON.stringify(stored)) as {
        rooms: { monsterIndexes?: unknown; targetLevel?: unknown }[];
      };
      return {
        ...parsed,
        rooms: parsed.rooms.map(({ monsterIndexes: _m, targetLevel: _t, ...rest }) => rest),
      };
    };
    expect(stripAssignment(layout)).toEqual(stripAssignment(JSON.parse(beforeLayout)));
    expect(after.data.mapImageId).toBe(beforeMap);

    // Prose + name untouched (checkbox OFF); advisory recomputed (the stale
    // one is gone); the row's fill grade honored — never redrawn.
    expect(after.name).toBe('Old Undercroft');
    expect(after.body).toBe('Existing prose.');
    expect(after.data.budgetAdvisory).not.toBe('STALE ADVISORY');
    expect(typeof after.data.budgetAdvisory).toBe('string');
    expect(after.data.fillGrade).toBe(100);
    expect(drawFillGradeMock).not.toHaveBeenCalled();
    expect(after.data.preset).toBe('dungeon');
    expect(after.data.siteShape).toBe('complex');
  });

  it('rejects an over-cap fresh roster loudly (the cap binds unpinned replies too)', async () => {
    const { campaign } = await setup();
    const goblinChunkId = await seedPackBook();
    const target = await seedComplexTarget(campaign.id, goblinChunkId);
    // 4 × 10 = 40 creature-levels against a cap of 4×6 + 2 = 26.
    chatMock.mockResolvedValue({ text: JSON.stringify({
      ...REPOPULATE_BRIEF,
      monsters: REPOPULATE_BRIEF.monsters.map((monster) => ({ ...monster, count: 10 })),
    }), modelUsed: 'test-model', fallback: null });
    const { db } = await import('@/db');
    const cartographer = await db.personas.where('slug').equals('encounter-cartographer').first();
    if (cartographer === undefined) throw new Error('cartographer missing');
    const runInput: StartRunInput = {
      campaign,
      persona: cartographer,
      autonomy: 'manual',
      brief: 'Repopulate',
      pinnedChunkIds: [],
      targetArtifactId: target.id,
      encounterScope: 'rosterOnly',
      encounterPreset: 'dungeon',
    };
    const runId = await runEngine.startRun(runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
    });
    const step = (await getRun(runId))?.steps[0];
    expect(step?.status).toBe('rejected');
    const issues = rejectionIssues(step ?? { output: null });
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain("over the complex's stocking cap of 26");
    // Nothing persisted over the cap.
    const untouched = await getArtifact(target.id);
    if (untouched?.kind !== 'encounter') throw new Error('encounter missing');
    expect(untouched.data.monsters.map((monster) => monster.name)).toEqual(['Tomb Ogre']);
  });

  it('draws the fill grade once for a legacy complex row without one (backfill unchanged)', async () => {
    const { campaign } = await setup();
    const goblinChunkId = await seedPackBook();
    const target = await seedComplexTarget(campaign.id, goblinChunkId, { fillGrade: undefined });
    expect(target.data.fillGrade).toBeUndefined();
    chatMock.mockResolvedValue({ text: JSON.stringify(REPOPULATE_BRIEF), modelUsed: 'test-model', fallback: null });
    await repopulateEncounter(target.id, { redesignProse: false });
    const after = await getArtifact(target.id);
    if (after?.kind !== 'encounter') throw new Error('encounter missing');
    expect(after.data.fillGrade).toBe(70);
    expect(drawFillGradeMock).toHaveBeenCalledTimes(1);
    expect(after.data.monsters).toHaveLength(4);
  });

  it('runs the brief→finalize pipeline shape (no layout/stylize/pick steps)', async () => {
    const { campaign } = await setup();
    const goblinChunkId = await seedPackBook();
    const target = await seedComplexTarget(campaign.id, goblinChunkId);
    chatMock.mockResolvedValue({ text: JSON.stringify(REPOPULATE_BRIEF), modelUsed: 'test-model', fallback: null });
    const { db } = await import('@/db');
    const cartographer = await db.personas.where('slug').equals('encounter-cartographer').first();
    if (cartographer === undefined) throw new Error('cartographer missing');
    const runInput: StartRunInput = {
      campaign,
      persona: cartographer,
      autonomy: 'auto',
      brief: 'Repopulate',
      pinnedChunkIds: [],
      targetArtifactId: target.id,
      encounterScope: 'rosterOnly',
      encounterPreset: 'dungeon',
    };
    const runId = await runEngine.startRun(runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    expect((await getRun(runId))?.steps.map((step) => step.name)).toEqual(['brief', 'finalize']);
  });
});

describe('encounter budget policy (docs/17 row 180 — ONE resolved policy)', () => {
  /** A pf2e-valid repopulation reply: four inline-statblock fights, so the
   *  roster needs no pack book and the level sum is deterministic. */
  const pf2eBrief = {
    ...REPOPULATE_BRIEF,
    monsters: [
      { name: 'Ghoul', count: 1, notes: '', treasure: '', statBlock: { ...INLINE_STATBLOCK, system: 'pathfinder2e', level: '2' } },
      { name: 'Ghoul', count: 1, notes: '', treasure: '', statBlock: { ...INLINE_STATBLOCK, system: 'pathfinder2e', level: '2' } },
      { name: 'Ghoul', count: 1, notes: '', treasure: '', statBlock: { ...INLINE_STATBLOCK, system: 'pathfinder2e', level: '2' } },
      { name: 'Ghoul', count: 1, notes: '', treasure: '', statBlock: { ...INLINE_STATBLOCK, system: 'pathfinder2e', level: '2' } },
    ],
  };

  async function cartographer(): Promise<Persona> {
    const { db } = await import('@/db');
    const persona = await db.personas.where('slug').equals('encounter-cartographer').first();
    if (persona === undefined) throw new Error('cartographer missing');
    return persona;
  }

  async function runArm(
    campaign: Awaited<ReturnType<typeof createCampaign>>,
    targetId: Id,
  ): Promise<{ prompt: string; calls: number; advisory: string }> {
    const runInput: StartRunInput = {
      campaign,
      persona: await cartographer(),
      autonomy: 'manual',
      brief: 'Repopulate',
      pinnedChunkIds: [],
      targetArtifactId: targetId,
      encounterScope: 'rosterOnly',
      encounterPreset: 'dungeon',
    };
    const runId = await runEngine.startRun(runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
    });
    const content =
      chatMock.mock.calls[0]?.[0].find((message) => message.role === 'user')?.content ?? '';
    const step = (await getRun(runId))?.steps[0];
    const output = step?.output as { budgetAdvisory?: unknown } | null | undefined;
    const advisory = typeof output?.budgetAdvisory === 'string' ? output.budgetAdvisory : '';
    const calls = chatMock.mock.calls.length;
    chatMock.mockClear();
    return { prompt: typeof content === 'string' ? content : JSON.stringify(content), calls, advisory };
  }

  it("the SAME brief under 'verbatim' vs 'pf2e-budget' produces DIFFERENT stocking instructions and a different verdict", async () => {
    const { campaign } = await setup('pathfinder2e');
    const goblinChunkId = await seedPackBook();
    const verbatimModule = await saveModule(createModule({
      campaignId: campaign.id, title: 'Verbatim Module', concept: '', levelMin: 4, levelMax: 5,
      sizeDial: 'standard', encounterBudgetPolicy: 'verbatim',
    }));
    const budgetModule = await saveModule(createModule({
      campaignId: campaign.id, title: 'Budget Module', concept: '', levelMin: 4, levelMax: 5,
      sizeDial: 'standard', encounterBudgetPolicy: 'pf2e-budget',
    }));
    // The layout carries each room's targetLevel, so a repopulation's brief
    // must pass the existing names AND targets through (requirement 4).
    const layoutWithTargets = (() => {
      const layout = complexLayoutFixture();
      return { ...layout, rooms: layout.rooms.map((room) => ({ ...room, targetLevel: 4 })) };
    })();
    const verbatimTarget = await seedComplexTarget(campaign.id, goblinChunkId, { layout: layoutWithTargets }, verbatimModule.id);
    const budgetTarget = await seedComplexTarget(campaign.id, goblinChunkId, { layout: layoutWithTargets }, budgetModule.id);
    chatMock.mockResolvedValue({ text: JSON.stringify(pf2eBrief), modelUsed: 'test-model', fallback: null });

    const verbatim = await runArm(campaign, verbatimTarget.id);
    const budget = await runArm(campaign, budgetTarget.id);

    // 1. DIFFERENT stocking instructions for the SAME brief + same rooms.
    expect(verbatim.prompt).not.toContain('fill grade is');
    expect(verbatim.prompt).not.toContain('stocking every one of them');
    expect(verbatim.prompt).toContain('Design a concrete monster roster appropriate to the requested difficulty.');
    expect(budget.prompt).toContain('fill grade is 100%');
    expect(budget.prompt).toContain('stocking every one of them');
    // The repopulation receives the existing room names AND their targetLevels.
    expect(budget.prompt).toContain('Entry (targetLevel 4)');
    expect(budget.prompt).toContain('Sanctum (targetLevel 4)');
    expect(budget.prompt).not.toBe(verbatim.prompt);

    // 2. DIFFERENT budget verdict for the SAME under-strength reply (each room
    //    ships 2 creature-levels against a pf2e expectation of 8).
    //    Verbatim: one call, accepted as-is, the loud not-checked advisory.
    expect(verbatim.calls).toBe(1);
    expect(verbatim.advisory).toContain('not deterministically budget-checked');
    //    pf2e-budget: the under-strength rooms are REPAIRABLE, so a second
    //    (bounded repair) turn ran, and the shipped advisory names them plus
    //    the approximation source — never silence.
    expect(budget.calls).toBe(2);
    expect(budget.advisory).toContain('ships under its expected challenge');
    expect(budget.advisory).toContain("Campaigner's OWN documented PF2e approximation");
    expect(budget.advisory).not.toContain('not deterministically budget-checked');
  });

  it('drives a repopulate from the MODULE ROW policy (stamping, not dialog state)', async () => {
    const { campaign } = await setup('pathfinder2e');
    const goblinChunkId = await seedPackBook();
    // An explicit choice is stamped on the row; an omitted one is the legacy
    // null (which resolves to 'system'), and the row — never the dialog or the
    // live settings — decides what a later repopulate uses.
    const fresh = await saveModule(createModule({
      campaignId: campaign.id, title: 'Fresh', concept: '', levelMin: 4, levelMax: 4,
      sizeDial: 'standard',
    }));
    const chosen = await saveModule(createModule({
      campaignId: campaign.id, title: 'Chosen', concept: '', levelMin: 4, levelMax: 4,
      sizeDial: 'standard', encounterBudgetPolicy: 'verbatim',
    }));
    expect((await getModule(fresh.id))?.encounterBudgetPolicy).toBeNull();
    expect((await getModule(chosen.id))?.encounterBudgetPolicy).toBe('verbatim');

    // A target owned by the CHOSEN (verbatim) module repopulates verbatim even
    // though the campaign is pf2e — the module row decides, deterministically.
    const target = await seedComplexTarget(campaign.id, goblinChunkId, {}, chosen.id);
    chatMock.mockResolvedValue({ text: JSON.stringify(pf2eBrief), modelUsed: 'test-model', fallback: null });
    const arm = await runArm(campaign, target.id);
    expect(arm.prompt).not.toContain('fill grade is');
    expect(arm.advisory).toContain('not deterministically budget-checked');
  });
});

describe('complex Regenerate everything (reset + full pipeline)', () => {
  it('resets roster/layout/map on the SAME row, then builds new ones; fill grade and preset honored, prose kept', async () => {
    const { campaign } = await setup();
    const goblinChunkId = await seedPackBook();
    const target = await seedComplexTarget(campaign.id, goblinChunkId);
    const beforeMap = target.data.mapImageId;
    const beforeRoomIds = target.data.layout?.rooms.map((room) => room.id) ?? [];

    chatMock.mockResolvedValue({ text: JSON.stringify(REPOPULATE_BRIEF), modelUsed: 'test-model', fallback: null });
    await regenerateEncounterEverything(target.id, { redesignProse: false });

    const after = await getArtifact(target.id);
    if (after?.kind !== 'encounter') throw new Error('encounter missing');

    // New roster (the reset emptied it; the pipeline designed it whole —
    // no verbatim pin of the stale Tomb Ogre).
    expect(after.data.monsters).toHaveLength(4);
    expect(after.data.monsters.every((monster) => monster.name === 'Goblin Boss')).toBe(true);

    // New layout + new map on the SAME row (no fresh artifact was created).
    expect(after.id).toBe(target.id);
    expect(after.data.layout).not.toBeNull();
    expect(after.data.layout?.rooms).toHaveLength(4);
    expect(after.data.layout?.rooms.map((room) => room.id)).not.toEqual(beforeRoomIds);
    expect(after.data.mapImageId).not.toBeNull();
    expect(after.data.mapImageId).not.toBe(beforeMap);

    // Kept: fill grade (never redrawn), preset (no silent re-tier),
    // siteShape, locationKind, name and prose.
    expect(after.data.fillGrade).toBe(100);
    expect(drawFillGradeMock).not.toHaveBeenCalled();
    expect(after.data.preset).toBe('dungeon');
    expect(after.data.siteShape).toBe('complex');
    expect(after.data.locationKind).toBe('dungeon');
    expect(after.name).toBe('Old Undercroft');
    expect(after.body).toBe('Existing prose.');
    expect(after.data.budgetAdvisory).not.toBe('STALE ADVISORY');
  });
});

describe('prose checkbox (prose-only redesign)', () => {
  it('ON redesigns name and prose without touching the roster (monsters byte-identical)', async () => {
    const { campaign } = await setup();
    const goblinChunkId = await seedPackBook();
    const target = await seedComplexTarget(campaign.id, goblinChunkId);
    const beforeMonsters = JSON.stringify(target.data.monsters);

    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(REPOPULATE_BRIEF), modelUsed: 'test-model', fallback: null })
      .mockResolvedValue({
        text: JSON.stringify(smithDraft({
          name: 'The Ash Redoubt',
          summary: 'A renamed crypt.',
          body: '# The Ash Redoubt\nRedesigned prose.',
          monsters: [0, 1, 2, 3].map((index) => ({
            name: 'Goblin Boss',
            count: 2,
            notes: ['entry guards', 'ossuary pack', 'ritual circle', 'sanctum guard'][index] ?? '',
            treasure: '',
            statBlock: INLINE_STATBLOCK,
          })),
        })),
        modelUsed: 'test-model',
        fallback: null,
      });

    await repopulateEncounter(target.id, { redesignProse: true });

    const after = await getArtifact(target.id);
    if (after?.kind !== 'encounter') throw new Error('encounter missing');
    // The prose leg ran AFTER the repopulation — and the roster it found is
    // the NEW one, echoed verbatim, so it persists byte-identically.
    expect(after.name).toBe('The Ash Redoubt');
    expect(after.body).toBe('# The Ash Redoubt\nRedesigned prose.');
    expect(after.summary).toBe('A renamed crypt.');
    expect(after.aliases).toContain('Old Undercroft');
    expect(after.data.monsters.map((monster) => `${monster.name}|${String(monster.count)}`)).toEqual(
      ['Goblin Boss|2', 'Goblin Boss|2', 'Goblin Boss|2', 'Goblin Boss|2'],
    );
    expect(JSON.stringify(beforeMonsters)).not.toBe(JSON.stringify(after.data.monsters));
  });

  it('renames without writing the old name TWICE when the pool already carries it (docs/17 row 121)', async () => {
    const { campaign } = await setup();
    const goblinChunkId = await seedPackBook();
    const target = await seedComplexTarget(campaign.id, goblinChunkId);
    // The pool already spells the row's OWN current name (an imported row, or
    // one the reader's old self-name append left behind). The hand-rolled guard
    // on this path asked whether the pool answered the NEW name and then
    // appended the OLD one unconditionally — so it wrote "Old Undercroft" a
    // second time, and one name became two rows in the alias editor. The ONE
    // merge rule dedupes against the pool it is appending to.
    await updateArtifact(target.id, { aliases: ['Old Undercroft'] });

    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(REPOPULATE_BRIEF), modelUsed: 'test-model', fallback: null })
      .mockResolvedValue({
        text: JSON.stringify(smithDraft({
          name: 'The Ash Redoubt',
          summary: 'A renamed crypt.',
          body: '# The Ash Redoubt\nRedesigned prose.',
          monsters: [0, 1, 2, 3].map((index) => ({
            name: 'Goblin Boss',
            count: 2,
            notes: ['entry guards', 'ossuary pack', 'ritual circle', 'sanctum guard'][index] ?? '',
            treasure: '',
            statBlock: INLINE_STATBLOCK,
          })),
        })),
        modelUsed: 'test-model',
        fallback: null,
      });

    await repopulateEncounter(target.id, { redesignProse: true });

    const after = await getArtifact(target.id);
    if (after?.kind !== 'encounter') throw new Error('encounter missing');
    expect(after.name).toBe('The Ash Redoubt');
    // Once — the old name still answers every `[[Old Undercroft]]`, and it is
    // not written a second time.
    expect(after.aliases).toEqual(['Old Undercroft']);
  });

  it('OFF keeps name and prose (covered above) — and a prose reply that rewrites monsters fails loud with nothing persisted', async () => {
    const { campaign } = await setup();
    const goblinChunkId = await seedPackBook();
    const target = await seedSingleTarget(campaign.id, goblinChunkId);
    const before = await getAnyArtifact(target.id);
    if (before?.kind !== 'encounter') throw new Error('encounter missing');

    chatMock.mockResolvedValue({
      text: JSON.stringify(smithDraft({
        name: 'Sneaky Rename',
        body: '# Sneaky prose',
        monsters: [{ name: 'Different Monster', count: 9, notes: '', treasure: '', statBlock: INLINE_STATBLOCK }],
      })),
      modelUsed: 'test-model',
      fallback: null,
    });

    const { db } = await import('@/db');
    const smith = await db.personas.where('slug').equals('encounter-smith').first();
    if (smith === undefined) throw new Error('smith missing');
    const runId = await runEngine.startRun({
      campaign,
      persona: smith,
      autonomy: 'auto',
      brief: 'Redesign prose only',
      pinnedChunkIds: [],
      targetArtifactId: target.id,
      encounterProseOnly: true,
    });
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    });
    expect((await getRun(runId))?.errorMessage).toContain('prose-only redesign');

    // Never partial-applies: name, prose, aliases and roster all unchanged.
    const after = await getAnyArtifact(target.id);
    if (after?.kind !== 'encounter') throw new Error('encounter missing');
    expect(after.name).toBe(before.name);
    expect(after.body).toBe(before.body);
    expect(after.summary).toBe(before.summary);
    expect(after.aliases).toEqual(before.aliases);
    expect(after.data.monsters).toEqual(before.data.monsters);
  });
});

describe('singles keep today\u2019s behavior under the new buttons', () => {
  it('Repopulate: new one-fight roster, map preserved, name kept (alias)', async () => {
    const { campaign } = await setup();
    const goblinChunkId = await seedPackBook();
    const target = await seedSingleTarget(campaign.id, goblinChunkId);
    const beforeMap = target.data.mapImageId;

    chatMock.mockResolvedValue({ text: JSON.stringify(smithDraft()), modelUsed: 'test-model', fallback: null });
    await repopulateEncounter(target.id, { redesignProse: false });

    const after = await getArtifact(target.id);
    if (after?.kind !== 'encounter') throw new Error('encounter missing');
    expect(after.data.monsters.map((monster) => monster.name)).toEqual(['Ash Cultist']);
    expect(after.data.mapImageId).toBe(beforeMap);
    expect(after.name).toBe('Gate Ambush');
    expect(after.aliases).toContain('Ambush at the ford');
    expect(after.body).toBe('# Ambush at the ford');
    expect(after.data.layout).toBeNull();
  });

  it('Regenerate everything: fresh one-fight draft + fresh map in one action (rename when checked)', async () => {
    const { campaign } = await setup();
    const goblinChunkId = await seedPackBook();
    const target = await seedSingleTarget(campaign.id, goblinChunkId);
    const beforeMap = target.data.mapImageId;

    const singleBrief = {
      name: 'Gate Ambush',
      summary: 'A gate fight.',
      body: '# Gate\nOne fight.',
      difficulty: 'medium',
      levelHint: '', partyLevel: 3,
      terrain: 'gatehouse',
      tactics: 'hold',
      treasure: 'none',
      theme: 'stone gate',
      styleNotes: 'inked fantasy map',
      negative: 'text, labels, tokens',
      environment: 'outdoor',
      monsters: [{ name: 'Ash Cultist', count: 2, notes: 'cut off the retreat', treasure: '' }],
      rooms: [
        { name: 'Gate', description: '', size: 'medium', monsterIndexes: [0], adjacentRoomIndexes: [], key: '', keyTreasure: '', targetLevel: 3 },
      ],
      entryRoomIndex: 0,
    };
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(smithDraft({ name: 'Renamed Gate' })), modelUsed: 'test-model', fallback: null })
      .mockResolvedValue({ text: JSON.stringify(singleBrief), modelUsed: 'test-model', fallback: null });

    await regenerateEncounterEverything(target.id, { redesignProse: true });

    const after = await getArtifact(target.id);
    if (after?.kind !== 'encounter') throw new Error('encounter missing');
    expect(after.id).toBe(target.id);
    expect(after.data.monsters.map((monster) => monster.name)).toEqual(['Ash Cultist']);
    expect(after.name).toBe('Renamed Gate');
    expect(after.aliases).toContain('Gate Ambush');
    // Fresh map: a new battlemap replaced the old one, with a fresh layout.
    expect(after.data.mapImageId).not.toBeNull();
    expect(after.data.mapImageId).not.toBe(beforeMap);
    expect(after.data.layout?.rooms).toHaveLength(1);
  });
});

/**
 * The encounter's own level and the owning module's difficulty are INPUTS on a
 * repopulate (docs/17 row 228) — the owner set a level-1 fight to Normal,
 * hit Repopulate, and got two level-9 mobs because the single-room route's
 * Smith brief stated neither level nor difficulty and the reply was allowed
 * to overwrite the row. These pins hold both halves: the prompt states them
 * through the EXISTING seams, and the row's stored values survive a reply
 * that claims otherwise (with the mismatch spoken loudly).
 */
describe('repopulate states and preserves its level and difficulty (docs/17 row 228)', () => {
  it('the SINGLE-room Smith draft prompt carries the party level and the module-difficulty clause', async () => {
    const { campaign } = await setup();
    const goblinChunkId = await seedPackBook();
    const module = await saveModule(createModule({
      campaignId: campaign.id, title: 'Level One Module', concept: '', levelMin: 1, levelMax: 1,
      sizeDial: 'standard', difficulty: 'much-harder',
    }));
    const target = await seedSingleTarget(
      campaign.id, goblinChunkId, { levelHint: '', partyLevel: 1, difficulty: 'normal' }, module.id,
    );
    chatMock.mockResolvedValue({ text: JSON.stringify(smithDraft()), modelUsed: 'test-model', fallback: null });

    await repopulateEncounter(target.id, { redesignProse: false });

    const prompt = userPrompt();
    // The party level, through the ONE shared sentence composer.
    expect(prompt).toContain(partyLevelLine(1));
    // The module difficulty, through the ONE clause composer — the seam's own
    // wording, so a re-spelled second sentence cannot satisfy this.
    const moduleRow = await getModule(module.id);
    const budget = encounterBudgetFor(
      resolveEncounterBudgetPolicy(moduleRow),
      'dnd5e',
      resolveModuleDifficulty(moduleRow),
    );
    expect(prompt).toContain(moduleDifficultyGuidanceFor(budget));
    expect(prompt).toContain('Much harder');
    expect(prompt).toContain('(targetLevel + 2) × 2');
  });

  it("sizes the fight from the row's OWN party level and keeps its difficulty when the reply claims otherwise", async () => {
    const { campaign } = await setup();
    const goblinChunkId = await seedPackBook();
    const module = await saveModule(createModule({
      campaignId: campaign.id, title: 'Level One Module', concept: '', levelMin: 1, levelMax: 1,
      sizeDial: 'standard',
    }));
    // The owner's row: a SINGLE-room encounter WITH a layout (so the budget
    // check runs at all — the old singles fixture carried none), level 1,
    // difficulty normal.
    const target = await seedSingleTarget(
      campaign.id,
      goblinChunkId,
      { levelHint: '', partyLevel: 1, difficulty: 'normal', layout: singleRoomLayoutFixture() },
      module.id,
    );
    // The mocked reply claims difficulty "deadly" and fields two level-9
    // creatures. It has NO level field to claim any more (docs/17 row 291:
    // the model stopped writing an encounter level), which is exactly why the
    // row's structured `partyLevel` is the one source.
    chatMock.mockResolvedValue({
      text: JSON.stringify(smithDraft({
        difficulty: 'deadly',
        monsters: [
          { name: 'Ash Cultist', count: 2, notes: '', treasure: '', statBlock: { ...INLINE_STATBLOCK, level: '9' } },
        ],
      })),
      modelUsed: 'test-model',
      fallback: null,
    });

    await repopulateEncounter(target.id, { redesignProse: false });

    const after = await getArtifact(target.id);
    if (after?.kind !== 'encounter') throw new Error('encounter missing');
    // WARN-AND-ACCEPT is preserved (docs/11 D14): the roster DID land.
    expect(after.data.monsters).toHaveLength(1);
    expect(after.data.monsters[0]?.name).toBe('Ash Cultist');
    // The row's own STRUCTURED level and difficulty are inputs: the reply did
    // not rewrite them, and the deprecated stored string is never read as a
    // level (docs/17 row 291) and never repopulated from the reply.
    expect(after.data.partyLevel).toBe(1);
    expect(after.data.levelHint).toBe('');
    expect(after.data.difficulty).toBe('normal');
    // The room was stamped from the ENCOUNTER's resolved level (1), not the
    // reply's level-9 creatures.
    expect(after.data.layout?.rooms[0]?.targetLevel).toBe(1);
    // The over-band advisory is present and visible, computed against the
    // row's own band (target level 1 ⇒ at most 3 creature-levels): two
    // level-9 creatures sum to 18.
    expect(after.data.budgetAdvisory).toContain('ships over its challenge budget');
    expect(after.data.budgetAdvisory).toContain('a band of at most 3 for target level 1');
    // The kept DIFFICULTY is spoken LOUDLY, never silently preserved. There is
    // NO level-drift sentence any more: the reply carries no level to disagree
    // with (this arm pinned the deleted free-text drift notice).
    expect(after.data.budgetAdvisory).toContain('labelled this fight "deadly"');
    expect(after.data.budgetAdvisory).not.toContain('designed at level');
    expect(after.data.budgetAdvisory).not.toContain("OWN level is kept");
  });

  it('a FRESH encounter generation records the create-dialog party level and the drafted difficulty', async () => {
    const { campaign } = await setup();
    await seedPackBook();
    const { db } = await import('@/db');
    const smith = await db.personas.where('slug').equals('encounter-smith').first();
    if (smith === undefined) throw new Error('smith missing');
    chatMock.mockResolvedValue({
      text: JSON.stringify(smithDraft({ difficulty: 'deadly' })),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun({
      campaign,
      persona: smith,
      autonomy: 'auto',
      brief: 'Design a brand new fight.',
      pinnedChunkIds: [],
      // The create dialog's STRUCTURED party level (docs/17 row 291): a fresh
      // encounter has no row yet and no module part mentions it, so this IS
      // the ONE source — the reply no longer carries a level at all.
      encounterPartyLevel: 9,
    });
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const created = await getArtifact((await getRun(runId))?.resultArtifactId ?? '');
    if (created?.kind !== 'encounter') throw new Error('fresh encounter missing');
    expect(created.data.partyLevel).toBe(9);
    expect(created.data.levelHint).toBe('');
    expect(created.data.difficulty).toBe('deadly');
  });
});

/**
 * The change seam's instruction (docs/17 row 101, docs/18 §2) reaches the REAL
 * prompt: `features/modules/change-artifact` threads it through
 * `EncounterRegenOptions.instruction`, this module appends it to every brief it
 * sends, and the run engine renders the brief verbatim in the model prompt. The
 * two halves are pinned together here — the ANCHORED paragraph for each leg,
 * and the no-instruction prompt with no paragraph at all (the byte-identity the
 * routed artifact editor buttons depend on).
 */
describe('an instruction is appended to the brief, and absent without one', () => {
  function promptFor(callIndex = 0): string {
    const messages = chatMock.mock.calls[callIndex]?.[0] as { content?: unknown }[] | undefined;
    const content = messages?.[1]?.content;
    return typeof content === 'string' ? content : '';
  }

  it('single Repopulate: the Smith draft prompt carries it as ONE appended paragraph', async () => {
    const { campaign } = await setup();
    const goblinChunkId = await seedPackBook();
    const target = await seedSingleTarget(campaign.id, goblinChunkId);
    const instruction = 'Make the fight brutal and the terrain flooded.';
    chatMock.mockResolvedValue({ text: JSON.stringify(smithDraft()), modelUsed: 'test-model', fallback: null });

    await repopulateEncounter(target.id, { redesignProse: false, instruction });

    const prompt = promptFor();
    // The Task line still carries the brief verbatim, with the instruction as a
    // paragraph of its own right after it (and before the next section).
    expect(prompt).toContain(
      'Task: Regenerate the full content of this encounter — roster with stat sources, terrain, tactics, treasure and prose. Its name, relations and battlemap are preserved.',
    );
    expect(prompt).toContain(`\n\nAdditional instruction: ${instruction}\n\n`);
  });

  it('single Repopulate with NO instruction: the same prompt, and no such paragraph', async () => {
    const { campaign } = await setup();
    const goblinChunkId = await seedPackBook();
    const target = await seedSingleTarget(campaign.id, goblinChunkId);
    chatMock.mockResolvedValue({ text: JSON.stringify(smithDraft()), modelUsed: 'test-model', fallback: null });

    await repopulateEncounter(target.id, { redesignProse: false });

    const prompt = promptFor();
    expect(prompt).not.toContain('Additional instruction');
    expect(prompt).toContain(
      'Task: Regenerate the full content of this encounter — roster with stat sources, terrain, tactics, treasure and prose. Its name, relations and battlemap are preserved.\n\n',
    );
  });

  it('complex Repopulate: the Cartographer BRIEF prompt carries it too', async () => {
    const { campaign } = await setup();
    const goblinChunkId = await seedPackBook();
    const target = await seedComplexTarget(campaign.id, goblinChunkId);
    const instruction = 'Stock the Sanctum with the cult’s high priest.';
    chatMock.mockResolvedValue({ text: JSON.stringify(REPOPULATE_BRIEF), modelUsed: 'test-model', fallback: null });

    await repopulateEncounter(target.id, { redesignProse: false, instruction });

    expect(promptFor()).toContain(`\n\nAdditional instruction: ${instruction}\n\n`);
  });
});

/**
 * The manual regen's OWN reason sentence — the one caller that deliberately
 * does NOT adopt the engine's sentence seam (docs/18 §2/§5, docs/17 row 128).
 *
 * It is a boundary, not an oversight, so it is pinned as one: the LABEL names
 * which LEG of a chained operation died (both legs brief under the same engine
 * step name), and the engine's own sentence rides behind it as a colon-suffixed
 * detail — so the composition hides nothing the engine said, while adopting the
 * seam would drop the leg. If a later slice adopts the seam here, these two
 * pins move WITH the docs and the scan's boundary note.
 */
describe('the manual regen keeps its own leg-labelled reason (the seam BOUNDARY)', () => {
  it('a leg that FAILED names the leg, then the engine’s sentence as a colon-suffixed detail', async () => {
    const { campaign } = await setup();
    const goblinChunkId = await seedPackBook();
    const target = await seedSingleTarget(campaign.id, goblinChunkId);
    chatMock.mockRejectedValue(new Error('provider exploded'));

    const thrown: unknown = await repopulateEncounter(target.id, { redesignProse: false }).catch(
      (error: unknown) => error,
    );

    const runRow = (await listRunsByCampaign(campaign.id)).find(
      (run) => run.targetArtifactId === target.id,
    );
    expect(runRow?.status).toBe('failed');
    // Non-vacuity first: an empty message would make the assertion below pass
    // for the fallback's reason instead (AGENTS rule 1).
    expect(runRow?.errorMessage).not.toBe('');
    expect(runRow?.errorMessage).toContain('provider exploded');
    // The BOUNDARY's exact shape: `<label> ended <status>: <the engine's own
    // sentence>`. Not the seam's shape — the message is NOT the whole sentence
    // here — and not the fallback either.
    expect((thrown as Error).message).toBe(`Repopulate ended failed: ${runRow?.errorMessage}`);
  });

  it('a leg the OWNER stopped is still REPORTED by this caller — `Repopulate ended cancelled`, the documented non-silence', async () => {
    const { campaign } = await setup();
    const goblinChunkId = await seedPackBook();
    const target = await seedSingleTarget(campaign.id, goblinChunkId);

    // Park the Smith's draft reply so the run stays live while the owner's Stop
    // lands (the Runs tab's own gesture). The reply is never released: nothing
    // but the regen's own caller may speak in this pin.
    chatMock.mockImplementation(
      () =>
        new Promise(() => {
          /* parked forever */
        }),
    );
    const pending = repopulateEncounter(target.id, { redesignProse: false });
    let runId: Id | undefined;
    await waitForRun(async () => {
      runId = (await listRunsByCampaign(campaign.id)).find(
        (run) => run.targetArtifactId === target.id,
      )?.id;
      expect(runId).toBeDefined();
    });
    if (runId === undefined) throw new Error('the regen run never appeared');
    await runEngine.cancel(runId);

    const thrown: unknown = await pending.catch((error: unknown) => error);

    // The contrast with the queue (docs/17 row 117): a queue job's withdrawal
    // is moot work and settles SILENTLY, while a manual regen has a caller to
    // answer to — so this sentence is deliberately still composed and still
    // thrown. The predicate exemption is the owner's decision and stands.
    expect((thrown as Error).message).toBe('Repopulate ended cancelled');
  }, 30000);
});
