/**
 * THE ONE value of the suite's async UI-wait budget (docs/17 row 377).
 *
 * It is a module of its own so the number has ONE declaration that BOTH the
 * seam that configures testing-library (`tests/setup.ts`) and the pin that
 * READS IT BACK from testing-library import — a literal repeated in the pin
 * would be a second spelling of the same fact, and a silent revert to the
 * library's default would then read as "the pin agrees with itself".
 *
 * WHY 3000, justified against the measurement rather than picked: the
 * dispatcher's integrated gate came back RED on one `battle-surface.test.tsx`
 * wait (1183 ms) against @testing-library's 1000 ms default, and the file
 * passes 122/122 in isolation. 3000 ms is 2.5x the measured need — real
 * headroom for a busier box — while staying far below the 20 s per-test
 * timeout (`vite.config.ts`), so a wait that is genuinely broken still fails,
 * and fails with the wait's own message instead of a test-timeout hang.
 */
export const ASYNC_UTIL_TIMEOUT_MS = 3000;
