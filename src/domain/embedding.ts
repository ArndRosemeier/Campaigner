import { z } from 'zod';

/**
 * Content-addressed embedding cache (01-DATA-MODEL §ChunkEmbedding). Keyed by
 * the SHA-256 of the chunk text, so identical text across books/models is
 * stored once per model.
 */
export const chunkEmbeddingSchema = z.object({
  contentHash: z.string(),
  /** Embedding model id used. */
  model: z.string(),
  /** Stored as a plain array; Float32Array in memory. */
  vector: z.array(z.number()),
});

export type ChunkEmbedding = z.infer<typeof chunkEmbeddingSchema>;
