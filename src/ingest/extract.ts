import type { ExtractedItem, ExtractedPage } from '@/ingest/types';
import { openPdfDocument } from '@/lib/pdfRuntime';

export interface ExtractProgress {
  page: number;
  pageCount: number;
}

/**
 * pdfjs's item transform types resolve as `any[]` in some toolchains and
 * `number | undefined` under noUncheckedIndexedAccess in others; coerce each
 * component defensively.
 */
function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Step 1 of the pipeline (02-INGESTION.md): per-page text items via pdfjs.
 * Runs inside our worker in the app; direct calls are used in tests.
 * The pdfjs worker wiring lives in `@/lib/pdfRuntime` (shared with the
 * viewer); the handed-in buffer is transferred by pdfjs and arrives
 * detached afterwards — callers must not reuse it (ingest snapshots its
 * retained copy before calling).
 */
export async function extractPages(
  data: ArrayBuffer,
  onProgress?: (progress: ExtractProgress) => void,
): Promise<ExtractedPage[]> {
  const { doc: pdf, destroy } = await openPdfDocument(new Uint8Array(data));

  const pages: ExtractedPage[] = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const pdfPage = await pdf.getPage(pageNo);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const textContent = await pdfPage.getTextContent();

    const items: ExtractedItem[] = [];
    for (const raw of textContent.items) {
      if (!('str' in raw)) continue; // TextMarkedContent carries no text
      const str: string = raw.str;
      if (str === '') continue;
      const transform = raw.transform;
      items.push({
        str,
        x: toNumber(transform[4], 0),
        y: toNumber(transform[5], 0),
        fontSize: toNumber(transform[0], 10),
        fontName: raw.fontName,
      });
    }

    pages.push({ page: pageNo, width: viewport.width, items });
    pdfPage.cleanup();
    onProgress?.({ page: pageNo, pageCount: pdf.numPages });
  }

  await destroy();
  return pages;
}
