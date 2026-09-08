import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAnyArtifact, listRevisions, updateArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createImage, getImage } from '@/db/imageRepo';
import { getOrCreateMobArtifact } from '@/db/mobArtifacts';
import { getMobPortraitCacheEntry } from '@/db/mobPortraitCache';
import { createRulebook } from '@/db/rulebookRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { updateSettings } from '@/db/settingsRepo';
import { newId, ruleChunkSchema, stampNewEntity, statBlockSchema } from '@/domain';
import {
  enqueueSingleMobPortrait,
  regenerateSingleMobPortrait,
  useMobPortraitQueue,
} from '@/features/campaign/mob-portrait-queue';
import { __clearPendingMobPortraitGenerationsForTests } from '@/features/campaign/mob-portrait-cache-queue';
import { sha256Hex } from '@/lib/hash';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';

/**
 * Single-mob portrait entry points (battle surface selection card, docs/11 D5):
 * the SAME queue and the SAME regen phases as the editor batch, for ONE
 * already-resolved token → mob artifact target — no second pipeline, no
 * second replace path. Delete-after-replace (preservation rule): the old
 * cover survives until the fresh cover commits; failures and dropped queues
 * keep it intact with loud errors.
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
const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

const GOBLIN_TEXT = 'Goblin Boss, humanoid, agile commander. HP 21, AC 17.';

function blobOf(text: string): Blob {
  return new Blob([text], { type: 'image/png' });
}

let campaignId = '';
let generationCount = 0;

async function seedCreatureChunk(creatureName: string, text: string): Promise<string> {
  const book = await createRulebook({ title: 'Bestiary', system: 'dnd5e', filename: 'bestiary.pdf' });
  await putChunks([
    ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: book.id,
      pageStart: 12,
      pageEnd: 12,
      chunkType: 'statblock',
      headingPath: [creatureName],
      text,
      statBlock: statBlockSchema.parse({
        system: 'dnd5e',
        level: '2',
        size: 'Large',
        creatureType: 'giant',
        ac: 11,
        acNote: '',
        hp: 59,
        hpFormula: '7d10 + 21',
        speed: '40 ft.',
        abilities: { str: 20, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
        saves: '',
        skills: '',
        senses: 'darkvision 60 ft.',
        languages: 'Common, Giant',
        traits: [],
        actions: [],
        reactions: [],
        legendary: [],
        extras: {},
      }),
      contentHash: await sha256Hex(text),
    }),
  ]);
  const { db } = await import('@/db/db');
  const chunk = await db.chunks.where('bookId').equals(book.id).first();
  if (chunk === undefined) throw new Error('chunk missing');
  return chunk.id;
}

async function attachUploadedCover(artifactId: string): Promise<string> {
  const existing = await createImage({
    campaignId,
    blob: blobOf('old-cover'),
    mimeType: 'image/png',
    width: 10,
    height: 10,
    source: 'uploaded',
  });
  await updateArtifact(artifactId, { imageIds: [existing.id], coverImageId: existing.id });
  return existing.id;
}

async function bytesText(imageId: string): Promise<string | null> {
  const stored = await getImage(imageId);
  if (stored === undefined) return null;
  return new TextDecoder().decode(stored.bytes);
}

/** How many of the artifact's revision snapshots still pin `imageId` —
 * the restore path the preservation rule protects. */
async function snapshotRefs(artifactId: string, imageId: string): Promise<number> {
  const revisions = await listRevisions(artifactId);
  return revisions.filter((revision) => {
    const snapshot = revision.snapshot as { coverImageId?: string | null; imageIds?: string[] };
    return snapshot.coverImageId === imageId || (snapshot.imageIds ?? []).includes(imageId);
  }).length;
}

/** Hangs the NEXT fresh generation until released (abort still rejects, so
 * `cancelAll` withdraws it silently) — deterministic while-queued pins. */
