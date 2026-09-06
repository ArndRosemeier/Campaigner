import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Side-effect module under test: registers the run-completion listener.
import '@/features/campaign/post-run-extras';
import { createArtifact, getAnyArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createModule as saveModule } from '@/db/moduleRepo';
import { createPersona } from '@/db/personaRepo';
import { listRunsByCampaign, getRun } from '@/db/runRepo';
import { updateSettings } from '@/db/settingsRepo';
import type { Campaign, Persona } from '@/domain';
import { createModule } from '@/domain';
import { runEngine, encounterRunAdapters } from '@/llm/runEngine';
import { useMobPortraitQueue } from '@/features/campaign/mob-portrait-queue';
import { useEncounterMapQueue } from '@/features/modules/encounter-map-queue';
import { seedBuiltInPersonas } from '@/db/seed';
import { clearDatabase } from '../db/helpers';
import { coarseStructure } from '@/llm/encounterVision';

/**
 * Ratified: the creation dialog's ticked extras execute AFTER the run
 * completes, in the queue layer — a cover portrait is enqueued (and, with
 * image generation enabled, attached as cover) without reopening or failing
 * the finished run. Unticked extras enqueue nothing.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
  fetchWithHeadersTimeout: vi.fn(),
}));
vi.mock('@/llm/imageGen', () => ({ generateImages: vi.fn() }));
vi.mock('@/lib/imageIntake', () => ({ intakeImage: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn(), toastInfo: vi.fn() }));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { generateImages } = await import('@/llm/imageGen');
const generateImagesMock = vi.mocked(generateImages);
const { intakeImage } = await import('@/lib/imageIntake');
const intakeImageMock = vi.mocked(intakeImage);


const VALID_DRAFT = {
  name: 'Grix',
  summary: 'A goblin alchemist boss.',
  suggestedTags: ['goblin'],
  body: '# Grix\nShe brews. She throws.',
  appearance: 'Small, soot-stained, goggles.',
  personality: 'Manic, cheerful, volatile.',
  needsStatBlock: false,
};

function blobOf(): Blob {
  return new Blob(['fake-png'], { type: 'image/png' });
}

const ENCOUNTER_STATBLOCK = {
  system: 'dnd5e', level: '1', size: 'Medium', creatureType: 'humanoid', ac: 12,
  acNote: '', hp: 7, hpFormula: '2d6', speed: '30 ft.',
  abilities: { str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 10 },
  saves: '', skills: '', senses: '', languages: '', traits: [], actions: [], reactions: [], legendary: [], extras: {},
};
/** A fresh-create Smith encounter draft that classifies itself as a dungeon. */
const ENCOUNTER_DRAFT = {
  name: 'The Drowned Cellars',
  summary: 'Flooded smuggling cellars.',
  suggestedTags: ['dungeon'],
  body: '# The Drowned Cellars',
  difficulty: 'deadly',
  levelHint: '5',
  monsters: [{ name: 'Kuo-toa', count: 3, notes: 'ambushers', statBlock: ENCOUNTER_STATBLOCK }],
  terrain: 'flooded cellars',
  tactics: 'drag intruders under',
  treasure: 'none',
  locationKind: 'dungeon',
};
/** The Cartographer brief the mocked chat returns when a map job runs. */
const CARTOGRAPHER_BRIEF = {
  name: 'Ignored regeneration name', summary: '', body: '', difficulty: 'deadly', levelHint: '5',
  terrain: 'flooded cellars', tactics: '', treasure: '', theme: 'drowned cellars', styleNotes: '', negative: '',
  monsters: [{ name: 'Kuo-toa', count: 3, notes: '', statBlock: ENCOUNTER_STATBLOCK }],
  rooms: [
    { name: 'Entry', description: '', size: 'small', monsterIndexes: [], adjacentRoomIndexes: [1] },
    { name: 'Cistern', description: '', size: 'medium', monsterIndexes: [0], adjacentRoomIndexes: [0] },
  ],
  entryRoomIndex: 0,
};

