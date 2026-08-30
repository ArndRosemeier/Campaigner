/// <reference types="vite/client" />

// pdfjs ships no types for its worker entry; we only need the module to exist
// for the vitest fake-worker preload (see src/ingest/extract.ts).
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  const WorkerMessageHandler: unknown;
  export { WorkerMessageHandler };
}
