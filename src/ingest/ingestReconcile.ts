import type { Id } from '@/domain';
import { failInterruptedPdfImport, listProcessingPdfBooks } from '@/db/rulebookRepo';
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
 * SCOPE: PDF-origin rows only. A pack book also carries `'processing'`, but it
 * has no file to re-select, so the PDF recovery sentence would be wrong on it;
 * the pack lane needs its own recovery affordance and is recorded as owed in
 * docs/18 §5 rather than half-fixed here.
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

/** Can another page (another tab) legitimately be importing this book? */
async function claimedElsewhere(bookId: Id): Promise<boolean> {
  return isGenerationLockHeld(ingestLockName(bookId));
}

/**
 * Reconciles ONE book: `true` when this call failed an interrupted import,
 * `false` when there was nothing to do (gone, no longer `'processing'`, a pack
 * book, or an import another tab holds the lease on).
 *
 * The lease is read IMMEDIATELY BEFORE the write; the write itself re-reads
 * the status and origin inside its transaction, so a pipeline that finished in
 * between is never overwritten. There is no in-transaction predicate like the
 * module twin's `isClaimed` because this row type has no page-local controller
 * registry to re-check against (nothing in this page can be importing at
 * mount time) — the transaction's own status re-read is the whole guard, and
 * it is what makes the call idempotent.
 */
export async function reconcileInterruptedPdfImport(bookId: Id): Promise<boolean> {
  if (await claimedElsewhere(bookId)) return false;
  return (await failInterruptedPdfImport(bookId, INTERRUPTED_PDF_IMPORT_MESSAGE)) !== undefined;
}

/**
 * Reconciles the given books (default: EVERY `'processing'` PDF-origin row).
 * Returns the ids it actually failed, in row order.
 *
 * `notify` (default true) is the loud half for the paths where the owner is
 * NOT looking at the library — app start; a caller that reports the outcome
 * itself passes `false` and folds the count into its own honest summary
 * instead of double-toasting.
 */
export async function reconcileInterruptedPdfImports(
  bookIds?: readonly Id[],
  options: { notify?: boolean } = {},
): Promise<Id[]> {
  const targets = bookIds ?? (await listProcessingPdfBooks()).map((book) => book.id);
  const reconciled: Id[] = [];
  for (const bookId of targets) {
    if (await reconcileInterruptedPdfImport(bookId)) reconciled.push(bookId);
  }
  if (reconciled.length > 0 && options.notify !== false) {
    toastError(formatInterruptedPdfImportReport(reconciled.length));
  }
  return reconciled;
}

/** The loud report for `count` reconciled imports (one sentence, no jargon). */
export function formatInterruptedPdfImportReport(count: number): string {
  const plural = count === 1 ? '' : 's';
  return (
    `Interrupted ${String(count)} PDF import${plural} — the page reading ` +
    `${count === 1 ? 'it' : 'them'} was reloaded, discarded or closed, so ` +
    `${count === 1 ? 'it' : 'they'} never finished. Open the book${plural} in the library, ` +
    `choose "Retry…" and pick the PDF again.`
  );
}
