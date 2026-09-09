import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getAnyArtifact, getArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { getRun } from '@/db/runRepo';
import { saveSettings } from '@/db/settingsRepo';
import {
  createPersona,
  defaultSettings,
  newId,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
  type Artifact,
  type Id,
  type Persona,
} from '@/domain';
import { sha256Hex } from '@/lib/hash';
import { encounterRunAdapters, rejectionIssues, runEngine, type StartRunInput } from '@/llm/runEngine';
import { chat } from '@/llm/openrouter';
import { repopulateEncounter, regenerateEncounterEverything } from '@/features/campaign/encounterRegen';
import { clearDatabase } from '../db/helpers';
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
  levelHint: '4',
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

async function setup(): Promise<{ campaign: Awaited<ReturnType<typeof createCampaign>> }> {
  const campaign = await createCampaign({ name: 'Regen Campaign', system: 'dnd5e' });
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
  goblinChunkId: Id,
  overrides: Record<string, unknown> = {},
): Promise<Artifact & { kind: 'encounter' }> {
  const mapImageId = newId();
  const target = await createArtifact({
    campaignId,
    kind: 'encounter',
    name: 'Old Undercroft',
    summary: 'Old summary.',
    body: 'Existing prose.',
    links: [],
    data: {
      difficulty: 'old', levelHint: '4',
      monsters: [{ name: 'Tomb Ogre', count: 4, notes: 'keep', treasure: 'Ogre pocket: 4 gp', source: { type: 'rulebook', chunkId: goblinChunkId } }],
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

async function seedSingleTarget(
  campaignId: Id,
  goblinChunkId: Id,
): Promise<Artifact & { kind: 'encounter' }> {
  const target = await createArtifact({
    campaignId,
    kind: 'encounter',
    name: 'Gate Ambush',
    summary: 'Gate summary.',
    body: 'Gate prose.',
    links: [],
    data: {
      difficulty: 'old', levelHint: '3',
      monsters: [{ name: 'Tomb Ogre', count: 4, notes: 'keep', treasure: '', source: { type: 'rulebook', chunkId: goblinChunkId } }],
      terrain: '', tactics: '', treasure: '',
      mapImageId: newId(), preset: 'standard', locationKind: 'other',
      siteShape: 'single', budgetAdvisory: '', layout: null,
    },
  });
  if (target.kind !== 'encounter') throw new Error('encounter target missing');
  return target;
}

function smithDraft(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Ambush at the ford',
    summary: 'A bridge ambush.',
    suggestedTags: ['ambush'],
    body: '# Ambush at the ford',
    difficulty: 'deadly',
    levelHint: '3',
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
  vi.spyOn(encounterRunAdapters, 'generateImages').mockResolvedValue({ images: [new Blob(['one']), new Blob(['two'])], costUsd: 0.02, cappedToOne: false, modelUsed: 'test-image-model', fallback: null, filteredCount: 0 });
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
      expect(monster.source.type).toBe('rulebook');
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
      levelHint: '3',
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
