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
import { deleteBookPdf } from '@/db/pdfRepo';
import { NotFoundError } from '@/lib/errors';

export type RulebookPatch = EntityPatch<Rulebook>;

/**
 * Legacy-row guard at the Dexie boundary (the ratified `parseBattleRow`
 * template): rows written before the pack arc lack `origin`/`packMeta` —
 * the schema defaults materialize on read ('pdf'/null, exactly what the
 * pack arc's additive-zod note promises), and a corrupt row fails loudly
 * (AGENTS rules 1+3).
 */
function parseRulebookRow(row: Rulebook): Rulebook {
  return rulebookSchema.parse(row);
}

/** All books, most recently updated first. */
export async function listRulebooks(): Promise<Rulebook[]> {
  const rows = await db.rulebooks.toArray();
  return rows.map(parseRulebookRow).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getRulebook(id: string): Promise<Rulebook | undefined> {
  const row = await db.rulebooks.get(id);
  return row === undefined ? undefined : parseRulebookRow(row);
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
 * Deletes a book, its chunks and its retained PDF bytes. Embeddings are
 * kept: they are content-addressed by chunk-text hash and may be shared
 * across books (pruning is a library-management concern, not a delete
 * concern).
 */
export async function deleteRulebook(id: string): Promise<void> {
  await db.transaction('rw', db.rulebooks, db.chunks, db.pdfFiles, async () => {
    await deleteChunksByBook(id);
    await deleteBookPdf(id);
    await db.rulebooks.delete(id);
  });
}
