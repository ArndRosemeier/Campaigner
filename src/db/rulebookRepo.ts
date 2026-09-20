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
  type RulebookOrigin,
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

/**
 * Default book resolution for a query without explicit `bookIds`: every
 * `'ready'` book, optionally restricted to one game system (the
 * campaign-scoped citable pool — pack books and PDF books alike carry
 * `system`).
 *
 * IT LIVES HERE, BESIDE THE ROWS IT FILTERS (docs/17 row 184). It was defined
 * in `search/search.ts` and re-exported from the `@/search` barrel; the spell
 * arc's corpus read (`db/spellRepo`) needed the same answer, and a `db` module
 * importing the RETRIEVAL barrel is both a layering inversion and a live
 * coupling — MEASURED: three LLM tests mock `@/search` with only
 * `searchRules`, so `readyBookIds` arrived `undefined` and every stat-block run
 * threw. The rule now sits where the books are; `@/search` re-exports it, so
 * every existing caller (`features/spells/SpellsPage`, `searchRules` itself)
 * is unchanged and there is still exactly ONE spelling.
 */
/**
 * THE ready-book rule — the ONE spelling (docs/17 row 255c), shaped as a FILTER
 * so a Dexie TRANSACTION can use it: the copy-on-write spell lookup inside
 * `db/mobCopyRepair` cannot call the `db`-bound `listReadyRulebooks` from an
 * upgrade body, re-spelled the predicate, and `ready-book-seam.test.ts` reds a
 * second spelling by file name. The predicate stays spelled as the filter arrow
 * this file has always carried, because that spelling IS what the pin's needle
 * names — so the rule moved into a shared filter rather than into a named
 * boolean, and both callers go through it.
 */
export function readyBooksOf<T extends Pick<Rulebook, 'status' | 'system'>>(
  books: readonly T[],
  system?: GameSystem,
): T[] {
  return books.filter(
    (book) => book.status === 'ready' && (system === undefined || book.system === system),
  );
}

export async function listReadyRulebooks(system?: GameSystem): Promise<Rulebook[]> {
  return readyBooksOf(await listRulebooks(), system);
}

/** The same answer as IDs — the shape a chunk read takes. */
export async function readyBookIds(system?: GameSystem): Promise<Id[]> {
  return (await listReadyRulebooks(system)).map((book) => book.id);
}

/** Total book count (onboarding detection). */
export async function countRulebooks(): Promise<number> {
  return db.rulebooks.count();
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
 * Every book of ONE origin whose persisted status is `'processing'` (docs/17
 * row 266 for PDFs, extended to packs by row 277) — the population the
 * start-up reconcile owns.
 *
 * The `status` INDEX is read (the table carries one), and the `origin` split is
 * applied after the parse because the two lanes need DIFFERENT recovery
 * sentences: a PDF book can be re-selected from the file picker, a pack book
 * has no file to re-select and is re-imported/ re-fetched instead. It is ONE
 * read parameterized by origin rather than one read per lane — the lanes differ
 * only in their message, and two near-identical reads would be the drift
 * AGENTS rule 4 forbids.
 */
export async function listProcessingBooks(origin: RulebookOrigin): Promise<Rulebook[]> {
  const rows = await db.rulebooks.where('status').equals('processing').toArray();
  return rows.map(parseRulebookRow).filter((book) => book.origin === origin);
}

/**
 * The interrupted-import reconcile write (docs/17 row 266, one write for BOTH
 * origins since row 277): marks a book of the given origin whose row still says
 * `'processing'` as `'error'` with `errorMessage` — the status the Rules page
 * already shows its failure copy on, so the row stops being a
 * forever-`processing…` card and becomes a named failure with a way forward.
 *
 * The status and origin are re-read INSIDE the transaction, so a pipeline that
 * finished between the reconcile's read and this write (or a row of the other
 * origin) is left alone: the write is idempotent, and after it lands the row is
 * no longer `'processing'`.
 *
 * Returns the failed row, or `undefined` when there was nothing to fail. The
 * CROSS-TAB lease is deliberately NOT read here (it is async, and the module
 * twin's in-transaction predicate exists for a page-local registry this row
 * type has none of) — the caller reads `isGenerationLockHeld` before opening
 * the transaction; see `ingest/ingestReconcile`.
 */
export async function failInterruptedBookImport(
  id: Id,
  origin: RulebookOrigin,
  errorMessage: string,
): Promise<Rulebook | undefined> {
  return db.transaction('rw', db.rulebooks, async () => {
    const current = await db.rulebooks.get(id);
    if (current === undefined) return undefined;
    const book = parseRulebookRow(current);
    if (book.status !== 'processing' || book.origin !== origin) return undefined;
    const updated = rulebookSchema.parse({
      ...book,
      status: 'error',
      errorMessage,
      updatedAt: Date.now(),
    });
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
