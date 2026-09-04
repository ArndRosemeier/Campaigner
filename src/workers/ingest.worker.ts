import type { GameSystem } from '@/domain/gameSystem';
import type { RuleChunkDraft } from '@/domain/rulebook';
import { runIngestPipeline } from '@/ingest/pipeline';
import { errorMessage } from '@/lib/errors';

/**
 * Ingestion Web Worker (02-INGESTION.md): PDF bytes in, RuleChunkDraft[]
 * out — no DB access here. Progress is posted every page (cheap; the
 * main thread throttles rendering), results once at the end.
 */

export interface IngestRequest {
  bookId: string;
  arrayBuffer: ArrayBuffer;
  system: GameSystem;
}

export type IngestResponse =
  | { kind: 'progress'; bookId: string; page: number; pageCount: number }
  | {
      kind: 'done';
      bookId: string;
      chunks: RuleChunkDraft[];
      pageCount: number;
      emptyPages: number;
    }
  | { kind: 'error'; bookId: string; message: string };

// Minimal worker-context handle (avoids mixing the DOM and WebWorker libs).
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<IngestRequest>) => void) | null;
  postMessage: (message: IngestResponse) => void;
};

ctx.onmessage = (event: MessageEvent<IngestRequest>): void => {
  const { bookId, arrayBuffer, system } = event.data;
  void (async () => {
    try {
      const result = await runIngestPipeline(arrayBuffer, system, (page, pageCount) => {
        ctx.postMessage({ kind: 'progress', bookId, page, pageCount });
      });
      ctx.postMessage({ kind: 'done', bookId, ...result });
    } catch (error) {
      ctx.postMessage({
        kind: 'error',
        bookId,
        message: errorMessage(error),
      });
    }
  })();
};
