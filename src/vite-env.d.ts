/// <reference types="vite/client" />

/**
 * The content version of `public/sw.js`, injected at BUILD time by
 * `vite.config.ts` (`define`) from the ONE seam `scripts/swVersion.ts`
 * (docs/17 row 379). Declared rather than cast at the use site so a typo in
 * the name is a type error instead of a silent `undefined` in the bundle.
 * `src/lib/serviceWorker.ts` is its only consumer in the app.
 */
declare const __SW_VERSION__: string;

/**
 * The published app version (`1.004`), injected at BUILD time by
 * `vite.config.ts` from `CAMPAIGNER_VERSION` (set by `scripts/publish.mjs`);
 * `'dev'` in dev, test and any unversioned build (docs/17 row 404).
 * `src/app/layout/build-status.ts` is its only consumer.
 */
declare const __APP_VERSION__: string;

// pdfjs ships no types for its worker entry; we only need the module to exist
// for the vitest fake-worker preload (see src/ingest/extract.ts).
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  const WorkerMessageHandler: unknown;
  export { WorkerMessageHandler };
}