function hangGeneration(releaseBytes: string): { release: () => void } {
  let release!: () => void;
  generateImagesMock.mockImplementationOnce((_prompt, _count, opts) => {
    const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
    return new Promise((resolve, reject) => {
      if (signal === undefined) {
        reject(new Error('no abort signal passed'));
        return;
      }
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
      release = () => {
        resolve({
          images: [blobOf(releaseBytes)],
          costUsd: 0.01,
          cappedToOne: false,
          modelUsed: 'test-image-model',
          fallback: null,
          filteredCount: 0,
        });
      };
    });
  });
  return {
    release: () => {
      release();
    },
  };
}

beforeEach(async () => {
  await clearDatabase();
  await seedBuiltInPersonas();
  await updateSettings({ imagesEnabled: true, imageModel: 'test-image-model' });
  chatMock.mockReset();
  generateImagesMock.mockReset();
  intakeImageMock.mockReset();
  toastErrorMock.mockReset();
  __clearPendingMobPortraitGenerationsForTests();
  useMobPortraitQueue.getState().reset();
  useProgressStore.getState().reset();
  generationCount = 0;
  generateImagesMock.mockImplementation(() => {
    generationCount += 1;
    return Promise.resolve({
      images: [blobOf(`gen-${String(generationCount)}`)],
      costUsd: 0.01,
      cappedToOne: false,
      modelUsed: 'test-image-model',
      fallback: null,
      filteredCount: 0,
    });
  });
  intakeImageMock.mockImplementation((blob: Blob) =>
    Promise.resolve({
      blob,
      mimeType: 'image/webp',
      width: 320,
      height: 240,
    }),
  );
  campaignId = (await createCampaign({ name: 'Single mob portrait', system: 'dnd5e' })).id;
});

describe('enqueueSingleMobPortrait', () => {
  it('enqueues one chunk-grounded job; the worker lands the cover on the artifact', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const artifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'Goblin Boss');

    enqueueSingleMobPortrait({ campaignId, artifactId, chunkId, name: 'Goblin Boss' });

    await waitFor(async () => {
      expect((await getAnyArtifact(artifactId))?.coverImageId).not.toBeNull();
    });
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(chatMock).not.toHaveBeenCalled();
    expect(await bytesText((await getAnyArtifact(artifactId))?.coverImageId ?? '')).toBe('gen-1');
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
  });

  it('dedupes against an identical in-flight job (same artifact-keyed dock entry)', () => {
    enqueueSingleMobPortrait({ campaignId, artifactId: newId(), chunkId: newId(), name: 'Kept' });
    expect(useMobPortraitQueue.getState().queued).toHaveLength(1);
  });

  it('throws loud on an empty citing name instead of enqueueing a nameless job', () => {
    expect(() => {
      enqueueSingleMobPortrait({ campaignId, artifactId: newId(), chunkId: newId(), name: '   ' });
    }).toThrow(/citing name is empty/);
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
  });
});

