import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createModule as saveModule } from '@/db/moduleRepo';
import { createPersona as savePersona } from '@/db/personaRepo';
import { listRunsByCampaign } from '@/db/runRepo';
import { saveSettings } from '@/db/settingsRepo';
import { createModule, defaultSettings, type Id } from '@/domain';
import { encounterNeedsMap, isEncounterMapPending, useEncounterMapQueue } from '@/features/modules/encounter-map-queue';
import { useProgressStore } from '@/lib/progress';
import { chat } from '@/llm/openrouter';
import { encounterRunAdapters } from '@/llm/runEngine';
import { clearDatabase } from '../db/helpers';
import { toastError } from '@/lib/toast';

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
}));
vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const chatMock = vi.mocked(chat);
const toastErrorMock = vi.mocked(toastError);
const STATBLOCK = {
  system: 'dnd5e', level: '1', size: 'Medium', creatureType: 'humanoid', ac: 12,
  acNote: '', hp: 7, hpFormula: '2d6', speed: '30 ft.',
  abilities: { str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 10 },
  saves: '', skills: '', senses: '', languages: '', traits: [], actions: [], reactions: [], legendary: [], extras: {},
};
const BRIEF = {
  // Minimum-content contract: summary/body carry substance.
  name: 'Ignored regeneration name', summary: 'Skeletons in the crypt.', body: '# Crypt\nRoom prose.', difficulty: 'medium', levelHint: '3',
  terrain: '', tactics: '', treasure: '', theme: 'crypt', styleNotes: '', negative: '',
  monsters: [{ name: 'Skeleton', count: 1, notes: '', statBlock: STATBLOCK }],
  rooms: [
    { name: 'Entry', description: '', size: 'medium', monsterIndexes: [0], adjacentRoomIndexes: [] },
  ],
  entryRoomIndex: 0,
};

