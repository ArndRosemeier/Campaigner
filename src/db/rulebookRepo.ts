import {
  createRulebook as buildRulebook,
  rulebookSchema,
  stampNewEntity,
  type EntityPatch,
  type GameSystem,
  type Id,
  type NewRulebook,
  type PackMeta,
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

/**
 * Pack-book lifecycle (12-BESTIARY-PACKS §6). Pack rows are ordinary
 * rulebooks (`origin: 'pack'`) — the same schema, table and repo as PDFs;
 * only the creation/finalization inputs differ.
 */
export async function createPackBook(input: {
  title: string;
  system: GameSystem;
  filename: string;
}): Promise<Rulebook> {
  const book = rulebookSchema.parse({
    ...stampNewEntity(),
    title: input.title,
    system: input.system,
    filename: input.filename,
    pageCount: 0,
    status: 'processing',
    errorMessage: '',
    origin: 'pack',
    packMeta: null,
  });
  await db.rulebooks.put(book);
  return book;
}

/** Marks a finished pack book ready and stores its import report. */
export async function finalizePackBook(id: Id, packMeta: PackMeta): Promise<Rulebook> {
  return db.transaction('rw', db.rulebooks, async () => {
    const current = await db.rulebooks.get(id);
    if (current === undefined) throw new NotFoundError('Rulebook', id);
    const updated = rulebookSchema.parse({
      ...current,
      status: 'ready',
      packMeta,
      updatedAt: Date.now(),
    });
    await db.rulebooks.put(updated);
    return updated;
  });
}

/** Marks a failed import (zero valid entries) with a loud errorMessage. */
export async function failPackBook(id: Id, message: string): Promise<void> {
  await db.transaction('rw', db.rulebooks, async () => {
    const current = await db.rulebooks.get(id);
    if (current === undefined) throw new NotFoundError('Rulebook', id);
    const updated = rulebookSchema.parse({
      ...current,
      status: 'error',
      errorMessage: message,
      updatedAt: Date.now(),
    });
    await db.rulebooks.put(updated);
  });
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
