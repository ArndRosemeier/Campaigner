import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getAnyArtifact, updateArtifact } from '@/db/artifactRepo';
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
 * Portrait regeneration (owner-ordered, docs/11 D5 amendment): detach the
 * existing covers, then enqueue normally — canonical slots republished with
 * FRESH bytes first (a plain re-enqueue would clone identical bytes), flavored
 * and invented covers regenerated locally only. The prompt draft stays
 * deterministic (no chat call) on every regen path.
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
  it('regenerates a flavored cover locally: detaches, frees the old blob, never touches the cache', async () => {
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

    const result = await regenerateMobPortraits(encounter, campaignId);
    expect(result).toEqual({ regenerated: 1, republishedCanonical: [] });
    // Detached synchronously: the old blob row is freed, the artifact is
    // cover-less (tokens show initials until the worker lands the cover).
    expect(await getImage(oldCoverId)).toBeUndefined();
    expect((await getAnyArtifact(artifactId))?.coverImageId).toBeNull();

    await waitFor(async () => {
      expect((await getAnyArtifact(artifactId))?.coverImageId).not.toBeNull();
    });
    const mob = await getAnyArtifact(artifactId);
    expect(mob?.coverImageId).not.toBe(oldCoverId);
    expect(await bytesText(mob?.coverImageId ?? '')).toBe('gen-1');
    // One local generation, no chat call, and the global slot stays empty
    // (flavored citations never read, populate, or overwrite the cache).
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(chatMock).not.toHaveBeenCalled();
    expect(await getMobPortraitCacheEntry(chunkId)).toBeUndefined();
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

    const result = await regenerateMobPortraits(encounterA, campaignId);
    expect(result).toEqual({ regenerated: 1, republishedCanonical: ['Ogre'] });
    // Fresh bytes were spent (no-op re-clone would have generated nothing).
    expect(generateImagesMock).toHaveBeenCalledTimes(2);
    expect(chatMock).not.toHaveBeenCalled();
    // The slot now points at a fresh row; the superseded global blob is gone.
    const slotAfter = await getMobPortraitCacheEntry(chunkId);
    expect(slotAfter?.imageId).not.toBe(slotBefore.imageId);
    expect(await getImage(slotBefore.imageId)).toBeUndefined();
    expect(await bytesText(slotAfter?.imageId ?? '')).toBe('gen-2');
    // The detached local clone is freed too.
    expect(await getImage(oldCoverA)).toBeUndefined();

    // The re-enqueue clones the NEW slot bytes into A's cover.
    await waitFor(async () => {
      expect((await getAnyArtifact(artifactA))?.coverImageId).not.toBeNull();
    });
    const coverA = (await getAnyArtifact(artifactA))?.coverImageId ?? '';
    expect(coverA).not.toBe(oldCoverA);
    expect(await bytesText(coverA)).toBe('gen-2');

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

  it('fails loud BEFORE detaching when the stat-block chunk is gone — the old cover stays', async () => {
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
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
  });

  it('skip-path regression: the normal batch never detaches an imaged mob', async () => {
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
  it('detaches the invented cover and re-enqueues locally with fresh bytes', async () => {
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

    const result = await regenerateInventedCreaturePortraits(encounter, campaignId);
    expect(result).toEqual({ created: 1, regenerated: 1 });
    // Detached synchronously (old blob freed), re-enqueued for the worker.
    expect(await getImage(oldCoverId)).toBeUndefined();
    expect((await getAnyArtifact(created.id))?.coverImageId).toBeNull();

    await waitFor(async () => {
      expect((await getAnyArtifact(created.id))?.coverImageId).not.toBeNull();
    });
    const cover = (await getAnyArtifact(created.id))?.coverImageId ?? '';
    expect(cover).not.toBe(oldCoverId);
    expect(await bytesText(cover)).toBe('gen-2');
    expect(generateImagesMock).toHaveBeenCalledTimes(2);
    expect(chatMock).not.toHaveBeenCalled();
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

    const result = await regenerateInventedCreaturePortraits(encounter, campaignId, [1]);
    expect(result).toEqual({ created: 1, regenerated: 1 });
    // The unselected entry keeps its cover; the selected one is re-covered.
    expect((await getAnyArtifact(ooze.id))?.coverImageId).toBe(oozeCover);
    await waitFor(async () => {
      expect((await getAnyArtifact(wisp.id))?.coverImageId).not.toBeNull();
    });
    const wispNew = (await getAnyArtifact(wisp.id))?.coverImageId ?? '';
    expect(wispNew).not.toBe(wispCover);
    expect(await getImage(wispCover)).toBeUndefined();
  });

  it('skip-path regression: the normal invented batch never detaches an imaged creature', async () => {
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
