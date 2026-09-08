import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getAnyArtifact, listRevisions, updateArtifact } from '@/db/artifactRepo';
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
  enqueueInventedCreaturePortraits,
  enqueueMobPortraits,
  regenerateInventedCreaturePortraits,
  regenerateMobPortraits,
  useMobPortraitQueue,
} from '@/features/campaign/mob-portrait-queue';
import { __clearPendingMobPortraitGenerationsForTests } from '@/features/campaign/mob-portrait-cache-queue';
import { sha256Hex } from '@/lib/hash';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';

/**
 * Portrait regeneration (owner-ordered, docs/11 D5 amendment + preservation
 * rule): delete-after-replace — regen entries enqueue fresh-generation jobs
 * WITHOUT detaching first; the old cover (blob + snapshot pins) survives
 * until the worker commits the replacement, and only the superseded blob is
 * freed. Canonical slots are republished with FRESH bytes first (a plain
 * re-enqueue would clone identical bytes); flavored and invented covers
 * regenerate locally only. The prompt draft stays deterministic (no chat
 * call) on every regen path.
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

function oozeBlock() {
  return statBlockSchema.parse({
    system: 'dnd5e',
    level: '2',
    size: 'Medium',
    creatureType: 'ooze',
    ac: 8,
    acNote: '',
    hp: 45,
    hpFormula: '6d10 + 12',
    speed: '20 ft.',
    abilities: { str: 14, dex: 6, con: 16, int: 1, wis: 6, cha: 1 },
    saves: '',
    skills: '',
    senses: 'blindsight 60 ft.',
    languages: '',
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
  });
}

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

async function addEncounter(monsters: { name: string; count: number; source: Record<string, unknown> }[]) {
  return createArtifact({
    campaignId,
    kind: 'encounter',
    name: 'Goblin warren',
    data: {
      difficulty: 'medium',
      levelHint: '1',
      monsters: monsters.map((monster) => ({
        name: monster.name,
        count: monster.count,
        notes: '',
        source: monster.source,
      })) as never,
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

async function attachUploadedCover(artifactId: string, campaign: string): Promise<string> {
  const existing = await createImage({
    campaignId: campaign,
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

/** How many of the artifact's revision snapshots still pin `imageId`
 * (cover or gallery) — the restore path the preservation rule protects. */
async function snapshotRefs(artifactId: string, imageId: string): Promise<number> {
  const revisions = await listRevisions(artifactId);
  return revisions.filter((revision) => {
    const snapshot = revision.snapshot as { coverImageId?: string | null; imageIds?: string[] };
    return snapshot.coverImageId === imageId || (snapshot.imageIds ?? []).includes(imageId);
  }).length;
}

/** Hangs the NEXT fresh generation until released (abort still rejects, so
 * `cancelAll` withdraws it silently). Lets a test pin the while-queued
 * preservation state deterministically: the worker cannot commit while hung.
 * Resolves with `releaseBytes` so byte assertions stay exact. */
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
  // Distinct bytes per generation: fresh-byte assertions compare stored bytes.
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
  // Echo intake: stored bytes identify the generation that produced them.
  intakeImageMock.mockImplementation((blob: Blob) =>
    Promise.resolve({
      blob,
      mimeType: 'image/webp',
      width: 320,
      height: 240,
    }),
  );
  campaignId = (await createCampaign({ name: 'Mob portraits', system: 'dnd5e' })).id;
});

