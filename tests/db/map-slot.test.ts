import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createArtifact,
  getAnyArtifact,
  getArtifact,
  removeImageFromArtifact,
  updateArtifact,
} from '@/db/artifactRepo';
import { convergeBoardsToRegeneratedMap, ensureBattle, getBattle, patchBattle } from '@/db/battleRepo';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import { createCampaign } from '@/db/campaignRepo';
import { createImage, deleteImageIfUnreferenced, getImage, referencedImageIds } from '@/db/imageRepo';
import { getRun } from '@/db/runRepo';
import { saveSettings } from '@/db/settingsRepo';
import { encounterRunAdapters, runEngine, type StartRunInput } from '@/llm/runEngine';
import { chat } from '@/llm/openrouter';
import { toastError } from '@/lib/toast';
import { useProgressStore } from '@/lib/progress';
import {
  createPersona,
  defaultSettings,
  newId,
  type Artifact,
  type EncounterLayout,
  type Id,
  type Persona,
} from '@/domain';
import { clearDatabase } from './helpers';

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
}));

vi.mock('@/search', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), searchRules: vi.fn() };
});

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastErrorPersistent: vi.fn(),
}));

const chatMock = vi.mocked(chat);
const toastErrorMock = vi.mocked(toastError);
const { searchRules } = await import('@/search');
const searchRulesMock = vi.mocked(searchRules);

/**
 * DOM-free poll for the engine's background finalization (the llm suites use
 * @testing-library's waitFor, which needs jsdom — this file stays in the
 * node project per vite.config.ts, so it polls with plain timers).
 */
