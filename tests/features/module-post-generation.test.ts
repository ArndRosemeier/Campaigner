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

// The automation hands its results to the two background queues — replaced
// with spies so the pumps never run inside this test.
const { enqueueImageJobs, enqueueEncounterMaps } = vi.hoisted(() => ({
  enqueueImageJobs: vi.fn(),
  enqueueEncounterMaps: vi.fn(),
}));

vi.mock('@/features/modules/entity-image-queue', () => ({
  useEntityImageQueue: { getState: () => ({ enqueue: enqueueImageJobs }) },
}));

vi.mock('@/features/modules/encounter-map-queue', () => ({
  useEncounterMapQueue: { getState: () => ({ enqueue: enqueueEncounterMaps }) },
}));

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
    entityKinds: [{ name: 'Kael', kind: 'npc', absorbed: [] }],
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
      .mockResolvedValueOnce(JSON.stringify(npcDraft))
      .mockResolvedValueOnce(JSON.stringify(npcStatblock));

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
      },
    });
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });

    await runModulePostGeneration(module.id, campaign);

    expect(enqueueEncounterMaps).toHaveBeenCalledWith([
      { campaignId: campaign.id, moduleId: module.id, artifactId: encounter.id, name: 'Ash Gate' },
    ]);
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
    });

    await runModulePostGeneration(module.id, campaign);

    expect(chatMock).not.toHaveBeenCalled();
    expect(enqueueImageJobs).not.toHaveBeenCalled();
    expect(enqueueEncounterMaps).not.toHaveBeenCalled();
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
