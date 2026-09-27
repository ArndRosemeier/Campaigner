import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ONE async UI-wait budget for the whole suite (docs/17 row 377, AGENTS rule 4
 * / centralization obligation 2).
 *
 * THE MEASURED DEFECT: the dispatcher's integrated gate over rows 374/375 came
 * back RED on ONE `battle-surface.test.tsx` wait that passes 122/122 in
 * isolation, because `waitFor` defaults to @testing-library's 1000 ms and the
 * failing run's wait needed 1183 ms under the two-chunk gate. That file alone
 * has ~110 default-budget waits, so the cure is ONE seam — `configure({
 * asyncUtilTimeout })` in `tests/setup.ts`, the suite's single shared setup
 * file — NOT 110 call-site `{ timeout }` options. A per-call budget would also
 * be the distributed-copy defect this repo keeps folding: whichever wait
 * someone forgets is the next false RED.
 *
 * The pin is a SOURCE SCAN because the drift it catches is invisible: a test
 * that adds its own `{ timeout: 5000 }` to one `waitFor` reads correctly today
 * and hides the class again. A re-added per-call budget reds here by file name.
 *
 * The file list comes from Vite's own `import.meta.glob` with KEYS ONLY (the
 * hand-rolled `sourceFiles` walker is a BASELINED multi-site population,
 * docs/17 row 212, and a new copy of it would be the very defect this file
 * exists to pin); contents are read on demand.
 */

const ROOT = process.cwd();
const SETUP = 'tests/setup.ts';
const BUDGET = 'tests/helpers/asyncWaitBudget.ts';

/**
 * The two needles are BUILT AT RUNTIME so this scan's own source cannot match
 * itself: written as literals, the scan file would name the configure property
 * and the declaration in its own assertions and report itself as an offender.
 */
const CONFIGURE_PROPERTY = ['asyncUtil', 'Timeout:'].join('');
const DECLARATION = ['ASYNC_UTIL_TIMEOUT_MS', '='].join(' ');

const TEST_PATHS: readonly string[] = Object.keys(import.meta.glob('/tests/**/*.{ts,tsx}'))
  .map((path) => path.replace(/^\//, ''))
  .sort();

function textOf(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

describe('one async UI-wait budget (SOURCE SCAN, docs/17 row 377)', () => {
  it('is CONFIGURED in exactly one file — the shared suite setup', () => {
    // Non-vacuity: the glob must see the whole test tree, and the seam file
    // must really be in it.
    expect(TEST_PATHS.length).toBeGreaterThan(300);
    expect(TEST_PATHS).toContain(SETUP);
    const configurers = TEST_PATHS.filter((path) => textOf(path).includes(CONFIGURE_PROPERTY));
    expect(configurers).toEqual([SETUP]);
  });

  it('declares the NUMBER once, and imports it at the seam', () => {
    const declarations = TEST_PATHS.filter((path) => textOf(path).includes(DECLARATION));
    expect(declarations).toEqual([BUDGET]);
    // The ONE configure site takes the value from that ONE declaration rather
    // than re-typing a literal.
    expect(textOf(SETUP)).toContain('ASYNC_UTIL_TIMEOUT_MS');
    expect(textOf(SETUP)).toMatch(/configure\(\{/);
  });
});
