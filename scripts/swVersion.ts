/**
 * THE content version of the service worker (`public/sw.js`) — docs/17 row 379.
 *
 * WHY A CONTENT HASH, AND WHY NOT A TIMESTAMP OR A BUILD ID. `sw.js` is a
 * FIXED-NAME asset, and the static host at `apps.futuremagic.de` caches it for
 * four hours at the CDN edge while IGNORING a client's `Cache-Control:
 * no-cache` — measured, table in docs/08-TESTING.md §The service worker's URL
 * is content-addressed. So the ONLY way a shipped worker change reaches a
 * browser is a URL whose NAME changes. The version is derived from the
 * worker's BYTES, so it changes exactly when the worker changes: an unchanged
 * worker keeps the URL it already had and no client is asked to re-install
 * anything. A timestamp or a random build id would make EVERY deploy a new
 * worker URL — every client would re-fetch and re-install a worker that did
 * not change, and the name would carry no information at all (docs/17 row 379).
 *
 * ONE SEAM. `vite.config.ts` injects this version into the bundle
 * (`readServiceWorkerVersion` at `define` time) and `tests/pwa-assets.test.ts`
 * asserts the injected value EQUALS the hash of the real file. Computing the
 * hash twice — once in the config, once in the test — is the drift this module
 * exists to prevent, and `tests/architecture/one-service-worker-version.test.ts`
 * reds a second definition, a second injection site or a second consumer.
 *
 * NOT `src/lib/hash.sha256Hex`. That seam is the APP's runtime hasher (Web
 * Crypto, async, full 64-hex digest, used for chunk `contentHash`); this one
 * runs at BUILD time in the config's Node context, synchronously, and answers
 * the short form the URL wants. Two callers, two contexts, one hash each.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The worker's path, relative to the repo root — one spelling for every reader. */
export const SERVICE_WORKER_RELATIVE_PATH = 'public/sw.js';

/**
 * The version of a worker SOURCE: sha256, truncated to 12 hex characters.
 *
 * Pure, so the same bytes always answer the same version — which is the whole
 * property the versioned URL rests on (docs/17 row 379).
 */
export function serviceWorkerVersion(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 12);
}

/** Read the real worker under `root` and version it through the ONE seam. */
export function readServiceWorkerVersion(root: string): string {
  return serviceWorkerVersion(readFileSync(resolve(root, SERVICE_WORKER_RELATIVE_PATH), 'utf8'));
}
