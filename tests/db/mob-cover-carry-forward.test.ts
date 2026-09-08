import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAnyArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createImage, getImage } from '@/db/imageRepo';
import { carryMobCoversForward, getOrCreateMobArtifact } from '@/db/mobArtifacts';
import { createRulebook } from '@/db/rulebookRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { ruleChunkSchema, stampNewEntity, statBlockSchema, type MonsterEntry } from '@/domain';
import { sha256Hex } from '@/lib/hash';
import { clearDatabase } from '../db/helpers';

/**
 * Cover carry-forward (docs/11 D5 preservation rule): when an encounter
 * content regeneration re-cites its roster onto NEW cover-less mob-artifact
 * rows (re-chunked/re-imported chunk, or a deleted-then-recreated row), the
 * old same-named row's cover is cloned onto the new row — old row untouched,
 * no deletion sweep. Best-effort: anything uncarriable is left alone, never
 * a failed finalize.
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

function blobOf(text: string): Blob {
  return new Blob([text], { type: 'image/png' });
}

let campaignId = '';

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

async function attachUploadedCover(artifactId: string, bytes: string): Promise<string> {
  const existing = await createImage({
    campaignId,
    blob: blobOf(bytes),
    mimeType: 'image/png',
    width: 10,
    height: 10,
    source: 'uploaded',
  });
  const { updateArtifact } = await import('@/db/artifactRepo');
  await updateArtifact(artifactId, { imageIds: [existing.id], coverImageId: existing.id });
  return existing.id;
}

async function bytesText(imageId: string): Promise<string | null> {
  const stored = await getImage(imageId);
  if (stored === undefined) return null;
  return new TextDecoder().decode(stored.bytes);
}

function rulebookEntry(name: string, chunkId: string, mobArtifactId: string): MonsterEntry {
  return {
    name,
    count: 1,
    notes: '',
    treasure: '',
    source: { type: 'rulebook', chunkId, mobArtifactId },
  };
}

beforeEach(async () => {
  await clearDatabase();
  await seedBuiltInPersonas();
  campaignId = (await createCampaign({ name: 'Cover carry', system: 'dnd5e' })).id;
});

describe('carryMobCoversForward', () => {
  it('a re-cited entry shows the old cover on the new row; the old row is untouched', async () => {
    const oldChunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    const oldArtifactId = await getOrCreateMobArtifact(campaignId, oldChunkId, 'Ogre');
    const oldCoverId = await attachUploadedCover(oldArtifactId, 'old-ogre-cover');
    // Re-chunk: the same creature under a NEW chunk id converges on a NEW
    // cover-less mob-artifact row.
    const newChunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11, second printing.');
    const newArtifactId = await getOrCreateMobArtifact(campaignId, newChunkId, 'Ogre');
    expect(newArtifactId).not.toBe(oldArtifactId);
    expect((await getAnyArtifact(newArtifactId))?.coverImageId).toBeNull();

    const result = await carryMobCoversForward({
      campaignId,
      oldMonsters: [rulebookEntry('Ogre', oldChunkId, oldArtifactId)],
      newMonsters: [rulebookEntry('Ogre', newChunkId, newArtifactId)],
    });
    expect(result).toEqual({ carried: 1 });

    // The new row renders the old art (its own cloned row, same bytes).
    const newCover = (await getAnyArtifact(newArtifactId))?.coverImageId ?? '';
    expect(newCover).not.toBe(oldCoverId);
    expect(await bytesText(newCover)).toBe('old-ogre-cover');
    // The old row is untouched — same cover id, same bytes.
    expect((await getAnyArtifact(oldArtifactId))?.coverImageId).toBe(oldCoverId);
    expect(await bytesText(oldCoverId)).toBe('old-ogre-cover');
  });

  it('matches names case-insensitively (roster flavor casing is not identity)', async () => {
    const oldChunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    const oldArtifactId = await getOrCreateMobArtifact(campaignId, oldChunkId, 'Ogre');
    await attachUploadedCover(oldArtifactId, 'old-ogre-cover');
    const newChunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11, second printing.');
    const newArtifactId = await getOrCreateMobArtifact(campaignId, newChunkId, 'OGRE');

    const result = await carryMobCoversForward({
      campaignId,
      oldMonsters: [rulebookEntry('Ogre', oldChunkId, oldArtifactId)],
      newMonsters: [rulebookEntry('OGRE', newChunkId, newArtifactId)],
    });
    expect(result).toEqual({ carried: 1 });
    expect(await bytesText((await getAnyArtifact(newArtifactId))?.coverImageId ?? '')).toBe(
      'old-ogre-cover',
    );
  });

  it('leaves an already-imaged new row alone', async () => {
    const oldChunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    const oldArtifactId = await getOrCreateMobArtifact(campaignId, oldChunkId, 'Ogre');
    await attachUploadedCover(oldArtifactId, 'old-ogre-cover');
    const newChunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11, second printing.');
    const newArtifactId = await getOrCreateMobArtifact(campaignId, newChunkId, 'Ogre');
    const newCoverId = await attachUploadedCover(newArtifactId, 'new-ogre-cover');

    const result = await carryMobCoversForward({
      campaignId,
      oldMonsters: [rulebookEntry('Ogre', oldChunkId, oldArtifactId)],
      newMonsters: [rulebookEntry('Ogre', newChunkId, newArtifactId)],
    });
    expect(result).toEqual({ carried: 0 });
    expect((await getAnyArtifact(newArtifactId))?.coverImageId).toBe(newCoverId);
    expect(await bytesText(newCoverId)).toBe('new-ogre-cover');
  });

  it('a cover-less old row carries nothing — the re-cite stays cover-less, no throw', async () => {
    const oldChunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    const oldArtifactId = await getOrCreateMobArtifact(campaignId, oldChunkId, 'Ogre');
    const newChunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11, second printing.');
    const newArtifactId = await getOrCreateMobArtifact(campaignId, newChunkId, 'Ogre');

    const result = await carryMobCoversForward({
      campaignId,
      oldMonsters: [rulebookEntry('Ogre', oldChunkId, oldArtifactId)],
      newMonsters: [rulebookEntry('Ogre', newChunkId, newArtifactId)],
    });
    expect(result).toEqual({ carried: 0 });
    expect((await getAnyArtifact(newArtifactId))?.coverImageId).toBeNull();
  });

  it('a differently-named re-cite carries nothing', async () => {
    const oldChunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    const oldArtifactId = await getOrCreateMobArtifact(campaignId, oldChunkId, 'Ogre');
    await attachUploadedCover(oldArtifactId, 'old-ogre-cover');
    const newChunkId = await seedCreatureChunk('Troll', 'Troll, lanky. HP 40, AC 10.');
    const newArtifactId = await getOrCreateMobArtifact(campaignId, newChunkId, 'Troll');

    const result = await carryMobCoversForward({
      campaignId,
      oldMonsters: [rulebookEntry('Ogre', oldChunkId, oldArtifactId)],
      newMonsters: [rulebookEntry('Troll', newChunkId, newArtifactId)],
    });
    expect(result).toEqual({ carried: 0 });
    expect((await getAnyArtifact(newArtifactId))?.coverImageId).toBeNull();
  });

  it('a deleted old row carries nothing — no throw, the re-cite stays cover-less', async () => {
    const oldChunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    const oldArtifactId = await getOrCreateMobArtifact(campaignId, oldChunkId, 'Ogre');
    await attachUploadedCover(oldArtifactId, 'old-ogre-cover');
    const { deleteArtifact } = await import('@/db/artifactRepo');
    await deleteArtifact(oldArtifactId);
    const newChunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11, second printing.');
    const newArtifactId = await getOrCreateMobArtifact(campaignId, newChunkId, 'Ogre');

    const result = await carryMobCoversForward({
      campaignId,
      oldMonsters: [rulebookEntry('Ogre', oldChunkId, oldArtifactId)],
      newMonsters: [rulebookEntry('Ogre', newChunkId, newArtifactId)],
    });
    expect(result).toEqual({ carried: 0 });
    expect((await getAnyArtifact(newArtifactId))?.coverImageId).toBeNull();
  });

  it('an unchanged re-cite (same artifact) carries nothing — the cover is already there', async () => {
    const chunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    const artifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'Ogre');
    const coverId = await attachUploadedCover(artifactId, 'ogre-cover');

    const result = await carryMobCoversForward({
      campaignId,
      oldMonsters: [rulebookEntry('Ogre', chunkId, artifactId)],
      newMonsters: [rulebookEntry('Ogre', chunkId, artifactId)],
    });
    expect(result).toEqual({ carried: 0 });
    expect((await getAnyArtifact(artifactId))?.coverImageId).toBe(coverId);
  });
});
