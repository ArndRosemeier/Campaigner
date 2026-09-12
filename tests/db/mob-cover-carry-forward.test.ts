import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import {
  creatureCoverImageId,
  creaturePortraitArt,
  resolveCreatureCitation,
  setCreatureCover,
} from '@/db/creatureRepo';
import { createImage, getImage } from '@/db/imageRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import {
  creatureIdentityForCitation,
  libraryCreatureKey,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
  type MonsterEntry,
} from '@/domain';
import { sha256Hex } from '@/lib/hash';
import { clearDatabase } from '../db/helpers';

/**
 * Portrait preservation across a re-cite (docs/11 D5 amendment).
 *
 * REWRITTEN for the ratified model (ledger row 106). This file used to pin
 * `carryMobCoversForward`: when a content regeneration re-cited a roster onto
 * NEW per-chunk mob-artifact rows, the old row's cover was CLONED onto the new
 * one — because a portrait hung off an artifact that a chunk id identified.
 * That whole mechanism is deleted: a creature's portrait lives on the
 * campaign's presentation row keyed by the creature's IDENTITY
 * (`db/creatureImages`), so re-citing a creature resolves to the SAME slot and
 * there is nothing to carry. The tests below pin the reassurance the deleted
 * mechanism existed to provide — "does my mob still have its face after a
 * re-run?" — against the model that now provides it, and pin the failure mode
 * the owner hit: the portrait must NOT depend on any campaign artifact
 * existing.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
  fetchWithHeadersTimeout: vi.fn(),
}));

const OGRE_TEXT = 'Ogre, big and rude. HP 59, AC 11.';

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
        level: '4',
        size: 'Large',
        creatureType: 'giant',
        ac: 11,
        acNote: '',
        hp: 59,
        hpFormula: '7d10 + 21',
        speed: '40 ft.',
        abilities: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
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

async function bytesText(imageId: string): Promise<string | null> {
  const stored = await getImage(imageId);
  if (stored === undefined) return null;
  return new TextDecoder().decode(stored.bytes);
}

/** Seats a portrait on the campaign's presentation row for a creature identity
 * — the ONE way a creature carries art, with no artifact involved. */
async function attachUploadedCover(creatureKey: string, text: string): Promise<string> {
  const existing = await createImage({
    campaignId,
    blob: new Blob([text], { type: 'image/png' }),
    mimeType: 'image/png',
    width: 10,
    height: 10,
    source: 'uploaded',
  });
  await setCreatureCover({ campaignId, creatureKey, imageId: existing.id });
  return existing.id;
}

/**
 * A roster citation as every writer in the app writes it: the chunk uuid plus
 * the content identity stamped at citation birth (`contentIdentityFor`) — the
 * chunk's CANONICAL creature heading, NOT the roster's own flavor casing. That
 * is what makes the two entries below byte-identical.
 */
function rulebookEntry(name: string, chunkId: string, contentHash: string): MonsterEntry {
  return {
    name,
    count: 1,
    notes: '',
    treasure: '',
    source: { type: 'rulebook', chunkId, contentHash, creatureName: 'Ogre' },
  };
}

beforeEach(async () => {
  await clearDatabase();
  await seedBuiltInPersonas();
  campaignId = (await createCampaign({ name: 'Cover carry', system: 'dnd5e' })).id;
});

