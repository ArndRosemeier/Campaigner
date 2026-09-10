/**
 * The stop epoch (owner report: "Stop all should stop all generations, but it
 * only stops the current type loop").
 *
 * Cancelling UNITS is not the same as stopping ORCHESTRATIONS. The sweep in
 * `features/progress/stop-all-generations` can abort every job queue, every
 * in-flight run, a running chain and a module forge, yet a LOOP that drives
 * those units — the post-generation kind sweep, the entity-batch concurrency
 * pool, a parts pass's automation tail, `post-run-extras` — keeps going,
 * because a cancelled unit either returns normally (the automation gates read
 * a `'ready'` row that must stay for Retry) or is recorded as a per-unit
 * failure that the loop swallows. One rule closes all of it:
 *
 *   **A stopped orchestration must not start its next unit.**
 *
 * The mechanism is ONE app-level counter, bumped by `stopAllGenerations`
 * BEFORE it cancels anything (so the gate is sealed for the whole sweep).
 * A loop that can run for minutes captures the epoch ONCE at entry
 * (`getStopEpoch()`) and asks `stoppedSince(captured)` before it launches its
 * next unit; the answer stays true for the rest of that pass, so nothing it
 * was about to start can slip through.
 *
 * Why an epoch and not a boolean "stopping" flag: a flag would have to be
 * cleared, and every clear is a race against an orchestration still unwinding
 * from the previous stop (the automation tail fires ~1s after a parts pass).
 * A per-pass capture is scoped by construction — a loop that starts AFTER a
 * stop holds the fresh epoch and runs normally, so one user's Stop all never
 * silently disables the next user-visible generation (the very failure mode a
 * sticky global flag would introduce).
 *
 * Layer: `lib` is imported by both `llm` and `features` (the layer map forbids
 * lib → features), so this module is deliberately dumb — one counter, no
 * imports, no side effects.
 *
 * This is NOT a replacement for the existing per-unit cancel seams: an
 * in-flight chat call is still aborted through its own AbortController
 * (`cancelModuleGen`, `jobQueue.dequeue`, `runEngine.cancelAllActive`). The
 * epoch answers only "should the next unit start?".
 */

let epoch = 0;

/** The current stop epoch — capture it at a loop's entry. */
export function getStopEpoch(): number {
  return epoch;
}

/**
 * Has a Stop-all landed since `captured` was taken? `true` means: do not
 * launch the next unit, do not enqueue the next job, stop the loop.
 */
export function stoppedSince(captured: number): boolean {
  return epoch !== captured;
}

/**
 * Bumps the epoch. Called by `stopAllGenerations` (and by tests that need to
 * simulate a stop that already happened). Every armed orchestration now sees
 * `stoppedSince(...) === true` for the pass it captured.
 */
export function bumpStopEpoch(): void {
  epoch += 1;
}
