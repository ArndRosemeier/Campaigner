import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createModule as saveModule } from '@/db/moduleRepo';
import { createPersona as savePersona } from '@/db/personaRepo';
import { deleteRun, getRun, listRunsByCampaign, updateRun } from '@/db/runRepo';
import { saveSettings } from '@/db/settingsRepo';
import { createModule, defaultSettings, type Id } from '@/domain';
import { encounterNeedsMap, isEncounterMapPending, useEncounterMapQueue } from '@/features/modules/encounter-map-queue';
import { useProgressStore } from '@/lib/progress';
import { chat } from '@/llm/openrouter';
import { encounterRunAdapters, runEngine } from '@/llm/runEngine';
import { clearDatabase } from '../db/helpers';
import { toastError } from '@/lib/toast';

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
}));
vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

// Fill-grade draw (docs/11 D12 amendment): pinned so the brief's
// stocking-cap verdicts are deterministic. Unpinned, the per-run
// `drawFillGrade()` draw moves the complex cap under the fixed fixtures —
// a low draw turns attempt 1 into a cap repair that consumes the NEXT mock
// in line (the locate step's shape), failing the run ~25-35% of the time.
// Same seam as the run-engine suites (mockReturnValue(70): every fixture
// room ships inside its band AND under the cap first attempt).
import type * as domainArtifact from '@/domain/artifact';

vi.mock('@/domain/artifact', async (importOriginal) => {
  const actual = await importOriginal<typeof domainArtifact>();
  return { ...actual, drawFillGrade: vi.fn(actual.drawFillGrade) };
});

const chatMock = vi.mocked(chat);
const toastErrorMock = vi.mocked(toastError);
const { drawFillGrade } = await import('@/domain/artifact');
const drawFillGradeMock = vi.mocked(drawFillGrade);
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

/**
 * A single-arena brief whose one room is OVER its challenge band (ogre
 * levels against a targetLevel-4 room): attempt 1 lands a repairable
 * budget issue, exercising the brief's designed repair turn. Brief-shaped
 * (and therefore a valid repair reply too) — a retry here never cascades
 * into a shape error.
 */
const OVER_BRIEF = {
  name: 'Ogre Pit',
  summary: 'An ogre in a pit.',
  body: '# Ogre Pit\nOne ogre, one pit.',
  difficulty: 'deadly',
  levelHint: '4',
  terrain: '',
  tactics: '',
  treasure: '',
  theme: 'pit',
  styleNotes: '',
  negative: '',
  monsters: [
    { name: 'Ogre', count: 1, notes: '', treasure: '', statBlock: { ...STATBLOCK, level: '10' } },
  ],
  rooms: [
    { name: 'Pit', description: '', size: 'medium', monsterIndexes: [0], adjacentRoomIndexes: [], key: '', keyTreasure: '', targetLevel: 4 },
  ],
  entryRoomIndex: 0,
};