describe('portrait preservation across a re-cite', () => {
  it('an unchanged re-cite needs NO carry-forward: the same citation is the same portrait', async () => {
    const chunkId = await seedCreatureChunk('Ogre', OGRE_TEXT);
    const creatureKey = libraryCreatureKey(chunkId);
    const coverId = await attachUploadedCover(creatureKey, 'old-ogre-cover');

    // The encounter is regenerated; the roster row cites the same chunk. The
    // identity is the citation, so the very same portrait answers — there is
    // no new row to carry anything onto.
    const first = rulebookEntry('Ogre', chunkId, await sha256Hex(OGRE_TEXT));
    const second = rulebookEntry('Ogre', chunkId, await sha256Hex(OGRE_TEXT));
    expect(second.source).toEqual(first.source);

    expect(await creaturePortraitArt(campaignId, creatureKey)).toBe('cover');
    expect(await creatureCoverImageId({ campaignId, creatureKey })).toBe(coverId);
    expect(await bytesText(coverId)).toBe('old-ogre-cover');
  });

  it('roster flavor casing does not move the portrait (identity is the citation, not the name)', async () => {
    const chunkId = await seedCreatureChunk('Ogre', OGRE_TEXT);
    const creatureKey = libraryCreatureKey(chunkId);
    await attachUploadedCover(creatureKey, 'old-ogre-cover');

    const lowercase = rulebookEntry('ogre', chunkId, await sha256Hex(OGRE_TEXT));
    const uppercase = rulebookEntry('OGRE', chunkId, await sha256Hex(OGRE_TEXT));
    expect(lowercase.source).toEqual(uppercase.source);
    expect(await creatureCoverImageId({ campaignId, creatureKey })).not.toBeNull();
  });

  it('the portrait survives a re-chunk that keeps the bytes (content-identity fallback)', async () => {
    const oldChunkId = await seedCreatureChunk('Ogre', OGRE_TEXT);
    const textHash = await sha256Hex(OGRE_TEXT);
    const oldKey = libraryCreatureKey(oldChunkId);
    await attachUploadedCover(oldKey, 'old-ogre-cover');
    // A re-ingest under a NEW row id with BYTE-IDENTICAL text.
    const newBook = await createRulebook({ title: 'Bestiary (2nd)', system: 'dnd5e', filename: 'b2.pdf' });
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: newBook.id,
        pageStart: 4,
        pageEnd: 4,
        chunkType: 'statblock',
        headingPath: ['Ogre'],
        text: OGRE_TEXT,
        // Byte-identical TEXT under a new row id, and the same kind of row:
        // the re-ingest of a real stat block, which is the drift a citation's
        // content hash exists to survive (a statless hash hit never satisfies).
        statBlock: statBlockSchema.parse({
          system: 'dnd5e',
          level: '4',
          size: 'Large',
          creatureType: 'giant',
          ac: 11,
          acNote: '',
          hp: 59,
          hpFormula: '7d10 + 21',
          speed: '40 ft.',
          abilities: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
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
        contentHash: textHash,
      }),
    ]);
    const { db } = await import('@/db/db');
    const newChunk = await db.chunks.where('bookId').equals(newBook.id).first();
    if (newChunk === undefined) throw new Error('new chunk missing');

    // The cited uuid still answers, so the resolution order takes it FIRST and
    // the identity does not move at all — a second local copy of the same
    // creature (two books, one stat block) cannot steal the citation.
    expect(newChunk.id).not.toBe(oldChunkId);
    const resolved = await resolveCreatureCitation({ chunkId: oldChunkId, contentHash: textHash }, 'Ogre');
    expect(resolved.chunkId).toBe(oldChunkId);
    expect(creatureIdentityForCitation({ chunkId: oldChunkId, contentHash: textHash }, oldChunkId).key).toBe(
      oldKey,
    );
    // …and the OLD identity's portrait is still there, untouched: nothing was
    // re-keyed and nothing was deleted, because no artifact owned it.
    expect(await bytesText((await creatureCoverImageId({ campaignId, creatureKey: oldKey })) ?? '')).toBe(
      'old-ogre-cover',
    );
  });

  it('a citation whose uuid is GONE still resolves by content hash — the ONE surviving failure is a genuine library gap', async () => {
    const { db } = await import('@/db/db');
    const oldChunkId = await seedCreatureChunk('Ogre', OGRE_TEXT);
    const textHash = await sha256Hex(OGRE_TEXT);
    const oldKey = libraryCreatureKey(oldChunkId);
    await attachUploadedCover(oldKey, 'old-ogre-cover');
    // The re-ingest: the old row is gone (its uuid answers to nobody) and the
    // identical bytes now carry a NEW row id.
    await db.chunks.delete(oldChunkId);
    const newChunkId = await seedCreatureChunk('Ogre', OGRE_TEXT);
    expect(await db.chunks.get(oldChunkId)).toBeUndefined();

    const resolved = await resolveCreatureCitation({ chunkId: oldChunkId, contentHash: textHash }, 'Ogre');
    expect(resolved.chunkId).toBe(newChunkId);
    expect(resolved.statBlock).not.toBeNull();

    // The OLD identity's portrait is untouched — nothing re-keyed it, nothing
    // deleted it, because no artifact owned it. Only a citation with NO
    // content hash would fall to the named `missing ref` (docs/11 D9).
    expect(await bytesText((await creatureCoverImageId({ campaignId, creatureKey: oldKey })) ?? '')).toBe(
      'old-ogre-cover',
    );
    const stranded = await resolveCreatureCitation({ chunkId: oldChunkId }, 'Ogre');
    expect(stranded.statBlock).toBeNull();
    expect(stranded.origin).toBe('missing ref (Ogre)');
  });

  it('the portrait outlives EVERY campaign artifact (the owner\u2019s missing-ref incident)', async () => {
    const chunkId = await seedCreatureChunk('Ogre', OGRE_TEXT);
    const creatureKey = libraryCreatureKey(chunkId);
    const coverId = await attachUploadedCover(creatureKey, 'old-ogre-cover');
    // An unrelated artifact exists and is then deleted — under the old model,
    // deleting the hidden creature rows is exactly what blanked two encounter
    // rosters to a permanent `missing ref` (ledger row 106).
    const { createArtifact } = await import('@/db/artifactRepo');
    const doomed = await createArtifact({ campaignId, kind: 'npc', name: 'Someone Else' });
    await deleteArtifact(doomed.id);

    expect(await creatureCoverImageId({ campaignId, creatureKey })).toBe(coverId);
    const { db } = await import('@/db/db');
    expect(await db.artifacts.count()).toBe(0);
    // The citation itself still resolves, because a citation names the LIBRARY
    // and never a campaign row.
    const resolved = await resolveCreatureCitation({ chunkId }, 'Ogre');
    expect(resolved.chunkId).toBe(chunkId);
  });

  it('an imageless creature stays imageless across a re-cite — nothing invents one', async () => {
    const chunkId = await seedCreatureChunk('Ogre', OGRE_TEXT);
    const creatureKey = libraryCreatureKey(chunkId);
    expect(await creaturePortraitArt(campaignId, creatureKey)).toBe('none');
    expect(await creatureCoverImageId({ campaignId, creatureKey })).toBeNull();
  });
});
