import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getAnyArtifact, listArtifactsByCampaign, updateArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createImage, getImage } from '@/db/imageRepo';
import { getOrCreateMobArtifact } from '@/db/mobArtifacts';
import { createRulebook } from '@/db/rulebookRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { updateSettings } from '@/db/settingsRepo';
import { newId, ruleChunkSchema, stampNewEntity, statBlockSchema } from '@/domain';
import { enqueueMobPortraits, useMobPortraitQueue } from '@/features/campaign/mob-portrait-queue';
import { sha256Hex } from '@/lib/hash';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';

/**
 * Mob portrait queue (owner-ratified arc): one click generates n=1 portrait
 * per cover-less rulebook-cited creature kind, keyed by artifactId, grounded
 * in the chunk's stat-block text — entity-image-queue mechanics, mob flavor.
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

const PROMPT_DRAFT = {
  prompt: 'A snarling goblin commander with a rusty scimitar',
  negative: 'text, watermark',
  styleNotes: 'inked bestiary plate',
};

const GOBLIN_TEXT = 'Goblin Boss, humanoid, agile commander. HP 21, AC 17.';

function blobOf(text: string): Blob {
  return new Blob([text], { type: 'image/png' });
}

let campaignId = '';
let encounterId = '';

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
    },
  });
}

beforeEach(async () => {
  await clearDatabase();
  await seedBuiltInPersonas();
  await updateSettings({ imagesEnabled: true, imageModel: 'test-image-model' });
  chatMock.mockReset();
  generateImagesMock.mockReset();
  intakeImageMock.mockReset();
  toastErrorMock.mockReset();
  useMobPortraitQueue.setState({ queued: [], activeJobs: [] });
  useProgressStore.getState().reset();
  chatMock.mockResolvedValue({ text: JSON.stringify(PROMPT_DRAFT), modelUsed: 'test-model', fallback: null });
  generateImagesMock.mockResolvedValue({ images: [blobOf('gen')], costUsd: 0.01, cappedToOne: false, modelUsed: 'test-image-model' });
  intakeImageMock.mockResolvedValue({
    blob: blobOf('intake'),
    mimeType: 'image/webp',
    width: 320,
    height: 240,
  });
  campaignId = (await createCampaign({ name: 'Mob portraits', system: 'dnd5e' })).id;
  encounterId = newId();
});

describe('mob portrait queue', () => {
  it('generates n=1 per queued mob, grounded in the chunk text, attached as cover', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const artifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'Goblin Boss');
    useMobPortraitQueue.getState().enqueue([
      { campaignId, encounterId, artifactId, name: 'Goblin Boss', chunkId },
    ]);

    await waitFor(async () => {
      const mob = await getAnyArtifact(artifactId);
      expect(mob?.coverImageId).not.toBeNull();
    });

    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    // n=1 (owner-ratified): one portrait per creature kind.
    expect(generateImagesMock.mock.calls[0]?.[1]).toBe(1);
    // The final prompt folds style + negative guidance in.
    expect(generateImagesMock.mock.calls[0]?.[0]).toContain('inked bestiary plate');
    // Chunk grounding: the prompt draft's instruction carries the stat-block
    // text — the only description a fresh mob artifact has.
    const draftCall = chatMock.mock.calls[0]?.[0].find((message) => message.role === 'user');
    expect(draftCall?.content).toContain(GOBLIN_TEXT);
    // Provenance lands on the image row; the queue and dock drain.
    const mob = await getAnyArtifact(artifactId);
    const stored = await getImage(mob?.coverImageId ?? '');
    expect(stored?.source).toBe('generated');
    expect(stored?.prompt).toContain('goblin commander');
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    expect(useMobPortraitQueue.getState().activeJobs).toEqual([]);
    expect(
      useProgressStore.getState().jobs.find((job) => job.id === `encounter-mob-portraits-${encounterId}`),
    ).toBeUndefined();
  });

  it('skips imaged mobs (no re-generation) and drains', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const artifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'Goblin Boss');
    const existing = await createImage({
      campaignId,
      blob: blobOf('old'),
      mimeType: 'image/png',
      width: 10,
      height: 10,
      source: 'uploaded',
    });
    await updateArtifact(artifactId, { imageIds: [existing.id], coverImageId: existing.id });

    useMobPortraitQueue.getState().enqueue([
      { campaignId, encounterId, artifactId, name: 'Goblin Boss', chunkId },
    ]);
    await waitFor(() => {
      expect(useMobPortraitQueue.getState().activeJobs).toEqual([]);
      expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    });
    expect(generateImagesMock).not.toHaveBeenCalled();
    expect(chatMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('fails loud per mob (name + reason) and keeps generating the others', async () => {
    const goblinChunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const good = await getOrCreateMobArtifact(campaignId, goblinChunkId, 'Goblin Boss');
    const ghostChunkId = await seedCreatureChunk('Ghost Boss', 'Ghost Boss, spectral and cold.');
    const ghost = await getOrCreateMobArtifact(campaignId, ghostChunkId, 'Ghost Boss');
    useMobPortraitQueue.getState().enqueue([
      // Existing artifact whose creature chunk is gone: loud failure, never a
      // prompt from nothing.
      { campaignId, encounterId, artifactId: ghost, name: 'Ghost Boss', chunkId: newId() },
      { campaignId, encounterId, artifactId: good, name: 'Goblin Boss', chunkId: goblinChunkId },
    ]);

    await waitFor(async () => {
      const mob = await getAnyArtifact(good);
      expect(mob?.coverImageId).not.toBeNull();
    });
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });
    const call = toastErrorMock.mock.calls[0];
    expect(call?.[0]).toBe('Could not generate a portrait for "Ghost Boss"');
    expect((call?.[1] as Error).message).toContain('stat-block chunk no longer exists');
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    expect(useMobPortraitQueue.getState().activeJobs).toEqual([]);
  });

  it('drops duplicate jobs for the same artifact instead of generating concurrently', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const artifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'Goblin Boss');
    const job = { campaignId, encounterId, artifactId, name: 'Goblin Boss', chunkId };
    useMobPortraitQueue.getState().enqueue([job, { ...job }]);
    expect(useMobPortraitQueue.getState().queued).toHaveLength(1);
    await waitFor(async () => {
      const mob = await getAnyArtifact(artifactId);
      expect(mob?.coverImageId).not.toBeNull();
    });
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
  });
});

describe('enqueueMobPortraits (the batch action)', () => {
  it('enumerates only cover-less rulebook mobs, deduped by artifact, retro-filling old rows', async () => {
    const goblinChunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const ogreChunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    // The goblin mob already carries a cover.
    const imagedMob = await getOrCreateMobArtifact(campaignId, goblinChunkId, 'Goblin Boss');
    const cover = await createImage({
      campaignId,
      blob: blobOf('cover'),
      mimeType: 'image/png',
      width: 10,
      height: 10,
      source: 'uploaded',
    });
    await updateArtifact(imagedMob, { imageIds: [cover.id], coverImageId: cover.id });

    const encounter = await addEncounter([
      // Old ogre row (no mobArtifactId): lazily get-or-created by the batch.
      { name: 'Ogre', count: 2, source: { type: 'rulebook', chunkId: ogreChunkId } },
      // Same chunk again: converges on the SAME artifact — no second job.
      { name: 'Ogre', count: 1, source: { type: 'rulebook', chunkId: ogreChunkId } },
      // Pre-imaged goblin mob: enumerated away.
      {
        name: 'Goblin Boss',
        count: 2,
        source: { type: 'rulebook', chunkId: goblinChunkId, mobArtifactId: imagedMob },
      },
      // Non-rulebook entries are not mobs.
      { name: 'Troll', count: 1, source: { type: 'none' } },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    const result = await enqueueMobPortraits(encounter, campaignId);
    expect(result).toEqual({ enqueued: 1, alreadyImaged: ['Goblin Boss'] });
    expect(useMobPortraitQueue.getState().queued).toHaveLength(1);
    const job = useMobPortraitQueue.getState().queued[0];
    expect(job?.chunkId).toBe(ogreChunkId);
    expect(job?.name).toBe('Ogre');
    expect(job?.encounterId).toBe(encounter.id);

    await waitFor(async () => {
      const mobs = await listArtifactsByCampaign(campaignId);
      const ogreMobs = mobs.filter(
        (row) => row.kind === 'npc' && row.data.monsterChunkId === ogreChunkId,
      );
      expect(ogreMobs).toHaveLength(1);
      expect(ogreMobs[0]?.name).toBe('Ogre');
      expect(ogreMobs[0]?.coverImageId).not.toBeNull();
    });
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
  });

  it('fails loudly when a stamped mobArtifactId dangles (no silent identity divergence)', async () => {
    const goblinChunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const encounter = await addEncounter([
      {
        name: 'Goblin Boss',
        count: 1,
        source: { type: 'rulebook', chunkId: goblinChunkId, mobArtifactId: newId() },
      },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    await expect(enqueueMobPortraits(encounter, campaignId)).rejects.toThrow('no longer exists');
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
  });
});
