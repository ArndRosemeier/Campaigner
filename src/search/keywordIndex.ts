import MiniSearch, { type Options } from 'minisearch';

import { db } from '@/db/db';
import type { Id, RuleChunk } from '@/domain';

/**
 * Keyword index (03-RETRIEVAL.md): module-level MiniSearch singleton built
 * lazily from all RuleChunks and invalidated by the chunk repos after bulk
 * writes/deletes. Rebuilds are cheap at M1 scale (~10k chunks).
 */

interface IndexedChunk {
  id: Id;
  text: string;
  headingJoined: string;
}

export interface KeywordHit {
  chunk: RuleChunk;
  /** 1-based rank in keyword relevance order. */
  rank: number;
}

const miniSearchOptions: Options<IndexedChunk> = {
  fields: ['text', 'headingJoined'],
  storeFields: ['id'],
  searchOptions: { prefix: true, fuzzy: 0.2, boost: { headingJoined: 2 } },
};

let indexPromise: Promise<MiniSearch<IndexedChunk>> | null = null;

/** Drops the cached index; the next search rebuilds it from Dexie. */
export function invalidateKeywordIndex(): void {
  indexPromise = null;
}

/** The shared index, built on first use. */
export function getKeywordIndex(): Promise<MiniSearch<IndexedChunk>> {
  indexPromise ??= buildIndex();
  return indexPromise;
}

async function buildIndex(): Promise<MiniSearch<IndexedChunk>> {
  const chunks = await db.chunks.toArray();
  const index = new MiniSearch<IndexedChunk>(miniSearchOptions);
  index.addAll(
    chunks.map((chunk) => ({
      id: chunk.id,
      text: chunk.text,
      headingJoined: chunk.headingPath.join(' '),
    })),
  );
  return index;
}

export interface KeywordSearchFilter {
  bookIds?: Id[] | undefined;
  chunkTypes?: RuleChunk['chunkType'][] | undefined;
}

/**
 * Ranks chunks by keyword relevance (MiniSearch score, descending) and
 * resolves full chunk rows. `limit` caps the result (use a large value, e.g.
 * 100, for the semantic pre-filter set).
 */
export async function searchKeyword(
  query: string,
  filter: KeywordSearchFilter = {},
  limit = 100,
): Promise<KeywordHit[]> {
  const trimmed = query.trim();
  if (trimmed === '') return [];

  const index = await getKeywordIndex();
  const matches = index.search(trimmed).slice(0, limit);
  if (matches.length === 0) return [];

  const ids: Id[] = matches.map((match) => String(match.id));
  const chunks = await db.chunks.bulkGet(ids);
  const byId = new Map<Id, RuleChunk>();
  for (const chunk of chunks) {
    if (chunk !== undefined) byId.set(chunk.id, chunk);
  }

  const hits: KeywordHit[] = [];
  let rank = 0;
  for (const match of matches) {
    const chunk = byId.get(String(match.id));
    if (chunk === undefined) continue;
    if (filter.bookIds !== undefined && !filter.bookIds.includes(chunk.bookId)) continue;
    if (filter.chunkTypes !== undefined && !filter.chunkTypes.includes(chunk.chunkType)) continue;
    rank += 1;
    hits.push({ chunk, rank });
  }
  return hits;
}
