import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { getImage } from '@/db/imageRepo';
import { listRunsByCampaign } from '@/db/runRepo';
import { getSettings, saveSettings } from '@/db/settingsRepo';
import {
  createPersona,
  defaultSettings,
  newId,
  type Artifact,
  type Id,
} from '@/domain';
import { settingsSchema } from '@/domain/settings';
import { clearDatabase } from '../db/helpers';
import { useProgressStore } from '@/lib/progress';
import { chat } from '@/llm/openrouter';
import { encounterRunAdapters } from '@/llm/runEngine';
import { regenerateEncounterEverything } from '@/features/campaign/encounterRegen';

/**
 * Commit-2 steering tests (docs/11 vision path): the Settings default, the
 * D18 per-run override for Regenerate everything (complex only), and the
 * singles-ignore contract. The queue-uses-setting case lives in the queue's
 * own suite; the steering control's rendering lives in editor-surfaces.
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

const COMPLEX_BRIEF = {
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
    { name: 'Ash Cultist', count: 2, notes: '', treasure: '', statBlock: { ...INLINE_STATBLOCK, level: '2' } },
    { name: 'Crypt Ghoul', count: 1, notes: '', treasure: '', statBlock: { ...INLINE_STATBLOCK, level: '4' } },
    { name: 'Bone Acolyte', count: 2, notes: '', treasure: '', statBlock: { ...INLINE_STATBLOCK, level: '2' } },
    { name: 'Ash Priest', count: 1, notes: '', treasure: '', statBlock: { ...INLINE_STATBLOCK, level: '4' } },
  ],
  rooms: [
    { name: 'Entry', description: 'Broken doors.', size: 'medium', monsterIndexes: [0], adjacentRoomIndexes: [1], key: '', keyTreasure: '', targetLevel: 4 },
    { name: 'Ossuary', description: 'Stacked bones.', size: 'medium', monsterIndexes: [1], adjacentRoomIndexes: [0, 2], key: '', keyTreasure: '', targetLevel: 4 },
    { name: 'Ritual Chamber', description: 'A carved circle.', size: 'large', monsterIndexes: [2], adjacentRoomIndexes: [1, 3], key: '', keyTreasure: '', targetLevel: 4 },
    { name: 'Sanctum', description: 'A dark altar.', size: 'large', monsterIndexes: [3], adjacentRoomIndexes: [2], key: '', keyTreasure: '', targetLevel: 5 },
  ],
  entryRoomIndex: 0,
};

const FULL_MARKS = {
  marks: [
    { label: 'A', x: 100, y: 200 },
    { label: 'B', x: 400, y: 200 },
    { label: 'C', x: 400, y: 600 },
    { label: 'D', x: 700, y: 600 },
  ],
};

const SMITH_DRAFT = {
  name: 'Ambush at the ford',
  summary: 'A bridge ambush.',
  suggestedTags: ['ambush'],
  body: '# Ambush at the ford\nA single fight.',
  difficulty: 'deadly',
  levelHint: '3',
  monsters: [
    { name: 'Ash Cultist', count: 2, notes: 'cut off the retreat', treasure: '', statBlock: INLINE_STATBLOCK },
  ],
  terrain: 'river crossing',
  tactics: 'hit and run',
  treasure: 'none',
  locationKind: 'other',
};

const SINGLE_MAP_BRIEF = {
  ...COMPLEX_BRIEF,
  monsters: [COMPLEX_BRIEF.monsters[0]],
  rooms: [
    { name: 'Entry', description: 'Broken doors.', size: 'medium', monsterIndexes: [0], adjacentRoomIndexes: [], key: '', keyTreasure: '', targetLevel: 4 },
  ],
  entryRoomIndex: 0,
};

function cartographerPersona() {
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

function smithPersona() {
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

async function setup(settingsPath: 'classic' | 'vision' = 'classic') {
  const campaign = await createCampaign({ name: 'Steering Campaign', system: 'dnd5e' });
  const { db } = await import('@/db');
  await db.personas.put(cartographerPersona());
  await db.personas.put(smithPersona());
  await saveSettings({
    ...defaultSettings(),
    openRouterApiKey: 'test-key',
    imagesEnabled: true,
    dungeonMapPath: settingsPath,
  });
  return { campaign };
}

/** A valid persisted 4-room complex target (rooms on file to regenerate). */
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
      key: '',
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

async function seedComplexTarget(campaignId: Id): Promise<Artifact & { kind: 'encounter' }> {
  const target = await createArtifact({
    campaignId,
    kind: 'encounter',
    name: 'Old Undercroft',
    summary: 'Old summary.',
    body: 'Existing prose.',
    links: [],
    data: {
      difficulty: 'old', levelHint: '4',
      monsters: [{ name: 'Tomb Ogre', count: 4, notes: 'keep', treasure: 'Ogre pocket: 4 gp', source: { type: 'none' } }],
      terrain: '', tactics: '', treasure: '',
      mapImageId: newId(), preset: 'dungeon', locationKind: 'dungeon',
      siteShape: 'complex', budgetAdvisory: 'STALE ADVISORY',
      layout: complexLayoutFixture(),
      fillGrade: 100,
    },
  });
  if (target.kind !== 'encounter') throw new Error('encounter target missing');
  return target;
}

