# 03 — Hybrid Retrieval

Module `/src/search`. Public API (used by rules browser and persona engine):

```ts
interface SearchOptions {
  bookIds?: Id[];               // restrict to these books; default: all 'ready' books
  chunkTypes?: RuleChunk['chunkType'][];
  limit?: number;               // default 12
}
interface SearchHit { chunk: RuleChunk; score: number; source: 'keyword' | 'semantic' | 'both'; }

async function searchRules(query: string, opts?: SearchOptions): Promise<SearchHit[]>;
```

## Keyword index (`/src/search/keywordIndex.ts`)

- MiniSearch instance, module-level singleton, built lazily on first search from
  all RuleChunks in Dexie: fields `['text', 'headingJoined']` (headingJoined =
  headingPath.join(' ')), stored field `id`, options
  `{ prefix: true, fuzzy: 0.2, boost: { headingJoined: 2 } }`.
- Invalidation: repos call `keywordIndex.invalidate()` after chunk bulkAdd/
  delete; next search rebuilds. (Rebuild of ~10k chunks is fast enough; do not
  implement incremental updates in M1.)

## Embeddings (`/src/search/embeddings.ts`)

- Only active when `settings.embeddingsEnabled && apiKey`.
- OpenRouter embeddings endpoint: `POST https://openrouter.ai/api/v1/embeddings`
  with `{ model: settings.embeddingModel, input: string[] }`,
  header `Authorization: Bearer <key>`.
- **Lazy embedding strategy** (cost control): chunks are embedded on demand,
  not at ingest. `ensureEmbeddings(chunks: RuleChunk[])` checks the
  `embeddings` table by `contentHash`, batches missing texts (≤ 64 per request,
  each text truncated to 6000 chars), stores results. Query embedding is
  requested per search (1 short input, negligible cost).
- Semantic search in M1 embeds only the **keyword pre-filter set**: take the
  top 100 keyword hits (or all chunks of the selected books if < 2000 total),
  ensure their embeddings, then cosine-similarity rank against the query
  vector. This avoids embedding entire books up front. A "Embed whole book"
  button in the rules browser triggers full `ensureEmbeddings` for a book with
  a progress indicator.
- Cosine similarity over `Float32Array`s; plain loop is fine at this scale.

## Fusion

Reciprocal Rank Fusion: `score(chunk) = Σ 1/(60 + rank_i)` over the keyword
ranking and semantic ranking. Mark `source` accordingly. If embeddings are
disabled, return keyword results directly with `source:'keyword'`.

## Failure behavior

Embedding request failure (network, 4xx) → log via toast once per session
("Semantic search unavailable: <msg>") and silently fall back to keyword-only.
`searchRules` never rejects for embedding reasons.

## Acceptance criteria

- Query "grapple rules" over an ingested d20 book returns the grappling section
  in the top 3 with embeddings disabled.
- Enabling embeddings changes results and marks some hits `both`.
- With no API key, everything works keyword-only with no errors.
