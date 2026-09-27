import { getConfig } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ASYNC_UTIL_TIMEOUT_MS } from '../helpers/asyncWaitBudget';

/**
 * THE SUITE'S ASYNC UI-WAIT BUDGET IS REALLY CONFIGURED (docs/17 row 377).
 *
 * This file lives in `tests/features` (the jsdom project — not one of the
 * DOM-free files listed in `vite.config.ts`'s `nodeTestGlobs`) on purpose: the
 * flake the budget cures was a jsdom `waitFor` in `battle-surface.test.tsx`, so
 * the read-back must happen in the project whose waits are governed.
 *
 * The value is READ from testing-library's live config, never re-declared here:
 * a silent revert of the one `configure` call in `tests/setup.ts` leaves the
 * library's own 1000 ms default and reds this pin. The expected value comes
 * from its ONE declaration (`tests/helpers/asyncWaitBudget.ts`), which the same
 * setup file configures from — so the number cannot be written twice and drift.
 */
describe('the suite async UI-wait budget (docs/17 row 377)', () => {
  it('is the seam value, not testing-library default', () => {
    expect(getConfig().asyncUtilTimeout).toBe(ASYNC_UTIL_TIMEOUT_MS);
    // Non-vacuity: the library default really is smaller, so "it equals the
    // seam value" is not accidentally true of the default.
    expect(getConfig().asyncUtilTimeout).toBeGreaterThan(1000);
  });
});
