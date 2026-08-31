import { ruleChunkSchema, type Id, type RuleChunk } from '@/domain';
import { db } from '@/db/db';
import { invalidateKeywordIndex } from '@/search/keywordIndex';

/** Bulk-inserts chunks (validated); used by the ingestion pipeline. */
export async function putChunks(chunks: RuleChunk[]): Promise<void> {
  const valid = chunks.map((chunk) => ruleChunkSchema.parse(chunk));
  await db.transaction('rw', db.chunks, async () => {
    await db.chunks.bulkPut(valid);
  });
  invalidateKeywordIndex();
}

/** Chunks of one book in reading order (page, then creation). */
/** Every chunk in the library (embedding management). */
export async function listAllChunks(): Promise<RuleChunk[]> {
  return db.chunks.toArray();
}

export async function listChunksByBook(bookId: Id): Promise<RuleChunk[]> {
  const rows = await db.chunks.where('bookId').equals(bookId).toArray();
  return rows.sort((a, b) => a.pageStart - b.pageStart || a.createdAt - b.createdAt);
}

export async function getChunksByIds(ids: Id[]): Promise<RuleChunk[]> {
  const rows = await db.chunks.bulkGet(ids);
  return rows.filter((row): row is RuleChunk => row !== undefined);
}

export async function countChunksByBook(bookId: Id): Promise<number> {
  return db.chunks.where('bookId').equals(bookId).count();
}

/** Chunk count across several books (semantic pre-filter size check). */
export async function countChunksByBooks(bookIds: Id[]): Promise<number> {
  if (bookIds.length === 0) return 0;
  return db.chunks.where('bookId').anyOf(bookIds).count();
}

/** All chunks of several books (semantic candidate set). */
export async function listChunksByBooks(bookIds: Id[]): Promise<RuleChunk[]> {
  if (bookIds.length === 0) return [];
  return db.chunks.where('bookId').anyOf(bookIds).toArray();
}

/** All chunks sharing a content hash (embedding-cache lookups). */
export async function getChunksByContentHash(contentHash: string): Promise<RuleChunk[]> {
  return db.chunks.where('contentHash').equals(contentHash).toArray();
}

/** Called by `rulebookRepo.deleteRulebook` inside its transaction. */
export async function deleteChunksByBook(bookId: Id): Promise<void> {
  await db.chunks.where('bookId').equals(bookId).delete();
  invalidateKeywordIndex();
}