async function seedSingleTarget(campaignId: Id): Promise<Artifact & { kind: 'encounter' }> {
  const target = await createArtifact({
    campaignId,
    kind: 'encounter',
    name: 'Gate Ambush',
    summary: 'Gate summary.',
    body: 'Gate prose.',
    links: [],
    data: {
      difficulty: 'old', levelHint: '3',
      monsters: [{ name: 'Tomb Ogre', count: 4, notes: 'keep', treasure: '', source: { type: 'none' } }],
      terrain: '', tactics: '', treasure: '',
      mapImageId: newId(), preset: 'standard', locationKind: 'other',
      siteShape: 'single', budgetAdvisory: '', layout: null,
    },
  });
  if (target.kind !== 'encounter') throw new Error('encounter target missing');
  return target;
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
  vi.spyOn(encounterRunAdapters, 'generateImages').mockResolvedValue({
    images: [new Blob(['one']), new Blob(['two'])],
    costUsd: 0.02,
    cappedToOne: false,
    modelUsed: 'test-image-model',
    fallback: null,
    filteredCount: 0,
  });
  vi.spyOn(encounterRunAdapters, 'normalizeImageAspect').mockImplementation((blob) =>
    Promise.resolve({ blob, width: 1200, height: 900, action: 'none' }),
  );
  vi.spyOn(encounterRunAdapters, 'intakeImage').mockImplementation((blob) =>
    Promise.resolve({ blob, width: 1200, height: 900, mimeType: 'image/webp' }),
  );
  vi.spyOn(encounterRunAdapters, 'blobToDataUrl').mockResolvedValue('data:image/webp;base64,bWFw');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dungeon map path setting (docs/11 vision path)', () => {
  it('defaults to classic — the vision path is opt-in, never the silent default', () => {
    expect(defaultSettings().dungeonMapPath).toBe('classic');
    // A stored row that predates the setting still parses — the default
    // materializes at the boundary (no settings migration needed).
    const { dungeonMapPath: _omitted, ...legacyRow } = defaultSettings();
    expect(settingsSchema.parse(legacyRow).dungeonMapPath).toBe('classic');
  });
});

describe('Regenerate everything steering (docs/11 vision path, complex only)', () => {
  it("a vision override beats a classic setting — and is never persisted as the new default", async () => {
    const { campaign } = await setup('classic');
    const target = await seedComplexTarget(campaign.id);
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(COMPLEX_BRIEF), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(FULL_MARKS), modelUsed: 'test-model', fallback: null });
    await regenerateEncounterEverything(target.id, { redesignProse: false, dungeonMapPath: 'vision' });
    const after = await getArtifact(target.id);
    if (after?.kind !== 'encounter') throw new Error('encounter missing');
    expect(after.data.layout?.mapPath).toBe('vision');
    expect(after.data.layout?.rooms.map((room) => room.letter)).toEqual(['A', 'B', 'C', 'D']);
    expect((await getImage(after.data.mapImageId ?? ''))?.role).toBe('map');
    // The steered run row carries the explicit choice (pause/resume exact)…
    const runs = await listRunsByCampaign(campaign.id);
    expect(runs.some((run) => run.dungeonMapPath === 'vision')).toBe(true);
    // …but the Settings default is untouched by the per-run choice.
    expect((await getSettings()).dungeonMapPath).toBe('classic');
  });

  it('a classic override beats a vision setting', async () => {
    const { campaign } = await setup('vision');
    const target = await seedComplexTarget(campaign.id);
    chatMock.mockResolvedValue({ text: JSON.stringify(COMPLEX_BRIEF), modelUsed: 'test-model', fallback: null });
    await regenerateEncounterEverything(target.id, { redesignProse: false, dungeonMapPath: 'classic' });
    const after = await getArtifact(target.id);
    if (after?.kind !== 'encounter') throw new Error('encounter missing');
    expect(after.data.layout?.mapPath ?? 'classic').toBe('classic');
    const [room] = after.data.layout?.rooms ?? [];
    if (room === undefined) throw new Error('regen built no rooms');
    expect(room.rects).toBeDefined();
    expect(room.mobsRect).toBeDefined();
    const runs = await listRunsByCampaign(campaign.id);
    expect(runs.some((run) => run.dungeonMapPath === 'classic')).toBe(true);
    expect((await getSettings()).dungeonMapPath).toBe('vision');
  });

  it('no override follows the vision setting default', async () => {
    const { campaign } = await setup('vision');
    const target = await seedComplexTarget(campaign.id);
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(COMPLEX_BRIEF), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(FULL_MARKS), modelUsed: 'test-model', fallback: null });
    await regenerateEncounterEverything(target.id, { redesignProse: false });
    const after = await getArtifact(target.id);
    if (after?.kind !== 'encounter') throw new Error('encounter missing');
    expect(after.data.layout?.mapPath).toBe('vision');
    const runs = await listRunsByCampaign(campaign.id);
    expect(runs.every((run) => run.dungeonMapPath === null)).toBe(true);
  });

  it('singles ignore the steering choice entirely (always classic)', async () => {
    const { campaign } = await setup('vision');
    const target = await seedSingleTarget(campaign.id);
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(SMITH_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValue({ text: JSON.stringify(SINGLE_MAP_BRIEF), modelUsed: 'test-model', fallback: null });
    await regenerateEncounterEverything(target.id, { redesignProse: false, dungeonMapPath: 'vision' });
    const after = await getArtifact(target.id);
    if (after?.kind !== 'encounter') throw new Error('encounter missing');
    expect(after.data.layout?.rooms).toHaveLength(1);
    expect(after.data.layout?.mapPath ?? 'classic').toBe('classic');
    const [room] = after.data.layout?.rooms ?? [];
    if (room === undefined) throw new Error('regen built no rooms');
    expect(room.rects).toBeDefined();
    // No vision-map step ran on any leg of the single regen.
    const runs = await listRunsByCampaign(campaign.id);
    expect(runs.length).toBeGreaterThan(0);
    await waitForRun(async () => {
      for (const run of await listRunsByCampaign(campaign.id)) {
        expect(run.steps.some((step) => step.name === 'vision-map')).toBe(false);
      }
    });
  });
});