describe('regenerateSingleMobPortrait', () => {
  it('regenerates a canonical cover delete-after-replace: fresh slot bytes, old cover live until the force-clone commits', async () => {
    const chunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    const artifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'Ogre');
    // Populate the slot + cover through the normal canonical flow first.
    enqueueSingleMobPortrait({ campaignId, artifactId, chunkId, name: 'Ogre' });
    await waitFor(async () => {
      expect((await getAnyArtifact(artifactId))?.coverImageId).not.toBeNull();
    });
    const slotBefore = await getMobPortraitCacheEntry(chunkId);
    if (slotBefore === undefined) throw new Error('slot missing');
    const oldCover = (await getAnyArtifact(artifactId))?.coverImageId ?? '';
    expect(await bytesText(oldCover)).toBe('gen-1');

    // Serialize the pump behind a blocker: the regen's force-clone commits
    // no generation, so only a blocker gates the while-queued pins.
    await updateSettings({ maxParallelRequests: 1 });
    const blocker = hangGeneration('blocker-bytes');
    const decoyChunkId = await seedCreatureChunk('Decoy Drake', 'Decoy Drake, scaly. HP 10, AC 10.');
    const decoyArtifactId = await getOrCreateMobArtifact(campaignId, decoyChunkId, 'Decoy Drake');
    enqueueSingleMobPortrait({ campaignId, artifactId: decoyArtifactId, chunkId: decoyChunkId, name: 'Decoy Drake' });
    await waitFor(() => {
      expect(useMobPortraitQueue.getState().active).toHaveLength(1);
    });

    const result = await regenerateSingleMobPortrait({ campaignId, artifactId, chunkId, name: 'Ogre' });
    expect(result).toEqual({ regenerated: true, republishedCanonical: true });
    // Fresh bytes were spent (no-op re-clone would have generated nothing).
    expect(generateImagesMock).toHaveBeenCalledTimes(3);
    expect(chatMock).not.toHaveBeenCalled();
    // The slot now points at a fresh row; the superseded slot blob is freed.
    const slotAfter = await getMobPortraitCacheEntry(chunkId);
    expect(slotAfter?.imageId).not.toBe(slotBefore.imageId);
    expect(await bytesText(slotAfter?.imageId ?? '')).toBe('gen-2');
    expect(await getImage(slotBefore.imageId)).toBeUndefined();
    // …while the old LOCAL cover is still live behind the blocker.
    expect((await getAnyArtifact(artifactId))?.coverImageId).toBe(oldCover);
    expect(await bytesText(oldCover)).toBe('gen-1');
    expect(await snapshotRefs(artifactId, oldCover)).toBeGreaterThan(0);
    expect(useMobPortraitQueue.getState().queued).toHaveLength(1);

    blocker.release();
    // The regen force-clones the NEW slot bytes over the old cover; only
    // then is the superseded local blob freed.
    await waitFor(async () => {
      const cover = (await getAnyArtifact(artifactId))?.coverImageId;
      expect(cover).not.toBeNull();
      expect(cover).not.toBe(oldCover);
    });
    const cover = (await getAnyArtifact(artifactId))?.coverImageId ?? '';
    expect(await bytesText(cover)).toBe('gen-2');
    expect(await getImage(oldCover)).toBeUndefined();
    expect(await snapshotRefs(artifactId, oldCover)).toBe(0);
  });

  it('regenerates a flavored cover locally: old cover live until the fresh cover commits, cache untouched', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const artifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'sickly goblin boss');
    const oldCoverId = await attachUploadedCover(artifactId);
    // Hang the worker's fresh generation for deterministic while-queued pins.
    const hung = hangGeneration('gen-1');

    const result = await regenerateSingleMobPortrait({
      campaignId,
      artifactId,
      chunkId,
      name: 'sickly goblin boss',
    });
    expect(result).toEqual({ regenerated: true, republishedCanonical: false });
    expect((await getAnyArtifact(artifactId))?.coverImageId).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe('old-cover');
    expect(await snapshotRefs(artifactId, oldCoverId)).toBeGreaterThan(0);
    const hungState = useMobPortraitQueue.getState();
    expect(hungState.queued.length + hungState.active.length).toBe(1);
    // The worker is inside the hung generation — now let it commit.
    await waitFor(() => {
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
    });

    hung.release();
    await waitFor(async () => {
      const cover = (await getAnyArtifact(artifactId))?.coverImageId;
      expect(cover).not.toBeNull();
      expect(cover).not.toBe(oldCoverId);
    });
    expect(await bytesText((await getAnyArtifact(artifactId))?.coverImageId ?? '')).toBe('gen-1');
    expect(await getImage(oldCoverId)).toBeUndefined();
    expect(await snapshotRefs(artifactId, oldCoverId)).toBe(0);
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(chatMock).not.toHaveBeenCalled();
    expect(await getMobPortraitCacheEntry(chunkId)).toBeUndefined();
  });

  it('a failed single fresh generation keeps the old cover: loud error, blob + snapshot pins intact', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const artifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'sickly goblin boss');
    const oldCoverId = await attachUploadedCover(artifactId);
    generateImagesMock.mockRejectedValueOnce(new Error('model exploded'));

    const result = await regenerateSingleMobPortrait({
      campaignId,
      artifactId,
      chunkId,
      name: 'sickly goblin boss',
    });
    expect(result).toEqual({ regenerated: true, republishedCanonical: false });

    await waitFor(() => {
      expect(useMobPortraitQueue.getState().failed).toHaveLength(1);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Could not generate a portrait for "sickly goblin boss"',
      expect.any(Error),
    );
    expect((await getAnyArtifact(artifactId))?.coverImageId).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe('old-cover');
    expect(await snapshotRefs(artifactId, oldCoverId)).toBeGreaterThan(0);
  });

  it('a failed canonical republish throws loud BEFORE enqueueing — the old cover stays', async () => {
    const chunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    const artifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'Ogre');
    const oldCoverId = await attachUploadedCover(artifactId);
    generateImagesMock.mockRejectedValueOnce(new Error('slot generation exploded'));

    await expect(
      regenerateSingleMobPortrait({ campaignId, artifactId, chunkId, name: 'Ogre' }),
    ).rejects.toThrow('slot generation exploded');
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    expect((await getAnyArtifact(artifactId))?.coverImageId).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe('old-cover');
    expect(await snapshotRefs(artifactId, oldCoverId)).toBeGreaterThan(0);
    expect(await getMobPortraitCacheEntry(chunkId)).toBeUndefined();
  });

  it('a dropped single queue keeps the old cover', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const artifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'sickly goblin boss');
    const oldCoverId = await attachUploadedCover(artifactId);
    hangGeneration('gen-never');

    const result = await regenerateSingleMobPortrait({
      campaignId,
      artifactId,
      chunkId,
      name: 'sickly goblin boss',
    });
    expect(result).toEqual({ regenerated: true, republishedCanonical: false });
    await waitFor(() => {
      expect(useMobPortraitQueue.getState().active).toHaveLength(1);
    });
    await useMobPortraitQueue.getState().cancelAll();

    expect(toastErrorMock).not.toHaveBeenCalled();
    expect((await getAnyArtifact(artifactId))?.coverImageId).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe('old-cover');
    expect(await snapshotRefs(artifactId, oldCoverId)).toBeGreaterThan(0);
  });

  it('reports unregenerated (no detach, no job) when the cover already landed elsewhere', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const artifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'Goblin Boss');

    const result = await regenerateSingleMobPortrait({ campaignId, artifactId, chunkId, name: 'Goblin Boss' });
    expect(result).toEqual({ regenerated: false, republishedCanonical: false });
    expect(generateImagesMock).not.toHaveBeenCalled();
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
  });

  it('throws loud with covers intact when the artifact is gone', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    await expect(
      regenerateSingleMobPortrait({ campaignId, artifactId: newId(), chunkId, name: 'Goblin Boss' }),
    ).rejects.toThrow(/no longer exists/);
    expect(generateImagesMock).not.toHaveBeenCalled();
  });

  it('throws loud with the old cover intact when the chunk is unreadable', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const artifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'Goblin Boss');
    const oldCoverId = await attachUploadedCover(artifactId);

    await expect(
      regenerateSingleMobPortrait({ campaignId, artifactId, chunkId: newId(), name: 'Goblin Boss' }),
    ).rejects.toThrow(/stat-block chunk.*no longer exists/);
    expect((await getAnyArtifact(artifactId))?.coverImageId).toBe(oldCoverId);
    expect(generateImagesMock).not.toHaveBeenCalled();
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
  });
});
