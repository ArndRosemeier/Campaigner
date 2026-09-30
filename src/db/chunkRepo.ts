import { ruleChunkSchema, type Id, type RuleChunk } from '@/domain';
import { db } from '@/db/db';
import { invalidateKeywordIndex } from '@/search/keywordIndex';

/**
 * THE chunk-write door (F10): validates, writes, and invalidates the keyword
 * index in the same step — the invalidation is coupled to the write HERE,
 * never left to call sites. `lib/backup`'s whole-DB restore used to rewrite
 * the chunks table through its generic `db.tables` loop and stale the index
 * until backup-section's page reload healed it (that reload was load-bearing
 * for exactly this). Restore paths MUST route through this door.
 */
export async function writeChunks(chunks: RuleChunk[]): Promise<void> {
  const valid = chunks.map((chunk) => ruleChunkSchema.parse(chunk));
  await db.transaction('rw', db.chunks, async () => {
    await db.chunks.bulkPut(valid);
  });
  invalidateKeywordIndex();
}

/** Ingestion-facing name for the chunk-write door (same write+invalidate). */
export const putChunks = writeChunks;

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

/**
 * THE chunk-type read (docs/17 row 182, docs/18 §2.1): every chunk of one
 * `chunkType`, through the already-indexed `chunkType` column. It exists
 * because three call sites were spelling the same Dexie query by hand — the
 * library creature pool (`db/creatureRepo.listLibraryCreatures`), the wiki-link
 * creature publisher (`app/use-library-creatures`) and the spell list page —
 * and the shape `where('chunkType').equals(...)` is EXACTLY the kind of
 * mechanism that drifts (a fourth caller adding a sort, a filter or a
 * different index). `chunkType` is indexed (`db/db.ts`), so no new index and
 * no payload column is needed: `spellData`/`itemData`/`statBlock` are read off
 * the row just like the item lane's payload.
 *
 * A source scan (`tests/db/chunk-type-read-seam.test.ts`) reds on a second
 * `where('chunkType')` in `src/` — caller-side filtering and sorting are fine,
 * a second QUERY spelling is not.
 */
export async function listChunksByType(chunkType: RuleChunk['chunkType']): Promise<RuleChunk[]> {
  return db.chunks.where('chunkType').equals(chunkType).toArray();
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