beforeEach(async () => {
  await clearDatabase();
  useEncounterMapQueue.getState().reset();
  useProgressStore.getState().reset();
  chatMock.mockReset().mockResolvedValue({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
  // Grade 70: COMPLEX_BRIEF ships 16 creature-levels against a 19.5 cap
  // with every room inside its band — first-attempt green, deterministically.
  drawFillGradeMock.mockReset();
  drawFillGradeMock.mockReturnValue(70);
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

/**
 * Drain the task queue so a FIRE-AND-FORGET pipeline reaches its next write.
 * `runEngine.startRun` resolves as soon as the run ROW is written and drives
 * the rest of the pipeline through `void this.executeFrom(…).catch(fail)`
 * (src/llm/runEngine.ts:1651), so the late write these pins own is observable
 * only after the microtasks of the deferred reply AND fake-indexeddb's
 * macrotask transaction commits have run. Deliberately not a sleep that
 * decides an outcome (docs/08 §the pending-continuation flake): the race is
 * forced by the deferred reply the test resolves itself, and this only lets
 * that reply LAND.
 */
async function drainPipeline(turns = 12): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
  }
}

/**
 * Park ONE test's brief reply on a promise the test resolves by hand (docs/08
 * §own the promise, not the clock) and let every other caller answer normally.
 *
 * The filter is load-bearing, not decoration. An earlier test in this file
 * leaves a real map job in flight (docs/17 row 115), and its pipeline reaches
 * the SAME chat mock by the same prompt path — measured: in a full-suite run a
 * stray call arrived while this test was still building its fixtures, satisfied
 * a bare `expect(chatMock).toHaveBeenCalled()` wait, and left the test holding
 * an unassigned resolver. Keyed on the campaign name the Cartographer prompt
 * carries (`Campaign: <name>`, src/llm/runEngine.ts:3736) only this run's call
 * can park here and only this run's reply can be the one the test hands over.
 */
function parkThisRunsBrief(campaignName: string, onParked: (release: () => void) => void): void {
  chatMock.mockImplementation((messages: unknown) => {
    const reply = { text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null };
    if (!JSON.stringify(messages).includes(campaignName)) return Promise.resolve(reply);
    return new Promise((resolve) => {
      onParked(() => {
        resolve(reply);
      });
    });
  });
}

/** The parked resolver, asserted loudly: a premise that never happened must not pass silently. */
function takeResolver<T extends (...args: never[]) => void>(resolver: T | undefined, what: string): T {
  if (resolver === undefined) throw new Error(`${what} never parked on the test's hand`);
  return resolver;
}

/**
 * Park THIS run's brief on a promise the TEST rejects by hand: the provider's
 * hard error, with no stop and no delete in play (the contrast half of
 * docs/17 row 117 — the cure is the withdrawal, never a quieter `fail`).
 */
function parkThisRunsBriefError(
  campaignName: string,
  onParked: (kill: (error: Error) => void) => void,
): void {
  chatMock.mockImplementation((messages: unknown) => {
    const reply = { text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null };
    if (!JSON.stringify(messages).includes(campaignName)) return Promise.resolve(reply);
    return new Promise((_resolve, reject) => {
      onParked((error: Error) => {
        reject(error);
      });
    });
  });
}

/**
 * The withdrawn-run fixture (docs/17 row 117): one campaign, the Cartographer
 * persona, an API key with images enabled, and ONE unmapped encounter — the
 * minimum a map job needs to start a real run.
 */
async function withdrawnRunFixture(
  campaignName: string,
  encounterName: string,
): Promise<{ campaignId: Id; encounterId: Id }> {
  const campaign = await createCampaign({ name: campaignName, system: 'dnd5e' });
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
    campaignId: campaign.id, kind: 'encounter', name: encounterName,
    data: { difficulty: '', levelHint: '', monsters: [{ name: 'Skeleton', count: 1, notes: '', treasure: '', source: { type: 'none' } }], terrain: '', tactics: '', treasure: '', mapImageId: null, layout: null, preset: 'standard', locationKind: 'other', siteShape: 'single', budgetAdvisory: '' },
  });
  return { campaignId: campaign.id, encounterId: encounter.id };
}

/**
 * Enqueue the encounter's map job, park THIS run's brief on the test's hand and
 * return the still-`running` run row the job is now WAITING on — the job keeps
 * its place in the queue (`dequeue`/`cancelAll` are deliberately NOT called, so
 * the queue's own abort signal is not the seam under test). The parked reply is
 * never released: nothing but the queue may speak in these pins.
 */
