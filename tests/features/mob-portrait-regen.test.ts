import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { creatureCoverImageId, setCreatureCover } from '@/db/creatureRepo';
import { createImage, getImage } from '@/db/imageRepo';
import { getMobPortraitCacheEntry } from '@/db/mobPortraitCache';
import { createRulebook } from '@/db/rulebookRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { updateSettings } from '@/db/settingsRepo';
import {
  contentCreatureKey,
  libraryCreatureKey,
  newId,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
  type EncounterArtifactData,
} from '@/domain';
import {
  enqueueInventedCreaturePortraits,
  enqueueMobPortraits,
  planMobPortraitBatch,
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

async function addEncounter(
  monsters: { name: string; count: number; source: Record<string, unknown>; notes?: string }[],
  /** Another campaign (canonical-slot tests build the same shape there). */
  campaign: string = campaignId,
) {
  return createArtifact({
    campaignId: campaign,
    kind: 'encounter',
    name: 'Goblin warren',
    data: {
      difficulty: 'medium',
      levelHint: '1',
      monsters: monsters.map((monster) => ({
        name: monster.name,
        count: monster.count,
        // An invented creature's prose IS its roster notes: with no artifact
        // and no chunk to read, the notes are the only description the portrait
        // prompt can be grounded in (docs/11 D5 amendment) — an empty one is
        // refused by the prompt contract, which is why an invented test entry
        // that expects a portrait must carry notes.
        notes: monster.notes ?? '',
        source: monster.source,
      })) as EncounterArtifactData['monsters'],
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

/**
 * REWRITTEN for the ratified model (ledger row 106): a creature portrait hangs
 * off the campaign's CREATURE IDENTITY (docs/11 D6), so this writes the
 * per-campaign presentation row instead of an artifact cover. The call shape is
 * unchanged — `(key, campaign)` — because the identity IS the key now.
 */
async function attachUploadedCover(creatureKey: string, campaign: string): Promise<string> {
  const existing = await createImage({
    campaignId: campaign,
    blob: blobOf('old-cover'),
    mimeType: 'image/png',
    width: 10,
    height: 10,
    source: 'uploaded',
  });
  await setCreatureCover({ campaignId: campaign, creatureKey, imageId: existing.id });
  return existing.id;
}

/**
 * The creature's portrait IN ONE CAMPAIGN — through the PRODUCTION seam
 * (`creatureCoverImageId`), never by poking the table: a test that reads the
 * store directly can pass while the seam a caller actually uses is broken.
 */
async function creatureCover(creatureKey: string, campaign: string): Promise<string | null> {
  return creatureCoverImageId({ campaignId: campaign, creatureKey });
}

/** Whether an image row still exists — the preservation invariant for a
 * creature portrait. A creature has no artifact and therefore NO revision
 * history, so there is no snapshot to keep the blob alive: the blob itself is
 * the whole proof that "the old art stays until the new art lands" holds. */
async function blobLive(imageId: string): Promise<boolean> {
  return (await getImage(imageId)) !== undefined;
}

async function bytesText(imageId: string): Promise<string | null> {
  const stored = await getImage(imageId);
  if (stored === undefined) return null;
  return new TextDecoder().decode(stored.bytes);
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
    const artifactId = libraryCreatureKey(chunkId);
    const oldCoverId = await attachUploadedCover(artifactId, campaignId);
    const encounter = await addEncounter([
      {
        name: 'sickly goblin boss',
        count: 1,
        source: { type: 'rulebook', chunkId },
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
    expect(await creatureCover(artifactId, campaignId)).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe('old-cover');
    expect(await blobLive(oldCoverId)).toBe(true);
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
      expect(await creatureCover(artifactId, campaignId)).not.toBeNull();
      expect(await creatureCover(artifactId, campaignId)).not.toBe(oldCoverId);
    });
    // The fresh cover landed on the campaign's PRESENTATION row (no creature
    // artifact exists to hold it) — the same seam every renderer reads.
    expect(await bytesText((await creatureCover(artifactId, campaignId)) ?? '')).toBe('gen-1');
    // The success path frees ONLY the superseded blob — and only after the
    // fresh cover committed (its snapshot pins are scrubbed with the swap).
    expect(await getImage(oldCoverId)).toBeUndefined();
    expect(await blobLive(oldCoverId)).toBe(false);
    // One local generation, no chat call, and the global slot stays empty
    // (flavored citations never read, populate, or overwrite the cache).
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(chatMock).not.toHaveBeenCalled();
    expect(await getMobPortraitCacheEntry(libraryCreatureKey(chunkId))).toBeUndefined();
  });

  it('a failed fresh generation keeps the old cover: loud error, blob + snapshot pins intact', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const artifactId = libraryCreatureKey(chunkId);
    const oldCoverId = await attachUploadedCover(artifactId, campaignId);
    const encounter = await addEncounter([
      {
        name: 'sickly goblin boss',
        count: 1,
        source: { type: 'rulebook', chunkId },
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
    expect(await creatureCover(artifactId, campaignId)).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe('old-cover');
    expect(await blobLive(oldCoverId)).toBe(true);
  });

  it('a queue dropped before the worker runs keeps the old cover', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const artifactId = libraryCreatureKey(chunkId);
    const oldCoverId = await attachUploadedCover(artifactId, campaignId);
    const encounter = await addEncounter([
      {
        name: 'sickly goblin boss',
        count: 1,
        source: { type: 'rulebook', chunkId },
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
    expect(await creatureCover(artifactId, campaignId)).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe('old-cover');
    expect(await blobLive(oldCoverId)).toBe(true);
  });

  it('republishes a canonical slot with fresh bytes; other-campaign covers keep their cloned bytes', async () => {
    const chunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    const campaignB = (await createCampaign({ name: 'Second campaign', system: 'dnd5e' })).id;
    // Campaign B populates the slot through the normal canonical flow (one
    // generation, then a clone into its own cover).
    const artifactB = libraryCreatureKey(chunkId);
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
      expect(await creatureCover(artifactB, campaignB)).not.toBeNull();
    });
    const slotBefore = await getMobPortraitCacheEntry(libraryCreatureKey(chunkId));
    if (slotBefore === undefined) throw new Error('slot missing');
    const coverB = await creatureCover(artifactB, campaignB) ?? '';
    expect(await bytesText(coverB)).toBe('gen-1');

    // Campaign A holds a clone of the same slot bytes.
    const artifactA = libraryCreatureKey(chunkId);
    const encounterA = await addEncounter([
      { name: 'Ogre', count: 1, source: { type: 'rulebook', chunkId } },
    ]);
    if (encounterA.kind !== 'encounter') throw new Error('not an encounter');
    await enqueueMobPortraits(encounterA, campaignId);
    await waitFor(async () => {
      expect(await creatureCover(artifactA, campaignId)).not.toBeNull();
    });
    const oldCoverA = await creatureCover(artifactA, campaignId) ?? '';
    expect(await bytesText(oldCoverA)).toBe('gen-1');

    // Serialize the pump behind a blocker job: the regen job cannot run
    // before the preservation pins below (its force-clone commits no image
    // generation, so nothing else gates it deterministically).
    await updateSettings({ maxParallelRequests: 1 });
    const blocker = hangGeneration('blocker-bytes');
    const decoyChunkId = await seedCreatureChunk('Decoy Drake', 'Decoy Drake, scaly. HP 10, AC 10.');
    const decoyArtifactId = libraryCreatureKey(decoyChunkId);
    useMobPortraitQueue.getState().enqueue([
      {
        campaignId,
        encounterId: encounterA.id,
        creatureKey: decoyArtifactId,
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
    const slotAfter = await getMobPortraitCacheEntry(libraryCreatureKey(chunkId));
    expect(slotAfter?.imageId).not.toBe(slotBefore.imageId);
    expect(await getImage(slotBefore.imageId)).toBeUndefined();
    expect(await bytesText(slotAfter?.imageId ?? '')).toBe('gen-2');
    // Delete-after-replace: the old LOCAL cover is still live while the
    // regen job waits behind the blocker — blob and snapshot pins intact.
    expect(await creatureCover(artifactA, campaignId)).toBe(oldCoverA);
    expect(await bytesText(oldCoverA)).toBe('gen-1');
    expect(await blobLive(oldCoverA)).toBe(true);
    expect(useMobPortraitQueue.getState().queued).toHaveLength(1);

    blocker.release();

    // The regen job force-clones the NEW slot bytes over the old cover.
    await waitFor(async () => {
      const cover = await creatureCover(artifactA, campaignId);
      expect(cover).not.toBeNull();
      expect(cover).not.toBe(oldCoverA);
    });
    const coverA = await creatureCover(artifactA, campaignId) ?? '';
    expect(await bytesText(coverA)).toBe('gen-2');
    // Only now is the superseded local blob freed (snapshot pins scrubbed
    // with the swap).
    expect(await getImage(oldCoverA)).toBeUndefined();
    expect(await blobLive(oldCoverA)).toBe(false);

    // Other-campaign invariance: B's existing cover keeps its cloned bytes.
    expect(await creatureCover(artifactB, campaignB)).toBe(coverB);
    expect(await bytesText(coverB)).toBe('gen-1');

    // Future clones render the new art.
    const campaignC = (await createCampaign({ name: 'Third campaign', system: 'dnd5e' })).id;
    // REWRITTEN (ledger row 106): the old call asked the CREATION seam to
    // pre-fill a NEW artifact's cover from the cache (`fillCoverFromCache`).
    // Nothing is created now, so the equivalent is the citation itself: a
    // fresh campaign's first enumeration clones the canonical slot (D6).
    const artifactC = libraryCreatureKey(chunkId);
    const encounterC = await addEncounter(
      [{ name: 'Ogre', count: 1, source: { type: 'rulebook', chunkId } }],
      campaignC,
    );
    if (encounterC.kind !== 'encounter') throw new Error('not an encounter');
    await enqueueMobPortraits(encounterC, campaignC);
    // The clone is the WORKER's work, never the enumeration's: the batch clones
    // nothing while it counts (plan/run agreement), so the row appears when the
    // job commits — and the bytes are the slot's, with no fresh generation.
    await waitFor(async () => {
      expect(await creatureCover(artifactC, campaignC)).not.toBeNull();
    });
    expect(await bytesText((await creatureCover(artifactC, campaignC)) ?? '')).toBe('gen-2');
  });

  it('a failed canonical republish throws loud BEFORE enqueueing — the old cover stays', async () => {
    const chunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    const artifactId = libraryCreatureKey(chunkId);
    const oldCoverId = await attachUploadedCover(artifactId, campaignId);
    const encounter = await addEncounter([
      { name: 'Ogre', count: 1, source: { type: 'rulebook', chunkId } },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    generateImagesMock.mockRejectedValueOnce(new Error('slot generation exploded'));

    await expect(regenerateMobPortraits(encounter, campaignId)).rejects.toThrow('slot generation exploded');
    // The fresh-bytes phase failed: no regen job was enqueued and the old
    // portrait — blob and snapshot pins — is intact.
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    expect(await creatureCover(artifactId, campaignId)).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe('old-cover');
    expect(await blobLive(oldCoverId)).toBe(true);
    expect(await getMobPortraitCacheEntry(libraryCreatureKey(chunkId))).toBeUndefined();
  });

  it('fails loud with no side effects when the stat-block chunk is gone — the old cover stays', async () => {
    const missingChunkId = newId();
    const artifactId = libraryCreatureKey(missingChunkId);
    const oldCoverId = await attachUploadedCover(artifactId, campaignId);
    const encounter = await addEncounter([
      {
        name: 'Ghost Boss',
        count: 1,
        source: { type: 'rulebook', chunkId: missingChunkId },
      },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    await expect(regenerateMobPortraits(encounter, campaignId)).rejects.toThrow(
      'the stat-block chunk for "Ghost Boss" no longer exists',
    );
    expect(generateImagesMock).not.toHaveBeenCalled();
    expect(await creatureCover(artifactId, campaignId)).toBe(oldCoverId);
    expect(await getImage(oldCoverId)).toBeDefined();
    expect(await blobLive(oldCoverId)).toBe(true);
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
  });

  it('skip-path regression: the normal batch never strips an imaged mob', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const artifactId = libraryCreatureKey(chunkId);
    const oldCoverId = await attachUploadedCover(artifactId, campaignId);
    const encounter = await addEncounter([
      {
        name: 'Goblin Boss',
        count: 1,
        source: { type: 'rulebook', chunkId },
      },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    const result = await enqueueMobPortraits(encounter, campaignId);
    expect(result).toEqual({ enqueued: 0, alreadyImaged: ['Goblin Boss'] });
    expect(await creatureCover(artifactId, campaignId)).toBe(oldCoverId);
    expect(await getImage(oldCoverId)).toBeDefined();
    expect(generateImagesMock).not.toHaveBeenCalled();
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
  });
});

describe('regenerateInventedCreaturePortraits', () => {
  it('replaces the invented cover delete-after-replace with fresh local bytes', async () => {
    const encounter = await addEncounter([
      {
        name: 'Gloom Ooze',
        count: 1,
        notes: 'A dripping gloom ooze, its body a standing wave of black tar.',
        source: { type: 'inline', statBlock: oozeBlock() },
      },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    await enqueueInventedCreaturePortraits(encounter, campaignId);
    // An invented creature owns NO row (docs/11 D5): its portrait is keyed by
    // its own content identity, which is what the batch used to enqueue it.
    const createdKey = contentCreatureKey('Gloom Ooze', oozeBlock());
    await waitFor(async () => {
      expect(await creatureCover(createdKey, campaignId)).not.toBeNull();
    });
    const oldCoverId = await creatureCover(createdKey, campaignId) ?? '';
    expect(await bytesText(oldCoverId)).toBe('gen-1');
    // Hang the worker's fresh generation for deterministic while-queued pins.
    const hung = hangGeneration('gen-2');

    const result = await regenerateInventedCreaturePortraits(encounter, campaignId);
    expect(result).toEqual({ regenerated: 1 });
    // Delete-after-replace: the old cover stays live until the worker
    // commits the fresh one (a dropped queue loses nothing).
    expect(await creatureCover(createdKey, campaignId)).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe('gen-1');
    expect(await blobLive(oldCoverId)).toBe(true);
    const hungState = useMobPortraitQueue.getState();
    expect(hungState.queued.length + hungState.active.length).toBe(1);
    // The initial batch generation (gen-1) plus the hung regen call: the
    // worker is inside the hung generation — now let it commit.
    await waitFor(() => {
      expect(generateImagesMock).toHaveBeenCalledTimes(2);
    });

    hung.release();
    await waitFor(async () => {
      const cover = await creatureCover(createdKey, campaignId);
      expect(cover).not.toBeNull();
      expect(cover).not.toBe(oldCoverId);
    });
    const cover = await creatureCover(createdKey, campaignId) ?? '';
    expect(await bytesText(cover)).toBe('gen-2');
    // Only the superseded blob is freed, after the fresh cover committed.
    expect(await getImage(oldCoverId)).toBeUndefined();
    expect(await blobLive(oldCoverId)).toBe(false);
    expect(generateImagesMock).toHaveBeenCalledTimes(2);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('a failed invented generation keeps the old cover: loud error, blob + snapshot pins intact', async () => {
    const encounter = await addEncounter([{ name: 'Gloom Ooze', count: 1, notes: 'A dripping gloom ooze, its body a standing wave of black tar.', source: { type: 'none' } }]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    await enqueueInventedCreaturePortraits(encounter, campaignId);
    // An invented creature owns NO row (docs/11 D5): its portrait is keyed by
    // its own content identity, which is what the batch used to enqueue it.
    // A `none` entry has no stat block, so its identity is the name alone.
    const createdKey = contentCreatureKey('Gloom Ooze', null);
    await waitFor(async () => {
      expect(await creatureCover(createdKey, campaignId)).not.toBeNull();
    });
    const oldCoverId = await creatureCover(createdKey, campaignId) ?? '';
    generateImagesMock.mockRejectedValueOnce(new Error('model exploded'));

    const result = await regenerateInventedCreaturePortraits(encounter, campaignId);
    expect(result).toEqual({ regenerated: 1 });

    await waitFor(() => {
      expect(useMobPortraitQueue.getState().failed).toHaveLength(1);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Could not generate a portrait for "Gloom Ooze"',
      expect.any(Error),
    );
    expect(await creatureCover(createdKey, campaignId)).toBe(oldCoverId);
    expect(await getImage(oldCoverId)).toBeDefined();
    expect(await blobLive(oldCoverId)).toBe(true);
  });

  it('a dropped invented queue keeps the old cover', async () => {
    const encounter = await addEncounter([{ name: 'Gloom Ooze', count: 1, notes: 'A dripping gloom ooze, its body a standing wave of black tar.', source: { type: 'none' } }]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    await enqueueInventedCreaturePortraits(encounter, campaignId);
    // An invented creature owns NO row (docs/11 D5): its portrait is keyed by
    // its own content identity, which is what the batch used to enqueue it.
    // A `none` entry has no stat block, so its identity is the name alone.
    const createdKey = contentCreatureKey('Gloom Ooze', null);
    await waitFor(async () => {
      expect(await creatureCover(createdKey, campaignId)).not.toBeNull();
    });
    const oldCoverId = await creatureCover(createdKey, campaignId) ?? '';
    const oldBytes = await bytesText(oldCoverId);
    // Hang the fresh generation: the job never commits before the withdraw.
    hangGeneration('gen-never');

    await regenerateInventedCreaturePortraits(encounter, campaignId);
    await waitFor(() => {
      expect(useMobPortraitQueue.getState().active).toHaveLength(1);
    });
    await useMobPortraitQueue.getState().cancelAll();

    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(await creatureCover(createdKey, campaignId)).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe(oldBytes);
    expect(await blobLive(oldCoverId)).toBe(true);
  });

  it('per-entry regen touches only the selected entry', async () => {
    const encounter = await addEncounter([
      {
        name: 'Gloom Ooze',
        count: 1,
        notes: 'A dripping gloom ooze, its body a standing wave of black tar.',
        source: { type: 'inline', statBlock: oozeBlock() },
      },
      { name: 'Whisper Wisp', count: 1, notes: 'A whisper wisp: a smear of pale light that hums a name.', source: { type: 'none' } },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    await enqueueInventedCreaturePortraits(encounter, campaignId);
    // Neither invented creature owns a row: both are keyed by content identity.
    const oozeKey = contentCreatureKey('Gloom Ooze', oozeBlock());
    const wispKey = contentCreatureKey('Whisper Wisp', null);
    await waitFor(async () => {
      expect(await creatureCover(oozeKey, campaignId)).not.toBeNull();
      expect(await creatureCover(wispKey, campaignId)).not.toBeNull();
    });
    const oozeCover = await creatureCover(oozeKey, campaignId) ?? '';
    const wispCover = await creatureCover(wispKey, campaignId) ?? '';
    // Hang the fresh generation so the while-queued pins are deterministic.
    const hungEntry = hangGeneration('gen-fresh');

    const result = await regenerateInventedCreaturePortraits(encounter, campaignId, [1]);
    expect(result).toEqual({ regenerated: 1 });
    // The unselected entry keeps its cover; the selected one is replaced
    // delete-after-replace (old cover live until the worker commits).
    expect(await creatureCover(oozeKey, campaignId)).toBe(oozeCover);
    expect(await creatureCover(wispKey, campaignId)).toBe(wispCover);
    // Two initial batch generations plus the hung regen call.
    await waitFor(() => {
      expect(generateImagesMock).toHaveBeenCalledTimes(3);
    });
    hungEntry.release();
    await waitFor(async () => {
      const cover = await creatureCover(wispKey, campaignId);
      expect(cover).not.toBeNull();
      expect(cover).not.toBe(wispCover);
    });
    expect(await bytesText(await creatureCover(wispKey, campaignId) ?? '')).toBe('gen-fresh');
    expect(await getImage(wispCover)).toBeUndefined();
  });

  it('skip-path regression: the normal invented batch never strips an imaged creature', async () => {
    const encounter = await addEncounter([{ name: 'Gloom Ooze', count: 1, notes: 'A dripping gloom ooze, its body a standing wave of black tar.', source: { type: 'none' } }]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    const first = await enqueueInventedCreaturePortraits(encounter, campaignId);
    expect(first.enqueued).toBe(1);
    // An invented creature owns NO row (docs/11 D5): its portrait is keyed by
    // its own content identity, which is what the batch used to enqueue it.
    // A `none` entry has no stat block, so its identity is the name alone.
    const createdKey = contentCreatureKey('Gloom Ooze', null);
    await waitFor(async () => {
      expect(await creatureCover(createdKey, campaignId)).not.toBeNull();
    });
    const coverId = await creatureCover(createdKey, campaignId) ?? '';
    const calls = generateImagesMock.mock.calls.length;

    const second = await enqueueInventedCreaturePortraits(encounter, campaignId, [0]);
    expect(second).toEqual({ enqueued: 0, alreadyImaged: ['Gloom Ooze'] });
    expect(await creatureCover(createdKey, campaignId)).toBe(coverId);
    expect(generateImagesMock.mock.calls.length).toBe(calls);
  });
});

/**
 * The batch confirm's read-only half (owner report: the press offered
 * replace-all in a state the owner read as "2 mobs have a portrait, one does
 * not" — Mob Core/canonical art). `planMobPortraitBatch` walks the SAME
 * enumeration as the batch, the regen paths and the fill, so the counts a
 * surface states are the counts the queue will act on; and the batch never
 * pre-clones a canonical slot while enumerating (a hole is WORK, reported as
 * work, and the worker's canonical branch clones the populated slot — one
 * generation per chunk, no API call for the fill).
 */
describe('planMobPortraitBatch (the read-only count behind the confirm)', () => {
  it('counts a cover-less canonical citation as work; the fill clones the shared slot with no new generation', async () => {
    const goblin = await seedCreatureChunk('Goblin', 'Goblin, small and mean. HP 7, AC 15.');
    const ogre = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    const troll = await seedCreatureChunk('Troll', 'Troll, huge and hungry. HP 84, AC 15.');

    // Another campaign publishes the SHARED canonical portrait for Troll.
    const campaignB = (await createCampaign({ name: 'Second campaign', system: 'dnd5e' })).id;
    libraryCreatureKey(troll);
    const encounterB = await addEncounter(
      [{ name: 'Troll', count: 1, source: { type: 'rulebook', chunkId: troll } }],
      campaignB,
    );
    if (encounterB.kind !== 'encounter') throw new Error('not an encounter');
    await enqueueMobPortraits(encounterB, campaignB);
    await waitFor(async () => {
      expect(await getMobPortraitCacheEntry(libraryCreatureKey(troll))).toBeDefined();
      expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
      expect(useMobPortraitQueue.getState().active).toHaveLength(0);
    });
    const slot = await getMobPortraitCacheEntry(libraryCreatureKey(troll));
    if (slot === undefined) throw new Error('slot missing');

    // This campaign: two kinds imaged, Troll cover-less — rows cited by hand
    // exactly as the roster UI writes them (rulebook citation, NO stamp).
    const goblinArt = libraryCreatureKey(goblin);
    const ogreArt = libraryCreatureKey(ogre);
    const trollArt = libraryCreatureKey(troll);
    await attachUploadedCover(goblinArt, campaignId);
    await attachUploadedCover(ogreArt, campaignId);
    const encounter = await addEncounter([
      { name: 'Goblin', count: 1, source: { type: 'rulebook', chunkId: goblin } },
      { name: 'Ogre', count: 1, source: { type: 'rulebook', chunkId: ogre } },
      { name: 'Troll', count: 1, source: { type: 'rulebook', chunkId: troll } },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    // The hole is real: the token for this kind renders initials (cover null).
    expect(await creatureCover(trollArt, campaignId)).toBeNull();
    const generationsBefore = generateImagesMock.mock.calls.length;

    const plan = await planMobPortraitBatch(encounter, campaignId);
    expect(plan).toEqual({
      missing: ['Troll'],
      imaged: ['Goblin', 'Ogre'],
      // No `artWithoutCover`: with ONE portrait seam the art row IS the
      // portrait, so "has art but no cover" cannot be represented at all
      // (docs/18 §4) — the count it used to report is structurally zero.
      sharedRows: 0,
      // Both imaged citations are canonical (Monster Core-style) — replacing
      // them republishes the shared slot, and the confirm must say so.
      sharedPortraitNames: ['Goblin', 'Ogre'],
      unreadableCitations: [],
    });
    // Counting cloned nothing and created nothing.
    expect(await creatureCover(trollArt, campaignId)).toBeNull();
    expect(generateImagesMock.mock.calls.length).toBe(generationsBefore);

    // The batch reports the hole as WORK — never as already-imaged, and it
    // does not pre-clone while enumerating (revert-proof: the read-through
    // returned {enqueued: 0, alreadyImaged: [Goblin, Ogre, Troll]}).
    const result = await enqueueMobPortraits(encounter, campaignId);
    expect(result).toEqual({ enqueued: 1, alreadyImaged: ['Goblin', 'Ogre'] });
    expect(await creatureCover(trollArt, campaignId)).toBeNull();
    // Plan/run agreement: what the confirm promised is what the batch queued.
    expect(result.enqueued).toBe(plan.missing.length);
    expect(result.alreadyImaged).toEqual(plan.imaged);

    // The job fills the hole by CLONING the shared slot: identical bytes,
    // zero fresh generations (one generation per chunk, unchanged).
    await waitFor(async () => {
      expect(await creatureCover(trollArt, campaignId)).not.toBeNull();
    });
    // The fill landed on the campaign's PRESENTATION row for the identity
    // (there is no artifact to hang it on) — and its bytes are the slot's.
    expect(await bytesText((await creatureCover(trollArt, campaignId)) ?? '')).toBe(
      await bytesText(slot.imageId),
    );
    expect(generateImagesMock.mock.calls.length).toBe(generationsBefore);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('counts both lanes per creature kind and reports a repeated kind as a shared row, never silencing it', async () => {
    const goblin = await seedCreatureChunk('Goblin', 'Goblin, small and mean. HP 7, AC 15.');
    const ogre = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    const goblinArt = libraryCreatureKey(goblin);
    await attachUploadedCover(goblinArt, campaignId);
    const encounter = await addEncounter([
      {
        name: 'Goblin',
        count: 2,
        source: { type: 'rulebook', chunkId: goblin },
      },
      {
        name: 'Goblin',
        count: 1,
        source: { type: 'rulebook', chunkId: goblin },
      },
      { name: 'Ogre', count: 1, source: { type: 'rulebook', chunkId: ogre } },
      {
        name: 'Gloom Ooze',
        count: 2,
        notes: 'A dripping gloom ooze, its body a standing wave of black tar.',
        source: { type: 'inline', statBlock: oozeBlock() },
      },
      {
        name: 'Gloom Ooze',
        count: 1,
        notes: 'A dripping gloom ooze, its body a standing wave of black tar.',
        source: { type: 'inline', statBlock: oozeBlock() },
      },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    const plan = await planMobPortraitBatch(encounter, campaignId);
    expect(plan.missing).toEqual(['Ogre', 'Gloom Ooze']);
    expect(plan.imaged).toEqual(['Goblin']);
    expect(plan.sharedRows).toBe(2);
    // Neither lane creates anything (docs/11 D5): the two lanes split the
    // SAME missing list, so their enqueued counts must sum to it.

    const rulebook = await enqueueMobPortraits(encounter, campaignId);
    expect(rulebook).toEqual({ enqueued: 1, alreadyImaged: ['Goblin'] });
    const invented = await enqueueInventedCreaturePortraits(encounter, campaignId);
    expect(invented).toEqual({ enqueued: 1, alreadyImaged: [] });
    expect(rulebook.enqueued + invented.enqueued).toBe(plan.missing.length);
    expect([...rulebook.alreadyImaged, ...invented.alreadyImaged]).toEqual(plan.imaged);
  });

  it('counts an imaged creature as imaged and enqueues nothing — the count and the run agree', async () => {
    const ogre = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    const ogreArt = libraryCreatureKey(ogre);
    // REWRITTEN (ledger row 106): this test used to build "gallery art with no
    // cover" on a creature ARTIFACT, and pinned a plan bucket
    // (`artWithoutCover`) for it. With ONE portrait seam the campaign's
    // presentation row IS the art AND the portrait, so "has art, is not
    // imaged" is not a state the model can represent (docs/18 §4) — the
    // bucket is gone, not defaulted to []. What survives, and is pinned here,
    // is the agreement the old bucket existed to protect: whatever the count
    // says, the run does.
    await attachUploadedCover(ogreArt, campaignId);
    const encounter = await addEncounter([
      { name: 'Ogre', count: 1, source: { type: 'rulebook', chunkId: ogre } },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    const plan = await planMobPortraitBatch(encounter, campaignId);
    expect(plan).toEqual({
      missing: [],
      imaged: ['Ogre'],
      sharedRows: 0,
      sharedPortraitNames: ['Ogre'],
      unreadableCitations: [],
    });
    expect(await creatureCover(ogreArt, campaignId)).not.toBeNull();
    const generationsBefore = generateImagesMock.mock.calls.length;
    const result = await enqueueMobPortraits(encounter, campaignId);
    expect(result).toEqual({ enqueued: 0, alreadyImaged: ['Ogre'] });
    expect(result.enqueued).toBe(plan.missing.length);
    expect(result.alreadyImaged).toEqual(plan.imaged);
    expect(generateImagesMock.mock.calls.length).toBe(generationsBefore);
  });

  it('names an unreadable citation instead of quietly calling it flavored, and still never blocks the fill', async () => {
    const ogre = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    const ogreArt = libraryCreatureKey(ogre);
    await attachUploadedCover(ogreArt, campaignId);
    const encounter = await addEncounter([
      { name: 'Ogre', count: 1, source: { type: 'rulebook', chunkId: ogre } },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    const { db } = await import('@/db/db');
    await db.chunks.delete(ogre);

    const plan = await planMobPortraitBatch(encounter, campaignId);
    expect(plan.unreadableCitations).toEqual(['Ogre']);
    expect(plan.sharedPortraitNames).toEqual([]);
    expect(plan.imaged).toEqual(['Ogre']);
    // Replacing fails loud with the cover kept (unchanged behavior) — the
    // count reports it instead of hiding it, and the additive path stands.
    await expect(regenerateMobPortraits(encounter, campaignId)).rejects.toThrow(
      /no longer exists — kept the existing portrait/,
    );
  });

  it('creates nothing while counting: the fill is what creates the artifacts', async () => {
    const kobold = await seedCreatureChunk('Kobold', 'Kobold, yappy. HP 5, AC 12.');
    const encounter = await addEncounter([
      { name: 'Kobold', count: 1, source: { type: 'rulebook', chunkId: kobold } },
      { name: 'Gloom Ooze', count: 1, notes: 'A dripping gloom ooze, its body a standing wave of black tar.', source: { type: 'none' } },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    const before = (await listArtifactsByCampaign(campaignId)).length;
    const plan = await planMobPortraitBatch(encounter, campaignId);
    expect(plan.missing).toEqual(['Kobold', 'Gloom Ooze']);
    expect(plan.imaged).toEqual([]);
    expect((await listArtifactsByCampaign(campaignId)).length).toBe(before);

    const rulebook = await enqueueMobPortraits(encounter, campaignId);
    expect(rulebook).toEqual({ enqueued: 1, alreadyImaged: [] });
    const invented = await enqueueInventedCreaturePortraits(encounter, campaignId);
    expect(invented).toEqual({ enqueued: 1, alreadyImaged: [] });
    expect(rulebook.enqueued + invented.enqueued).toBe(plan.missing.length);
  });
});
