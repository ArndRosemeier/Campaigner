import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

/**
 * Shared pdfjs runtime (source-viewers arc): ONE worker wiring for every
 * pdfjs consumer — the ingest extraction (extract.ts) and the in-app PDF
 * viewer. Moved here verbatim from extract.ts so both entry points share
 * the same GlobalWorkerOptions and the same vitest fake-worker preload.
 *
 * pdfjs needs a worker source. In the browser we point at the emitted worker
 * asset; under vitest there is no Worker implementation, so pdfjs falls back
 * to its main-thread "fake worker" — preloaded here onto `globalThis`
 * (pdfjs checks `pdfjsWorker` before trying to import `workerSrc`, which a
 * test runner cannot resolve at runtime).
 */
if (import.meta.env.VITEST) {
  const workerModule: unknown = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = workerModule;
} else {
  GlobalWorkerOptions.workerSrc = workerUrl;
}

export type { PDFDocumentProxy };

/**
 * Realm-safe copy of a byte payload (same trick class as backup.ts's
 * `ArrayBuffer.isView` check): Dexie/structured-clone backends may hand back
 * Uint8Arrays from another realm, where `instanceof` lies AND the typed-array
 * constructors/`Uint8Array.from` throw ("this is not a typed array") because
 * the internal slots are missing. Indexed access still works, so the copy is
 * element-wise. Returns the input untouched when it is already a
 * same-realm Uint8Array (the production path).
 */
export function copyBytes(bytes: Uint8Array): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes;
  // Cross-realm typed array (Dexie/structured-clone): internal-slot getters
  // (byteLength) and the typed-array constructors throw on re-cloned rows,
  // so length comes from the materialized own index keys and the copy is
  // element-wise. Never hit on same-realm bytes (the production path).
  const view = bytes as unknown as Record<number, number | undefined>;
  const out = new Uint8Array(Object.keys(view).length);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = view[index] ?? 0;
  }
  return out;
}

/** An opened PDF plus its teardown — pdfjs v6 keeps `destroy()` on the
 * loading task, not the document proxy, so both travel together. */
export interface OpenedPdfDocument {
  doc: PDFDocumentProxy;
  destroy: () => Promise<void>;
}

/**
 * Opens a PDF document from raw bytes. Callers pass a fresh COPY
 * (`copyBytes(bytes)`): pdfjs takes ownership of the buffer it is handed and
 * transfers it to the worker — the original arrives detached ("Cannot
 * perform Construct on a detached ArrayBuffer"), the same behavior the
 * ingest retention copies around.
 */
export async function openPdfDocument(data: Uint8Array): Promise<OpenedPdfDocument> {
  const loadingTask = getDocument({
    data,
    useWorkerFetch: false,
    disableFontFace: true,
  });
  const doc = await loadingTask.promise;
  return { doc, destroy: () => loadingTask.destroy() };
}