beforeEach(async () => {
  await clearDatabase();
  chatMock.mockReset();
  generateImagesMock.mockReset();
  intakeImageMock.mockReset();
  useMobPortraitQueue.getState().reset();
  useEncounterMapQueue.getState().reset();
  await updateSettings({ imagesEnabled: true });
  // Green-path map runs: the unattended Cartographer's image/verify steps
  // run on adapters, spied exactly like tests/features/encounter-map-queue.
  vi.spyOn(encounterRunAdapters, 'renderSchematic').mockReturnValue({ dataUrl: 'data:image/png;base64,schematic', width: 240, height: 180 });
  vi.spyOn(encounterRunAdapters, 'generateImages').mockResolvedValue({ images: [blobOf()], costUsd: null, cappedToOne: false, modelUsed: 'test-image-model' });
  vi.spyOn(encounterRunAdapters, 'normalizeImageAspect').mockImplementation((blob) => Promise.resolve({ blob, width: 800, height: 600, action: 'none' }));
  vi.spyOn(encounterRunAdapters, 'intakeImage').mockImplementation((blob) => Promise.resolve({ blob, width: 800, height: 600, mimeType: 'image/webp' }));
  vi.spyOn(encounterRunAdapters, 'blobToDataUrl').mockResolvedValue('data:image/webp;base64,map');
  vi.spyOn(encounterRunAdapters, 'verifyEncounterMap').mockImplementation(({ layout }) => {
    const expected = coarseStructure(layout);
    return Promise.resolve({ expected, actual: expected, mismatchedIndexes: [], mismatchRatio: 0, needsReview: false });
  });
});

afterEach(() => {
  useEncounterMapQueue.getState().reset();
  vi.restoreAllMocks();
});

async function seed(): Promise<{ campaignId: string; personaId: string }> {
  await seedBuiltInPersonas();
  const campaign = await createCampaign({ name: 'Test Campaign', system: 'dnd5e' });
  const persona = await createPersona({
    slug: 'npc-smith-extras-test',
    name: 'NPC Smith',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    producesKind: 'npc',
    builtIn: true,
  });
  return { campaignId: campaign.id, personaId: persona.id };
}

const RUN_INPUT = (campaignId: string, personaId: string) => ({
  campaign: {
    id: campaignId,
    name: 'Test Campaign',
    system: 'dnd5e' as const,
    description: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  persona: {
    id: personaId,
    slug: 'npc-smith-extras-test',
    name: 'NPC Smith',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    model: '',
    reasoningEffort: 'default' as const,
    temperature: 0.8,
    producesKind: 'npc' as const,
    mode: 'generate' as const,
    builtIn: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  autonomy: 'auto' as const,
  brief: 'a goblin alchemist boss',
  pinnedChunkIds: [],
});

describe('post-run extras', () => {
  it('the image extra attaches a cover portrait after the run completes', async () => {
    const { campaignId, personaId } = await seed();
    // The image extra's portrait draft is deterministic (the artifact has an
    // appearance — the shortcut wins) and never calls chat.
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null });
    generateImagesMock.mockResolvedValue({
      images: [blobOf()],
      modelUsed: 'image-model',
      costUsd: null,
      cappedToOne: false,
    });
    intakeImageMock.mockResolvedValue({
      blob: blobOf(),
      mimeType: 'image/png',
      width: 64,
      height: 64,
    });

    const runId = await runEngine.startRun({
      ...RUN_INPUT(campaignId, personaId),
      extras: { image: true, statBlock: false, mobPortraits: false, battlemap: false },
    });
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });
    const run = await getRun(runId);
    await waitFor(async () => {
      const artifact = await getAnyArtifact(run?.resultArtifactId ?? '');
      expect(artifact?.coverImageId).not.toBeNull();
    });
    // The completed run was not reopened by the extras execution.
    expect((await getRun(runId))?.status).toBe('completed');
  }, 20000);

  it('unticked extras enqueue nothing', async () => {
    const { campaignId, personaId } = await seed();
    chatMock.mockResolvedValue({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      ...RUN_INPUT(campaignId, personaId),
      extras: { image: false, statBlock: false, mobPortraits: false, battlemap: false },
    });
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    expect(useMobPortraitQueue.getState().active).toHaveLength(0);
  }, 20000);

  it('a statblock-extra run whose statblock step is skipped persists the loud finalize notice', async () => {
    const { campaignId, personaId } = await seed();
    // VALID_DRAFT sets needsStatBlock: false → the statblock step is
    // skipped and data.statBlock stays null. The extra is verification-only:
    // the finalize step must carry the visible notice, never fabricate one.
    chatMock.mockResolvedValue({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      ...RUN_INPUT(campaignId, personaId),
      extras: { image: false, statBlock: true, mobPortraits: false, battlemap: false },
    });
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });
    const run = await getRun(runId);
    const finalize = run?.steps.find((step) => step.name === 'finalize');
    expect((finalize?.output as { notice?: string } | null)?.notice).toBe(
      'No stat block was generated — add one in the artifact editor.',
    );
  }, 20000);

  it('a completed npc run without the statblock extra attaches no notice', async () => {
    const { campaignId, personaId } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          system: 'dnd5e',
          level: '3',
          size: 'Small',
          creatureType: 'humanoid (goblinoid)',
          ac: 14,
          acNote: '',
          hp: 22,
          hpFormula: '5d6',
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
          extras: {},
        }),
        modelUsed: 'test-model',
        fallback: null,
      });

    const runId = await runEngine.startRun(RUN_INPUT(campaignId, personaId));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });
    const run = await getRun(runId);
    const finalize = run?.steps.find((step) => step.name === 'finalize');
    expect((finalize?.output as { notice?: string } | null)?.notice ?? '').toBe('');
  }, 20000);
});

