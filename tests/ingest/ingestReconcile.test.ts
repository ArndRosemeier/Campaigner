import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPackBook,
  createRulebook,
  finalizePackBook,
  getRulebook,
  updateRulebook,
} from '@/db/rulebookRepo';
import { ingestLockName } from '@/lib/generationLocks';
import {
  INTERRUPTED_PACK_IMPORT_MESSAGE,
  INTERRUPTED_PDF_IMPORT_MESSAGE,
  formatInterruptedPackImportReport,
  formatInterruptedPdfImportReport,
  reconcileInterruptedPackImport,
  reconcileInterruptedPackImports,
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

/**
 * The PACK arm of the same reconcile (docs/17 row 277, the row-241 residual).
 *
 * A pack book carries `'processing'` exactly like a PDF import, and a discarded
 * tab leaves it behind the same way — but it has NO file to re-select, so the
 * PDF lane's remedy ("pick the PDF again") would be a lie on it. The pack lane
 * rides the SAME seam (ONE read parameterized by origin, ONE transaction, ONE
 * lease guard, ONE batch loop) and differs only in its named sentence and its
 * report line. These pins hold that: the pack sentence is its own and names the
 * pack's real remedy, each lane leaves the other's rows alone, and the lease
 * guard is the same one — non-vacuous because `importPack` holds it.
 */
describe('interrupted PACK import reconciliation (docs/17 row 277)', () => {
  async function seedProcessingPackBook(): Promise<string> {
    const book = await createPackBook({
      title: 'bestiary-pack',
      system: 'dnd5e',
      filename: 'pack.json',
    });
    expect(book.status).toBe('processing');
    return book.id;
  }

  it("fails a processing pack row with the PACK lane's own sentence, never the PDF one", async () => {
    const bookId = await seedProcessingPackBook();

    expect(await reconcileInterruptedPackImport(bookId)).toBe(true);

    const row = await getRulebook(bookId);
    expect(row?.status).toBe('error');
    expect(row?.errorMessage).toBe(INTERRUPTED_PACK_IMPORT_MESSAGE);
    // The remedy names the REAL way forward — import the pack again — and the
    // two lanes' sentences must differ: the PDF one would tell the owner to
    // re-select a PDF that does not exist.
    expect(INTERRUPTED_PACK_IMPORT_MESSAGE).not.toBe(INTERRUPTED_PDF_IMPORT_MESSAGE);
    expect(INTERRUPTED_PACK_IMPORT_MESSAGE).toContain('Import the pack again');
    expect(INTERRUPTED_PACK_IMPORT_MESSAGE).toContain('"Import bestiary pack"');
    expect(INTERRUPTED_PACK_IMPORT_MESSAGE).not.toContain('Retry');

    // Idempotent: the row is no longer processing.
    expect(await reconcileInterruptedPackImport(bookId)).toBe(false);
    expect((await getRulebook(bookId))?.errorMessage).toBe(INTERRUPTED_PACK_IMPORT_MESSAGE);
  });

  it("the two lanes never touch each other's rows (the origin re-read)", async () => {
    const packId = await seedProcessingPackBook();
    const pdfId = await seedProcessingPdfBook();

    expect(await reconcileInterruptedPdfImports([packId, pdfId])).toEqual([pdfId]);
    expect((await getRulebook(packId))?.status).toBe('processing');
    expect((await getRulebook(pdfId))?.errorMessage).toBe(INTERRUPTED_PDF_IMPORT_MESSAGE);

    const packId2 = await seedProcessingPackBook();
    const pdfId2 = await seedProcessingPdfBook();
    expect(await reconcileInterruptedPackImports([pdfId2, packId2])).toEqual([packId2]);
    expect((await getRulebook(pdfId2))?.status).toBe('processing');
    expect((await getRulebook(packId2))?.errorMessage).toBe(INTERRUPTED_PACK_IMPORT_MESSAGE);
  });

  it('leaves a pack row another tab is importing alone (the SAME held lease)', async () => {
    const bookId = await seedProcessingPackBook();
    const held: string[] = [ingestLockName(bookId)];
    stubHeldIngestLock(held);

    expect(await reconcileInterruptedPackImports([bookId])).toEqual([]);
    expect((await getRulebook(bookId))?.status).toBe('processing');
    expect(toastErrorMock).not.toHaveBeenCalled();

    // …and with the lease released the very same row IS reconciled.
    held.length = 0;
    expect(await reconcileInterruptedPackImports([bookId])).toEqual([bookId]);
    expect((await getRulebook(bookId))?.status).toBe('error');
  });

  it('reads its own origin population, so a start-up reconciles both lanes', async () => {
    const packId = await seedProcessingPackBook();
    const pdfId = await seedProcessingPdfBook();

    expect(await reconcileInterruptedPdfImports()).toEqual([pdfId]);
    expect(await reconcileInterruptedPackImports()).toEqual([packId]);
    expect((await getRulebook(pdfId))?.errorMessage).toBe(INTERRUPTED_PDF_IMPORT_MESSAGE);
    expect((await getRulebook(packId))?.errorMessage).toBe(INTERRUPTED_PACK_IMPORT_MESSAGE);
  });

  it('reports a pack batch loudly, once, with the pack remedy', async () => {
    const first = await seedProcessingPackBook();
    const second = await seedProcessingPackBook();

    expect((await reconcileInterruptedPackImports()).sort()).toEqual([first, second].sort());
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(String(toastErrorMock.mock.calls[0]?.[0])).toContain('Interrupted 2 pack imports');
    expect(formatInterruptedPackImportReport(1)).toContain('Interrupted 1 pack import —');
    expect(formatInterruptedPackImportReport(1)).toContain(
      '"Import bestiary pack" on the Rules page',
    );
    expect(formatInterruptedPackImportReport(2)).toContain('Import the packs again');

    toastErrorMock.mockClear();
    await updateRulebook(first, { status: 'processing', errorMessage: '' });
    expect(await reconcileInterruptedPackImports([first], { notify: false })).toEqual([first]);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('never overwrites a pack row that finished between the read and the write', async () => {
    const bookId = await seedProcessingPackBook();
    await finalizePackBook(bookId, {
      sourceId: 'test-pack',
      license: 'CC-BY-4.0',
      entriesImported: 1,
      entriesSkipped: 0,
      entriesFailed: 0,
    });

    expect(await reconcileInterruptedPackImport(bookId)).toBe(false);
    const row = await getRulebook(bookId);
    expect(row?.status).toBe('ready');
    expect(row?.errorMessage).toBe('');
  });
});
