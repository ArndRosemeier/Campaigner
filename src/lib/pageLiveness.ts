/**
 * Page-liveness clock (docs/17 row 110, docs/18 §2.2/§4).
 *
 * A browser may suspend a page for minutes (a hidden tab under intensive
 * throttling, a frozen background tab, a discarded-and-restored page). While
 * it is suspended the page's `Date.now()` keeps advancing — the wall clock is
 * the browser's, not the page's — so every wall-clock watchdog that measures
 * silence with `Date.now()` deltas BILLS THE SUSPENDED GAP to the work it is
 * watching. On the streaming path that is a real data-loss bug: a healthy SSE
 * stream that was merely frozen for longer than the content-stall limit gets
 * cancelled the moment the page resumes, and a stream that closed cleanly
 * during the gap has its complete answer diagnosed as a stall.
 *
 * The fix is gap CREDITING, never limit loosening: this module records the
 * suspended intervals and `activeElapsedMs(from, to)` subtracts the part of
 * `[from, to]` the page spent suspended, so a watchdog measures the time it
 * was actually able to observe. A stream that truly died still trips its
 * limit once the page is watching again (the silence after resume is real and
 * counts in full) — see `tests/llm/openrouter-watchdog-gap.test.ts`.
 *
 * What counts as a suspension, and why each event:
 * - `visibilitychange` → hidden: Chromium throttles timers in a hidden tab
 *   (1/minute under intensive throttling after ~5 minutes) — the page is not
 *   watching its own clocks;
 * - `freeze` / `resume` (Page Lifecycle API): the tab was actually frozen
 *   (Chromium's desktop freeze criteria) and its timers stopped entirely;
 * - `pagehide` / `pageshow`: a page entering and returning from the
 *   back/forward cache is suspended for the whole interval between them, and
 *   it does not necessarily get a `freeze` event first.
 *
 * The clock is a MODULE-level concern, not React state: the streaming
 * watchdog and the run/parts passes read it from plain modules that run with
 * no React tree (and in node tests with no `document` at all), so the
 * listeners are installed once at import time when a document exists and are
 * pure bookkeeping otherwise. Nothing here is required for correctness: a
 * caller with no `document` (node, a worker) simply never records a gap and
 * behaves exactly as before.
 */

/** One interval the page spent suspended. `end === null` = still suspended. */
interface SuspendedGap {
  start: number;
  end: number | null;
}

/**
 * How many gaps are kept. The longest clock any caller measures against is a
 * streaming call's max duration (10 minutes by default), so a handful of
 * intervals is always enough; the cap exists so a tab left hidden for days
 * cannot grow the array without bound.
 */
const MAX_GAPS = 32;

let gaps: SuspendedGap[] = [];
let suspended = false;
const resumeListeners = new Set<() => void>();

/**
 * True while the page believes it is suspended (hidden, frozen or in the
 * back/forward cache). Exposed for tests and for callers that want to say so;
 * no correctness path branches on it.
 */
export function isPageSuspended(): boolean {
  return suspended;
}

/** Records the start of a suspension (idempotent: a second call is ignored). */
export function notePageSuspended(now: number = Date.now()): void {
  if (suspended) return;
  suspended = true;
  gaps.push({ start: now, end: null });
  if (gaps.length > MAX_GAPS) gaps = gaps.slice(gaps.length - MAX_GAPS);
}

/**
 * Records the end of a suspension and notifies the resume listeners (the
 * reconciliation hook: work that died while the page was suspended is
 * discovered on the way back in). Idempotent, and silent when nothing was
 * suspended — a fresh load's `pageshow` must not fire a resume event.
 */
export function notePageResumed(now: number = Date.now()): void {
  if (!suspended) return;
  suspended = false;
  // The open gap IS the last one by construction (only `notePageSuspended`
  // pushes, and it pushes exactly one while `suspended` holds).
  const last = gaps[gaps.length - 1];
  if (last !== undefined) last.end = now;
  for (const listener of resumeListeners) listener();
}

/** Subscribes to page-resume events; returns the unsubscribe function. */
export function onPageResumed(listener: () => void): () => void {
  resumeListeners.add(listener);
  return () => {
    resumeListeners.delete(listener);
  };
}

/**
 * Milliseconds of `[fromMs, toMs]` the page spent suspended. A still-open gap
 * is measured up to `Date.now()` (or `toMs`), so a caller running BEFORE the
 * resume sees the same credit the resume path will compute.
 */
export function suspendedMsWithin(fromMs: number, toMs: number = Date.now()): number {
  if (toMs <= fromMs) return 0;
  let total = 0;
  for (const gap of gaps) {
    const end = gap.end ?? toMs;
    const overlapStart = Math.max(fromMs, gap.start);
    const overlapEnd = Math.min(toMs, end);
    if (overlapEnd > overlapStart) total += overlapEnd - overlapStart;
  }
  return total;
}

/**
 * THE liveness clock: wall-clock elapsed minus the suspended part. This is
 * what a watchdog must compare against its limits — `Date.now() - startedAt`
 * is not the time the page was able to observe anything.
 */
export function activeElapsedMs(fromMs: number, toMs: number = Date.now()): number {
  return Math.max(0, toMs - fromMs - suspendedMsWithin(fromMs, toMs));
}

/** Test seam: drops every recorded gap and the suspended flag. */
export function resetPageLiveness(): void {
  gaps = [];
  suspended = false;
}

type LivenessDocument = Pick<
  Document,
  'hidden' | 'addEventListener' | 'removeEventListener'
>;

/**
 * Installs the listeners on a document (defaults to the global one). Returns
 * the uninstall function. Safe to call more than once — listeners are
 * idempotent by construction (`notePageSuspended`/`notePageResumed` ignore
 * redundant transitions), and the returned uninstaller removes exactly what
 * this call added.
 */
export function installPageLiveness(target: LivenessDocument): () => void {
  const onVisibility = (): void => {
    if (target.hidden) notePageSuspended();
    else notePageResumed();
  };
  const onFreeze = (): void => {
    notePageSuspended();
  };
  const onResume = (): void => {
    notePageResumed();
  };
  target.addEventListener('visibilitychange', onVisibility);
  target.addEventListener('freeze', onFreeze);
  target.addEventListener('resume', onResume);
  target.addEventListener('pagehide', onFreeze);
  target.addEventListener('pageshow', onResume);
  return () => {
    target.removeEventListener('visibilitychange', onVisibility);
    target.removeEventListener('freeze', onFreeze);
    target.removeEventListener('resume', onResume);
    target.removeEventListener('pagehide', onFreeze);
    target.removeEventListener('pageshow', onResume);
  };
}

// Installed once, when there is a document to listen to. A node/test
// environment without one keeps the clock at zero gaps (every caller then
// measures plain wall-clock time, exactly as before this module existed).
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  installPageLiveness(document);
}