describe('automatic battlemaps for automated encounter creation (owner request)', () => {
  /** Seeds the built-ins plus a content-only Encounter Smith and a Cartographer. */
  async function seedEncounterPersonas(): Promise<{
    campaign: Campaign;
    smith: Persona;
    cartographer: Persona;
  }> {
    await seedBuiltInPersonas();
    const campaign = await createCampaign({ name: 'Cellars', system: 'dnd5e' });
    const smith = await createPersona({
      slug: 'encounter-smith-auto-test',
      name: 'Encounter Smith',
      description: 'test',
      systemPrompt: 'You are a test persona. Reply with JSON only.',
      producesKind: 'encounter',
      mode: 'generate',
      builtIn: true,
    });
    const cartographer = await createPersona({
      slug: 'encounter-cartographer-auto-test',
      name: 'Encounter Cartographer',
      description: 'test',
      systemPrompt: 'You are a test persona. Reply with JSON only.',
      producesKind: 'encounter',
      mode: 'encounter',
      builtIn: true,
    });
    return { campaign, smith, cartographer };
  }

  /** Waits until the encounter-map queue has fully settled (all jobs done). */
  async function queueSettled(): Promise<void> {
    await waitFor(
      () => {
        expect(useEncounterMapQueue.getState().queued).toEqual([]);
        expect(useEncounterMapQueue.getState().active).toEqual([]);
      },
      { timeout: 15000 },
    );
  }

  it('a fresh module-owned Smith encounter is auto-enqueued on the module queue and mapped with resolved defaults', async () => {
    const { campaign, smith } = await seedEncounterPersonas();
    const module = await saveModule(createModule({
      campaignId: campaign.id, title: 'Ruins', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch',
      // The dialog passes the master switch explicitly (default ON there).
      autoGenerateBattlemaps: true,
    }));
    chatMock.mockResolvedValue({ text: JSON.stringify(ENCOUNTER_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(ENCOUNTER_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(CARTOGRAPHER_BRIEF), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      campaign,
      persona: smith,
      autonomy: 'auto',
      brief: 'a flooded cellar ambush',
      pinnedChunkIds: [],
      placementModuleId: module.id,
    });
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const run = await getRun(runId);
    const artifact = await getAnyArtifact(run?.resultArtifactId ?? '');
    if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
    expect(artifact.moduleId).toBe(module.id);

    // The unattended Cartographer ran on the encounter and mapped it.
    await queueSettled();
    const mapped = await getAnyArtifact(artifact.id);
    if (mapped?.kind !== 'encounter') throw new Error('encounter missing');
    expect(mapped.data.layout).not.toBeNull();
    expect(mapped.data.mapImageId).not.toBeNull();
    // The queue's run carried the encounter's own moduleId.
    const runs = await listRunsByCampaign(campaign.id);
    const mapRun = runs.find((entry) => entry.targetArtifactId === artifact.id && entry.personaId !== smith.id);
    expect(mapRun?.status).toBe('completed');
    // Defaults resolved through the D10 chain: the draft's dungeon kind put
    // the map on the dungeon tier (48x36 for the 4:3 aspect default).
    expect(mapRun?.encounterPreset).toBe('dungeon');
    expect(mapped.data.layout?.gridW).toBe(48);
    // The Smith run itself was never reopened by the extras execution.
    expect((await getRun(runId))?.status).toBe('completed');
  }, 30000);

  it('a campaign-level encounter auto-enqueues a campaign-level (moduleId null) job', async () => {
    const { campaign, smith } = await seedEncounterPersonas();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(ENCOUNTER_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(CARTOGRAPHER_BRIEF), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      campaign,
      persona: smith,
      autonomy: 'auto',
      brief: 'a flooded cellar ambush',
      pinnedChunkIds: [],
    });
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const run = await getRun(runId);
    const artifact = await getAnyArtifact(run?.resultArtifactId ?? '');
    expect(artifact?.moduleId ?? null).toBeNull();

    await queueSettled();
    const runs = await listRunsByCampaign(campaign.id);
    const mapRun = runs.find((entry) => entry.targetArtifactId === artifact?.id && entry.personaId !== smith.id);
    // The map run exists and the JOB was campaign-level (moduleId null —
    // pinned via the run's campaign-level artifact and the queue's empty
    // module dock state after settle).
    expect(mapRun?.status).toBe('completed');
    expect(useEncounterMapQueue.getState().failed).toEqual([]);
  }, 30000);

  it('a targeted content regeneration never auto-enqueues a map', async () => {
    const { campaign, smith } = await seedEncounterPersonas();
    const stub = await createArtifact({
      campaignId: campaign.id, kind: 'encounter', name: 'Ford Ambush',
      data: {
        difficulty: '', levelHint: '', monsters: [], terrain: '', tactics: '', treasure: '',
        mapImageId: null, layout: null, preset: 'standard', locationKind: 'other',
      },
    });
    chatMock.mockResolvedValue({ text: JSON.stringify(ENCOUNTER_DRAFT), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      campaign,
      persona: smith,
      autonomy: 'auto',
      brief: 'refill the stub',
      pinnedChunkIds: [],
      targetArtifactId: stub.id,
    });
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    expect(useEncounterMapQueue.getState().queued).toEqual([]);
    expect(useEncounterMapQueue.getState().active).toEqual([]);
    expect(useEncounterMapQueue.getState().failed).toEqual([]);
    // Regenerating an existing map stays an EXPLICIT user action.
  }, 30000);

  it('the module master switch off keeps the encounter maps manual', async () => {
    const { campaign, smith } = await seedEncounterPersonas();
    const module = await saveModule({
      ...createModule({ campaignId: campaign.id, title: 'Quiet', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
      autoGenerateBattlemaps: false,
    });
    chatMock.mockResolvedValue({ text: JSON.stringify(ENCOUNTER_DRAFT), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      campaign,
      persona: smith,
      autonomy: 'auto',
      brief: 'a flooded cellar ambush',
      pinnedChunkIds: [],
      placementModuleId: module.id,
    });
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    expect(useEncounterMapQueue.getState().queued).toEqual([]);
    expect(useEncounterMapQueue.getState().active).toEqual([]);
    expect(useEncounterMapQueue.getState().failed).toEqual([]);
  }, 30000);

  it('a Cartographer run never auto-enqueues (it maps its own encounter in-run)', async () => {
    const { campaign, cartographer } = await seedEncounterPersonas();
    chatMock.mockResolvedValue({ text: JSON.stringify(CARTOGRAPHER_BRIEF), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      campaign,
      persona: cartographer,
      autonomy: 'auto',
      brief: 'a flooded cellar ambush',
      pinnedChunkIds: [],
      encounterMapAspect: '4:3',
    });
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    expect(useEncounterMapQueue.getState().queued).toEqual([]);
    expect(useEncounterMapQueue.getState().active).toEqual([]);
    expect(useEncounterMapQueue.getState().failed).toEqual([]);
  }, 30000);

  it('a failed map job toasts loudly per artifact and never fails the completed run', async () => {
    const { campaign, smith } = await seedEncounterPersonas();
    const module = await saveModule(createModule({
      campaignId: campaign.id, title: 'Ruins', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch',
      // The dialog passes the master switch explicitly (default ON there).
      autoGenerateBattlemaps: true,
    }));
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(ENCOUNTER_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(CARTOGRAPHER_BRIEF), modelUsed: 'test-model', fallback: null });
    // The verify step collapses — the map run fails, the queue reports it.
    vi.spyOn(encounterRunAdapters, 'verifyEncounterMap').mockRejectedValue(new Error('vision drift'));

    const runId = await runEngine.startRun({
      campaign,
      persona: smith,
      autonomy: 'auto',
      brief: 'a flooded cellar ambush',
      pinnedChunkIds: [],
      placementModuleId: module.id,
    });
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const run = await getRun(runId);
    const artifact = await getAnyArtifact(run?.resultArtifactId ?? '');
    await waitFor(() => {
      expect(useEncounterMapQueue.getState().failed.map((job) => job.artifactId)).toEqual([artifact?.id]);
    }, { timeout: 15000 });
    const { toastError } = await import('@/lib/toast');
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Drowned Cellars'), expect.any(Error));
    // The queue contract holds: the completed Smith run was never reopened.
    expect((await getRun(runId))?.status).toBe('completed');
  }, 30000);
});
