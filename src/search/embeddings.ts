import { db } from '@/db/db';
import { getSettings } from '@/db/settingsRepo';
import type { RuleChunk } from '@/domain';
import { listAllChunks } from '@/db/chunkRepo';
import { fetchWithHeadersTimeout } from '@/llm/openrouter';
import { toastError } from '@/lib/toast';

/**
 * Embeddings (03-RETRIEVAL.md): lazy, content-addressed cache. Chunks are
 * embedded on demand (never at ingest); results are cached per
 * `contentHash + model` in the embeddings table and stored as plain arrays.
 */

const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';
const MAX_BATCH = 64;
const MAX_CHARS = 6000;

/** Cache key: same text embedded under different models must not collide. */
export function embeddingKey(contentHash: string, model: string): string {
  return `${model}::${contentHash}`;
}

/** True when the semantic path may run (settings toggle + key present). */
export async function embeddingsActive(): Promise<boolean> {
  const settings = await getSettings();
  return settings.embeddingsEnabled && settings.openRouterApiKey !== '';
}

/** One-session flag: the user is told once, then we fall back silently. */
let failureToasted = false;

/** Test seam: clears the once-per-session toast flag. */
export function resetEmbeddingFailureNotice(): void {
  failureToasted = false;
}

function notifyFailure(error: unknown): void {
  if (failureToasted) return;
  failureToasted = true;
  const message = error instanceof Error ? error.message : String(error);
  toastError(`Semantic search unavailable: ${message}`);
}

interface EmbeddingResponse {
  data?: { embedding?: number[]; index?: number }[];
}

async function requestEmbeddings(inputs: string[]): Promise<number[][]> {
  const settings = await getSettings();
  // Headers timeout: a black-holed embedding request used to hang the whole
  // runEngine pipeline (retrieve/draft call searchRules) forever — the throw
  // lands in tryEmbeddings, which falls back to keyword search (03-RETRIEVAL).
  const response = await fetchWithHeadersTimeout(
    OPENROUTER_EMBEDDINGS_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.openRouterApiKey}`,
      },
      body: JSON.stringify({ model: settings.embeddingModel, input: inputs }),
    },
  );
  if (!response.ok) {
    throw new Error(`embedding request failed (${String(response.status)})`);
  }
  const json = (await response.json()) as EmbeddingResponse;
  const vectors = (json.data ?? [])
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((entry) => entry.embedding);
  if (vectors.length !== inputs.length || vectors.some((v) => v === undefined)) {
    throw new Error('embedding response is missing vectors');
  }
  return vectors.filter((v): v is number[] => v !== undefined);
}

/** Library-wide embedding stats for the current model (M2 management UI). */
export interface EmbeddingStats {
  model: string;
  totalChunks: number;
  embeddedChunks: number;
}

export async function embeddingStats(): Promise<EmbeddingStats> {
  const settings = await getSettings();
  const model = settings.embeddingModel;
  const keys = (await db.chunks.toArray()).map((chunk) => embeddingKey(chunk.contentHash, model));
  const rows = await db.embeddings.bulkGet(keys);
  const embedded = rows.filter((row) => row?.model === model).length;
  return { model, totalChunks: keys.length, embeddedChunks: embedded };
}

/** Removes every cached embedding. */
export async function clearEmbeddings(): Promise<void> {
  await db.embeddings.clear();
}

/**
 * Embeds every chunk of the library that is missing an embedding for the
 * current model (M2: whole-library management).
 */
export async function embedWholeLibrary(
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const chunks = await listAllChunks();
  if (chunks.length === 0) return;
  await ensureEmbeddings(chunks, onProgress);
}

/**
 * Ensures every chunk has a cached embedding for the current model; returns
 * hash → vector for all requested chunks. Failures bubble up (callers fall
 * back to keyword-only and notify once).
 */
export async function ensureEmbeddings(
  chunks: readonly RuleChunk[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, Float32Array>> {
  const settings = await getSettings();
  const model = settings.embeddingModel;

  const keys = chunks.map((chunk) => embeddingKey(chunk.contentHash, model));
  const cached = await db.embeddings.bulkGet(keys);
  const result = new Map<string, Float32Array>();
  const missing: RuleChunk[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const row = cached[i];
    const chunk = chunks[i];
    if (chunk === undefined) continue;
    if (row?.model === model) {
      result.set(chunk.contentHash, new Float32Array(row.vector));
    } else {
      missing.push(chunk);
    }
  }

  let done = chunks.length - missing.length;
  for (let i = 0; i < missing.length; i += MAX_BATCH) {
    const batch = missing.slice(i, i + MAX_BATCH);
    const inputs = batch.map((chunk) => chunk.text.slice(0, MAX_CHARS));
    const vectors = await requestEmbeddings(inputs);
    const rows = batch.map((chunk, j) => ({
      contentHash: embeddingKey(chunk.contentHash, model),
      model,
      vector: vectors[j] ?? [],
    }));
    await db.embeddings.bulkPut(rows);
    for (let j = 0; j < batch.length; j += 1) {
      const chunk = batch[j];
      const vector = vectors[j];
      if (chunk !== undefined && vector !== undefined) {
        result.set(chunk.contentHash, new Float32Array(vector));
      }
    }
    done += batch.length;
    onProgress?.(done, chunks.length);
  }
  return result;
}

/** Embeds a short query string (never cached — negligible cost). */
export async function embedQuery(query: string): Promise<Float32Array> {
  const vectors = await requestEmbeddings([query.slice(0, MAX_CHARS)]);
  const vector = vectors[0];
  if (vector === undefined) throw new Error('embedding response is missing the query vector');
  return new Float32Array(vector);
}

/**
 * Cosine similarity over equal-length vectors; plain loop is fine at this
 * scale (03-RETRIEVAL.md).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Wraps an embedding-sensitive operation: failures notify once per session
 * and yield null so the caller can fall back to keyword-only. `searchRules`
 * never rejects for embedding reasons (03-RETRIEVAL.md).
 */
export async function tryEmbeddings<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    notifyFailure(error);
    return null;
  }
}
