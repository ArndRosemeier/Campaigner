import type { GameSystem } from '@/domain/gameSystem';
import type { RuleChunkDraft } from '@/domain/rulebook';
import { buildLines } from '@/ingest/buildLines';
import { chunkLines } from '@/ingest/chunker';
import { extractPages } from '@/ingest/extract';
import { sha256Hex } from '@/lib/hash';

export interface PipelineResult {
  chunks: RuleChunkDraft[];
  pageCount: number;
  emptyPages: number;
}

/**
 * The single ingestion pipeline (02-INGESTION.md): PDF bytes in, hashed
 * RuleChunkDraft[] out. The worker calls this; the main thread uses the same
 * function as a fallback when Worker is unavailable (test environments only).
 */
export async function runIngestPipeline(
  arrayBuffer: ArrayBuffer,
  system: GameSystem,
  onProgress?: (page: number, pageCount: number) => void,
): Promise<PipelineResult> {
  const pages = await extractPages(arrayBuffer, (progress) => {
    onProgress?.(progress.page, progress.pageCount);
  });
  const emptyPages = pages.filter((page) => page.items.length === 0).length;
  const lines = buildLines(pages).flat();
  const unhashed = chunkLines(lines, system);

  const chunks: RuleChunkDraft[] = [];
  for (const draft of unhashed) {
    chunks.push({ ...draft, contentHash: await sha256Hex(draft.text) });
  }
  return { chunks, pageCount: pages.length, emptyPages };
}
