import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { createImage } from '@/db/imageRepo';
import { createModule as saveModuleRow, getModule } from '@/db/moduleRepo';
import { updateCampaign } from '@/db/campaignRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { updateSettings } from '@/db/settingsRepo';
import { createModule, newId, type Id } from '@/domain';
import {
  attachCover,
  enqueueCampaignCover,
  enqueueModuleCover,
  regenerateCampaignCover,
  regenerateModuleCover,
  useCoverImageQueue,
} from '@/features/covers/cover-image-queue';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';

/**
 * Module/campaign cover queue (cover-generation arc): unattended generation
 * for the cover slots — real Dexie rows, LLM/image entry points mocked.
 * The prompt draft is deterministic (buildImagePrompt): the openrouter chat
 * mock must stay silent through every queue path. Regen is
 * delete-after-replace: the old cover survives until the fresh one commits.
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
vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { generateImages } = await import('@/llm/imageGen');
const generateImagesMock = vi.mocked(generateImages);
const { intakeImage } = await import('@/lib/imageIntake');
const intakeImageMock = vi.mocked(intakeImage);
const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

function blobOf(text: string): Blob {
  return new Blob([text], { type: 'image/png' });
}

beforeEach(async () => {
  await clearDatabase();
  await seedBuiltInPersonas();
  await updateSettings({ imagesEnabled: true, imageModel: 'test-image-model' });
  chatMock.mockReset();
  generateImagesMock.mockReset();
  intakeImageMock.mockReset();
  toastErrorMock.mockReset();
  useCoverImageQueue.getState().reset();
  useProgressStore.getState().reset();
  generateImagesMock.mockResolvedValue({ images: [blobOf('gen')], costUsd: 0.01, cappedToOne: false, modelUsed: 'test-image-model', fallback: null, filteredCount: 0 });
  intakeImageMock.mockResolvedValue({
    blob: blobOf('intake'),
    mimeType: 'image/webp',
    width: 320,
    height: 240,
  });
});

async function seedModule(campaignId: Id, title = 'Vault of Whispers'): Promise<Id> {
  const module = await saveModuleRow(
    createModule({
      campaignId,
      title,
      concept: 'A whispering vault under the mill.',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'standard',
    }),
  );
  return module.id;
}

describe('cover image queue', () => {
  it('generates a module cover grounded in title/concept, lands the slot, anchors to the campaign', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const moduleId = await seedModule(campaign.id);

    enqueueModuleCover(moduleId, campaign.id, 'Vault of Whispers');

    await waitFor(async () => {
      const module = await getModule(moduleId);
      expect(module?.coverImageId).not.toBeNull();
    });

    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    // n=1: the queue only ever asks for one image.
    expect(generateImagesMock.mock.calls[0]?.[1]).toBe(1);
    expect(chatMock).not.toHaveBeenCalled();
    const prompt = generateImagesMock.mock.calls[0]?.[0] ?? '';
    expect(prompt).toContain('Vault of Whispers');
    expect(prompt).toContain('whispering vault');

    const module = await getModule(moduleId);
    const { getImage } = await import('@/db/imageRepo');
    const stored = await getImage(module?.coverImageId ?? '');
    expect(stored?.campaignId).toBe(campaign.id);
    expect(stored?.source).toBe('generated');
    expect(stored?.model).toBe('test-image-model');
    // The queue drains and the dock job finishes.
    expect(useCoverImageQueue.getState().queued).toHaveLength(0);
    expect(useCoverImageQueue.getState().active).toEqual([]);
    expect(
      useProgressStore.getState().jobs.find((job) => job.id === `module-cover-${moduleId}`),
    ).toBeUndefined();
  });

  it('generates a campaign cover grounded in name/description', async () => {
    const campaign = await createCampaign({
      name: 'Ember',
      description: 'A city of ash and bells.',
      system: 'dnd5e',
    });

    enqueueCampaignCover(campaign.id, campaign.name);

    await waitFor(async () => {
      const { getCampaign } = await import('@/db/campaignRepo');
      expect((await getCampaign(campaign.id))?.coverImageId).not.toBeNull();
    });

    const prompt = generateImagesMock.mock.calls[0]?.[0] ?? '';
    expect(prompt).toContain('Ember');
    expect(prompt).toContain('ash and bells');
    const { getCampaign } = await import('@/db/campaignRepo');
    const updated = await getCampaign(campaign.id);
    const { getImage } = await import('@/db/imageRepo');
    const stored = await getImage(updated?.coverImageId ?? '');
    expect(stored?.campaignId).toBe(campaign.id);
  });

  it('skips imaged slots and dedupes concurrent same-slot jobs', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const moduleId = await seedModule(campaign.id);

    // Two identical jobs in one batch collapse to one generation.
    useCoverImageQueue.getState().enqueue([
      { kind: 'module', campaignId: campaign.id, moduleId, name: 'Vault of Whispers' },
      { kind: 'module', campaignId: campaign.id, moduleId, name: 'Vault of Whispers' },
    ]);

    await waitFor(async () => {
      expect((await getModule(moduleId))?.coverImageId).not.toBeNull();
    });
    expect(generateImagesMock).toHaveBeenCalledTimes(1);

    // A later job against the now-imaged slot skips without generating.
    generateImagesMock.mockClear();
    enqueueModuleCover(moduleId, campaign.id, 'Vault of Whispers');
    await waitFor(() => {
      expect(useCoverImageQueue.getState().queued).toHaveLength(0);
      expect(useCoverImageQueue.getState().active).toEqual([]);
    });
    expect(generateImagesMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('regen replaces the slot delete-after-replace and prunes the old blob', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const moduleId = await seedModule(campaign.id);
    enqueueModuleCover(moduleId, campaign.id, 'Vault of Whispers');
    await waitFor(async () => {
      expect((await getModule(moduleId))?.coverImageId).not.toBeNull();
    });
    const oldCover = (await getModule(moduleId))?.coverImageId ?? '';
    generateImagesMock.mockClear();
    generateImagesMock.mockResolvedValue({ images: [blobOf('gen-2')], costUsd: 0.01, cappedToOne: false, modelUsed: 'test-image-model', fallback: null, filteredCount: 0 });

    regenerateModuleCover(moduleId, campaign.id, 'Vault of Whispers');

    await waitFor(async () => {
      expect((await getModule(moduleId))?.coverImageId).not.toBe(oldCover);
    });
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    const { getImage } = await import('@/db/imageRepo');
    // The superseded blob is freed only after the fresh cover committed.
    expect(await getImage(oldCover)).toBeUndefined();
    expect((await getModule(moduleId))?.coverImageId).not.toBeNull();
  });

  it('a failed regen keeps the old cover and fails loud', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const moduleId = await seedModule(campaign.id);
    enqueueModuleCover(moduleId, campaign.id, 'Vault of Whispers');
    await waitFor(async () => {
      expect((await getModule(moduleId))?.coverImageId).not.toBeNull();
    });
    const oldCover = (await getModule(moduleId))?.coverImageId ?? '';
    generateImagesMock.mockRejectedValueOnce(new Error('model exploded'));

    regenerateModuleCover(moduleId, campaign.id, 'Vault of Whispers');

    await waitFor(() => {
      expect(useCoverImageQueue.getState().failed).toHaveLength(1);
    });
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock.mock.calls[0]?.[0]).toMatch(/Vault of Whispers/);
    // The old cover — blob and slot — is intact.
    expect((await getModule(moduleId))?.coverImageId).toBe(oldCover);
    const { getImage } = await import('@/db/imageRepo');
    expect(await getImage(oldCover)).toBeDefined();
  });

  it('fails loud when the slot was deleted while queued', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const moduleId = await seedModule(campaign.id);
    const { deleteModule } = await import('@/db/moduleRepo');
    await deleteModule(moduleId, 'keep');

    enqueueModuleCover(moduleId, campaign.id, 'Vault of Whispers');

    await waitFor(() => {
      expect(useCoverImageQueue.getState().failed).toHaveLength(1);
    });
    expect(generateImagesMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
  });

  it('refuses empty grounding instead of generating a blank cover', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    // No concept, no spine, no parts: nothing to ground the prompt.
    const empty = await saveModuleRow(
      createModule({
        campaignId: campaign.id,
        title: 'Blank',
        concept: '',
        levelMin: 1,
        levelMax: 1,
        sizeDial: 'sketch',
      }),
    );
    enqueueModuleCover(empty.id, campaign.id, 'Blank');
    // A campaign without a description has no grounding either.
    const nodesc = await createCampaign({ name: 'Nodesc', system: 'dnd5e' });
    enqueueCampaignCover(nodesc.id, nodesc.name);

    await waitFor(() => {
      expect(useCoverImageQueue.getState().failed).toHaveLength(2);
    });
    expect(generateImagesMock).not.toHaveBeenCalled();
    expect((await getModule(empty.id))?.coverImageId).toBeNull();
  });

  it('fails loud when image generation is disabled', async () => {
    await updateSettings({ imagesEnabled: false });
    const campaign = await createCampaign({
      name: 'Ember',
      description: 'A city of ash.',
      system: 'dnd5e',
    });
    enqueueCampaignCover(campaign.id, campaign.name);

    await waitFor(() => {
      expect(useCoverImageQueue.getState().failed).toHaveLength(1);
    });
    expect(generateImagesMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
  });

  it('campaign regen replaces the slot and prunes the old blob', async () => {
    const campaign = await createCampaign({
      name: 'Ember',
      description: 'A city of ash.',
      system: 'dnd5e',
    });
    enqueueCampaignCover(campaign.id, campaign.name);
    const { getCampaign } = await import('@/db/campaignRepo');
    await waitFor(async () => {
      expect((await getCampaign(campaign.id))?.coverImageId).not.toBeNull();
    });
    const oldCover = (await getCampaign(campaign.id))?.coverImageId ?? '';
    generateImagesMock.mockClear();

    regenerateCampaignCover(campaign.id, campaign.name);

    await waitFor(async () => {
      expect((await getCampaign(campaign.id))?.coverImageId).not.toBe(oldCover);
    });
    const { getImage } = await import('@/db/imageRepo');
    expect(await getImage(oldCover)).toBeUndefined();
  });

  it('the writer refuses a missing row loudly (no dangling cover)', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const image = await createImage({
      campaignId: campaign.id,
      blob: blobOf('orphan'),
      mimeType: 'image/png',
      width: 10,
      height: 10,
      prompt: '',
      model: '',
      source: 'uploaded',
    });
    const missingModule = newId();
    await expect(
      attachCover({ kind: 'module', campaignId: campaign.id, moduleId: missingModule, name: 'Gone' }, image),
    ).rejects.toThrow();
    await expect(
      attachCover({ kind: 'campaign', campaignId: newId(), name: 'Gone' }, image),
    ).rejects.toThrow();
    // The orphaned blob is untouched by the refusal (the next prune owns it).
    const { getImage } = await import('@/db/imageRepo');
    expect(await getImage(image.id)).toBeDefined();
  });

  it('updating a campaign cover through the writer lands the slot', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const image = await createImage({
      campaignId: campaign.id,
      blob: blobOf('cover'),
      mimeType: 'image/png',
      width: 10,
      height: 10,
      prompt: '',
      model: '',
      source: 'uploaded',
    });
    await attachCover({ kind: 'campaign', campaignId: campaign.id, name: campaign.name }, image);
    const { getCampaign } = await import('@/db/campaignRepo');
    expect((await getCampaign(campaign.id))?.coverImageId).toBe(image.id);
    // The repo patch path carries the same loud check.
    await expect(updateCampaign(newId(), { coverImageId: image.id })).rejects.toThrow();
  });
});
