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
 * The prompt draft is deterministic (buildImagePrompt): the openrouter chat
 * mock must stay silent through every queue path.
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
  useEntityImageQueue.getState().reset();
  useProgressStore.getState().reset();
  generateImagesMock.mockResolvedValue({ images: [blobOf('gen')], costUsd: 0.01, cappedToOne: false, modelUsed: 'test-image-model', fallback: null, filteredCount: 0 });
  intakeImageMock.mockResolvedValue({
    blob: blobOf('intake'),
    mimeType: 'image/webp',
    width: 320,
    height: 240,
  });
});

describe('entity image queue', () => {
  it('generates one image per queued entity, grounded in the artifact text, attached as the cover', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const campaignId = campaign.id;
    const moduleId = newId();
    await createArtifact({ campaignId, kind: 'npc', name: 'Kael', summary: 'Ember\u2019s gate warden.' });
    await createArtifact({ campaignId, kind: 'npc', name: 'Bram', summary: 'A quiet farrier.' });

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
    // Headline pin (owner amendment): NO prompt-draft chat call — the prompt
    // is built deterministically from the artifact's own data.
    expect(chatMock).not.toHaveBeenCalled();
    expect(generateImagesMock.mock.calls[0]?.[0]).toContain('Kael (npc)');
    expect(generateImagesMock.mock.calls[0]?.[0]).toContain('Summary: Ember\u2019s gate warden.');

    // The stored row records provenance…
    const kael = (await listArtifactsByCampaign(campaignId)).find((a) => a.name === 'Kael');
    const stored = await getImage(kael?.imageIds[0] ?? '');
    expect(stored?.source).toBe('generated');
    expect(stored?.model).toBe('test-image-model');
    expect(stored?.prompt).toContain('gate warden');
    // …the queue drains, and the dock job finishes.
    expect(useEntityImageQueue.getState().queued).toHaveLength(0);
    expect(useEntityImageQueue.getState().active).toEqual([]);
    expect(
      useProgressStore.getState().jobs.find((job) => job.id === `module-entity-images-${moduleId}`),
    ).toBeUndefined();
  });

  it('skips entities that already have an image, fails loud without an artifact, keeps going', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const campaignId = campaign.id;
    const moduleId = newId();
    await createArtifact({ campaignId, kind: 'npc', name: 'Kael', summary: 'Ember\u2019s gate warden.' });
    const bram = await createArtifact({ campaignId, kind: 'npc', name: 'Bram', summary: 'A quiet farrier.' });
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
    expect(useEntityImageQueue.getState().active).toEqual([]);
  });

  it('dequeue aborts in-flight jobs silently and drops pending ones', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const campaignId: Id = campaign.id;
    const moduleId = newId();
    await createArtifact({ campaignId, kind: 'npc', name: 'Kael', summary: 'Ember\u2019s gate warden.' });
    await createArtifact({ campaignId, kind: 'npc', name: 'Mira', summary: 'A tide-watcher.' });
    await createArtifact({ campaignId, kind: 'npc', name: 'Ruth', summary: 'A net-mender.' });

    // Hold every image call until the test releases it — with the default
    // parallel limit of 2 both slots fill, and the third job stays pending.
    // (The prompt draft is deterministic and instant; the abort gate lives on
    // the image API call, which carries the job's abort signal.)
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    generateImagesMock.mockImplementation((_prompt, _n, opts) => {
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
          resolve({ images: [blobOf('gen')], costUsd: 0.01, cappedToOne: false, modelUsed: 'test-image-model', fallback: null, filteredCount: 0 });
        });
      });
    });

    useEntityImageQueue.getState().enqueue([
      { campaignId, moduleId, name: 'Kael' },
      { campaignId, moduleId, name: 'Mira' },
      { campaignId, moduleId, name: 'Ruth' },
    ]);
    await waitFor(() => {
      expect(useEntityImageQueue.getState().active).toHaveLength(2);
    });
    expect(useEntityImageQueue.getState().queued.some((job) => job.name === 'Ruth')).toBe(true);

    // Dequeue the two IN-FLIGHT jobs (abort) and the PENDING one (drop).
    useEntityImageQueue.getState().dequeue({ campaignId, moduleId, name: 'Kael' });
    useEntityImageQueue.getState().dequeue({ campaignId, moduleId, name: 'Mira' });
    useEntityImageQueue.getState().dequeue({ campaignId, moduleId, name: 'Ruth' });
    release();

    await waitFor(() => {
      expect(useEntityImageQueue.getState().active).toEqual([]);
    });
    expect(useEntityImageQueue.getState().queued).toEqual([]);
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

    // The appearance shortcut wins AND carries the default-on text-render
    // guard (the negative reaches the final prompt on both builder
    // branches).
    const finalPrompt = generateImagesMock.mock.calls[0]?.[0] ?? '';
    expect(finalPrompt).toContain(
      'Pathfinder 2e=>Varisian sorceress with blue robes and tattoos',
    );
    expect(finalPrompt).toContain('Avoid: text, letters, numbers');
    expect(finalPrompt).toContain('speech bubbles');
    expect(generateImagesMock.mock.calls[0]?.[1]).toBe(1);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('dedupes concurrent same-name jobs (createJobQueue invariant) — one job, one image', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const campaignId = campaign.id;
    const moduleId = newId();
    await createArtifact({ campaignId, kind: 'npc', name: 'Kael', summary: 'Ember\u2019s gate warden.' });

    // The entity panel's checkbox could tick twice in quick succession
    // (double click, rapid re-render): the pre-factory queue enqueued both,
    // generated a double image and silently overwrote the cover.
    useEntityImageQueue.getState().enqueue([{ campaignId, moduleId, name: 'Kael' }]);
    useEntityImageQueue.getState().enqueue([{ campaignId, moduleId, name: 'Kael' }]);
    expect(useEntityImageQueue.getState().queued).toHaveLength(1);

    await waitFor(async () => {
      const kael = (await listArtifactsByCampaign(campaignId)).find((a) => a.name === 'Kael');
      expect(kael?.imageIds).toHaveLength(1);
    });
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(useEntityImageQueue.getState().queued).toHaveLength(0);
    expect(useEntityImageQueue.getState().active).toEqual([]);
    expect(useEntityImageQueue.getState().failed).toEqual([]);
  });

  it('cancelAll aborts the in-flight image job and withdraws the queued one silently (stop-all seam)', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const campaignId = campaign.id;
    const moduleId = newId();
    await createArtifact({ campaignId, kind: 'npc', name: 'Kael', summary: 'Ember\u2019s gate warden.' });
    await createArtifact({ campaignId, kind: 'npc', name: 'Bram', summary: 'A quiet farrier.' });
    // Serial pump: Kael in flight (held on the image call's abort signal),
    // Bram still queued.
    await updateSettings({ maxParallelRequests: 1 });
    generateImagesMock.mockImplementation((_prompt, _count, opts) => {
      const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
      if (signal === undefined) return Promise.reject(new Error('no abort signal passed'));
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    useEntityImageQueue.getState().enqueue([
      { campaignId, moduleId, name: 'Kael' },
      { campaignId, moduleId, name: 'Bram' },
    ]);
    await waitFor(() => {
      expect(useEntityImageQueue.getState().active).toHaveLength(1);
      expect(useEntityImageQueue.getState().queued).toHaveLength(1);
    });

    const withdrawn = await useEntityImageQueue.getState().cancelAll();
    expect(withdrawn).toBe(2);
    expect(useEntityImageQueue.getState().active).toEqual([]);
    expect(useEntityImageQueue.getState().queued).toEqual([]);
    expect(useEntityImageQueue.getState().failed).toEqual([]);
    expect(useProgressStore.getState().jobs).toEqual([]);
    // Silent + non-destructive: no failure toast, no image attached.
    expect(toastErrorMock).not.toHaveBeenCalled();
    const kael = (await listArtifactsByCampaign(campaignId)).find((a) => a.name === 'Kael');
    expect(kael?.coverImageId).toBeNull();
  });
});
