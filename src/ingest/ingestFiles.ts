import { stampNewEntity, type Id } from '@/domain/entity';
import type { GameSystem } from '@/domain/gameSystem';
import { ruleChunkSchema, type Rulebook } from '@/domain/rulebook';
import { putChunks } from '@/db/chunkRepo';
import { createRulebook, updateRulebook } from '@/db/rulebookRepo';
import { runIngestPipeline } from '@/ingest/pipeline';
import type { IngestRequest, IngestResponse } from '@/workers/ingest.worker';
import { errorMessage } from '@/lib/errors';

/**
 * Main-thread orchestration (02-INGESTION.md flow): creates the Rulebook row,
 * runs the pipeline in a worker, forwards progress, persists chunks on
 * success, and marks the book 'error' on failure. Original bytes are never
 * stored. Environments without Worker (tests) run the same pipeline inline.
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

/** Strips the .pdf extension for the default book title. */
export function titleFromFilename(filename: string): string {
  return filename.replace(/\.pdf$/i, '').trim() || 'Untitled rulebook';
}

export async function ingestPdf(
  file: File,
  system: GameSystem,
  onProgress?: (progress: IngestProgress) => void,
): Promise<IngestResult> {
  const arrayBuffer = await file.arrayBuffer();
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
    const result =
      typeof Worker === 'undefined'
        ? await runIngestPipeline(arrayBuffer, system, trackProgress)
        : await runInWorker({ bookId: book.id, arrayBuffer, system }, trackProgress);

    const base = Date.now();
    const chunks = result.chunks.map((draft, index) =>
      ruleChunkSchema.parse({
        ...draft,
        ...stampNewEntity(base + index),
        bookId: book.id,
      }),
    );
    await putChunks(chunks);
    const ready = await updateRulebook(book.id, {
      status: 'ready',
      pageCount: result.pageCount,
    });
    return { book: ready, chunkCount: chunks.length, emptyPages: result.emptyPages };
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