/** A 4-room complex brief with inline statblocks (vision-path queue test). */
const COMPLEX_BRIEF = {
  name: 'Cellar Undercroft',
  summary: 'A four-room crypt.',
  body: '# Cellar\nFour rooms of cultists.',
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
    { name: 'Ash Cultist', count: 2, notes: '', treasure: '', statBlock: { ...STATBLOCK, level: '2' } },
    { name: 'Crypt Ghoul', count: 1, notes: '', treasure: '', statBlock: { ...STATBLOCK, level: '4' } },
    { name: 'Bone Acolyte', count: 2, notes: '', treasure: '', statBlock: { ...STATBLOCK, level: '2' } },
    { name: 'Ash Priest', count: 1, notes: '', treasure: '', statBlock: { ...STATBLOCK, level: '4' } },
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

beforeEach(async () => {
  await clearDatabase();
  useEncounterMapQueue.getState().reset();
  useProgressStore.getState().reset();
  chatMock.mockReset().mockResolvedValue({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
  toastErrorMock.mockReset();
  vi.spyOn(encounterRunAdapters, 'renderSchematic').mockReturnValue({ dataUrl: 'data:image/png;base64,schematic', width: 240, height: 180 });
  vi.spyOn(encounterRunAdapters, 'generateImages').mockResolvedValue({ images: [new Blob(['map'])], costUsd: null, cappedToOne: false, modelUsed: 'test-image-model', fallback: null, filteredCount: 0 });
  vi.spyOn(encounterRunAdapters, 'normalizeImageAspect').mockImplementation((blob) => Promise.resolve({ blob, width: 800, height: 600, action: 'none' }));
  vi.spyOn(encounterRunAdapters, 'intakeImage').mockImplementation((blob) => Promise.resolve({ blob, width: 800, height: 600, mimeType: 'image/webp' }));
});

afterEach(() => {
  useEncounterMapQueue.getState().reset();
  useProgressStore.getState().reset();
  vi.restoreAllMocks();
});

describe('module encounter map queue', () => {
  it('uses one candidate, continues after failure, and retries only failed jobs', async () => {
    const campaign = await createCampaign({ name: 'Queue', system: 'dnd5e' });
    const module = await saveModule(createModule({
      campaignId: campaign.id,
      title: 'Crypt Module',
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'sketch',
    }));
    await savePersona({
      slug: 'encounter-cartographer',
      name: 'Encounter Cartographer',
      description: '',
      systemPrompt: '',
      mode: 'encounter',
      producesKind: 'encounter',
      builtIn: true,
    });
    await saveSettings({ ...defaultSettings(), openRouterApiKey: 'key', imagesEnabled: true });
    const first = await createArtifact({
      campaignId: campaign.id, moduleId: module.id, kind: 'encounter', name: 'First',
      data: { difficulty: '', levelHint: '', monsters: [{ name: 'Skeleton', count: 1, notes: '', treasure: '', source: { type: 'none' } }], terrain: '', tactics: '', treasure: '', mapImageId: null, layout: null, preset: 'standard', locationKind: 'other', siteShape: 'single', budgetAdvisory: '' },
    });
    const second = await createArtifact({
      campaignId: campaign.id, moduleId: module.id, kind: 'encounter', name: 'Second',
      data: { difficulty: '', levelHint: '', monsters: [{ name: 'Skeleton', count: 1, notes: '', treasure: '', source: { type: 'none' } }], terrain: '', tactics: '', treasure: '', mapImageId: null, layout: null, preset: 'standard', locationKind: 'other', siteShape: 'single', budgetAdvisory: '' },
    });
    // The stylize step fails for the SECOND job only — the queue continues
    // with the next job and reports the failure loudly.
    const generateSpy = vi.spyOn(encounterRunAdapters, 'generateImages');
    let stylizeAttempts = 0;
    generateSpy.mockImplementation(() => {
      stylizeAttempts += 1;
      if (stylizeAttempts === 2) return Promise.reject(new Error('image drift'));
      return Promise.resolve({ images: [new Blob(['map'])], costUsd: null, cappedToOne: false, modelUsed: 'test-image-model', fallback: null, filteredCount: 0 });
    });

    useEncounterMapQueue.getState().enqueue([
      { campaignId: campaign.id, moduleId: module.id, artifactId: first.id, name: first.name },
      { campaignId: campaign.id, moduleId: module.id, artifactId: second.id, name: second.name },
    ]);
    await waitFor(() => {
      expect(useEncounterMapQueue.getState().active).toEqual([]);
      expect(useEncounterMapQueue.getState().queued).toEqual([]);
      expect(useEncounterMapQueue.getState().failed.map((job) => job.artifactId)).toEqual([second.id]);
    }, { timeout: 15000 });
    const firstAfter = await getArtifact(first.id);
    const secondAfter = await getArtifact(second.id);
    if (firstAfter?.kind !== 'encounter' || secondAfter?.kind !== 'encounter') {
      throw new Error('encounter rows disappeared');
    }
    expect(firstAfter.data.layout).not.toBeNull();
    expect(secondAfter.data.layout).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining('Second'), expect.any(Error));

    useEncounterMapQueue.getState().retryFailed((job) => job.moduleId === module.id);
    await waitFor(() => {
      expect(useEncounterMapQueue.getState().active).toEqual([]);
      expect(useEncounterMapQueue.getState().queued).toEqual([]);
      expect(useEncounterMapQueue.getState().failed).toEqual([]);
    }, { timeout: 15000 });
    const retried = await getArtifact(second.id);
    expect(retried?.kind === 'encounter' && retried.data.layout).not.toBeNull();
    const generateCalls = vi.mocked(encounterRunAdapters.generateImages).mock.calls;
    expect(generateCalls.every((call) => call[1] === 1)).toBe(true);
    expect(generateCalls[0]?.[2].inputReferences?.[0]?.dataUrl).toContain('schematic');
    expect(useProgressStore.getState().jobs).toEqual([]);
  }, 30000);

  it('resolves the unattended job preset from the encounter locationKind (docs/11 D10 amendment)', async () => {
    const campaign = await createCampaign({ name: 'Queue Preset', system: 'dnd5e' });
    await savePersona({
      slug: 'encounter-cartographer',
      name: 'Encounter Cartographer',
      description: '',
      systemPrompt: '',
      mode: 'encounter',
      producesKind: 'encounter',
      builtIn: true,
    });
    // Settings stay Auto (null) — the encounter's own classification decides.
    await saveSettings({ ...defaultSettings(), openRouterApiKey: 'key', imagesEnabled: true });
    const dungeon = await createArtifact({
      campaignId: campaign.id, kind: 'encounter', name: 'Cellar',
      data: { difficulty: '', levelHint: '', monsters: [{ name: 'Skeleton', count: 1, notes: '', treasure: '', source: { type: 'none' } }], terrain: '', tactics: '', treasure: '', mapImageId: null, layout: null, preset: 'standard', locationKind: 'dungeon', siteShape: 'single', budgetAdvisory: '' },
    });
    const hall = await createArtifact({
      campaignId: campaign.id, kind: 'encounter', name: 'Great Hall',
      data: { difficulty: '', levelHint: '', monsters: [{ name: 'Skeleton', count: 1, notes: '', treasure: '', source: { type: 'none' } }], terrain: '', tactics: '', treasure: '', mapImageId: null, layout: null, preset: 'standard', locationKind: 'building', siteShape: 'single', budgetAdvisory: '' },
    });
    useEncounterMapQueue.getState().enqueue([
      { campaignId: campaign.id, moduleId: dungeon.moduleId, artifactId: dungeon.id, name: dungeon.name },
      { campaignId: campaign.id, moduleId: hall.moduleId, artifactId: hall.id, name: hall.name },
    ]);
    await waitFor(() => {
      expect(useEncounterMapQueue.getState().active).toEqual([]);
      expect(useEncounterMapQueue.getState().queued).toEqual([]);
      expect(useEncounterMapQueue.getState().failed).toEqual([]);
    }, { timeout: 15000 });
    const dungeonAfter = await getArtifact(dungeon.id);
    const hallAfter = await getArtifact(hall.id);
    if (dungeonAfter?.kind !== 'encounter' || hallAfter?.kind !== 'encounter') {
      throw new Error('encounter rows disappeared');
    }
    // dungeon kind → the D10 fixed x2 tier (48x36 for 4:3); building kind →
    // the standard base tier (24x18) even though Settings still says Auto.
    expect(dungeonAfter.data.preset).toBe('dungeon');
    expect(dungeonAfter.data.layout?.gridW).toBe(48);
    expect(dungeonAfter.data.layout?.gridH).toBe(36);
    expect(hallAfter.data.preset).toBe('standard');
    expect(hallAfter.data.layout?.gridW).toBe(24);
    expect(hallAfter.data.layout?.gridH).toBe(18);
  }, 30000);

  it('maps a complex job through the vision path when the setting says vision (no per-run steering in the queue)', async () => {
    const campaign = await createCampaign({ name: 'Queue Vision', system: 'dnd5e' });
    await savePersona({
      slug: 'encounter-cartographer',
      name: 'Encounter Cartographer',
      description: '',
      systemPrompt: '',
      mode: 'encounter',
      producesKind: 'encounter',
      builtIn: true,
    });
    // The unattended queue makes no explicit per-run choice — the Settings
    // default governs (docs/11 vision path).
    await saveSettings({ ...defaultSettings(), openRouterApiKey: 'key', imagesEnabled: true, dungeonMapPath: 'vision' });
    vi.spyOn(encounterRunAdapters, 'blobToDataUrl').mockResolvedValue('data:image/webp;base64,bWFw');
    const dungeon = await createArtifact({
      campaignId: campaign.id, kind: 'encounter', name: 'Cellar',
      data: { difficulty: '', levelHint: '', monsters: [{ name: 'Skeleton', count: 1, notes: '', treasure: '', source: { type: 'none' } }], terrain: '', tactics: '', treasure: '', mapImageId: null, layout: null, preset: 'standard', locationKind: 'dungeon', siteShape: 'complex', budgetAdvisory: '' },
    });
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(COMPLEX_BRIEF), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(FULL_MARKS), modelUsed: 'test-model', fallback: null });
    useEncounterMapQueue.getState().enqueue([
      { campaignId: campaign.id, moduleId: dungeon.moduleId, artifactId: dungeon.id, name: dungeon.name },
    ]);
    await waitFor(() => {
      expect(useEncounterMapQueue.getState().active).toEqual([]);
      expect(useEncounterMapQueue.getState().queued).toEqual([]);
      expect(useEncounterMapQueue.getState().failed).toEqual([]);
    }, { timeout: 15000 });
    const after = await getArtifact(dungeon.id);
    if (after?.kind !== 'encounter') throw new Error('encounter rows disappeared');
    expect(after.data.layout?.mapPath).toBe('vision');
    expect(after.data.layout?.rooms.map((room) => room.letter)).toEqual(['A', 'B', 'C', 'D']);
    expect(after.data.mapImageId).not.toBeNull();
    // No pick pause on the unattended vision run: brief→vision-map→finalize.
    const runs = await listRunsByCampaign(campaign.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.steps.map((step) => step.name)).toEqual(['brief', 'vision-map', 'finalize']);
    expect(runs[0]?.dungeonMapPath).toBeNull();
  }, 30000);

  it('exposes the no-double-work guards: pending job and already-mapped checks', async () => {
    const campaign = await createCampaign({ name: 'Guards', system: 'dnd5e' });
    const encounter = await createArtifact({
      campaignId: campaign.id, kind: 'encounter', name: 'Guarded',
      data: { difficulty: '', levelHint: '', monsters: [], terrain: '', tactics: '', treasure: '', mapImageId: null, layout: null, preset: 'standard', locationKind: 'other', siteShape: 'single', budgetAdvisory: '' },
    });
    // encounterNeedsMap is the automation-path guard: layout + map present
    // means the encounter never gets re-enqueued automatically.
    if (encounter.kind !== 'encounter') throw new Error('encounter missing');
    expect(encounterNeedsMap(encounter)).toBe(true);
    expect(encounterNeedsMap({ data: { layout: { a: 1 }, mapImageId: 'img' } })).toBe(false);
    expect(encounterNeedsMap({ data: { layout: { a: 1 }, mapImageId: null } })).toBe(true);

    // A queued/active job counts as pending; nothing pending after settle.
    chatMock.mockReturnValue(new Promise(() => undefined)); // hold the job active
    useEncounterMapQueue.getState().enqueue([
      { campaignId: campaign.id, moduleId: null, artifactId: encounter.id, name: encounter.name },
    ]);
    await waitFor(() => {
      expect(isEncounterMapPending(null, encounter.id)).toBe(true);
    });
    expect(isEncounterMapPending('some-module', encounter.id)).toBe(false);
    useEncounterMapQueue.getState().reset();
    expect(isEncounterMapPending(null, encounter.id)).toBe(false);
  }, 30000);

  it('dequeue cancels the in-flight unattended run and drops the job silently (createJobQueue invariant)', async () => {
    const campaign = await createCampaign({ name: 'Cancelled map', system: 'dnd5e' });
    await savePersona({
      slug: 'encounter-cartographer',
      name: 'Encounter Cartographer',
      description: '',
      systemPrompt: '',
      mode: 'encounter',
      producesKind: 'encounter',
      builtIn: true,
    });
    await saveSettings({ ...defaultSettings(), openRouterApiKey: 'key', imagesEnabled: true });
    const encounter = await createArtifact({
      campaignId: campaign.id, kind: 'encounter', name: 'Withdrawn',
      data: { difficulty: '', levelHint: '', monsters: [{ name: 'Skeleton', count: 1, notes: '', treasure: '', source: { type: 'none' } }], terrain: '', tactics: '', treasure: '', mapImageId: null, layout: null, preset: 'standard', locationKind: 'other', siteShape: 'single', budgetAdvisory: '' },
    });
    // Hold the Cartographer's brief call until the abort — the job's abort
    // signal is the cancellation seam (runEngine.cancel aborts it).
    chatMock.mockImplementation((_messages, opts) => {
      const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
      if (signal === undefined) return Promise.reject(new Error('no abort signal passed'));
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    const job = { campaignId: campaign.id, moduleId: null as Id | null, artifactId: encounter.id, name: encounter.name };
    useEncounterMapQueue.getState().enqueue([job]);
    await waitFor(() => {
      expect(useEncounterMapQueue.getState().active).toHaveLength(1);
    });

    useEncounterMapQueue.getState().dequeue(job);
    // The withdrawn job must not leave an unattended run generating a map
    // nobody asked for: the queue cancels the underlying run row.
    await waitFor(async () => {
      const mapRun = (await listRunsByCampaign(campaign.id)).find(
        (run) => run.targetArtifactId === encounter.id,
      );
      expect(mapRun?.status).toBe('cancelled');
    }, { timeout: 10000 });
    expect(useEncounterMapQueue.getState().active).toEqual([]);
    expect(useEncounterMapQueue.getState().queued).toEqual([]);
    expect(useEncounterMapQueue.getState().failed).toEqual([]);
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(isEncounterMapPending(null, encounter.id)).toBe(false);
    const after = await getArtifact(encounter.id);
    if (after?.kind !== 'encounter') throw new Error('encounter missing');
    expect(after.data.layout).toBeNull();
  }, 30000);

  it('cancelAll withdraws queued jobs, cancels the in-flight run and settles silently (stop-all seam)', async () => {
    const campaign = await createCampaign({ name: 'Stop all maps', system: 'dnd5e' });
    await savePersona({
      slug: 'encounter-cartographer',
      name: 'Encounter Cartographer',
      description: '',
      systemPrompt: '',
      mode: 'encounter',
      producesKind: 'encounter',
      builtIn: true,
    });
    await saveSettings({ ...defaultSettings(), openRouterApiKey: 'key', imagesEnabled: true });
    const activeEncounter = await createArtifact({
      campaignId: campaign.id, kind: 'encounter', name: 'Mapping now',
      data: { difficulty: '', levelHint: '', monsters: [{ name: 'Skeleton', count: 1, notes: '', treasure: '', source: { type: 'none' } }], terrain: '', tactics: '', treasure: '', mapImageId: null, layout: null, preset: 'standard', locationKind: 'other', siteShape: 'single', budgetAdvisory: '' },
    });
    const queuedEncounter = await createArtifact({
      campaignId: campaign.id, kind: 'encounter', name: 'Still queued',
      data: { difficulty: '', levelHint: '', monsters: [{ name: 'Skeleton', count: 1, notes: '', treasure: '', source: { type: 'none' } }], terrain: '', tactics: '', treasure: '', mapImageId: null, layout: null, preset: 'standard', locationKind: 'other', siteShape: 'single', budgetAdvisory: '' },
    });
    // Hold the Cartographer's brief call until the abort — the job's abort
    // signal is the cancellation seam (runEngine.cancel aborts it).
    chatMock.mockImplementation((_messages, opts) => {
      const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
      if (signal === undefined) return Promise.reject(new Error('no abort signal passed'));
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    useEncounterMapQueue.getState().enqueue([
      { campaignId: campaign.id, moduleId: null as Id | null, artifactId: activeEncounter.id, name: activeEncounter.name },
      { campaignId: campaign.id, moduleId: null as Id | null, artifactId: queuedEncounter.id, name: queuedEncounter.name },
    ]);
    await waitFor(() => {
      expect(useEncounterMapQueue.getState().active).toHaveLength(1);
      expect(useEncounterMapQueue.getState().queued).toHaveLength(1);
    });

    const withdrawn = await useEncounterMapQueue.getState().cancelAll();
    expect(withdrawn).toBe(2);
    expect(useEncounterMapQueue.getState().active).toEqual([]);
    expect(useEncounterMapQueue.getState().queued).toEqual([]);
    expect(useEncounterMapQueue.getState().failed).toEqual([]);
    // The dock counters drain with the withdrawn jobs (per-job dequeue path).
    expect(useProgressStore.getState().jobs).toEqual([]);
    // The in-flight unattended run row is cancelled — no map materializes.
    await waitFor(async () => {
      const mapRun = (await listRunsByCampaign(campaign.id)).find(
        (run) => run.targetArtifactId === activeEncounter.id,
      );
      expect(mapRun?.status).toBe('cancelled');
    }, { timeout: 10000 });
    // Silent: a job the user just stopped never toasts or lands on the retry list.
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 30000);
});
