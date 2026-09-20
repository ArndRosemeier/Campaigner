import type { Id, RulebookOrigin } from '@/domain';
import { failInterruptedBookImport, listProcessingBooks } from '@/db/rulebookRepo';
import { ingestLockName, isGenerationLockHeld } from '@/lib/generationLocks';
import { toastError } from '@/lib/toast';

/**
 * Interrupted PDF-import reconciliation (docs/17 row 266, docs/18 §2.2).
 *
 * THE defect this exists for: `ingestPdf` creates the Rulebook row BEFORE the
 * extraction (`:57` at the pre-266 base), AppShell reconciles RUNS
 * (`runRepo.failRunningRuns`) and MODULE generations
 * (`llm/moduleGenReconcile`) at start but NOTHING reconciled rulebooks, and
 * the Rules page offers its `Retry…` control only for `status: 'error'`
 * (`RulesPage.tsx:445-458`). So a tab that was reloaded/discarded mid-import —
 * or an extraction the page never came back from — left a row reading
 * `processing…` FOREVER, with no control that could move it. On the iPad this
 * arc protects that is the NORMAL case, not the edge: a large PDF is the
 * common file, and a suspended tab is how a tablet saves memory.
 *
 * THE MECHANISM, AND WHY THIS ONE (the brief offered two; exactly one is
 * implemented): a `'processing'` row is reconciled AT START, exactly as runs
 * and module generations already are. The alternative — create the row only
 * after extraction succeeds — was rejected because it deletes the live row
 * the progress UI is built on (`RulesPage` keys its progress bar off the
 * processing book row) and would have to re-plumb the retry path's identity
 * for a defect whose measured shape is "the row outlives the page", not "the
 * row was born too early". Reconciling extends the ONE existing loud-reconcile
 * idiom instead of inventing a second lifecycle.
 *
 * START is the load-bearing moment, and it is the ONLY moment: a discarded
 * tab RELOADS, and this page has started no import when the shell mounts. It
 * is deliberately NOT run on `onPageResumed` (unlike the module twin): a
 * merely suspended tab RESUMES its own extraction, so failing that row on the
 * way back would invent the very defect this removes — the same reasoning that
 * keeps RUN rows out of the visibility path.
 *
 * The write is LOUD and never a silent reset (AGENTS rules 1–2): the row lands
 * `'error'` with the named sentence below, which says what happened AND which
 * control recovers, and `'error'` is exactly the status the existing `Retry…`
 * menu item is shown on — so the row gains the way forward it never had.
 *
 * The cross-tab LEASE is the SAME seam the module reconcile uses
 * (`lib/generationLocks.isGenerationLockHeld`): `ingestPdf` holds the ingest
 * lock for the whole extraction AND persistence, so a start-up in another tab
 * can tell a row that is genuinely being imported from one nobody owns. When
 * the Web Locks API is absent the read answers `false` and the status re-read
 * inside the write transaction is the only guard — stated in docs/18 §4 rather
 * than pretended away.
 *
 * SCOPE: PDF-origin rows (docs/17 row 266) AND pack-origin rows (docs/17 row
 * 277). Both carry `'processing'`, and the TWO lanes differ in exactly ONE
 * thing — the recovery sentence: a PDF can be re-selected from the file picker,
 * a pack has no file to re-select and is imported/fetched again. So there is ONE
 * reconcile mechanism with a per-lane named message, never a second reconciler:
 * the read (`db/rulebookRepo.listProcessingBooks(origin)`), the write
 * (`db/rulebookRepo.failInterruptedBookImport(id, origin, message)`), the lease
 * guard and the batch loop are shared, and only the sentence and its report line
 * are per-lane.
 *
 * THE PACK LEASE IS REAL, NOT DECORATIVE: `ingest/packImport.importPack` holds
 * `ingestLockName(bookId)` across its whole post-create pass (row 277), exactly
 * as `ingest/ingestFiles.ingestPdf` does. Without that, this file's
 * `isGenerationLockHeld` read would be vacuous on a pack book and a start-up in
 * another tab would falsely fail an import that is genuinely running.
 */

/**
 * The named sentence on the reconciled row — what happened, and what to do
 * about it. One constant, so the card's message and the tests cannot drift
 * from each other.
 */
export const INTERRUPTED_PDF_IMPORT_MESSAGE =
  'This PDF import was interrupted: the page that was reading the file is gone (the tab was ' +
  'reloaded, discarded or closed while the PDF was still being extracted), so nothing is ' +
  'importing it any more. Open this book\'s menu and choose "Retry…", then pick the PDF again.';

/**
 * The PACK lane's sentence (docs/17 row 277). It names the remedy a pack book
 * actually has — re-run the pack's import — and NEVER the PDF one: a pack book
 * has no file to re-select, so "pick the PDF again" would be a lie on it. Kept
 * as its own constant so the two lanes' sentences cannot be confused and the
 * tests can assert their DISAGREEMENT, not merely their text.
 */
export const INTERRUPTED_PACK_IMPORT_MESSAGE =
  'This pack import was interrupted: the page that was importing the pack is gone (the tab was ' +
  'reloaded, discarded or closed while the pack was still being imported), so nothing is ' +
  'importing it any more. Import the pack again — "Import bestiary pack" on the Rules page ' +
  '(or fetch it again from Settings if it came from there).';

