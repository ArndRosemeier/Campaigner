import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PDF_MAX_BYTES } from '@/domain';
import type * as PdfRepo from '@/db/pdfRepo';
import { getBookPdf } from '@/db/pdfRepo';
import { listRulebooks } from '@/db/rulebookRepo';
import type { IngestRequest } from '@/workers/ingest.worker';
import { clearDatabase } from '../db/helpers';
import { ingestBuffers, ingestPdf } from '@/ingest/ingestFiles';

/**
 * Ingest retention (source-viewers arc): a successful ingest retains the
 * original bytes in `pdfFiles`; a failed ingest retains nothing; the
 * per-PDF size cap rejects loudly BEFORE any book row exists. Tests run the
 * pipeline inline (no Worker in jsdom) against the committed fixture PDF.
 *
 * The "held ONCE" half (docs/17 row 266) is pinned twice: `ingestBuffers` is
 * the pure decision (with a Worker the buffer the pipeline consumes IS the
 * buffer this thread retains — the worker gets a structured clone — and only
 * the in-process path copies, which is what pdfjs's transfer forces there),
 * and the worker-path test asserts the END-TO-END property that would fail on
 * the pre-266 shape: the buffer handed to the worker is the very buffer
 * `putBookPdf` retains. **jsdom cannot measure real memory pressure or a tab
 * suspension**, so these identity/copy assertions are the mechanizable reach
 * and the device is the proof (docs/18 §5).
 *
 * `putBookPdf` is a passthrough spy (the real write still happens) so that
 * identity is observable at the seam where the retention is handed over.
 */
vi.mock('@/db/pdfRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof PdfRepo>();
  return { ...actual, putBookPdf: vi.fn(actual.putBookPdf) };
});

const { putBookPdf } = await import('@/db/pdfRepo');
const putBookPdfMock = vi.mocked(putBookPdf);


const fixturePath = join(import.meta.dirname, '..', 'fixtures', 'sample-rulebook.pdf');
const fixtureBytes = readFileSync(fixturePath);

function fixtureFile(name = 'sample-rulebook.pdf'): File {
  return new File([new Uint8Array(fixtureBytes)], name, { type: 'application/pdf' });
}

/** The real worker protocol, answered in-thread: jsdom has no `Worker`. The
 * constructor is the platform's own (the URL and options passed are real);
 * only the THREAD boundary is faked. */
class FakeIngestWorker {
  static readonly requests: IngestRequest[] = [];

  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

  onerror: ((event: { message: string }) => void) | null = null;

  postMessage(request: IngestRequest): void {
    FakeIngestWorker.requests.push(request);
    queueMicrotask(() => {
      this.onmessage?.({
        data: { kind: 'done', bookId: request.bookId, chunks: [], pageCount: 1, emptyPages: 0 },
      } as MessageEvent<unknown>);
    });
  }

  terminate(): void {
    // Nothing to tear down in-thread.
  }
}

describe('ingestPdf retention', () => {
  beforeEach(clearDatabase);

  it('retains the original bytes, filename and mime type on success', async () => {
    const result = await ingestPdf(fixtureFile(), 'dnd5e');
    expect(result.book.status).toBe('ready');

    const pdf = await getBookPdf(result.book.id);
    expect(pdf).toBeDefined();
    expect(pdf?.filename).toBe('sample-rulebook.pdf');
    expect(pdf?.mimeType).toBe('application/pdf');
    expect(pdf?.sizeBytes).toBe(fixtureBytes.byteLength);
    expect(Array.from(pdf?.bytes ?? [])).toEqual(Array.from(fixtureBytes));
  }, 30000);

  it('retains nothing when the ingest fails (error book, no bytes)', async () => {
    // A "%PDF" header with no body is a loud pipeline failure.
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'broken.pdf', {
      type: 'application/pdf',
    });
    await expect(ingestPdf(file, 'dnd5e')).rejects.toThrow();

    const books = await listRulebooks();
    expect(books).toHaveLength(1); // the error row stays for its message
    const book = books[0];
    if (book === undefined) throw new Error('error book row is missing');
    expect(book.status).toBe('error');
    expect(await getBookPdf(book.id)).toBeUndefined();
  }, 30000);

  it('rejects an oversized file loudly before creating any book row', async () => {
    const file = fixtureFile('huge.pdf');
    Object.defineProperty(file, 'size', { value: PDF_MAX_BYTES + 1 });

    await expect(ingestPdf(file, 'dnd5e')).rejects.toThrow(/import limit is 250 MB/);
    expect(await listRulebooks()).toHaveLength(0);
  });
});

describe('the PDF is held ONCE (docs/17 row 266)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    putBookPdfMock.mockClear();
    FakeIngestWorker.requests.length = 0;
  });

  it('hands the worker the SAME buffer it retains — no second main-thread copy', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { retained, pipeline } = ingestBuffers(bytes, true);

    // This is the pin the pre-266 shape fails: it took `arrayBuffer.slice(0)`
    // up front, so the retained copy and the buffer the pipeline consumed were
    // two full-size allocations alive at once for the whole extraction.
    expect(pipeline).toBe(retained.buffer);
    expect(retained).toBe(bytes);
  });

  it('copies ONLY for the in-process pipeline, because pdfjs detaches what it is given', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { retained, pipeline } = ingestBuffers(bytes, false);

    expect(pipeline).not.toBe(retained.buffer);
    // Exactly what pdfjs's transfer does to the buffer it is handed…
    structuredClone(pipeline, { transfer: [pipeline] });
    expect(pipeline.byteLength).toBe(0);
    // …the retained copy survives it, which is why this path must copy at all.
    expect(Array.from(retained)).toEqual([1, 2, 3, 4]);
  });

  it('retains the file through the worker path, whose buffer is NOT detached by posting it', async () => {
    vi.stubGlobal('Worker', FakeIngestWorker);

    const result = await ingestPdf(fixtureFile(), 'dnd5e');

    expect(result.book.status).toBe('ready');
    expect(FakeIngestWorker.requests).toHaveLength(1);
    const request = FakeIngestWorker.requests[0];
    if (request === undefined) throw new Error('the worker never received the request');
    // The worker got the real file bytes (a clone), and this thread's copy is
    // still whole — which is what lets the SAME buffer be retained below.
    expect(Array.from(new Uint8Array(request.arrayBuffer))).toEqual(Array.from(fixtureBytes));
    expect(request.arrayBuffer.byteLength).toBe(fixtureBytes.byteLength);

    // THE PIN THE PRE-266 SHAPE FAILS: the buffer the pipeline consumed and the
    // bytes retained in `pdfFiles` are ONE allocation, not two copies alive at
    // once for the whole extraction.
    const retained = putBookPdfMock.mock.calls[0]?.[0].bytes;
    expect(retained?.buffer).toBe(request.arrayBuffer);

    const pdf = await getBookPdf(result.book.id);
    expect(pdf?.sizeBytes).toBe(fixtureBytes.byteLength);
    expect(Array.from(pdf?.bytes ?? [])).toEqual(Array.from(fixtureBytes));
  }, 30000);
});

