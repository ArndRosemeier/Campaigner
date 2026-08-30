import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

import type { ExtractedItem, ExtractedPage } from '@/ingest/types';

// pdfjs needs a worker source. In the browser we point at the emitted worker
// asset; under vitest there is no Worker implementation, so pdfjs falls back
// to its main-thread "fake worker" — preloaded here onto `globalThis`
// (pdfjs checks `pdfjsWorker` before trying to import `workerSrc`, which a
// test runner cannot resolve at runtime).
if (import.meta.env.VITEST) {
  const workerModule: unknown = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = workerModule;
} else {
  GlobalWorkerOptions.workerSrc = workerUrl;
}

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
 */
export async function extractPages(
  data: ArrayBuffer,
  onProgress?: (progress: ExtractProgress) => void,
): Promise<ExtractedPage[]> {
  const loadingTask = getDocument({
    data: new Uint8Array(data),
    useWorkerFetch: false,
    disableFontFace: true,
  });
  const pdf = await loadingTask.promise;

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

  await loadingTask.destroy();
  return pages;
}
