/**
 * The service worker's REGISTRATION URL, built from the Vite base and the
 * build-time content version of `public/sw.js` (docs/17 row 379).
 *
 * The injected global is written by `vite.config.ts` (`define`) from the ONE
 * seam `scripts/swVersion.ts`, so the value here is the hash of the worker's
 * own bytes. It is deliberately NOT a timestamp or a build id: a changed
 * worker must be a new URL (the static host's CDN caches the fixed name for
 * four hours and ignores a client `no-cache`), while an unchanged worker must
 * KEEP its URL so no client re-installs anything (docs/08-TESTING.md §The
 * service worker's URL is content-addressed).
 */

/** The injected version — the declaration lives in `src/vite-env.d.ts`. */
export const SERVICE_WORKER_VERSION: string = __SW_VERSION__;

/**
 * Compose the worker's registration URL. The `?v=` query is the whole point:
 * it makes a changed worker a NEW url at the edge while an unchanged worker
 * keeps the url it already had. It does not change the worker's SCOPE — the
 * scope is the script's directory, minus query and fragment — so a changed
 * script url for the same scope is an ordinary registration update, never a
 * second registration or an unregister step.
 */
export function serviceWorkerUrl(baseUrl: string, version: string): string {
  return `${baseUrl}sw.js?v=${version}`;
}
