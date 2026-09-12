import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { creatureCoverImageId, setCreatureCover } from '@/db/creatureRepo';
import { createImage, getImage } from '@/db/imageRepo';
import { getMobPortraitCacheEntry } from '@/db/mobPortraitCache';
import { createRulebook } from '@/db/rulebookRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { updateSettings } from '@/db/settingsRepo';
import { libraryCreatureKey, newId, ruleChunkSchema, stampNewEntity, statBlockSchema } from '@/domain';
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
 * Single-creature portrait entry points (battle surface selection card,
 * docs/11 D5 amendment): the SAME queue and the SAME regen phases as the editor
 * batch, for ONE already-resolved token → CREATURE IDENTITY target — no second
 * pipeline, no second replace path. Delete-after-replace (preservation rule):
 * the old portrait survives until the fresh one commits; failures and dropped
 * queues keep it intact with loud errors.
 *
 * REWRITTEN for the ratified model (ledger row 106): the old fixture created a
 * hidden `npc` artifact per creature and asserted on THAT artifact's cover plus
 * its revision snapshots. Under the model the portrait is this campaign's
 * presentation row for the creature identity (`db/creatureImages`), and there
 * are no revisions to snapshot — so preservation is now pinned the way the seam
 * actually guarantees it: the superseded BLOB stays readable (still pinned)
 * while the replacement is in flight, and is freed exactly when the fresh
 * portrait commits. Strictly stronger: it reads the real invariant rather than
 * a revision that happened to name it.
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

/** The identity of the creature a cited chunk IS (the citing name is flavor
 * only — identity is the citation). */
function creatureKeyForChunk(chunkId: string, _citingName: string): string {
  return libraryCreatureKey(chunkId);
}

/** Seats an uploaded portrait on the campaign's presentation row for one
 * creature identity — the ONE way a creature carries art, with no artifact in
 * sight (docs/11 D5 amendment, D6). */
async function attachUploadedCover(creatureKey: string): Promise<string> {
  const existing = await createImage({
    campaignId,
    blob: blobOf('old-cover'),
    mimeType: 'image/png',
    width: 10,
    height: 10,
    source: 'uploaded',
  });
  await setCreatureCover({ campaignId, creatureKey, imageId: existing.id });
  return existing.id;
}

/** The creature's CURRENT portrait image id, read through the ONE identity
 * seam (`null` when it has no art). */
function portraitId(creatureKey: string): Promise<string | null> {
  return creatureCoverImageId({ campaignId, creatureKey });
}

async function bytesText(imageId: string): Promise<string | null> {
  const stored = await getImage(imageId);
  if (stored === undefined) return null;
  return new TextDecoder().decode(stored.bytes);
}

/** True while the given blob is still on disk — the presentation-tier stand-in
 * for the old revision-snapshot pin: the superseded portrait's bytes stay
 * referenced (readable) until the replacement commits, then are freed. */
async function blobLive(imageId: string): Promise<boolean> {
  return (await getImage(imageId)) !== undefined;
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
    const creatureKey = creatureKeyForChunk(chunkId, 'Goblin Boss');

    enqueueSingleMobPortrait({ campaignId, creatureKey, chunkId, name: 'Goblin Boss' });

    await waitFor(async () => {
      expect(await portraitId(creatureKey)).not.toBeNull();
    });
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(chatMock).not.toHaveBeenCalled();
    expect(await bytesText((await portraitId(creatureKey)) ?? '')).toBe('gen-1');
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
  });

  it('dedupes against an identical in-flight job (same artifact-keyed dock entry)', () => {
    enqueueSingleMobPortrait({ campaignId, creatureKey: `chunk:${newId()}`, chunkId: newId(), name: 'Kept' });
    expect(useMobPortraitQueue.getState().queued).toHaveLength(1);
  });

  it('throws loud on an empty citing name instead of enqueueing a nameless job', () => {
    expect(() => {
      enqueueSingleMobPortrait({ campaignId, creatureKey: `chunk:${newId()}`, chunkId: newId(), name: '   ' });
    }).toThrow(/citing name is empty/);
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
  });
});

