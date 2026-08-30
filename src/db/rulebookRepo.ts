import {
  createRulebook as buildRulebook,
  rulebookSchema,
  type EntityPatch,
  type NewRulebook,
  type Rulebook,
} from '@/domain';
import { db } from '@/db/db';
import { deleteChunksByBook } from '@/db/chunkRepo';
import { NotFoundError } from '@/lib/errors';

export type RulebookPatch = EntityPatch<Rulebook>;

/** All books, most recently updated first. */
export async function listRulebooks(): Promise<Rulebook[]> {
  const rows = await db.rulebooks.toArray();
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getRulebook(id: string): Promise<Rulebook | undefined> {
  return db.rulebooks.get(id);
}

export async function createRulebook(input: NewRulebook): Promise<Rulebook> {
  const rulebook = buildRulebook(input);
  await db.rulebooks.put(rulebook);
  return rulebook;
}

export async function updateRulebook(id: string, patch: RulebookPatch): Promise<Rulebook> {
  return db.transaction('rw', db.rulebooks, async () => {
    const current = await db.rulebooks.get(id);
    if (!current) throw new NotFoundError('Rulebook', id);
    const updated = rulebookSchema.parse({ ...current, ...patch, updatedAt: Date.now() });
    await db.rulebooks.put(updated);
    return updated;
  });
}

/**
 * Deletes a book and its chunks. Embeddings are kept: they are
 * content-addressed by chunk-text hash and may be shared across books
 * (pruning is a library-management concern, not a delete concern).
 */
export async function deleteRulebook(id: string): Promise<void> {
  await db.transaction('rw', db.rulebooks, db.chunks, async () => {
    await deleteChunksByBook(id);
    await db.rulebooks.delete(id);
  });
}
