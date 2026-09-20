import { stampNewEntity, type Id } from '@/domain/entity';
import type { GameSystem } from '@/domain/gameSystem';
import { PDF_MAX_BYTES } from '@/domain/pdf';
import { ruleChunkSchema, type Rulebook } from '@/domain/rulebook';
import { putChunks } from '@/db/chunkRepo';
import { putBookPdf } from '@/db/pdfRepo';
import { createRulebook, updateRulebook } from '@/db/rulebookRepo';
import { ingestLockName, withGenerationLock } from '@/lib/generationLocks';
import { runIngestPipeline } from '@/ingest/pipeline';
import type { IngestRequest, IngestResponse } from '@/workers/ingest.worker';
import { errorMessage } from '@/lib/errors';

/**
 * Main-thread orchestration (02-INGESTION.md flow): creates the Rulebook row,
 * runs the pipeline in a worker, forwards progress, persists chunks on
 * success, and marks the book 'error' on failure. The original PDF bytes are
 * RETAINED in the `pdfFiles` table on success (source-viewers arc — the
 * in-app viewer renders them; retention happens here, never via a later
 * attach: there is no path that hands a file to an existing book).
 * Environments without Worker (tests) run the same pipeline inline.
 *
 * THE FILE IS READ ONCE (docs/17 row 266). `ingestBuffers` is the ONE place
 * that decides which buffer the pipeline consumes, so a large PDF is held in
 * THIS thread exactly once for the whole extraction — the pre-266 shape took
 * `arrayBuffer.slice(0)` up front and kept two full copies alive on the main
 * thread for minutes, which is the memory an iPad tab suspension is made of.
 * The extraction also holds the ingest lease (`lib/generationLocks`), which
 * makes the row's `'processing'` status a claim another tab's start-up
 * reconciler can check rather than guess at (docs/17 row 266).
 */

export interface IngestProgress {
  bookId: Id;
  page: number;
  pageCount: number;
}

export interface IngestResult {
  book: Rulebook;
  chunkCount: number;
  /** Pages with no extractable text (scanned PDFs) — the UI warns when > 0. */
  emptyPages: number;
}

/**
 * The ONE decision about which buffer the pipeline is handed (docs/17 row
 * 266) — pure, so the "held once" property is testable without a device.
 *
 * `retained` is the single main-thread copy of the PDF and is what `pdfFiles`
 * stores on success. `pipeline` is what the extraction consumes:
 *
 * - WITH a Worker, it is that SAME buffer — `postMessage` without a transfer
 *   list STRUCTURED-CLONES it, so the worker (and pdfjs inside it) detaches
 *   its own clone and this thread's copy survives untouched. No copy is made
 *   here.
 * - WITHOUT a Worker (tests, older browsers) pdfjs runs IN this thread and
 *   transfers the buffer it is given to its own worker, DETACHING it — so the
 *   in-process path hands over a copy, and only then. One extra copy in an
 *   environment with no worker boundary is inherent; an extra copy in the
 *   production worker path is the double-hold this slice removes.
 */
export interface IngestBuffers {
  retained: Uint8Array<ArrayBuffer>;
  pipeline: ArrayBuffer;
}

export function ingestBuffers(bytes: Uint8Array<ArrayBuffer>, inWorker: boolean): IngestBuffers {
  if (inWorker) return { retained: bytes, pipeline: bytes.buffer };
  const copy = bytes.slice();
  return { retained: bytes, pipeline: copy.buffer };
}

/** Strips the .pdf extension for the default book title. */
export function titleFromFilename(filename: string): string {
  return filename.replace(/\.pdf$/i, '').trim() || 'Untitled rulebook';
}

export async function ingestPdf(
  file: File,
  system: GameSystem,
  onProgress?: (progress: IngestProgress) => void,
): Promise<IngestResult> {
  // Per-PDF cap (source-viewers arc): fail loudly BEFORE any row exists and
  // before the multi-minute extraction runs on a pathological file.
  if (file.size > PDF_MAX_BYTES) {
    const mb = Math.round(file.size / (1024 * 1024));
    const capMb = Math.round(PDF_MAX_BYTES / (1024 * 1024));
    throw new Error(`"${file.name}" is ${String(mb)} MB — the per-PDF import limit is ${String(capMb)} MB`);
  }
  // ONE read, ONE main-thread copy (docs/17 row 266): the read buffer is what
  // gets retained, and `ingestBuffers` decides what the pipeline consumes.
  const retainedBytes = new Uint8Array(await file.arrayBuffer());
  const inWorker = typeof Worker !== 'undefined';
  const { pipeline } = ingestBuffers(retainedBytes, inWorker);
  const book = await createRulebook({
    title: titleFromFilename(file.name),
    system,
    filename: file.name,
    pageCount: 0,
  });

  const trackProgress = (page: number, pageCount: number): void => {
    onProgress?.({ bookId: book.id, page, pageCount });
  };

  try {
    // The ingest LEASE (docs/17 row 266) is held across the extraction AND
    // the persistence, so `ingest/ingestReconcile` can tell a live import
    // (this page or another tab) from a row a discarded tab left behind.
    // Advisory, like every generation lock: with no Web Locks API the work
    // runs directly and the reconcile's guard is the status re-read alone.
    return await withGenerationLock(ingestLockName(book.id), async () => {
      const result = inWorker
        ? await runInWorker({ bookId: book.id, arrayBuffer: pipeline, system }, trackProgress)
        : await runIngestPipeline(pipeline, system, trackProgress);

      const base = Date.now();
      const chunks = result.chunks.map((draft, index) =>
        ruleChunkSchema.parse({
          ...draft,
          ...stampNewEntity(base + index),
          bookId: book.id,
        }),
      );
      await putChunks(chunks);
      // Retain the original bytes (source-viewers arc): the ONE copy read
      // above, written after the chunks persist so a failed run leaves no
      // bytes behind. Re-ingest replaces via the `&bookId` unique index — one
      // row per book, always.
      await putBookPdf({
        bookId: book.id,
        bytes: retainedBytes,
        filename: file.name,
        mimeType: file.type === '' ? 'application/pdf' : file.type,
      });
      const ready = await updateRulebook(book.id, {
        status: 'ready',
        pageCount: result.pageCount,
      });
      return { book: ready, chunkCount: chunks.length, emptyPages: result.emptyPages };
    });
  } catch (error) {
    const message = errorMessage(error);
    await updateRulebook(book.id, { status: 'error', errorMessage: message });
    throw error;
  }
}

type DoneResponse = Extract<IngestResponse, { kind: 'done' }>;

/** Runs the pipeline in a module worker, resolving the final response. */
function runInWorker(
  request: IngestRequest,
  onProgress: (page: number, pageCount: number) => void,
): Promise<Omit<DoneResponse, 'kind'>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/ingest.worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event: MessageEvent<IngestResponse>) => {
      const message = event.data;
      if (message.bookId !== request.bookId) return;
      if (message.kind === 'progress') {
        onProgress(message.page, message.pageCount);
        return;
      }
      worker.terminate();
      if (message.kind === 'done') {
        const { kind: _kind, ...result } = message;
        resolve(result);
      } else {
        reject(new Error(message.message));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message === '' ? 'Ingestion worker crashed' : event.message));
    };

    worker.postMessage(request);
  });
}
