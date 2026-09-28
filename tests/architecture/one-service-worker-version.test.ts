import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE SERVICE WORKER'S CONTENT VERSION IS ONE SEAM (docs/17 row 379, AGENTS
 * rule 4 / centralization obligation 2).
 *
 * THE DEFECT THIS EXISTS FOR. The worker's registration url must change
 * exactly when `public/sw.js` changes, because this host's CDN caches the
 * fixed name for four hours and IGNORES a client `no-cache` (measured; the
 * table is in docs/08-TESTING.md §The service worker's URL is content-addressed).
 * Three small pieces have to agree for that to hold, and each of them is
 * silent when copied:
 *
 *   1. the HASH — `serviceWorkerVersion` in `scripts/swVersion.ts`;
 *   2. the INJECTION — `vite.config.ts`'s `define`, read by the app through
 *      `src/lib/serviceWorker.ts` and declared in `src/vite-env.d.ts`;
 *   3. the URL COMPOSITION — `serviceWorkerUrl`, which appends the version.
 *
 * A second hash or a second composition answers identically TODAY (both hash
 * the same file, both append the same query), so no behavioural pin can see
 * the copy — `tests/pwa-assets.test.ts` pins the version's equality, the
 * composition and the differential, all of which a duplicate would satisfy.
 * This scan is what makes a second copy red BY FILE NAME.
 *
 * The file list comes from Vite's own `import.meta.glob` with KEYS ONLY (the
 * hand-rolled recursive walker is a BASELINED multi-site population,
 * docs/17 row 212 — `tests/helpers/sourceCode.ts` is the ONE `src/`-only scan
 * seam, and this pin needs `scripts/` and the config too); contents are read
 * on demand. The needles are BUILT AT RUNTIME so this scan's own source cannot
 * match itself.
 */

const ROOT = process.cwd();
const SEAM = 'scripts/swVersion.ts';
const APP_SEAM = 'src/lib/serviceWorker.ts';
const DECLARATION = 'src/vite-env.d.ts';
const CONFIG = 'vite.config.ts';

const PATHS: readonly string[] = Object.keys(
  import.meta.glob(['/src/**/*.{ts,tsx}', '/scripts/**/*.ts', '/vite.config.ts']),
)
  .map((path) => path.replace(/^\//, ''))
  .sort();

function textOf(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

/** `__SW_VERSION__`, assembled so this file does not contain the literal. */
const INJECTED = ['__SW_', 'VERSION__'].join('');
/** `sw.js?v=`, the versioned spelling — the pre-379 bare form omits the query. */
const COMPOSED = ['sw.js', '?v='].join('');
/** The hash's DEFINITION, not its two callers (`read…` does not match). */
const DEFINED = ['function serviceWorkerVersion', '('].join('');

describe('one service worker content version (SOURCE SCAN, docs/17 row 379)', () => {
  it('scans the whole build surface (non-vacuity)', () => {
    // A glob that saw nothing would make every verdict below meaningless, and
    // every declared site must really be in the population.
    expect(PATHS.length).toBeGreaterThan(200);
    for (const path of [SEAM, APP_SEAM, DECLARATION, CONFIG]) {
      expect(PATHS).toContain(path);
    }
  });

  it('is INJECTED once (the config), DECLARED once and CONSUMED once', () => {
    expect(PATHS.filter((path) => textOf(path).includes(INJECTED))).toEqual(
      [CONFIG, APP_SEAM, DECLARATION].sort(),
    );
  });

  it('composes the VERSIONED url in exactly one file', () => {
    expect(PATHS.filter((path) => textOf(path).includes(COMPOSED))).toEqual([APP_SEAM]);
  });

  it('DEFINES the content hash in exactly one file', () => {
    expect(PATHS.filter((path) => textOf(path).includes(DEFINED))).toEqual([SEAM]);
  });
});