async function watchRunningRun(
  campaignId: Id,
  encounterId: Id,
  encounterName: string,
  campaignName: string,
): Promise<Id> {
  parkThisRunsBrief(campaignName, () => undefined);
  useEncounterMapQueue.getState().enqueue([
    { campaignId, moduleId: null as Id | null, artifactId: encounterId, name: encounterName },
  ]);
  await waitFor(() => {
    expect(useEncounterMapQueue.getState().active).toHaveLength(1);
  }, { timeout: 10000 });
  await waitFor(async () => {
    const openRun = (await listRunsByCampaign(campaignId)).find(
      (run) => run.targetArtifactId === encounterId,
    );
    expect(openRun?.status).toBe('running');
  }, { timeout: 10000 });
  const openRun = (await listRunsByCampaign(campaignId)).find(
    (run) => run.targetArtifactId === encounterId,
  );
  if (openRun === undefined) throw new Error('the map run never appeared');
  return openRun.id;
}

/** The settlement the owner's own withdrawal owes: no toast, no retry entry, dock drained. */
function expectWithdrawnSilently(encounterId: Id): void {
  expect(useEncounterMapQueue.getState().active).toEqual([]);
  expect(useEncounterMapQueue.getState().queued).toEqual([]);
  expect(useEncounterMapQueue.getState().failed).toEqual([]);
  expect(toastErrorMock).not.toHaveBeenCalled();
  expect(useProgressStore.getState().jobs).toEqual([]);
  expect(isEncounterMapPending(null, encounterId)).toBe(false);
}

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
    // The dungeon job briefs fresh (never-mapped + dungeon preset ⇒ no pin),
    // so its reply must stock a real complex; the hall job keeps the pinned
    // single-arena path on the shared default mock. Jobs run serially —
    // dungeon first.
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(COMPLEX_BRIEF), modelUsed: 'test-model', fallback: null });
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
    // Retry-proof property: the pinned grade held — exactly one brief call
    // per job, no repair turn ever consumed a mock (a repair would eat the
    // hall's BRIEF for the dungeon's second attempt and cascade).
    expect(chatMock).toHaveBeenCalledTimes(2);
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
    // Retry-proof property: the pinned grade held — the brief passed first
    // attempt and the locate consumed its own marks (a budget repair would
    // eat FULL_MARKS as a brief and reject the step).
    expect(chatMock).toHaveBeenCalledTimes(2);
  }, 30000);

  it('an over-budget brief uses the designed repair turn and still maps green (retry path, not feared)', async () => {
    const campaign = await createCampaign({ name: 'Queue Repair', system: 'dnd5e' });
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
    // Pinned single (standard preset, single shape): the roster pin resolves
    // the ogre's level from the TARGET's own inline source, so the room
    // ships over its band whatever the mock carries — attempt 1 is
    // repairable by design.
    const pit = await createArtifact({
      campaignId: campaign.id, kind: 'encounter', name: 'Ogre Pit',
      data: {
        difficulty: '', levelHint: '4',
        monsters: [{ name: 'Ogre', count: 1, notes: '', treasure: '', source: { type: 'inline', statBlock: { ...STATBLOCK, system: 'dnd5e' as const, level: '10' } } }],
        terrain: '', tactics: '', treasure: '', mapImageId: null, layout: null,
        preset: 'standard', locationKind: 'other', siteShape: 'single', budgetAdvisory: '',
      },
    });
    // Brief-valid content all the way down: attempt AND the repair turn both
    // draw from this default, so the retry can never exhaust into a shape
    // error — it settles green with the loud advisory instead.
    chatMock.mockResolvedValue({ text: JSON.stringify(OVER_BRIEF), modelUsed: 'test-model', fallback: null });
    useEncounterMapQueue.getState().enqueue([
      { campaignId: campaign.id, moduleId: pit.moduleId, artifactId: pit.id, name: pit.name },
    ]);
    await waitFor(() => {
      expect(useEncounterMapQueue.getState().active).toEqual([]);
      expect(useEncounterMapQueue.getState().queued).toEqual([]);
      expect(useEncounterMapQueue.getState().failed).toEqual([]);
    }, { timeout: 15000 });
    // Attempt 1 hit the over-budget issue; the single designed repair turn
    // re-ran the brief and the bounded loop shipped loud instead of failing.
    expect(chatMock).toHaveBeenCalledTimes(2);
    const after = await getArtifact(pit.id);
    if (after?.kind !== 'encounter') throw new Error('encounter rows disappeared');
    expect(after.data.layout).not.toBeNull();
    expect(after.data.mapImageId).not.toBeNull();
    expect(after.data.budgetAdvisory).toContain('over its challenge budget');
    const runs = await listRunsByCampaign(campaign.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('completed');
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

  it('a step whose reply lands AFTER the owner stopped the run is not reported, and the cancel verdict stands (late-write seam)', async () => {
    const campaign = await createCampaign({ name: 'Late brief', system: 'dnd5e' });
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
      campaignId: campaign.id, kind: 'encounter', name: 'Stopped mid-brief',
      data: { difficulty: '', levelHint: '', monsters: [{ name: 'Skeleton', count: 1, notes: '', treasure: '', source: { type: 'none' } }], terrain: '', tactics: '', treasure: '', mapImageId: null, layout: null, preset: 'standard', locationKind: 'other', siteShape: 'single', budgetAdvisory: '' },
    });
    // THE DELAY IS THE CAUSE, NOT THE CLOCK (docs/08 §the pending-continuation
    // flake, the `89e5d71` method): the brief's reply is a promise the TEST
    // resolves, so the step's write is held open while the owner stops the run
    // and released at the exact moment the late write is under test. No sleep
    // decides the outcome and nothing loads the machine.
    let releaseBrief: (() => void) | undefined;
    parkThisRunsBrief(campaign.name, (release) => {
      releaseBrief = release;
    });
    const job = { campaignId: campaign.id, moduleId: null as Id | null, artifactId: encounter.id, name: encounter.name };
    useEncounterMapQueue.getState().enqueue([job]);
    // The step is IN FLIGHT: this run's brief call is parked on the test's hand
    // (a wait for the model call in general would be satisfied by a pipeline an
    // earlier test left running — see parkThisRunsBrief).
    await waitFor(() => {
      expect(releaseBrief).toBeTypeOf('function');
    }, { timeout: 10000 });
    const openRun = (await listRunsByCampaign(campaign.id)).find(
      (run) => run.targetArtifactId === encounter.id,
    );
    if (openRun === undefined) throw new Error('the map run never appeared');
    expect(openRun.status).toBe('running');

    const withdrawn = await useEncounterMapQueue.getState().cancelAll();
    expect(withdrawn).toBe(1);
    // The cancel path's own verdict, asserted and not assumed (docs/05 §Progress
    // dock: a cancelled run is never reported as a failure).
    const cancelled = await getRun(openRun.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.errorMessage).toBe('');

    // NOW the model reply arrives — the step's write lands after the abort.
    takeResolver(releaseBrief, "this run's brief reply")();
    await drainPipeline();

    // A deliberate stop is not an incident: no toast, and the late step result
    // must not resurrect the row the cancel path settled.
    expect(toastErrorMock).not.toHaveBeenCalled();
    const settled = await getRun(openRun.id);
    expect(settled?.status).toBe('cancelled');
    expect(settled?.errorMessage).toBe('');
    const after = await getArtifact(encounter.id);
    if (after?.kind !== 'encounter') throw new Error('encounter missing');
    expect(after.data.layout).toBeNull();
  }, 30000);

  it('a step whose write lands after the run row is gone is not reported as an error (spurious-toast pin)', async () => {
    const campaign = await createCampaign({ name: 'Vanished row', system: 'dnd5e' });
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
      campaignId: campaign.id, kind: 'encounter', name: 'Row gone',
      data: { difficulty: '', levelHint: '', monsters: [{ name: 'Skeleton', count: 1, notes: '', treasure: '', source: { type: 'none' } }], terrain: '', tactics: '', treasure: '', mapImageId: null, layout: null, preset: 'standard', locationKind: 'other', siteShape: 'single', budgetAdvisory: '' },
    });
    let releaseBrief: (() => void) | undefined;
    parkThisRunsBrief(campaign.name, (release) => {
      releaseBrief = release;
    });
    const job = { campaignId: campaign.id, moduleId: null as Id | null, artifactId: encounter.id, name: encounter.name };
    useEncounterMapQueue.getState().enqueue([job]);
    await waitFor(() => {
      expect(releaseBrief).toBeTypeOf('function');
    }, { timeout: 10000 });
    const openRun = (await listRunsByCampaign(campaign.id)).find(
      (run) => run.targetArtifactId === encounter.id,
    );
    if (openRun === undefined) throw new Error('the map run never appeared');

    await useEncounterMapQueue.getState().cancelAll();
    // The row disappears underneath the still-live pipeline — in the suite the
    // NEXT test's `clearDatabase()` (tests/db/helpers.ts), in the app the Runs
    // list's delete of a run the owner deleted (db/runRepo.ts `deleteRun`).
    await deleteRun(openRun.id);
    takeResolver(releaseBrief, "this run's brief reply")();
    await drainPipeline();

    // The stopped step's write has nothing to record and no failure to report:
    // "Encounter step "brief" failed: PersonaRun not found: …" is exactly the
    // spurious toast three full-suite sightings recorded (docs/17 row 115).
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 30000);

  it('a step that dies AFTER the owner stopped the run is not reported as a failure either (the row is already gone)', async () => {
    const campaign = await createCampaign({ name: 'Stopped then died', system: 'dnd5e' });
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
      campaignId: campaign.id, kind: 'encounter', name: 'Stopped then died',
      data: { difficulty: '', levelHint: '', monsters: [{ name: 'Skeleton', count: 1, notes: '', treasure: '', source: { type: 'none' } }], terrain: '', tactics: '', treasure: '', mapImageId: null, layout: null, preset: 'standard', locationKind: 'other', siteShape: 'single', budgetAdvisory: '' },
    });
    // A reply the test can REJECT by hand: the abort of a stopped run reaches
    // the step as whatever the provider raised (a transport error, a
    // DOMException) — the engine must key on the STOP it recorded, never on the
    // error's kind (docs/17 row 115).
    let killBrief: ((error: Error) => void) | undefined;
    chatMock.mockImplementation((messages: unknown) => {
      const reply = { text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null };
      if (!JSON.stringify(messages).includes(campaign.name)) return Promise.resolve(reply);
      return new Promise((_resolve, reject) => {
        killBrief = (error: Error) => {
          reject(error);
        };
      });
    });
    const job = { campaignId: campaign.id, moduleId: null as Id | null, artifactId: encounter.id, name: encounter.name };
    useEncounterMapQueue.getState().enqueue([job]);
    await waitFor(() => {
      expect(killBrief).toBeTypeOf('function');
    }, { timeout: 10000 });
    const openRun = (await listRunsByCampaign(campaign.id)).find(
      (run) => run.targetArtifactId === encounter.id,
    );
    if (openRun === undefined) throw new Error('the map run never appeared');

    await useEncounterMapQueue.getState().cancelAll();
    await deleteRun(openRun.id);
    takeResolver(killBrief, "this run's brief reply")(new Error('transport died with the stop'));

    await drainPipeline();
    expect(toastErrorMock).not.toHaveBeenCalled();
    // The stop settled the job; the death is not a retryable failure.
    expect(useEncounterMapQueue.getState().failed).toEqual([]);
  }, 30000);

  it('a step that dies on its own — no cancel in play — still toasts and still writes its failed run', async () => {
    const campaign = await createCampaign({ name: 'Genuine failure', system: 'dnd5e' });
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
      campaignId: campaign.id, kind: 'encounter', name: 'Provider died',
      data: { difficulty: '', levelHint: '', monsters: [{ name: 'Skeleton', count: 1, notes: '', treasure: '', source: { type: 'none' } }], terrain: '', tactics: '', treasure: '', mapImageId: null, layout: null, preset: 'standard', locationKind: 'other', siteShape: 'single', budgetAdvisory: '' },
    });
    // Nobody stopped anything: the step itself dies (the provider's reply is a
    // hard error). This is the guard against curing the seam by swallowing —
    // AGENTS rule 2 still binds every genuine failure. The campaign filter keeps
    // a straggler pipeline from an earlier test (see parkThisRunsBrief) from
    // failing into this assertion: only THIS run's brief gets the hard error.
    chatMock.mockImplementation((messages: unknown) => {
      if (!JSON.stringify(messages).includes(campaign.name)) {
        return Promise.resolve({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
      }
      return Promise.reject(new Error('provider exploded'));
    });
    const job = { campaignId: campaign.id, moduleId: null as Id | null, artifactId: encounter.id, name: encounter.name };
    useEncounterMapQueue.getState().enqueue([job]);
    await waitFor(() => {
      expect(useEncounterMapQueue.getState().failed.map((failed) => failed.artifactId)).toEqual([encounter.id]);
    }, { timeout: 15000 });
    // The engine's failure surface: the wrapped sentence (and the queue's own
    // per-artifact toast rides the same failure).
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('Encounter step "brief" failed: provider exploded'),
      expect.any(Error),
    );
    // …and the failed run row is still written, with its message.
    const runs = await listRunsByCampaign(campaign.id);
    const failedRun = runs.find((run) => run.targetArtifactId === encounter.id);
    expect(failedRun?.status).toBe('failed');
    expect(failedRun?.errorMessage).toContain('provider exploded');
  }, 30000);

  /**
   * THE RESIDUE THIS SLICE CURES (docs/17 row 116's measured three variants,
   * row 117's decision): a run the OWNER withdrew is not a failure to report.
   * Every pin below FORCES the ordering — the map job is left WAITING on a run
   * the test then stops or deletes by hand, with no `dequeue`/`cancelAll` in
   * play, so the queue's own abort signal is not the seam under test and the
   * run's ROW is the only fact the job can read.
   */
  it('a run the OWNER cancelled under a watching job is not a queue failure: silent, no retry entry, dock drained', async () => {
    const { campaignId, encounterId } = await withdrawnRunFixture('Cancelled under watch', 'Stopped by owner');
    const runId = await watchRunningRun(campaignId, encounterId, 'Stopped by owner', 'Cancelled under watch');

    // The owner's Stop on the RUN itself — the Runs tab's own button, and
    // nothing else: the map job keeps its place in the queue.
    await runEngine.cancel(runId);
    // The premise, asserted rather than assumed: the row IS withdrawn before the
    // job settles.
    expect((await getRun(runId))?.status).toBe('cancelled');

    await waitFor(() => {
      expect(useEncounterMapQueue.getState().active).toEqual([]);
      expect(useEncounterMapQueue.getState().queued).toEqual([]);
    }, { timeout: 10000 });
    // At HEAD this is the sighting, verbatim: toast `Could not generate a map
    // for "Stopped by owner"` carrying `run ended cancelled`, and the job lands
    // on the retryable failed list.
    expectWithdrawnSilently(encounterId);
    const after = await getArtifact(encounterId);
    if (after?.kind !== 'encounter') throw new Error('encounter missing');
    expect(after.data.layout).toBeNull();
  }, 30000);

  it('a run row DELETED under a watching job (the owner\u2019s delete) is that same withdrawal, seen one step later: silent', async () => {
    const { campaignId, encounterId } = await withdrawnRunFixture('Deleted under watch', 'Row deleted');
    const runId = await watchRunningRun(campaignId, encounterId, 'Row deleted', 'Deleted under watch');

    await deleteRun(runId);

    await waitFor(() => {
      expect(useEncounterMapQueue.getState().active).toEqual([]);
      expect(useEncounterMapQueue.getState().queued).toEqual([]);
    }, { timeout: 10000 });
    // At HEAD this is variant (A): toast `Could not generate a map for "Row
    // deleted"` carrying `Run <id> disappeared while waiting for it to finish`,
    // plus a retryable failed entry.
    expectWithdrawnSilently(encounterId);
    expect(await getRun(runId)).toBeUndefined();
    const after = await getArtifact(encounterId);
    if (after?.kind !== 'encounter') throw new Error('encounter missing');
    expect(after.data.layout).toBeNull();
  }, 30000);

  it('cancel-then-delete (the Runs tab\u2019s own gesture) is the same withdrawal on both halves: silent', async () => {
    const { campaignId, encounterId } = await withdrawnRunFixture('Cancelled then deleted', 'Stop then delete');
    const runId = await watchRunningRun(campaignId, encounterId, 'Stop then delete', 'Cancelled then deleted');

    // The owner's gesture as docs/17 row 116 wired it: the stop is recorded
    // FIRST, the row goes second.
    await runEngine.cancel(runId);
    expect((await getRun(runId))?.status).toBe('cancelled');
    await deleteRun(runId);

    await waitFor(() => {
      expect(useEncounterMapQueue.getState().active).toEqual([]);
      expect(useEncounterMapQueue.getState().queued).toEqual([]);
    }, { timeout: 10000 });
    // Variant (B) at HEAD: the pipeline's toast is gone (row 116), the queue's
    // `… disappeared while waiting for it to finish` remains.
    expectWithdrawnSilently(encounterId);
    expect(await getRun(runId)).toBeUndefined();
  }, 30000);

  it('a withdrawn job key enqueued AGAIN is new work: the second withdrawal owes its own counter decrement (no stuck dock)', async () => {
    const { campaignId, encounterId } = await withdrawnRunFixture('Withdrawn twice', 'Withdrawn twice');
    const first = await watchRunningRun(campaignId, encounterId, 'Withdrawn twice', 'Withdrawn twice');
    await runEngine.cancel(first);
    await waitFor(() => {
      expect(useEncounterMapQueue.getState().active).toEqual([]);
    }, { timeout: 10000 });
    expectWithdrawnSilently(encounterId);

    // The same encounter, enqueued again (its own automation re-entry: the map
    // is still missing) and withdrawn again. A withdrawal is spent per JOB, not
    // per key: the second one owes its OWN decrement, or the group's counter
    // would sit at 0/1 forever — the dock claiming work nobody is doing.
    const second = await watchRunningRun(campaignId, encounterId, 'Withdrawn twice', 'Withdrawn twice');
    expect(second).not.toBe(first);
    await runEngine.cancel(second);
    await waitFor(() => {
      expect(useEncounterMapQueue.getState().active).toEqual([]);
    }, { timeout: 10000 });
    expectWithdrawnSilently(encounterId);
  }, 30000);

  it('the contrast: a run that FAILED on its own still toasts the queue failure and still lands retryable', async () => {
    const { campaignId, encounterId } = await withdrawnRunFixture('Queue genuine failure', 'Provider died in queue');
    // Nobody stopped anything and nothing was deleted: the step itself dies.
    // This is the guard against curing the withdrawal by swallowing every
    // non-completed run (AGENTS rules 1-2).
    let killBrief: ((error: Error) => void) | undefined;
    parkThisRunsBriefError('Queue genuine failure', (kill) => {
      killBrief = kill;
    });
    useEncounterMapQueue.getState().enqueue([
      { campaignId, moduleId: null as Id | null, artifactId: encounterId, name: 'Provider died in queue' },
    ]);
    await waitFor(() => {
      expect(killBrief).toBeTypeOf('function');
    }, { timeout: 10000 });
    takeResolver(killBrief, "this run's brief reply")(new Error('provider exploded'));

    await waitFor(() => {
      expect(useEncounterMapQueue.getState().failed.map((job) => job.artifactId)).toEqual([encounterId]);
    }, { timeout: 15000 });
    // The queue's own loud verdict, and the run row that carries the reason.
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Could not generate a map for "Provider died in queue"',
      expect.any(Error),
    );
    expect(useEncounterMapQueue.getState().active).toEqual([]);
    expect(useProgressStore.getState().jobs).toEqual([]);
    const runs = await listRunsByCampaign(campaignId);
    const failedRun = runs.find((run) => run.targetArtifactId === encounterId);
    expect(failedRun?.status).toBe('failed');
    expect(failedRun?.errorMessage).toContain('provider exploded');
    // …and the queue's own verdict says WHY with that very sentence, verbatim:
    // the engine wrote it, so it IS the reason (docs/18 §2,
    // `runNotCompletedReason`) — never a reworded fragment behind the queue's
    // own words. The non-empty half is asserted first so this can never pass
    // by both sides being empty (AGENTS rule 1).
    expect(failedRun?.errorMessage).not.toBe('');
    const failureCall = toastErrorMock.mock.calls.find(
      ([title]) => title === 'Could not generate a map for "Provider died in queue"',
    );
    expect(failureCall).toBeDefined();
    expect((failureCall?.[1] as Error).message).toBe(failedRun?.errorMessage);
  }, 30000);

  it('a terminal run that carries NO sentence of its own still says why: `run ended <status>` (the seam’s fallback at this site)', async () => {
    const { campaignId, encounterId } = await withdrawnRunFixture('Queue silent death', 'No sentence');
    const runId = await watchRunningRun(campaignId, encounterId, 'No sentence', 'Queue silent death');

    // The row is made terminal by hand, with no message. This is the branch the
    // engine's own failure path cannot reach any more (`fail` always composes a
    // sentence), so without this write the fallback would be pinned NOWHERE at
    // this site — it would survive only as an unpinned template.
    await updateRun(runId, { status: 'failed', errorMessage: '' });

    await waitFor(() => {
      expect(useEncounterMapQueue.getState().failed.map((job) => job.artifactId)).toEqual([
        encounterId,
      ]);
    }, { timeout: 15000 });
    // The queue's own loud verdict, carrying the seam's fallback sentence.
    const failureCall = toastErrorMock.mock.calls.find(
      ([title]) => title === 'Could not generate a map for "No sentence"',
    );
    expect(failureCall).toBeDefined();
    expect((failureCall?.[1] as Error).message).toBe('run ended failed');
    // It is a FALLBACK, not a verdict: the job is still loud and still
    // retryable, which is what an owner-visible failure owes.
    expect(useEncounterMapQueue.getState().failed).toHaveLength(1);
  }, 30000);

  it('a job whose run COMPLETED normally is unchanged: it maps, it never toasts, it never lands retryable', async () => {
    const { campaignId, encounterId } = await withdrawnRunFixture('Queue completed', 'Mapped normally');
    useEncounterMapQueue.getState().enqueue([
      { campaignId, moduleId: null as Id | null, artifactId: encounterId, name: 'Mapped normally' },
    ]);
    await waitFor(() => {
      expect(useEncounterMapQueue.getState().active).toEqual([]);
      expect(useEncounterMapQueue.getState().queued).toEqual([]);
    }, { timeout: 15000 });
    expect(useEncounterMapQueue.getState().failed).toEqual([]);
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(useProgressStore.getState().jobs).toEqual([]);
    const after = await getArtifact(encounterId);
    if (after?.kind !== 'encounter') throw new Error('encounter missing');
    expect(after.data.layout).not.toBeNull();
    // The normal completion still writes its own verdict (the withdrawal branch
    // must not answer for it).
    const runs = await listRunsByCampaign(campaignId);
    expect(runs.find((run) => run.targetArtifactId === encounterId)?.status).toBe('completed');
  }, 30000);
});
