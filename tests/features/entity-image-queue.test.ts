import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, listArtifactsByCampaign, updateArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createImage, getImage } from '@/db/imageRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { updateSettings } from '@/db/settingsRepo';
import { newId, type Id } from '@/domain';
import { useEntityImageQueue } from '@/features/modules/entity-image-queue';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';

/**
 * Entity image queue (08-MODULE-DESIGNER M4-C): background generation for the
 * panel's image checkboxes — real Dexie rows, LLM/image entry points mocked.
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

const PROMPT_DRAFT = {
  prompt: 'A weathered gate warden at dusk',
  negative: 'text, watermark',
  styleNotes: 'moody ink wash',
};

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
  useEntityImageQueue.setState({ queued: [], active: null });
  useProgressStore.getState().reset();
  chatMock.mockResolvedValue({ text: JSON.stringify(PROMPT_DRAFT), modelUsed: 'test-model', fallback: null });
  generateImagesMock.mockResolvedValue({ images: [blobOf('gen')], costUsd: 0.01, cappedToOne: false });
  intakeImageMock.mockResolvedValue({
    blob: blobOf('intake'),
    mimeType: 'image/webp',
    width: 320,
    height: 240,
  });
});

describe('entity image queue', () => {
  it('generates one image per queued entity and attaches it as the cover', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const campaignId = campaign.id;
    const moduleId = newId();
    await createArtifact({ campaignId, kind: 'npc', name: 'Kael' });
    await createArtifact({ campaignId, kind: 'npc', name: 'Bram' });

    useEntityImageQueue.getState().enqueue([
      { campaignId, moduleId, name: 'Kael' },
      { campaignId, moduleId, name: 'Bram' },
    ]);

    await waitFor(async () => {
      const artifacts = await listArtifactsByCampaign(campaignId);
      const kael = artifacts.find((artifact) => artifact.name === 'Kael');
      const bram = artifacts.find((artifact) => artifact.name === 'Bram');
      expect(kael?.imageIds).toHaveLength(1);
      expect(kael?.coverImageId).toBe(kael?.imageIds[0] ?? null);
      expect(bram?.imageIds).toHaveLength(1);
    });

    expect(generateImagesMock).toHaveBeenCalledTimes(2);
    expect(chatMock).toHaveBeenCalledTimes(2);
    // The final prompt folds style + negative guidance in.
    expect(generateImagesMock.mock.calls[0]?.[0]).toContain('moody ink wash');
    expect(generateImagesMock.mock.calls[0]?.[0]).toContain('Avoid: text, watermark');

    // The stored row records provenance…
    const kael = (await listArtifactsByCampaign(campaignId)).find((a) => a.name === 'Kael');
    const stored = await getImage(kael?.imageIds[0] ?? '');
    expect(stored?.source).toBe('generated');
    expect(stored?.model).toBe('test-image-model');
    expect(stored?.prompt).toContain('gate warden');
    // …the queue drains, and the dock job finishes.
    expect(useEntityImageQueue.getState().queued).toHaveLength(0);
    expect(useEntityImageQueue.getState().active).toBeNull();
    expect(
      useProgressStore.getState().jobs.find((job) => job.id === `module-entity-images-${moduleId}`),
    ).toBeUndefined();
  });

  it('skips entities that already have an image, fails loud without an artifact, keeps going', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const campaignId = campaign.id;
    const moduleId = newId();
    await createArtifact({ campaignId, kind: 'npc', name: 'Kael' });
    const bram = await createArtifact({ campaignId, kind: 'npc', name: 'Bram' });
    const existing = await createImage({
      campaignId,
      blob: blobOf('old'),
      mimeType: 'image/png',
      width: 10,
      height: 10,
      source: 'uploaded',
    });
    await updateArtifact(bram.id, { imageIds: [existing.id], coverImageId: existing.id });

    useEntityImageQueue.getState().enqueue([
      { campaignId, moduleId, name: 'Bram' },
      { campaignId, moduleId, name: 'Kael' },
      { campaignId, moduleId, name: 'Ghost' },
    ]);

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });
    await waitFor(async () => {
      const kael = (await listArtifactsByCampaign(campaignId)).find((a) => a.name === 'Kael');
      expect(kael?.imageIds).toHaveLength(1);
    });

    // Bram was skipped (already had an image); only Kael generated.
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    const call = toastErrorMock.mock.calls[0];
    expect(call?.[0]).toBe('Could not generate an image for "Ghost"');
    expect((call?.[1] as Error).message).toContain('no artifact exists');
    // The queue drains despite the failure.
    expect(useEntityImageQueue.getState().queued).toHaveLength(0);
    expect(useEntityImageQueue.getState().active).toBeNull();
  });

  it('dequeue aborts the active job silently and drops pending ones', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const campaignId: Id = campaign.id;
    const moduleId = newId();
    await createArtifact({ campaignId, kind: 'npc', name: 'Kael' });
    await createArtifact({ campaignId, kind: 'npc', name: 'Mira' });

    // Hold Kael's prompt draft until the test releases it — the job is
    // ACTIVE (abortable) while Mira is still pending.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    chatMock.mockImplementationOnce((_messages, opts) => {
      const signal = opts.signal;
      if (signal === undefined) return Promise.reject(new Error('no abort signal passed'));
      return new Promise((resolve, reject) => {
        const abort = (): void => {
          reject(new DOMException('Aborted', 'AbortError'));
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener('abort', abort);
        void gate.then(() => {
          signal.removeEventListener('abort', abort);
          if (signal.aborted) {
            abort();
            return;
          }
          resolve({ text: JSON.stringify(PROMPT_DRAFT), modelUsed: 'test-model', fallback: null });
        });
      });
    });

    useEntityImageQueue.getState().enqueue([
      { campaignId, moduleId, name: 'Kael' },
      { campaignId, moduleId, name: 'Mira' },
    ]);
    await waitFor(() => {
      expect(useEntityImageQueue.getState().active?.name).toBe('Kael');
    });

    // Dequeue the ACTIVE job (abort) and the PENDING one (drop).
    useEntityImageQueue.getState().dequeue({ campaignId, moduleId, name: 'Kael' });
    useEntityImageQueue.getState().dequeue({ campaignId, moduleId, name: 'Mira' });
    release();

    await waitFor(() => {
      expect(useEntityImageQueue.getState().active).toBeNull();
    });
    expect(generateImagesMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
    const artifacts = await listArtifactsByCampaign(campaignId);
    expect(artifacts.find((a) => a.name === 'Kael')?.imageIds).toHaveLength(0);
    expect(artifacts.find((a) => a.name === 'Mira')?.imageIds).toHaveLength(0);
    expect(useProgressStore.getState().jobs).toHaveLength(0);
  });

  it('uses game system prefix and appearance directly without calling LLM chat when entity has appearance', async () => {
    const campaign = await createCampaign({ name: 'Golarion', system: 'pathfinder2e' });
    const campaignId = campaign.id;
    const moduleId = newId();
    await createArtifact({
      campaignId,
      kind: 'npc',
      name: 'Seoni',
      data: {
        appearance: 'Varisian sorceress with blue robes and tattoos',
        personality: 'Enigmatic',
        statBlock: null,
      },
    });

    useEntityImageQueue.getState().enqueue([
      { campaignId, moduleId, name: 'Seoni' },
    ]);

    await waitFor(async () => {
      const artifacts = await listArtifactsByCampaign(campaignId);
      const seoni = artifacts.find((artifact) => artifact.name === 'Seoni');
      expect(seoni?.imageIds).toHaveLength(1);
    });

    expect(generateImagesMock).toHaveBeenCalledWith(
      'Pathfinder 2e=>Varisian sorceress with blue robes and tattoos',
      1,
      expect.anything(),
    );
    expect(chatMock).not.toHaveBeenCalled();
  });
});
