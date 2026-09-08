import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { listArtifactsByCampaign, createArtifact } from '@/db/artifactRepo';
import { saveModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { saveSettings } from '@/db/settingsRepo';
import { createModule, defaultSettings, modulePartSchema, moduleSpineSchema, type Module } from '@/domain';
import { runModulePostGeneration } from '@/features/modules/post-generation';
import { chainRunner } from '@/llm/chainRunner';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

// The automation hands its results to the background queues — replaced with
// spies so the pumps never run inside this test.
const { enqueueImageJobs, enqueueEncounterMaps, enqueueMobPortraits } = vi.hoisted(() => ({
  enqueueImageJobs: vi.fn(),
  enqueueEncounterMaps: vi.fn(),
  enqueueMobPortraits: vi.fn(),
}));

vi.mock('@/features/modules/entity-image-queue', () => ({
  useEntityImageQueue: { getState: () => ({ enqueue: enqueueImageJobs }) },
}));

vi.mock('@/features/modules/encounter-map-queue', () => ({
  useEncounterMapQueue: { getState: () => ({ enqueue: enqueueEncounterMaps }) },
}));

vi.mock('@/features/campaign/mob-portrait-queue', () => ({ enqueueMobPortraits }));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError, toastSuccess } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const toastSuccessMock = vi.mocked(toastSuccess);

const npcDraft = {
  name: 'Kael Ashbound, Warden of the Gate',
  summary: 'The watchful keeper of the tide gate.',
  suggestedTags: ['warden'],
  body: '# Kael\nKael keeps the gate and knows who passed at dusk.',
  appearance: 'Weathered leathers and a brass key-ring.',
  personality: 'Quiet and observant.',
  needsStatBlock: true,
};

const npcStatblock = {
  system: 'dnd5e',
  level: '3',
  size: 'Medium',
  creatureType: 'Humanoid',
  ac: 15,
  acNote: 'leather armor',
  hp: 27,
  hpFormula: '5d8+5',
  speed: '30 ft.',
  abilities: { str: 12, dex: 14, con: 12, int: 11, wis: 15, cha: 10 },
  saves: 'Wis +4',
  skills: 'Insight +4, Perception +4',
  senses: 'passive Perception 14',
  languages: 'Common',
  traits: [],
  actions: [],
  reactions: [],
  legendary: [],
  extras: {},
};

const npcData = { appearance: '', personality: '', statBlock: null };

const CHUNK_ID = '00000000-0000-4000-8000-00000000c001';

/** A rulebook-cited roster entry (mobArtifactId when the row is stamped). */
function rulebookEntry(mobArtifactId?: string) {
  return {
    name: 'Goblin',
    count: 2,
    notes: '',
    treasure: '',
    source: {
      type: 'rulebook' as const,
      chunkId: CHUNK_ID,
      ...(mobArtifactId === undefined ? {} : { mobArtifactId }),
    },
  };
}

/** A module-owned encounter artifact carrying the given roster. */
async function seedEncounter(
  campaignId: string,
  moduleId: string,
  monsters: ReturnType<typeof rulebookEntry>[],
  name = 'Ash Gate',
) {
  return createArtifact({
    campaignId,
    moduleId,
    kind: 'encounter',
    name,
    summary: '',
    body: '',
    data: {
      difficulty: 'medium',
      levelHint: '3',
      monsters,
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    },
  });
}

async function seedModule(
  campaignId: string,
  overrides: Partial<Module> = {},
): Promise<Module> {
  const base = createModule({
    campaignId,
    title: 'Ember Crypt',
    concept: 'A drowned crypt beneath the harbor.',
    levelMin: 1,
    levelMax: 4,
    sizeDial: 'sketch',
    autoGenerateKinds: ['npc'],
  });
  const module = moduleOverrides(base, {
    status: 'ready',
    entityNamesNormalized: true,
    entityKinds: [{ name: 'Kael', kind: 'npc', absorbed: [], wants: [], conflictKind: null }],
    spine: moduleSpineSchema.parse({
      premise: 'The gate of [[Ember Crypt]] opens at dusk.',
      themes: [],
      partPlan: [
        {
          title: 'The Tide Gate',
          levelBand: '1–4',
          synopsis: 'The party meets [[Kael]] at the sealed gate.',
          levelUpTrigger: 'The gate opens.',
        },
      ],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        status: 'ready',
        markdown: '## The Tide Gate\n\n[[Kael]] watches the gate and counts every visitor.',
        edited: false,
        errorMessage: '',
      }),
    ],
    ...overrides,
  });
  return saveModule(module);
}

