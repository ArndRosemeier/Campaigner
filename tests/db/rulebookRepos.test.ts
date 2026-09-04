import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { rulebookSchema, ruleChunkSchema, stampNewEntity, type RuleChunk } from '@/domain';
import { sha256Hex } from '@/lib/hash';
import {
  createPackBook,
  createRulebook,
  deleteRulebook,
  failPackBook,
  finalizePackBook,
  getRulebook,
  listRulebooks,
  updateRulebook,
} from '@/db/rulebookRepo';
import {
  countChunksByBook,
  getChunksByContentHash,
  getChunksByIds,
  listChunksByBook,
  putChunks,
} from '@/db/chunkRepo';
import { deleteEmbedding, getEmbedding, putEmbedding } from '@/db/embeddingRepo';
import { clearDatabase, expectNotFound } from './helpers';

async function makeChunk(bookId: string, page: number, text: string): Promise<RuleChunk> {
  return ruleChunkSchema.parse({
    ...stampNewEntity(),
    bookId,
    pageStart: page,
    pageEnd: page,
    chunkType: 'section',
    headingPath: ['Chapter 1', `Section ${page}`],
    text,
    statBlock: null,
    contentHash: await sha256Hex(text),
  });
}

describe('rulebookRepo', () => {
  beforeEach(clearDatabase);

  it('creates books in the processing state and updates them to ready', async () => {
    const book = await createRulebook({
      title: 'Players Handbook',
      system: 'dnd5e',
      filename: 'phb.pdf',
    });

    expect(book.status).toBe('processing');
    expect(book.pageCount).toBe(0);
    expect(book.errorMessage).toBe('');

    const ready = await updateRulebook(book.id, { status: 'ready', pageCount: 320 });
    expect(ready.status).toBe('ready');
    expect(ready.pageCount).toBe(320);
    expect(await getRulebook(book.id)).toEqual(ready);
  });

  it('throws NotFoundError when updating a missing book', async () => {
    await expectNotFound(updateRulebook('missing', { status: 'ready' }));
  });

  it('deletes a book and its chunks, but keeps content-addressed embeddings', async () => {
    const book = await createRulebook({
      title: 'Bestiary',
      system: 'pathfinder2e',
      filename: 'bestiary.pdf',
    });
    const chunk = await makeChunk(book.id, 12, 'Grappling rules text.');
    await putChunks([chunk]);
    await putEmbedding({
      contentHash: await sha256Hex('Grappling rules text.'),
      model: 'test-model',
      vector: [0.1, 0.2],
    });

    await deleteRulebook(book.id);

    expect(await getRulebook(book.id)).toBeUndefined();
    expect(await countChunksByBook(book.id)).toBe(0);
    // Embeddings are a shared cache keyed by text hash — not cascade-deleted.
    expect(await getEmbedding(await sha256Hex('Grappling rules text.'))).toBeDefined();
  });
});

describe('chunkRepo', () => {
  beforeEach(clearDatabase);

  it('bulk-inserts, lists in reading order, and looks up by id/hash', async () => {
    const book = await createRulebook({ title: 'PHB', system: 'dnd5e', filename: 'phb.pdf' });
    const c3 = await makeChunk(book.id, 3, 'Third page text.');
    const c1 = await makeChunk(book.id, 1, 'First page text.');
    const c2 = await makeChunk(book.id, 2, 'Second page text.');
    await putChunks([c3, c1, c2]);

    expect(await countChunksByBook(book.id)).toBe(3);
    expect((await listChunksByBook(book.id)).map((chunk) => chunk.pageStart)).toEqual([1, 2, 3]);

    const fetched = await getChunksByIds([c1.id, c3.id]);
    expect(fetched.map((chunk) => chunk.id).sort()).toEqual([c1.id, c3.id].sort());

    const byHash = await getChunksByContentHash(await sha256Hex('Second page text.'));
    expect(byHash.map((chunk) => chunk.id)).toEqual([c2.id]);
  });

  it('rejects chunks with an invalid content hash', async () => {
    const book = await createRulebook({ title: 'PHB', system: 'dnd5e', filename: 'phb.pdf' });
    const chunk = await makeChunk(book.id, 1, 'text');
    const invalid = { ...chunk, contentHash: 'not-a-hash' };

    await expect(putChunks([invalid])).rejects.toThrow();
  });
});

describe('embeddingRepo', () => {
  beforeEach(clearDatabase);

  it('round-trips embeddings by content hash', async () => {
    const hash = await sha256Hex('some chunk text');
    expect(await getEmbedding(hash)).toBeUndefined();

    await putEmbedding({ contentHash: hash, model: 'test-model', vector: [1, 2, 3] });
    const embedding = await getEmbedding(hash);
    expect(embedding?.vector).toEqual([1, 2, 3]);

    await deleteEmbedding(hash);
    expect(await getEmbedding(hash)).toBeUndefined();
  });
});

describe('listRulebooks', () => {
  beforeEach(clearDatabase);

  it('sorts by most recent update', async () => {
    const first = await createRulebook({ title: 'A', system: 'cosmere', filename: 'a.pdf' });
    const second = await createRulebook({ title: 'B', system: 'other', filename: 'b.pdf' });

    // Deterministic ordering: updatedAt has millisecond resolution.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await updateRulebook(first.id, { title: 'A2' });
    expect((await listRulebooks()).map((book) => book.id)).toEqual([first.id, second.id]);
  });
});

describe('pack rulebooks (12-BESTIARY-PACKS §4)', () => {
  beforeEach(clearDatabase);

  it('fills origin/packMeta defaults so pre-pack rows stay valid (no Dexie bump)', () => {
    // A legacy row as stored before packs existed: no origin/packMeta keys.
    const legacy = rulebookSchema.parse({
      ...stampNewEntity(),
      title: 'Players Handbook',
      system: 'dnd5e',
      filename: 'phb.pdf',
      pageCount: 320,
      status: 'ready',
      errorMessage: '',
    });
    expect(legacy.origin).toBe('pdf');
    expect(legacy.packMeta).toBeNull();
  });

  it('creates, finalizes and fails pack books as ordinary rulebook rows', async () => {
    const book = await createPackBook({ title: 'Bestiary', system: 'pathfinder2e', filename: 'bestiary.zip' });
    expect(book.origin).toBe('pack');
    expect(book.packMeta).toBeNull();
    expect(book.status).toBe('processing');

    const ready = await finalizePackBook(book.id, {
      sourceId: 'foundry-pf2e',
      license: 'OGL',
      entriesImported: 12,
      entriesSkipped: 3,
      entriesFailed: 0,
    });
    expect(ready.status).toBe('ready');
    expect(ready.packMeta?.entriesImported).toBe(12);
    expect(await getRulebook(book.id)).toEqual(ready);

    await failPackBook(book.id, 'no valid creature entries');
    const failed = await getRulebook(book.id);
    expect(failed?.status).toBe('error');
    expect(failed?.errorMessage).toContain('no valid creature entries');
  });

  it('keeps origin/packMeta through ordinary patches (rename, set system)', async () => {
    const book = await createPackBook({ title: 'Bestiary', system: 'pathfinder2e', filename: 'b.zip' });
    const renamed = await updateRulebook(book.id, {
      title: 'PF2e Bestiary',
      system: 'dnd5e',
    });
    expect(renamed.title).toBe('PF2e Bestiary');
    expect(renamed.origin).toBe('pack');
    expect(renamed.packMeta).toBeNull();
  });
});