async function waitForRun(assertion: () => void | Promise<void>, timeoutMs = 15000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let campaignId = '';

beforeEach(async () => {
  await clearDatabase();
  useProgressStore.getState().reset();
  chatMock.mockReset();
  searchRulesMock.mockReset();
  searchRulesMock.mockResolvedValue([]);
  toastErrorMock.mockClear();
  vi.spyOn(encounterRunAdapters, 'renderSchematic').mockReturnValue({
    dataUrl: 'data:image/png;base64,schematic',
    width: 2304,
    height: 1728,
  });
  vi.spyOn(encounterRunAdapters, 'generateImages').mockResolvedValue({
    images: [new Blob(['one']), new Blob(['two'])],
    costUsd: 0.02,
    cappedToOne: false,
    modelUsed: 'test-image-model',
    fallback: null,
    filteredCount: 0,
  });
  vi.spyOn(encounterRunAdapters, 'normalizeImageAspect').mockImplementation((blob) =>
    Promise.resolve({ blob, width: 1200, height: 900, action: 'none' as const }),
  );vi.spyOn(encounterRunAdapters, 'intakeImage').mockImplementation((blob) =>
    Promise.resolve({ blob, width: 1200, height: 900, mimeType: 'image/webp' }),
  );
  campaignId = (await createCampaign({ name: 'Map slot campaign', system: 'dnd5e' })).id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function mapImage(): Promise<{ id: Id }> {
  return createImage({
    campaignId,
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    mimeType: 'image/png',
    width: 100,
    height: 80,
    source: 'uploaded',
    role: 'map',
  });
}

interface EncounterOptions {
  mapImageId?: Id | null;
  imageIds?: Id[];
  linkLocationId?: Id;
}

async function addEncounter(over: EncounterOptions = {}): Promise<Artifact> {
  return createArtifact({
    campaignId,
    kind: 'encounter',
    name: 'Bridge ambush',
    imageIds: over.imageIds ?? [],
    data: {
      difficulty: 'medium',
      levelHint: '3',
      monsters: [],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: over.mapImageId ?? null,
      layout: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    },
    links: over.linkLocationId === undefined ? [] : [{ targetId: over.linkLocationId, relation: 'at' }],
  });
}

async function encounterData(id: Id) {
  const row = await getAnyArtifact(id);
  if (row?.kind !== 'encounter') throw new Error('encounter missing');
  return row;
}

describe('single-map-slot refcount (imageRepo)', () => {
  it('pins the encounter live map even when it is absent from imageIds', async () => {
    const pinned = await mapImage();
    const encounter = await addEncounter();
    const row = await encounterData(encounter.id);
    // Live map stamped on data but NOT in the gallery: still referenced.
    await updateArtifact(encounter.id, { data: { ...row.data, mapImageId: pinned.id } });
    expect((await referencedImageIds(campaignId)).has(pinned.id)).toBe(true);
    expect(await deleteImageIfUnreferenced(pinned.id)).toBe(false);
    expect(await getImage(pinned.id)).toBeDefined();
  });

  it('pins replaced maps kept only by revision-snapshot history', async () => {
    const oldMap = await mapImage();
    const freshMap = await mapImage();
    const encounter = await addEncounter();
    const first = await encounterData(encounter.id);
    await updateArtifact(encounter.id, { data: { ...first.data, mapImageId: oldMap.id } });
    // Slot replace at repo level: old id leaves data+gallery, history keeps it.
    const second = await encounterData(encounter.id);
    await updateArtifact(encounter.id, {
      imageIds: [freshMap.id],
      data: { ...second.data, mapImageId: freshMap.id },
    });
    // The old id is referenced NOWHERE live — only snapshot.data carries it.
    expect((await referencedImageIds(campaignId)).has(oldMap.id)).toBe(true);
    expect(await deleteImageIfUnreferenced(oldMap.id)).toBe(false);
    expect(await getImage(oldMap.id)).toBeDefined();
  });

  it('pins frozen battle boards even when the encounter moved on', async () => {
    const frozen = await mapImage();
    const battle = await ensureBattle(campaignId, newId());
    await patchBattle(battle.id, { board: { ...battle.board, mapImageId: frozen.id } });
    expect((await referencedImageIds(campaignId)).has(frozen.id)).toBe(true);
    expect(await deleteImageIfUnreferenced(frozen.id)).toBe(false);
    expect(await getImage(frozen.id)).toBeDefined();
  });

  it('still frees a truly unreferenced image', async () => {
    const orphan = await mapImage();
    expect((await referencedImageIds(campaignId)).has(orphan.id)).toBe(false);
    expect(await deleteImageIfUnreferenced(orphan.id)).toBe(true);
    expect(await getImage(orphan.id)).toBeUndefined();
  });
});

describe('live-map delete guard (artifactRepo)', () => {
  it('refuses to delete the encounter’s live battlemap, loudly', async () => {
    const live = await mapImage();
    const encounter = await addEncounter({ mapImageId: live.id, imageIds: [live.id] });
    await expect(removeImageFromArtifact(encounter.id, live.id)).rejects.toThrow(
      /Regenerate replaces the battlemap; the live map cannot be deleted/,
    );
    // No delete: the blob and the gallery reference both survive.
    expect(await getImage(live.id)).toBeDefined();
    expect((await encounterData(encounter.id)).imageIds).toEqual([live.id]);
  });

  it('refuses from any artifact, not just the owning encounter', async () => {
    const live = await mapImage();
    await addEncounter({ mapImageId: live.id, imageIds: [live.id] });
    const location = await createArtifact({
      campaignId,
      kind: 'location',
      name: 'Gatehouse',
      imageIds: [live.id],
      data: { locationType: '', inhabitants: '', pointsOfInterest: [], hooks: [] },
    });
    await expect(removeImageFromArtifact(location.id, live.id)).rejects.toThrow(
      /the live map cannot be deleted/,
    );
    expect(await getImage(live.id)).toBeDefined();
  });

  it('still deletes an ordinary gallery image', async () => {
    const live = await mapImage();
    const ordinary = await mapImage();
    const encounter = await addEncounter({ mapImageId: live.id, imageIds: [live.id, ordinary.id] });
    await removeImageFromArtifact(encounter.id, ordinary.id);
    expect(await getImage(ordinary.id)).toBeUndefined();
    expect((await encounterData(encounter.id)).imageIds).toEqual([live.id]);
  });
});

describe('dangling-map seed fallback (battleSeed)', () => {
  async function locationWithMapCover(): Promise<Id> {
    const cover = await mapImage();
    const location = await createArtifact({
      campaignId,
      kind: 'location',
      name: 'Bridge',
      data: { locationType: '', inhabitants: '', pointsOfInterest: [], hooks: [] },
    });
    await updateArtifact(location.id, { imageIds: [cover.id], coverImageId: cover.id });
    return location.id;
  }

  it('falls through to the linked location cover when the map row is gone', async () => {
    const locationId = await locationWithMapCover();
    const location = await getAnyArtifact(locationId);
    if (location?.kind !== 'location') throw new Error('location missing');
    const encounter = await addEncounter({ mapImageId: newId(), linkLocationId: locationId });
    const { battle } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    // Never a frozen dangling id: the board carries the location cover.
    expect(battle.board.mapImageId).toBe(location.coverImageId);
    expect(battle.board.mapImageId).not.toBe((await encounterData(encounter.id)).data.mapImageId);
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining('is missing'));
  });

  it('seeds a mapless board when the map row is gone and no cover applies', async () => {
    const encounter = await addEncounter({ mapImageId: newId() });
    const { battle } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    expect(battle.board.mapImageId).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining('is missing'));
  });
});

describe('board convergence (battleRepo)', () => {
  it('moves never-live boards to the fresh map and freezes live ones', async () => {
    const encounter = await addEncounter();
    const other = await addEncounter();
    const oldMap = await mapImage();
    const freshMap = await mapImage();

    const pending = await ensureBattle(campaignId, newId());
    await patchBattle(pending.id, {
      encounterArtifactId: encounter.id,
      board: { ...pending.board, mapImageId: oldMap.id, mapLayout: { cols: 24, rows: 18 } },
    });
    const before = await getBattle(pending.id);
    if (before === undefined) throw new Error('battle missing');

    const live = await ensureBattle(campaignId, newId());
    await patchBattle(live.id, {
      encounterArtifactId: encounter.id,
      board: { ...live.board, everLive: true, mapImageId: oldMap.id },
    });

    const foreign = await ensureBattle(campaignId, newId());
    await patchBattle(foreign.id, {
      encounterArtifactId: other.id,
      board: { ...foreign.board, mapImageId: oldMap.id },
    });

    const result = await convergeBoardsToRegeneratedMap(encounter.id, {
      mapImageId: freshMap.id,
      mapLayout: { cols: 28, rows: 16 },
    });
    expect(result).toEqual({ converged: 1, liveSkipped: 1 });

    const converged = await getBattle(pending.id);
    expect(converged?.board.mapImageId).toBe(freshMap.id);
    expect(converged?.board.mapLayout).toEqual({ cols: 28, rows: 16 });
    // Everything else rides along untouched.
    expect(converged?.board.tokens).toEqual(before.board.tokens);
    expect(converged?.board.veils).toEqual(before.board.veils);
    expect(converged?.board.everLive).toBe(false);

    expect((await getBattle(live.id))?.board.mapImageId).toBe(oldMap.id);
    expect((await getBattle(foreign.id))?.board.mapImageId).toBe(oldMap.id);
  });
});

describe('seed after a map replace', () => {
  it('picks up the new map instead of the frozen old board copy', async () => {
    const first = await mapImage();
    const second = await mapImage();
    const encounter = await addEncounter({ mapImageId: first.id, imageIds: [first.id] });
    const seededFirst = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    expect(seededFirst.battle.board.mapImageId).toBe(first.id);

    // The slot replace the finalize performs: old id out, new id in.
    const current = await encounterData(encounter.id);
    await updateArtifact(encounter.id, {
      imageIds: [second.id],
      data: { ...current.data, mapImageId: second.id },
    });

    const seededSecond = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    expect(seededSecond.battle.board.mapImageId).toBe(second.id);
  });
});

// --- Regenerate-finalize slot replace, end to end through runEngine ---

const INLINE_STATBLOCK = {
  system: 'dnd5e', level: '1', size: 'Medium', creatureType: 'humanoid', ac: 12,
  acNote: '', hp: 7, hpFormula: '2d6', speed: '30 ft.',
  abilities: { str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 10 },
  saves: '', skills: '', senses: '', languages: '', traits: [], actions: [], reactions: [], legendary: [], extras: {},
};

const BRIEF = {
  name: 'Ash Gate Ambush',
  summary: 'Cultists guard a ruined gate.',
  body: '# Ash Gate\nA room-by-room battle.',
  difficulty: 'hard',
  levelHint: '4',
  terrain: 'broken pillars',
  tactics: 'fall back through the gate',
  treasure: 'obsidian key',
  theme: 'ash-choked temple',
  styleNotes: 'inked fantasy map, volcanic stone',
  negative: 'text, labels, tokens',
  monsters: [
    { name: 'Ash Cultist', count: 2, notes: '', treasure: 'Robes: 2 gp', statBlock: INLINE_STATBLOCK },
  ],
  rooms: [
    {
      name: 'Entry',
      description: 'Broken doors',
      size: 'medium',
      monsterIndexes: [0],
      adjacentRoomIndexes: [],
      key: 'Cracked doors hang off one hinge.',
      keyTreasure: 'Fallen banner: 15 gp',
    },
  ],
  entryRoomIndex: 0,
};

function cartographerPersona(): Persona {
  return createPersona({
    slug: 'encounter-cartographer-slot-test',
    name: 'Encounter Cartographer',
    description: '',
    systemPrompt: 'Return encounter JSON.',
    mode: 'encounter',
    producesKind: 'encounter',
    builtIn: true,
  });
}

async function setupRun() {
  const campaign = await createCampaign({ name: 'Slot Campaign', system: 'dnd5e' });
  const cartographer = cartographerPersona();
  const { db } = await import('@/db');
  await db.personas.put(cartographer);
  await saveSettings({ ...defaultSettings(), openRouterApiKey: 'test-key', imagesEnabled: true });
  return { campaign, cartographer };
}

function runInput(
  campaign: Awaited<ReturnType<typeof createCampaign>>,
  cartographer: Persona,
  targetArtifactId: string,
): StartRunInput {
  return {
    campaign,
    persona: cartographer,
    autonomy: 'manual',
    brief: 'A temple gate encounter',
    pinnedChunkIds: [],
    encounterMapAspect: '4:3',
    targetArtifactId,
  };
}

async function approveUntilPick(runId: string, input: StartRunInput): Promise<string[]> {
  await waitForRun(async () => {
    const run = await getRun(runId);
    expect(run?.status).toBe('awaiting_user');
    expect(run?.steps.at(-1)?.name).toBe('brief');
  });
  await runEngine.approve(runId, input);
  await waitForRun(async () => {
    const run = await getRun(runId);
    expect(run?.status).toBe('awaiting_user');
    expect(run?.steps.at(-1)?.name).toBe('pick');
  });
  const run = await getRun(runId);
  return (run?.steps.find((step) => step.name === 'pick')?.output as { candidates: string[] }).candidates;
}

async function pickIndexOf(runId: string): Promise<number> {
  const run = await getRun(runId);
  const index = run?.steps.find((step) => step.name === 'pick')?.index;
  if (index === undefined) throw new Error('run has no pick step');
  return index;
}

describe('regenerate finalize slot-replace (runEngine)', () => {
  it('replaces the gallery slot across regenerates, converges pending boards, freezes live ones', async () => {
    const { campaign, cartographer } = await setupRun();
    const oldMap = await createImage({
      campaignId: campaign.id,
      blob: new Blob([new Uint8Array([7])], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 100,
      height: 80,
      source: 'uploaded',
      role: 'map',
    });
    const target = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Keep This Name',
      body: 'Keep this prose.',
      imageIds: [oldMap.id],
      data: {
        difficulty: 'old',
        levelHint: '2',
        monsters: [{ name: 'Original Ogre', count: 1, notes: 'keep', treasure: '', source: { type: 'none' } }],
        terrain: 'old terrain',
        tactics: 'old tactics',
        treasure: 'old treasure',
        mapImageId: oldMap.id,
        layout: null,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      },
    });

    // One battle seeded but never opened, one that already went live.
    const pending = await ensureBattle(campaign.id, newId());
    await patchBattle(pending.id, {
      encounterArtifactId: target.id,
      board: { ...pending.board, mapImageId: oldMap.id },
    });
    const live = await ensureBattle(campaign.id, newId());
    await patchBattle(live.id, {
      encounterArtifactId: target.id,
      board: { ...live.board, everLive: true, mapImageId: oldMap.id },
    });

    async function regenerateOnce(): Promise<{ mapId: Id; layout: EncounterLayout }> {
      chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
      const input = runInput(campaign, cartographer, target.id);
      const runId = await runEngine.startRun(input);
      const candidates = await approveUntilPick(runId, input);
      await runEngine.editStep(runId, await pickIndexOf(runId), { keep: [candidates[0]] }, input);
      await waitForRun(async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      });
      const updated = await getArtifact(target.id);
      if (updated?.kind !== 'encounter') throw new Error('encounter missing');
      const mapId = updated.data.mapImageId;
      const layout = updated.data.layout;
      if (mapId === null || layout === null) throw new Error('regenerate left no map');
      return { mapId, layout };
    }

    const first = await regenerateOnce();
    expect(first.mapId).not.toBe(oldMap.id);
    // True replace after ONE regenerate: the old id is out, the gallery holds one map.
    let updated = await getArtifact(target.id);
    if (updated?.kind !== 'encounter') throw new Error('encounter missing');
    expect(updated.imageIds).toEqual([first.mapId]);

    const second = await regenerateOnce();
    expect(second.mapId).not.toBe(first.mapId);
    // Length stable ACROSS regenerates: still exactly one map, the middle one pruned.
    updated = await getArtifact(target.id);
    if (updated?.kind !== 'encounter') throw new Error('encounter missing');
    expect(updated.imageIds).toEqual([second.mapId]);
    expect(updated.imageIds).toHaveLength(1);

    // History keeps every replaced id via revision snapshots.
    const { db } = await import('@/db');
    const revisions = await db.revisions.where('artifactId').equals(target.id).toArray();
    const historicMaps = revisions.map(
      (revision) => (revision.snapshot as { data?: { mapImageId?: Id | null } }).data?.mapImageId,
    );
    expect(historicMaps).toContain(oldMap.id);
    expect(historicMaps).toContain(first.mapId);
    expect(historicMaps).toContain(second.mapId);

    // The never-opened board converged twice onto the newest map+layout…
    const pendingAfter = await getBattle(pending.id);
    expect(pendingAfter?.board.mapImageId).toBe(second.mapId);
    expect(pendingAfter?.board.mapLayout).toEqual({ cols: second.layout.gridW, rows: second.layout.gridH });
    // …while the live board stays frozen on the original map.
    expect((await getBattle(live.id))?.board.mapImageId).toBe(oldMap.id);

    // Loud: every regenerate with a frozen live board toasts the re-run guidance.
    const guidance = toastErrorMock.mock.calls.filter((call) =>
      call[0].includes('re-run battle to pick up the new map'),
    );
    expect(guidance).toHaveLength(2);
  });
});
