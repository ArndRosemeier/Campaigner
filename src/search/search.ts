import type { ChunkType, Id, RuleChunk } from '@/domain';
import { countChunksByBooks, listChunksByBooks } from '@/db/chunkRepo';
import { listRulebooks } from '@/db/rulebookRepo';
import { searchKeyword } from '@/search/keywordIndex';
import {
  cosineSimilarity,
  embedQuery,
  embeddingsActive,
  ensureEmbeddings,
  tryEmbeddings,
} from '@/search/embeddings';

/**
 * Hybrid retrieval (03-RETRIEVAL.md): MiniSearch keyword ranking fused with
 * lazy semantic ranking via Reciprocal Rank Fusion. The semantic path only
 * runs when enabled and never rejects — failures fall back to keyword-only
 * with a single per-session toast.
 */

export interface SearchOptions {
  /** Restrict to these books; default: all 'ready' books. */
  bookIds?: Id[] | undefined;
  chunkTypes?: ChunkType[] | undefined;
  /** Default 12. */
  limit?: number | undefined;
}

export interface SearchHit {
  chunk: RuleChunk;
  score: number;
  source: 'keyword' | 'semantic' | 'both';
}

/** Keyword hits considered for the semantic pre-filter (03-RETRIEVAL.md). */
const PREFILTER_KEYWORD_HITS = 100;
/** Below this chunk count, semantic search embeds all chunks of the books. */
const EMBED_ALL_THRESHOLD = 2000;
const RRF_K = 60;

export async function searchRules(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  const limit = opts.limit ?? 12;
  const trimmed = query.trim();
  if (trimmed === '') return [];

  const bookIds = opts.bookIds ?? (await readyBookIds());
  if (bookIds.length === 0) return [];

  const filter = { bookIds, chunkTypes: opts.chunkTypes };
  const keywordHits = await searchKeyword(trimmed, filter, PREFILTER_KEYWORD_HITS);

  if (!(await embeddingsActive())) {
    return keywordHits.slice(0, limit).map(({ chunk, rank }) => ({
      chunk,
      score: 1 / (RRF_K + rank),
      source: 'keyword',
    }));
  }

  const semantic = await tryEmbeddings(async () => {
    const totalChunks = await countChunksByBooks(bookIds);
    const candidates =
      totalChunks < EMBED_ALL_THRESHOLD
        ? await listChunksByBooks(bookIds)
        : keywordHits.map((hit) => hit.chunk);
    if (candidates.length === 0) return null;

    const [queryVector, vectors] = await Promise.all([
      embedQuery(trimmed),
      ensureEmbeddings(candidates),
    ]);
    return rankSemantic(candidates, vectors, queryVector);
  });
  if (semantic === null) {
    // Embedding failure (notified once): keyword-only fallback.
    return keywordHits.slice(0, limit).map(({ chunk, rank }) => ({
      chunk,
      score: 1 / (RRF_K + rank),
      source: 'keyword',
    }));
  }

  return fuse(keywordHits, semantic).slice(0, limit);
}

interface SemanticHit {
  chunk: RuleChunk;
  /** 1-based rank in semantic similarity order. */
  rank: number;
}

function rankSemantic(
  candidates: readonly RuleChunk[],
  vectors: Map<string, Float32Array>,
  queryVector: Float32Array,
): SemanticHit[] {
  const scored = candidates
    .map((chunk) => {
      const vector = vectors.get(chunk.contentHash);
      return {
        chunk,
        similarity: vector === undefined ? 0 : cosineSimilarity(queryVector, vector),
      };
    })
    .filter((entry) => vectors.has(entry.chunk.contentHash));
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.map((entry, index) => ({ chunk: entry.chunk, rank: index + 1 }));
}

/** Reciprocal Rank Fusion: score = Σ 1/(60 + rank_i); source reflects both lists. */
function fuse(
  keywordHits: readonly { chunk: RuleChunk; rank: number }[],
  semanticHits: readonly SemanticHit[],
): SearchHit[] {
  const scores = new Map<
    Id,
    { score: number; keyword: boolean; semantic: boolean; chunk: RuleChunk }
  >();
  const add = (chunk: RuleChunk, rank: number, keyword: boolean, semantic: boolean): void => {
    const entry = scores.get(chunk.id) ?? { score: 0, keyword: false, semantic: false, chunk };
    entry.score += 1 / (RRF_K + rank);
    entry.keyword = entry.keyword || keyword;
    entry.semantic = entry.semantic || semantic;
    scores.set(chunk.id, entry);
  };
  keywordHits.forEach((hit) => {
    add(hit.chunk, hit.rank, true, false);
  });
  semanticHits.forEach((hit) => {
    add(hit.chunk, hit.rank, false, true);
  });

  const fused: SearchHit[] = [...scores.values()].map((entry) => ({
    chunk: entry.chunk,
    score: entry.score,
    source: entry.keyword && entry.semantic ? 'both' : entry.keyword ? 'keyword' : 'semantic',
  }));
  fused.sort((a, b) => b.score - a.score);
  return fused;
}

async function readyBookIds(): Promise<Id[]> {
  const books = await listRulebooks();
  return books.filter((book) => book.status === 'ready').map((book) => book.id);
}
