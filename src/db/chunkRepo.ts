import { ruleChunkSchema, type Id, type RuleChunk } from '@/domain';
import { db } from '@/db/db';

/** Bulk-inserts chunks (validated); used by the ingestion pipeline. */
export async function putChunks(chunks: RuleChunk[]): Promise<void> {
  const valid = chunks.map((chunk) => ruleChunkSchema.parse(chunk));
  await db.transaction('rw', db.chunks, async () => {
    await db.chunks.bulkPut(valid);
  });
}

/** Chunks of one book in reading order (page, then creation). */
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

/** All chunks sharing a content hash (embedding-cache lookups). */
export async function getChunksByContentHash(contentHash: string): Promise<RuleChunk[]> {
  return db.chunks.where('contentHash').equals(contentHash).toArray();
}

/** Called by `rulebookRepo.deleteRulebook` inside its transaction. */
export async function deleteChunksByBook(bookId: Id): Promise<void> {
  await db.chunks.where('bookId').equals(bookId).delete();
}
