import { chunkEmbeddingSchema, type ChunkEmbedding } from '@/domain';
import { db } from '@/db/db';

export async function getEmbedding(contentHash: string): Promise<ChunkEmbedding | undefined> {
  return db.embeddings.get(contentHash);
}

export async function getEmbeddings(contentHashes: string[]): Promise<ChunkEmbedding[]> {
  const rows = await db.embeddings.bulkGet(contentHashes);
  return rows.filter((row): row is ChunkEmbedding => row !== undefined);
}

export async function putEmbedding(embedding: ChunkEmbedding): Promise<void> {
  await db.embeddings.put(chunkEmbeddingSchema.parse(embedding));
}

export async function deleteEmbedding(contentHash: string): Promise<void> {
  await db.embeddings.delete(contentHash);
}