/** Can another page (another tab) legitimately be importing this book? */
async function claimedElsewhere(bookId: Id): Promise<boolean> {
  return isGenerationLockHeld(ingestLockName(bookId));
}

/**
 * ONE recoverable lane: the origin it owns, the sentence a reconciled row
 * carries and the loud report it toasts. The two lanes below are the whole of
 * what differs between a PDF import and a pack import.
 */
interface InterruptedImportLane {
  readonly origin: RulebookOrigin;
  readonly message: string;
  readonly report: (count: number) => string;
}

const PDF_LANE: InterruptedImportLane = {
  origin: 'pdf',
  message: INTERRUPTED_PDF_IMPORT_MESSAGE,
  report: (count) => formatInterruptedPdfImportReport(count),
};

const PACK_LANE: InterruptedImportLane = {
  origin: 'pack',
  message: INTERRUPTED_PACK_IMPORT_MESSAGE,
  report: (count) => formatInterruptedPackImportReport(count),
};

/**
 * Reconciles ONE book in ONE lane: `true` when this call failed an interrupted
 * import, `false` when there was nothing to do (gone, no longer `'processing'`,
 * of the other origin, or an import another tab holds the lease on).
 *
 * The lease is read IMMEDIATELY BEFORE the write; the write itself re-reads
 * the status and origin inside its transaction, so a pipeline that finished in
 * between is never overwritten. There is no in-transaction predicate like the
 * module twin's `isClaimed` because this row type has no page-local controller
 * registry to re-check against (nothing in this page can be importing at
 * mount time) — the transaction's own status re-read is the whole guard, and
 * it is what makes the call idempotent.
 */
async function reconcileOne(bookId: Id, lane: InterruptedImportLane): Promise<boolean> {
  if (await claimedElsewhere(bookId)) return false;
  return (
    (await failInterruptedBookImport(bookId, lane.origin, lane.message)) !== undefined
  );
}

/**
 * Reconciles the given books in ONE lane (default: EVERY `'processing'` row of
 * that lane's origin). Returns the ids it actually failed, in row order.
 *
 * `notify` (default true) is the loud half for the paths where the owner is
 * NOT looking at the library — app start; a caller that reports the outcome
 * itself passes `false` and folds the count into its own honest summary
 * instead of double-toasting. One row cannot be seen by both lanes: `origin` is
 * a single stored value, and the write re-checks it inside the transaction, so
 * no row is ever toasted twice.
 */
async function reconcileLane(
  lane: InterruptedImportLane,
  bookIds?: readonly Id[],
  options: { notify?: boolean } = {},
): Promise<Id[]> {
  const targets = bookIds ?? (await listProcessingBooks(lane.origin)).map((book) => book.id);
  const reconciled: Id[] = [];
  for (const bookId of targets) {
    if (await reconcileOne(bookId, lane)) reconciled.push(bookId);
  }
  if (reconciled.length > 0 && options.notify !== false) {
    toastError(lane.report(reconciled.length));
  }
  return reconciled;
}

/** Reconciles ONE PDF-origin book (docs/17 row 266). */
export async function reconcileInterruptedPdfImport(bookId: Id): Promise<boolean> {
  return reconcileOne(bookId, PDF_LANE);
}

/** Reconciles the given PDF books, or every `'processing'` PDF row. */
export async function reconcileInterruptedPdfImports(
  bookIds?: readonly Id[],
  options: { notify?: boolean } = {},
): Promise<Id[]> {
  return reconcileLane(PDF_LANE, bookIds, options);
}

/**
 * Reconciles ONE pack-origin book (docs/17 row 277) — the pack arm of the SAME
 * start-up seam, with the pack lane's own remedy sentence.
 */
export async function reconcileInterruptedPackImport(bookId: Id): Promise<boolean> {
  return reconcileOne(bookId, PACK_LANE);
}

/** Reconciles the given pack books, or every `'processing'` pack row. */
export async function reconcileInterruptedPackImports(
  bookIds?: readonly Id[],
  options: { notify?: boolean } = {},
): Promise<Id[]> {
  return reconcileLane(PACK_LANE, bookIds, options);
}

/** The loud report for `count` reconciled PDF imports (one sentence, no jargon). */
export function formatInterruptedPdfImportReport(count: number): string {
  const plural = count === 1 ? '' : 's';
  return (
    `Interrupted ${String(count)} PDF import${plural} — the page reading ` +
    `${count === 1 ? 'it' : 'them'} was reloaded, discarded or closed, so ` +
    `${count === 1 ? 'it' : 'they'} never finished. Open the book${plural} in the library, ` +
    `choose "Retry…" and pick the PDF again.`
  );
}

/**
 * The loud report for `count` reconciled PACK imports (docs/17 row 277) — the
 * pack counterpart of the sentence above, naming the pack's OWN remedy.
 */
export function formatInterruptedPackImportReport(count: number): string {
  const plural = count === 1 ? '' : 's';
  return (
    `Interrupted ${String(count)} pack import${plural} — the page importing ` +
    `${count === 1 ? 'it' : 'them'} was reloaded, discarded or closed, so ` +
    `${count === 1 ? 'it' : 'they'} never finished. Import the pack${plural} again — ` +
    `"Import bestiary pack" on the Rules page.`
  );
}