describe('regenerateSingleMobPortrait', () => {
  it('regenerates a canonical cover delete-after-replace: fresh slot bytes, old cover live until the force-clone commits', async () => {
    const chunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    const creatureKey = creatureKeyForChunk(chunkId, 'Ogre');
    // Populate the slot + cover through the normal canonical flow first.
    enqueueSingleMobPortrait({ campaignId, creatureKey, chunkId, name: 'Ogre' });
    await waitFor(async () => {
      expect(await portraitId(creatureKey)).not.toBeNull();
    });
    const slotBefore = await getMobPortraitCacheEntry(creatureKey);
    if (slotBefore === undefined) throw new Error('slot missing');
    const oldCover = (await portraitId(creatureKey)) ?? '';
    expect(await bytesText(oldCover)).toBe('gen-1');

    // Serialize the pump behind a blocker: the regen's force-clone commits
    // no generation, so only a blocker gates the while-queued pins.
    await updateSettings({ maxParallelRequests: 1 });
    const blocker = hangGeneration('blocker-bytes');
    const decoyChunkId = await seedCreatureChunk('Decoy Drake', 'Decoy Drake, scaly. HP 10, AC 10.');
    const decoyKey = creatureKeyForChunk(decoyChunkId, 'Decoy Drake');
    enqueueSingleMobPortrait({ campaignId, creatureKey: decoyKey, chunkId: decoyChunkId, name: 'Decoy Drake' });
    await waitFor(() => {
      expect(useMobPortraitQueue.getState().active).toHaveLength(1);
    });

    const result = await regenerateSingleMobPortrait({ campaignId, creatureKey, chunkId, name: 'Ogre' });
    expect(result).toEqual({ regenerated: true, republishedCanonical: true });
    // Fresh bytes were spent (no-op re-clone would have generated nothing).
    expect(generateImagesMock).toHaveBeenCalledTimes(3);
    expect(chatMock).not.toHaveBeenCalled();
    // The slot now points at a fresh row; the superseded slot blob is freed.
    const slotAfter = await getMobPortraitCacheEntry(creatureKey);
    expect(slotAfter?.imageId).not.toBe(slotBefore.imageId);
    expect(await bytesText(slotAfter?.imageId ?? '')).toBe('gen-2');
    expect(await getImage(slotBefore.imageId)).toBeUndefined();
    // …while the old LOCAL cover is still live behind the blocker.
    expect(await portraitId(creatureKey)).toBe(oldCover);
    expect(await bytesText(oldCover)).toBe('gen-1');
    expect(await blobLive(oldCover)).toBe(true);
    expect(useMobPortraitQueue.getState().queued).toHaveLength(1);

    blocker.release();
    // The regen force-clones the NEW slot bytes over the old cover; only
    // then is the superseded local blob freed.
    await waitFor(async () => {
      const cover = await portraitId(creatureKey);
      expect(cover).not.toBeNull();
      expect(cover).not.toBe(oldCover);
    });
    const cover = (await portraitId(creatureKey)) ?? '';
    expect(await bytesText(cover)).toBe('gen-2');
    expect(await getImage(oldCover)).toBeUndefined();
    expect(await blobLive(oldCover)).toBe(false);
  });

  it('regenerates a flavored cover locally: old cover live until the fresh cover commits, cache untouched', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const creatureKey = creatureKeyForChunk(chunkId, 'sickly goblin boss');
    const oldCoverId = await attachUploadedCover(creatureKey);
    // Hang the worker's fresh generation for deterministic while-queued pins.
    const hung = hangGeneration('gen-1');

    const result = await regenerateSingleMobPortrait({
      campaignId,
      creatureKey,
      chunkId,
      name: 'sickly goblin boss',
    });
    expect(result).toEqual({ regenerated: true, republishedCanonical: false });
    expect(await portraitId(creatureKey)).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe('old-cover');
    expect(await blobLive(oldCoverId)).toBe(true);
    const hungState = useMobPortraitQueue.getState();
    expect(hungState.queued.length + hungState.active.length).toBe(1);
    // The worker is inside the hung generation — now let it commit.
    await waitFor(() => {
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
    });

    hung.release();
    await waitFor(async () => {
      const cover = await portraitId(creatureKey);
      expect(cover).not.toBeNull();
      expect(cover).not.toBe(oldCoverId);
    });
    expect(await bytesText((await portraitId(creatureKey)) ?? '')).toBe('gen-1');
    expect(await getImage(oldCoverId)).toBeUndefined();
    expect(await blobLive(oldCoverId)).toBe(false);
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(chatMock).not.toHaveBeenCalled();
    expect(await getMobPortraitCacheEntry(creatureKey)).toBeUndefined();
  });

  it('a failed single fresh generation keeps the old cover: loud error, blob + snapshot pins intact', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const creatureKey = creatureKeyForChunk(chunkId, 'sickly goblin boss');
    const oldCoverId = await attachUploadedCover(creatureKey);
    generateImagesMock.mockRejectedValueOnce(new Error('model exploded'));

    const result = await regenerateSingleMobPortrait({
      campaignId,
      creatureKey,
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
    expect(await portraitId(creatureKey)).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe('old-cover');
    expect(await blobLive(oldCoverId)).toBe(true);
  });

  it('a failed canonical republish throws loud BEFORE enqueueing — the old cover stays', async () => {
    const chunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    const creatureKey = creatureKeyForChunk(chunkId, 'Ogre');
    const oldCoverId = await attachUploadedCover(creatureKey);
    generateImagesMock.mockRejectedValueOnce(new Error('slot generation exploded'));

    await expect(
      regenerateSingleMobPortrait({ campaignId, creatureKey, chunkId, name: 'Ogre' }),
    ).rejects.toThrow('slot generation exploded');
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    expect(await portraitId(creatureKey)).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe('old-cover');
    expect(await blobLive(oldCoverId)).toBe(true);
    expect(await getMobPortraitCacheEntry(creatureKey)).toBeUndefined();
  });

  it('a dropped single queue keeps the old cover', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const creatureKey = creatureKeyForChunk(chunkId, 'sickly goblin boss');
    const oldCoverId = await attachUploadedCover(creatureKey);
    hangGeneration('gen-never');

    const result = await regenerateSingleMobPortrait({
      campaignId,
      creatureKey,
      chunkId,
      name: 'sickly goblin boss',
    });
    expect(result).toEqual({ regenerated: true, republishedCanonical: false });
    await waitFor(() => {
      expect(useMobPortraitQueue.getState().active).toHaveLength(1);
    });
    await useMobPortraitQueue.getState().cancelAll();

    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(await portraitId(creatureKey)).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe('old-cover');
    expect(await blobLive(oldCoverId)).toBe(true);
  });

  it('reports unregenerated (no detach, no job) when the cover already landed elsewhere', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const creatureKey = creatureKeyForChunk(chunkId, 'Goblin Boss');

    const result = await regenerateSingleMobPortrait({ campaignId, creatureKey, chunkId, name: 'Goblin Boss' });
    expect(result).toEqual({ regenerated: false, republishedCanonical: false });
    expect(generateImagesMock).not.toHaveBeenCalled();
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
  });

  it('reports no regeneration for a creature identity that holds no portrait (nothing to detach)', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const result = await regenerateSingleMobPortrait({
      campaignId,
      creatureKey: libraryCreatureKey(chunkId),
      chunkId,
      name: 'Goblin Boss',
    });
    expect(result).toEqual({ regenerated: false, republishedCanonical: false });
    expect(generateImagesMock).not.toHaveBeenCalled();
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
  });

  it('throws loud, changing nothing, on an empty creature identity', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    await expect(
      regenerateSingleMobPortrait({ campaignId, creatureKey: '   ', chunkId, name: 'Goblin Boss' }),
    ).rejects.toThrow(/creature identity is empty/);
    expect(generateImagesMock).not.toHaveBeenCalled();
  });

  it('throws loud with the old cover intact when the chunk is unreadable', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const creatureKey = creatureKeyForChunk(chunkId, 'Goblin Boss');
    const oldCoverId = await attachUploadedCover(creatureKey);

    await expect(
      regenerateSingleMobPortrait({ campaignId, creatureKey, chunkId: newId(), name: 'Goblin Boss' }),
    ).rejects.toThrow(/stat-block chunk.*no longer exists/);
    expect(await portraitId(creatureKey)).toBe(oldCoverId);
    expect(generateImagesMock).not.toHaveBeenCalled();
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
  });
});