describe('regenerateMobPortraits (rulebook)', () => {
  it('regenerates a flavored cover locally: old cover survives until the fresh cover commits, only the superseded blob is freed', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const artifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'sickly goblin boss');
    const oldCoverId = await attachUploadedCover(artifactId, campaignId);
    const encounter = await addEncounter([
      {
        name: 'sickly goblin boss',
        count: 1,
        source: { type: 'rulebook', chunkId, mobArtifactId: artifactId },
      },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    // Hang the worker's fresh generation: the while-queued pins below are
    // deterministic (the replacement cannot commit before the release).
    const hung = hangGeneration('gen-1');

    const result = await regenerateMobPortraits(encounter, campaignId);
    expect(result).toEqual({ regenerated: 1, republishedCanonical: [] });
    // Delete-after-replace: NOTHING is stripped synchronously — the old
    // cover, its blob, and its snapshot pins are all intact while the regen
    // job is queued (a dropped queue loses nothing).
    expect((await getAnyArtifact(artifactId))?.coverImageId).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe('old-cover');
    expect(await snapshotRefs(artifactId, oldCoverId)).toBeGreaterThan(0);
    // The regen job is queued or already picked up — but cannot have
    // finished while its generation is hung.
    const state = useMobPortraitQueue.getState();
    expect(state.queued.length + state.active.length).toBe(1);
    // The worker is inside the hung generation (its mock call assigned the
    // releaser above) — now let it commit.
    await waitFor(() => {
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
    });

    hung.release();
    await waitFor(async () => {
      expect((await getAnyArtifact(artifactId))?.coverImageId).not.toBeNull();
      expect((await getAnyArtifact(artifactId))?.coverImageId).not.toBe(oldCoverId);
    });
    const mob = await getAnyArtifact(artifactId);
    expect(await bytesText(mob?.coverImageId ?? '')).toBe('gen-1');
    // The success path frees ONLY the superseded blob — and only after the
    // fresh cover committed (its snapshot pins are scrubbed with the swap).
    expect(await getImage(oldCoverId)).toBeUndefined();
    expect(await snapshotRefs(artifactId, oldCoverId)).toBe(0);
    // One local generation, no chat call, and the global slot stays empty
    // (flavored citations never read, populate, or overwrite the cache).
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(chatMock).not.toHaveBeenCalled();
    expect(await getMobPortraitCacheEntry(chunkId)).toBeUndefined();
  });

  it('a failed fresh generation keeps the old cover: loud error, blob + snapshot pins intact', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const artifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'sickly goblin boss');
    const oldCoverId = await attachUploadedCover(artifactId, campaignId);
    const encounter = await addEncounter([
      {
        name: 'sickly goblin boss',
        count: 1,
        source: { type: 'rulebook', chunkId, mobArtifactId: artifactId },
      },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    generateImagesMock.mockRejectedValueOnce(new Error('model exploded'));

    const result = await regenerateMobPortraits(encounter, campaignId);
    expect(result).toEqual({ regenerated: 1, republishedCanonical: [] });

    // The worker fails LOUD on the queue's per-mob path (name + reason) and
    // lands on the retry list — while the old portrait is untouched.
    await waitFor(() => {
      expect(useMobPortraitQueue.getState().failed).toHaveLength(1);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Could not generate a portrait for "sickly goblin boss"',
      expect.any(Error),
    );
    expect((toastErrorMock.mock.calls[0]?.[1] as Error).message).toContain('model exploded');
    expect((await getAnyArtifact(artifactId))?.coverImageId).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe('old-cover');
    expect(await snapshotRefs(artifactId, oldCoverId)).toBeGreaterThan(0);
  });

  it('a queue dropped before the worker runs keeps the old cover', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const artifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'sickly goblin boss');
    const oldCoverId = await attachUploadedCover(artifactId, campaignId);
    const encounter = await addEncounter([
      {
        name: 'sickly goblin boss',
        count: 1,
        source: { type: 'rulebook', chunkId, mobArtifactId: artifactId },
      },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    // Hang the fresh generation on the abort signal (in-memory queue lost on
    // reload behaves the same: the job never commits).
    hangGeneration('gen-never');

    await regenerateMobPortraits(encounter, campaignId);
    await waitFor(() => {
      expect(useMobPortraitQueue.getState().active).toHaveLength(1);
    });
    await useMobPortraitQueue.getState().cancelAll();

    // Silent withdraw, old portrait intact — no error, no strip, no commit.
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect((await getAnyArtifact(artifactId))?.coverImageId).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe('old-cover');
    expect(await snapshotRefs(artifactId, oldCoverId)).toBeGreaterThan(0);
  });

  it('republishes a canonical slot with fresh bytes; other-campaign covers keep their cloned bytes', async () => {
    const chunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    const campaignB = (await createCampaign({ name: 'Second campaign', system: 'dnd5e' })).id;
    // Campaign B populates the slot through the normal canonical flow (one
    // generation, then a clone into its own cover).
    const artifactB = await getOrCreateMobArtifact(campaignB, chunkId, 'Ogre');
    const encounterB = await createArtifact({
      campaignId: campaignB,
      kind: 'encounter',
      name: 'Ogre den',
      data: {
        difficulty: 'medium',
        levelHint: '1',
        monsters: [{ name: 'Ogre', count: 1, notes: '', source: { type: 'rulebook', chunkId } }] as never,
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
    if (encounterB.kind !== 'encounter') throw new Error('not an encounter');
    await enqueueMobPortraits(encounterB, campaignB);
    await waitFor(async () => {
      expect((await getAnyArtifact(artifactB))?.coverImageId).not.toBeNull();
    });
    const slotBefore = await getMobPortraitCacheEntry(chunkId);
    if (slotBefore === undefined) throw new Error('slot missing');
    const coverB = (await getAnyArtifact(artifactB))?.coverImageId ?? '';
    expect(await bytesText(coverB)).toBe('gen-1');

    // Campaign A holds a clone of the same slot bytes.
    const artifactA = await getOrCreateMobArtifact(campaignId, chunkId, 'Ogre');
    const encounterA = await addEncounter([
      { name: 'Ogre', count: 1, source: { type: 'rulebook', chunkId, mobArtifactId: artifactA } },
    ]);
    if (encounterA.kind !== 'encounter') throw new Error('not an encounter');
    await enqueueMobPortraits(encounterA, campaignId);
    await waitFor(async () => {
      expect((await getAnyArtifact(artifactA))?.coverImageId).not.toBeNull();
    });
    const oldCoverA = (await getAnyArtifact(artifactA))?.coverImageId ?? '';
    expect(await bytesText(oldCoverA)).toBe('gen-1');

    // Serialize the pump behind a blocker job: the regen job cannot run
    // before the preservation pins below (its force-clone commits no image
    // generation, so nothing else gates it deterministically).
    await updateSettings({ maxParallelRequests: 1 });
    const blocker = hangGeneration('blocker-bytes');
    const decoyChunkId = await seedCreatureChunk('Decoy Drake', 'Decoy Drake, scaly. HP 10, AC 10.');
    const decoyArtifactId = await getOrCreateMobArtifact(campaignId, decoyChunkId, 'Decoy Drake');
    useMobPortraitQueue.getState().enqueue([
      {
        campaignId,
        encounterId: encounterA.id,
        artifactId: decoyArtifactId,
        name: 'Decoy Drake',
        chunkId: decoyChunkId,
      },
    ]);
    await waitFor(() => {
      expect(useMobPortraitQueue.getState().active).toHaveLength(1);
    });

    const result = await regenerateMobPortraits(encounterA, campaignId);
    expect(result).toEqual({ regenerated: 1, republishedCanonical: ['Ogre'] });
    // Fresh bytes were spent (no-op re-clone would have generated nothing).
    expect(generateImagesMock).toHaveBeenCalledTimes(3);
    expect(chatMock).not.toHaveBeenCalled();
    // The slot now points at a fresh row; the superseded global blob is gone.
    const slotAfter = await getMobPortraitCacheEntry(chunkId);
    expect(slotAfter?.imageId).not.toBe(slotBefore.imageId);
    expect(await getImage(slotBefore.imageId)).toBeUndefined();
    expect(await bytesText(slotAfter?.imageId ?? '')).toBe('gen-2');
    // Delete-after-replace: the old LOCAL cover is still live while the
    // regen job waits behind the blocker — blob and snapshot pins intact.
    expect((await getAnyArtifact(artifactA))?.coverImageId).toBe(oldCoverA);
    expect(await bytesText(oldCoverA)).toBe('gen-1');
    expect(await snapshotRefs(artifactA, oldCoverA)).toBeGreaterThan(0);
    expect(useMobPortraitQueue.getState().queued).toHaveLength(1);

    blocker.release();

    // The regen job force-clones the NEW slot bytes over the old cover.
    await waitFor(async () => {
      const cover = (await getAnyArtifact(artifactA))?.coverImageId;
      expect(cover).not.toBeNull();
      expect(cover).not.toBe(oldCoverA);
    });
    const coverA = (await getAnyArtifact(artifactA))?.coverImageId ?? '';
    expect(await bytesText(coverA)).toBe('gen-2');
    // Only now is the superseded local blob freed (snapshot pins scrubbed
    // with the swap).
    expect(await getImage(oldCoverA)).toBeUndefined();
    expect(await snapshotRefs(artifactA, oldCoverA)).toBe(0);

    // Other-campaign invariance: B's existing cover keeps its cloned bytes.
    expect((await getAnyArtifact(artifactB))?.coverImageId).toBe(coverB);
    expect(await bytesText(coverB)).toBe('gen-1');

    // Future clones render the new art.
    const campaignC = (await createCampaign({ name: 'Third campaign', system: 'dnd5e' })).id;
    const artifactC = await getOrCreateMobArtifact(campaignC, chunkId, 'Ogre', undefined, undefined, {
      fillCoverFromCache: true,
    });
    expect((await getAnyArtifact(artifactC))?.coverImageId).not.toBeNull();
    expect(await bytesText((await getAnyArtifact(artifactC))?.coverImageId ?? '')).toBe('gen-2');
  });

  it('a failed canonical republish throws loud BEFORE enqueueing — the old cover stays', async () => {
    const chunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    const artifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'Ogre');
    const oldCoverId = await attachUploadedCover(artifactId, campaignId);
    const encounter = await addEncounter([
      { name: 'Ogre', count: 1, source: { type: 'rulebook', chunkId, mobArtifactId: artifactId } },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    generateImagesMock.mockRejectedValueOnce(new Error('slot generation exploded'));

    await expect(regenerateMobPortraits(encounter, campaignId)).rejects.toThrow('slot generation exploded');
    // The fresh-bytes phase failed: no regen job was enqueued and the old
    // portrait — blob and snapshot pins — is intact.
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    expect((await getAnyArtifact(artifactId))?.coverImageId).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe('old-cover');
    expect(await snapshotRefs(artifactId, oldCoverId)).toBeGreaterThan(0);
    expect(await getMobPortraitCacheEntry(chunkId)).toBeUndefined();
  });

  it('fails loud with no side effects when the stat-block chunk is gone — the old cover stays', async () => {
    const missingChunkId = newId();
    const artifactId = await getOrCreateMobArtifact(campaignId, missingChunkId, 'Ghost Boss');
    const oldCoverId = await attachUploadedCover(artifactId, campaignId);
    const encounter = await addEncounter([
      {
        name: 'Ghost Boss',
        count: 1,
        source: { type: 'rulebook', chunkId: missingChunkId, mobArtifactId: artifactId },
      },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    await expect(regenerateMobPortraits(encounter, campaignId)).rejects.toThrow(
      'the stat-block chunk for "Ghost Boss" no longer exists',
    );
    expect(generateImagesMock).not.toHaveBeenCalled();
    expect((await getAnyArtifact(artifactId))?.coverImageId).toBe(oldCoverId);
    expect(await getImage(oldCoverId)).toBeDefined();
    expect(await snapshotRefs(artifactId, oldCoverId)).toBeGreaterThan(0);
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
  });

  it('skip-path regression: the normal batch never strips an imaged mob', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const artifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'Goblin Boss');
    const oldCoverId = await attachUploadedCover(artifactId, campaignId);
    const encounter = await addEncounter([
      {
        name: 'Goblin Boss',
        count: 1,
        source: { type: 'rulebook', chunkId, mobArtifactId: artifactId },
      },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    const result = await enqueueMobPortraits(encounter, campaignId);
    expect(result).toEqual({ enqueued: 0, alreadyImaged: ['Goblin Boss'] });
    expect((await getAnyArtifact(artifactId))?.coverImageId).toBe(oldCoverId);
    expect(await getImage(oldCoverId)).toBeDefined();
    expect(generateImagesMock).not.toHaveBeenCalled();
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
  });
});

describe('regenerateInventedCreaturePortraits', () => {
  it('replaces the invented cover delete-after-replace with fresh local bytes', async () => {
    const encounter = await addEncounter([{ name: 'Gloom Ooze', count: 1, source: { type: 'inline', statBlock: oozeBlock() } }]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    await enqueueInventedCreaturePortraits(encounter, campaignId);
    const { db } = await import('@/db/db');
    const created = await db.artifacts.where('name').equals('Gloom Ooze').first();
    if (created === undefined) throw new Error('creature missing');
    await waitFor(async () => {
      expect((await getAnyArtifact(created.id))?.coverImageId).not.toBeNull();
    });
    const oldCoverId = (await getAnyArtifact(created.id))?.coverImageId ?? '';
    expect(await bytesText(oldCoverId)).toBe('gen-1');
    // Hang the worker's fresh generation for deterministic while-queued pins.
    const hung = hangGeneration('gen-2');

    const result = await regenerateInventedCreaturePortraits(encounter, campaignId);
    expect(result).toEqual({ created: 1, regenerated: 1 });
    // Delete-after-replace: the old cover stays live until the worker
    // commits the fresh one (a dropped queue loses nothing).
    expect((await getAnyArtifact(created.id))?.coverImageId).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe('gen-1');
    expect(await snapshotRefs(created.id, oldCoverId)).toBeGreaterThan(0);
    const hungState = useMobPortraitQueue.getState();
    expect(hungState.queued.length + hungState.active.length).toBe(1);
    // The initial batch generation (gen-1) plus the hung regen call: the
    // worker is inside the hung generation — now let it commit.
    await waitFor(() => {
      expect(generateImagesMock).toHaveBeenCalledTimes(2);
    });

    hung.release();
    await waitFor(async () => {
      const cover = (await getAnyArtifact(created.id))?.coverImageId;
      expect(cover).not.toBeNull();
      expect(cover).not.toBe(oldCoverId);
    });
    const cover = (await getAnyArtifact(created.id))?.coverImageId ?? '';
    expect(await bytesText(cover)).toBe('gen-2');
    // Only the superseded blob is freed, after the fresh cover committed.
    expect(await getImage(oldCoverId)).toBeUndefined();
    expect(await snapshotRefs(created.id, oldCoverId)).toBe(0);
    expect(generateImagesMock).toHaveBeenCalledTimes(2);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('a failed invented generation keeps the old cover: loud error, blob + snapshot pins intact', async () => {
    const encounter = await addEncounter([{ name: 'Gloom Ooze', count: 1, source: { type: 'none' } }]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    await enqueueInventedCreaturePortraits(encounter, campaignId);
    const { db } = await import('@/db/db');
    const created = await db.artifacts.where('name').equals('Gloom Ooze').first();
    if (created === undefined) throw new Error('creature missing');
    await waitFor(async () => {
      expect((await getAnyArtifact(created.id))?.coverImageId).not.toBeNull();
    });
    const oldCoverId = (await getAnyArtifact(created.id))?.coverImageId ?? '';
    generateImagesMock.mockRejectedValueOnce(new Error('model exploded'));

    const result = await regenerateInventedCreaturePortraits(encounter, campaignId);
    expect(result).toEqual({ created: 1, regenerated: 1 });

    await waitFor(() => {
      expect(useMobPortraitQueue.getState().failed).toHaveLength(1);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Could not generate a portrait for "Gloom Ooze"',
      expect.any(Error),
    );
    expect((await getAnyArtifact(created.id))?.coverImageId).toBe(oldCoverId);
    expect(await getImage(oldCoverId)).toBeDefined();
    expect(await snapshotRefs(created.id, oldCoverId)).toBeGreaterThan(0);
  });

  it('a dropped invented queue keeps the old cover', async () => {
    const encounter = await addEncounter([{ name: 'Gloom Ooze', count: 1, source: { type: 'none' } }]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    await enqueueInventedCreaturePortraits(encounter, campaignId);
    const { db } = await import('@/db/db');
    const created = await db.artifacts.where('name').equals('Gloom Ooze').first();
    if (created === undefined) throw new Error('creature missing');
    await waitFor(async () => {
      expect((await getAnyArtifact(created.id))?.coverImageId).not.toBeNull();
    });
    const oldCoverId = (await getAnyArtifact(created.id))?.coverImageId ?? '';
    const oldBytes = await bytesText(oldCoverId);
    // Hang the fresh generation: the job never commits before the withdraw.
    hangGeneration('gen-never');

    await regenerateInventedCreaturePortraits(encounter, campaignId);
    await waitFor(() => {
      expect(useMobPortraitQueue.getState().active).toHaveLength(1);
    });
    await useMobPortraitQueue.getState().cancelAll();

    expect(toastErrorMock).not.toHaveBeenCalled();
    expect((await getAnyArtifact(created.id))?.coverImageId).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe(oldBytes);
    expect(await snapshotRefs(created.id, oldCoverId)).toBeGreaterThan(0);
  });

  it('per-entry regen touches only the selected entry', async () => {
    const encounter = await addEncounter([
      { name: 'Gloom Ooze', count: 1, source: { type: 'inline', statBlock: oozeBlock() } },
      { name: 'Whisper Wisp', count: 1, source: { type: 'none' } },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    await enqueueInventedCreaturePortraits(encounter, campaignId);
    const { db } = await import('@/db/db');
    const ooze = await db.artifacts.where('name').equals('Gloom Ooze').first();
    const wisp = await db.artifacts.where('name').equals('Whisper Wisp').first();
    if (ooze === undefined || wisp === undefined) throw new Error('creatures missing');
    await waitFor(async () => {
      expect((await getAnyArtifact(ooze.id))?.coverImageId).not.toBeNull();
      expect((await getAnyArtifact(wisp.id))?.coverImageId).not.toBeNull();
    });
    const oozeCover = (await getAnyArtifact(ooze.id))?.coverImageId ?? '';
    const wispCover = (await getAnyArtifact(wisp.id))?.coverImageId ?? '';
    // Hang the fresh generation so the while-queued pins are deterministic.
    const hungEntry = hangGeneration('gen-fresh');

    const result = await regenerateInventedCreaturePortraits(encounter, campaignId, [1]);
    expect(result).toEqual({ created: 1, regenerated: 1 });
    // The unselected entry keeps its cover; the selected one is replaced
    // delete-after-replace (old cover live until the worker commits).
    expect((await getAnyArtifact(ooze.id))?.coverImageId).toBe(oozeCover);
    expect((await getAnyArtifact(wisp.id))?.coverImageId).toBe(wispCover);
    // Two initial batch generations plus the hung regen call.
    await waitFor(() => {
      expect(generateImagesMock).toHaveBeenCalledTimes(3);
    });
    hungEntry.release();
    await waitFor(async () => {
      const cover = (await getAnyArtifact(wisp.id))?.coverImageId;
      expect(cover).not.toBeNull();
      expect(cover).not.toBe(wispCover);
    });
    expect(await bytesText((await getAnyArtifact(wisp.id))?.coverImageId ?? '')).toBe('gen-fresh');
    expect(await getImage(wispCover)).toBeUndefined();
  });

  it('skip-path regression: the normal invented batch never strips an imaged creature', async () => {
    const encounter = await addEncounter([{ name: 'Gloom Ooze', count: 1, source: { type: 'none' } }]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    const first = await enqueueInventedCreaturePortraits(encounter, campaignId);
    expect(first.enqueued).toBe(1);
    const { db } = await import('@/db/db');
    const created = await db.artifacts.where('name').equals('Gloom Ooze').first();
    if (created === undefined) throw new Error('creature missing');
    await waitFor(async () => {
      expect((await getAnyArtifact(created.id))?.coverImageId).not.toBeNull();
    });
    const coverId = (await getAnyArtifact(created.id))?.coverImageId ?? '';
    const calls = generateImagesMock.mock.calls.length;

    const second = await enqueueInventedCreaturePortraits(encounter, campaignId, [0]);
    expect(second).toEqual({ created: 1, enqueued: 0, alreadyImaged: ['Gloom Ooze'] });
    expect((await getAnyArtifact(created.id))?.coverImageId).toBe(coverId);
    expect(generateImagesMock.mock.calls.length).toBe(calls);
  });
});
