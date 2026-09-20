import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPackBook, createRulebook, getRulebook, updateRulebook } from '@/db/rulebookRepo';
import { ingestLockName } from '@/lib/generationLocks';
import {
  INTERRUPTED_PDF_IMPORT_MESSAGE,
  formatInterruptedPdfImportReport,
  reconcileInterruptedPdfImport,
  reconcileInterruptedPdfImports,
} from '@/ingest/ingestReconcile';
import { clearDatabase } from '../db/helpers';

/**
 * Interrupted PDF-import reconciliation (docs/17 row 266).
 *
 * THE defect: a PDF import creates its Rulebook row BEFORE the extraction, so
 * a tab reloaded/discarded mid-import — or an extraction the page never came
 * back from — left a row reading `processing…` forever, and the Rules page
 * offers its `Retry…` control only for `status: 'error'`. Nothing reconciled
 * rulebooks, although runs and module generations are both reconciled at
 * start. These pins hold the START-time reconcile: a named failure on the row
 * (which IS the status Retry appears on), a row another tab's ingest lease
 * covers left alone, pack rows untouched, and a batch that is loud once.
 *
 * jsdom has no device: it cannot suspend a tab or measure the memory a
 * double-hold costs. What is mechanizable is the ROW STATE the reconcile
 * leaves and the lease guard; the tab-discard behaviour itself is the owner's
 * iPad (docs/18 §5).
 */

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

/** A row in exactly the state a tab discarded mid-extraction leaves behind. */
async function seedProcessingPdfBook(): Promise<string> {
  const book = await createRulebook({
    title: 'torn-scan',
    system: 'dnd5e',
    filename: 'torn.pdf',
  });
  expect(book.status).toBe('processing');
  return book.id;
}

/** The ingest lease held by ANOTHER tab, as `navigator.locks.query` sees it. */
function stubHeldIngestLock(names: string[]): void {
  vi.stubGlobal('navigator', {
    locks: {
      request: (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback(),
      query: () => Promise.resolve({ held: names.map((name) => ({ name })), pending: [] }),
    },
  });
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('interrupted PDF import reconciliation', () => {
  it('fails a processing row with the named sentence — the status Retry… is offered on', async () => {
    const bookId = await seedProcessingPdfBook();

    expect(await reconcileInterruptedPdfImport(bookId)).toBe(true);

    const row = await getRulebook(bookId);
    expect(row?.status).toBe('error');
    expect(row?.errorMessage).toBe(INTERRUPTED_PDF_IMPORT_MESSAGE);
    // The sentence says what happened AND names the control that recovers it,
    // because the row's whole defect was having no way forward.
    expect(INTERRUPTED_PDF_IMPORT_MESSAGE).toContain('was interrupted');
    expect(INTERRUPTED_PDF_IMPORT_MESSAGE).toContain('tab was reloaded, discarded or closed');
    expect(INTERRUPTED_PDF_IMPORT_MESSAGE).toContain('"Retry…"');

    // Idempotent: the row is no longer processing, so a second pass is a no-op.
    expect(await reconcileInterruptedPdfImport(bookId)).toBe(false);
  });

  it('leaves a row another tab is importing alone (the held ingest lease)', async () => {
    const bookId = await seedProcessingPdfBook();
    const held: string[] = [ingestLockName(bookId)];
    stubHeldIngestLock(held);

    expect(await reconcileInterruptedPdfImports([bookId])).toEqual([]);
    expect((await getRulebook(bookId))?.status).toBe('processing');
    expect(toastErrorMock).not.toHaveBeenCalled();

    // …and with the lease released the very same row IS reconciled: the lease
    // is the only reason it survived, so the guard is not vacuous.
    held.length = 0;
    expect(await reconcileInterruptedPdfImports([bookId])).toEqual([bookId]);
    expect((await getRulebook(bookId))?.status).toBe('error');
  });

  it('leaves a ready row and a processing PACK book untouched', async () => {
    const ready = await createRulebook({
      title: 'emberfall-core',
      system: 'dnd5e',
      filename: 'core.pdf',
    });
    await updateRulebook(ready.id, { status: 'ready' });
    // A pack book also says 'processing', but it has no PDF to re-select, so
    // the PDF recovery sentence would be a lie on it (its own slice is owed —
    // docs/18 §5).
    const pack = await createPackBook({
      title: 'bestiary-pack',
      system: 'dnd5e',
      filename: 'pack.json',
    });

    expect(await reconcileInterruptedPdfImports()).toEqual([]);
    expect((await getRulebook(ready.id))?.status).toBe('ready');
    expect((await getRulebook(pack.id))?.status).toBe('processing');
    expect((await getRulebook(pack.id))?.errorMessage).toBe('');
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('reports a batch loudly, once, and stays silent when asked to', async () => {
    const first = await seedProcessingPdfBook();
    const second = await seedProcessingPdfBook();

    expect((await reconcileInterruptedPdfImports()).sort()).toEqual([first, second].sort());
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(String(toastErrorMock.mock.calls[0]?.[0])).toContain('Interrupted 2 PDF imports');
    expect(formatInterruptedPdfImportReport(1)).toContain('Interrupted 1 PDF import —');
    expect(formatInterruptedPdfImportReport(1)).toContain('Open the book in the library');
    expect(formatInterruptedPdfImportReport(2)).toContain('Open the books in the library');

    toastErrorMock.mockClear();
    await updateRulebook(first, { status: 'processing', errorMessage: '' });
    const quiet = await reconcileInterruptedPdfImports([first], { notify: false });
    expect(quiet).toEqual([first]);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('never overwrites a row a pipeline finished between the read and the write', async () => {
    const bookId = await seedProcessingPdfBook();
    // The extraction landed ready before the reconcile's write transaction:
    // the in-transaction status re-read must leave it alone.
    await updateRulebook(bookId, { status: 'ready' });

    expect(await reconcileInterruptedPdfImport(bookId)).toBe(false);
    const row = await getRulebook(bookId);
    expect(row?.status).toBe('ready');
    expect(row?.errorMessage).toBe('');
  });
});
