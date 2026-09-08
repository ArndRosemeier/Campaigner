import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAnyArtifact, updateArtifact } from '@/db/artifactRepo';
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
 * second detach path.
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

beforeEach(async () => {
  await clearDatabase();
  await seedBuiltInPersonas();
  await updateSettings({ imagesEnabled: true, imageModel: 'test-image-model' });
  chatMock.mockReset();
  generateImagesMock.mockReset();
  intakeImageMock.mockReset();
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
  it('regenerates a canonical cover: fresh slot bytes first, old cover freed, new cover cloned', async () => {
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

    const result = await regenerateSingleMobPortrait({ campaignId, artifactId, chunkId, name: 'Ogre' });
    expect(result).toEqual({ regenerated: true, republishedCanonical: true });
    // Fresh bytes were spent (no-op re-clone would have generated nothing).
    expect(generateImagesMock).toHaveBeenCalledTimes(2);
    expect(chatMock).not.toHaveBeenCalled();
    // The slot now points at a fresh row; both superseded blobs are freed.
    const slotAfter = await getMobPortraitCacheEntry(chunkId);
    expect(slotAfter?.imageId).not.toBe(slotBefore.imageId);
    expect(await bytesText(slotAfter?.imageId ?? '')).toBe('gen-2');
    expect(await getImage(slotBefore.imageId)).toBeUndefined();
    expect(await getImage(oldCover)).toBeUndefined();

    // The re-enqueue clones the NEW slot bytes into the cover.
    await waitFor(async () => {
      expect((await getAnyArtifact(artifactId))?.coverImageId).not.toBeNull();
    });
    const cover = (await getAnyArtifact(artifactId))?.coverImageId ?? '';
    expect(cover).not.toBe(oldCover);
    expect(await bytesText(cover)).toBe('gen-2');
  });

  it('regenerates a flavored cover locally: never reads, populates, or overwrites the cache', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const artifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'sickly goblin boss');
    const oldCoverId = await attachUploadedCover(artifactId);

    const result = await regenerateSingleMobPortrait({
      campaignId,
      artifactId,
      chunkId,
      name: 'sickly goblin boss',
    });
    expect(result).toEqual({ regenerated: true, republishedCanonical: false });
    expect(await getImage(oldCoverId)).toBeUndefined();
    expect((await getAnyArtifact(artifactId))?.coverImageId).toBeNull();

    await waitFor(async () => {
      expect((await getAnyArtifact(artifactId))?.coverImageId).not.toBeNull();
    });
    expect(await bytesText((await getAnyArtifact(artifactId))?.coverImageId ?? '')).toBe('gen-1');
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(chatMock).not.toHaveBeenCalled();
    expect(await getMobPortraitCacheEntry(chunkId)).toBeUndefined();
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