/** Applies partial overrides while keeping the parsed shape. */
function moduleOverrides(module: Module, overrides: Partial<Module>): Module {
  // The schema re-validates on save; spread order keeps overrides authoritative.
  return { ...module, ...overrides };
}

describe('runModulePostGeneration', () => {
  beforeEach(async () => {
    await clearDatabase();
    await seedBuiltInPersonas();
    chatMock.mockReset();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
    enqueueImageJobs.mockReset();
    enqueueEncounterMaps.mockReset();
    enqueueMobPortraits.mockReset();
    chainRunner.reset();
    useProgressStore.getState().reset();
  });
  afterEach(() => {
    chainRunner.reset();
    useProgressStore.getState().reset();
  });

  it('auto-generates unresolved entities of the configured kinds through the real chain', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id);
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(npcDraft), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(npcStatblock), modelUsed: 'test-model', fallback: null });

    await runModulePostGeneration(module.id, campaign);

    const artifacts = await listArtifactsByCampaign(campaign.id);
    expect(artifacts).toHaveLength(1);
    const artifact = artifacts[0];
    expect(artifact?.name).toBe('Kael');
    expect(artifact?.kind).toBe('npc');
    expect(artifact?.moduleId).toBe(module.id);
    expect(artifact?.tags).toContain('module:Ember Crypt');
    // The batches are the entity chain's own dock jobs — no image/map work.
    expect(enqueueImageJobs).not.toHaveBeenCalled();
    expect(enqueueEncounterMaps).not.toHaveBeenCalled();
    // One honest completion signal.
    expect(toastSuccessMock).toHaveBeenCalledWith(
      expect.stringContaining('1 artifact generated'),
    );
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 30_000);

  it('enqueues image jobs for resolved entities of the configured kinds (no image yet)', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id, {
      autoGenerateKinds: [],
      autoImageKinds: ['npc'],
    });
    await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Kael',
      summary: '',
      body: '',
      data: npcData,
    });
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });

    await runModulePostGeneration(module.id, campaign);

    expect(enqueueImageJobs).toHaveBeenCalledTimes(1);
    expect(enqueueImageJobs).toHaveBeenCalledWith([
      { campaignId: campaign.id, moduleId: module.id, name: 'Kael' },
    ]);
    expect(chatMock).not.toHaveBeenCalled();
  }, 30_000);

  it('skips entities that already have an image', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id, {
      autoGenerateKinds: [],
      autoImageKinds: ['npc'],
    });
    const imageId = '00000000-0000-4000-8000-00000000a001';
    await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Kael',
      summary: '',
      body: '',
      coverImageId: imageId,
      data: npcData,
    });
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });

    await runModulePostGeneration(module.id, campaign);

    expect(enqueueImageJobs).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
  }, 30_000);

  it('skips image automation loudly when image generation is disabled', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id, {
      autoGenerateKinds: [],
      autoImageKinds: ['npc'],
    });
    await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Kael',
      summary: '',
      body: '',
      data: npcData,
    });
    // defaultSettings has imagesEnabled: false.

    await runModulePostGeneration(module.id, campaign);

    expect(enqueueImageJobs).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Auto image generation skipped — image generation is disabled in Settings',
    );
  }, 30_000);

  it('enqueues battlemap jobs for module encounters without a map', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id, {
      autoGenerateKinds: [],
      autoGenerateBattlemaps: true,
    });
    const encounter = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'encounter',
      name: 'Ash Gate',
      summary: '',
      body: '',
      data: {
        difficulty: 'medium',
        levelHint: '3',
        monsters: [],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout: null,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      },
    });
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });

    await runModulePostGeneration(module.id, campaign);

    expect(enqueueEncounterMaps).toHaveBeenCalledWith([
      { campaignId: campaign.id, moduleId: module.id, artifactId: encounter.id, name: 'Ash Gate' },
    ]);
  }, 30_000);

  it('enqueues mob portraits for module-owned encounters when configured', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id, {
      autoGenerateKinds: [],
      autoGenerateMobImages: true,
    });
    const encounter = await seedEncounter(campaign.id, module.id, [rulebookEntry()]);
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });
    enqueueMobPortraits.mockResolvedValue({ enqueued: 2, alreadyImaged: [] });

    await runModulePostGeneration(module.id, campaign);

    // The batch entry is called per encounter with the encounter itself.
    expect(enqueueMobPortraits).toHaveBeenCalledTimes(1);
    expect(enqueueMobPortraits.mock.calls[0]?.[0]).toMatchObject({
      id: encounter.id,
      kind: 'encounter',
    });
    expect(enqueueMobPortraits.mock.calls[0]?.[1]).toBe(campaign.id);
    expect(toastSuccessMock).toHaveBeenCalledWith(
      expect.stringContaining('2 mob portraits queued'),
    );
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 30_000);

  it('skips encounters whose cited mobs are all already imaged', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id, {
      autoGenerateKinds: [],
      autoGenerateMobImages: true,
    });
    // Campaign-level mob artifact (mobArtifacts are not module-owned) that
    // the encounter's roster entry already points at, cover included.
    const mob = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Goblin',
      summary: '',
      body: '',
      coverImageId: '00000000-0000-4000-8000-00000000a001',
      data: npcData,
    });
    await seedEncounter(campaign.id, module.id, [rulebookEntry(mob.id)]);
    await seedEncounter(campaign.id, module.id, [rulebookEntry()], 'Flooded Stair');
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });
    enqueueMobPortraits.mockResolvedValue({ enqueued: 1, alreadyImaged: [] });

    await runModulePostGeneration(module.id, campaign);

    expect(enqueueMobPortraits).toHaveBeenCalledTimes(1);
    expect(enqueueMobPortraits.mock.calls[0]?.[0]).toMatchObject({ name: 'Flooded Stair' });
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 30_000);

  it('skips mob portrait automation loudly when image generation is disabled', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id, {
      autoGenerateKinds: [],
      autoGenerateMobImages: true,
    });
    await seedEncounter(campaign.id, module.id, [rulebookEntry()]);
    // defaultSettings has imagesEnabled: false.

    await runModulePostGeneration(module.id, campaign);

    expect(enqueueMobPortraits).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Auto mob portrait generation skipped — image generation is disabled in Settings',
    );
  }, 30_000);

  it('keeps enqueueing portraits when one encounter fails loudly', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id, {
      autoGenerateKinds: [],
      autoGenerateMobImages: true,
    });
    await seedEncounter(campaign.id, module.id, [rulebookEntry()]);
    await seedEncounter(campaign.id, module.id, [rulebookEntry()], 'Flooded Stair');
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });
    // Sync implementation: the throw still rejects the awaited call, the
    // plain return still satisfies it — no fake await needed.
    enqueueMobPortraits.mockImplementation((encounter: { name: string }) => {
      if (encounter.name === 'Ash Gate') {
        throw new Error('the mob artifact no longer exists — regenerate the encounter');
      }
      return Promise.resolve({ enqueued: 1, alreadyImaged: [] });
    });

    await runModulePostGeneration(module.id, campaign);

    // The failed encounter never stops the remaining automation.
    expect(enqueueMobPortraits).toHaveBeenCalledTimes(2);
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    const failureToast = toastErrorMock.mock.calls[0]?.[0];
    expect(failureToast).toContain('1 of 2 encounters failed to enqueue mob portraits');
    expect(failureToast).toContain('"Ash Gate"');
    expect(toastSuccessMock).toHaveBeenCalledWith(
      expect.stringContaining('1 mob portrait queued'),
    );
  }, 30_000);

  it('skips the portrait step silently-free when no encounter roster cites rulebook creatures', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id, {
      autoGenerateKinds: [],
      autoGenerateMobImages: true,
    });
    await seedEncounter(campaign.id, module.id, []);
    await saveSettings({ ...defaultSettings(), imagesEnabled: false });

    await runModulePostGeneration(module.id, campaign);

    // Nothing to enqueue and nothing skipped: no false "disabled" toast.
    expect(enqueueMobPortraits).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
  }, 30_000);

  it('skips entity batches when the name-normalization pass has not succeeded', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id, { entityNamesNormalized: false });

    await runModulePostGeneration(module.id, campaign);

    expect(chatMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
  }, 30_000);

  it('is a no-op when nothing is configured', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id, {
      autoGenerateKinds: [],
      autoImageKinds: [],
      autoGenerateBattlemaps: false,
      autoGenerateMobImages: false,
    });

    await runModulePostGeneration(module.id, campaign);

    expect(chatMock).not.toHaveBeenCalled();
    expect(enqueueImageJobs).not.toHaveBeenCalled();
    expect(enqueueEncounterMaps).not.toHaveBeenCalled();
    expect(enqueueMobPortraits).not.toHaveBeenCalled();
  }, 30_000);

  it('is a no-op while the module is still generating', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id, { status: 'generating' });

    await runModulePostGeneration(module.id, campaign);

    expect(chatMock).not.toHaveBeenCalled();
    expect(enqueueImageJobs).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  }, 30_000);
});
