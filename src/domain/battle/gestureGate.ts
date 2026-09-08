/**
 * Board gesture visibility for the initiative reconcile (09-MILESTONE-5 M5-B,
 * ported from GM Cockpit's `host/boardGestureGate.ts` +
 * `host/initiativeDragGate.ts`): while a board pointer gesture is in flight,
 * reactive reconcile (initiative auto-roll/prune) must NOT fight the live
 * drag; the initiative gate also publishes an epoch so effects can re-run
 * when the drag ends.
 *
 * One-gesture-machine rebuild: the old depth counters + throwing `end*` are
 * GONE. The surface's single gesture machine (`domain/battle/gestureMachine`)
 * is the sole writer — `begin`/`end` project its phase here as a plain
 * boolean, and every `end` is idempotent. Imbalance (an end with no begin, a
 * double finish, a cancel racing a release) resolves to a recoverable reset,
 * never a crash — the double-finish class that used to throw through the
 * dispatch cannot exist: the second finish finds `false` and no-ops.
 */

// --- Board gesture gate ------------------------------------------------------

let boardGestureActive = false;

export function beginBoardGesture(): void {
  boardGestureActive = true;
}

export function endBoardGesture(): void {
  // Idempotent by contract: ends without a begin (stray release, cancel
  // racing release, unmount mid-gesture) reset to inactive, never throw.
  boardGestureActive = false;
}

export function isBoardGestureActive(): boolean {
  return boardGestureActive;
}

// --- Initiative reorder gate ---------------------------------------------------

let initiativeDragging = false;
let dragEpoch = 0;
const epochListeners = new Set<() => void>();

export function beginInitiativeDrag(): void {
  initiativeDragging = true;
}

export function endInitiativeDrag(): void {
  // Same recoverable-reset contract: only the active → inactive edge
  // publishes an epoch; an end with no drag no-ops instead of throwing.
  if (!initiativeDragging) return;
  initiativeDragging = false;
  dragEpoch += 1;
  for (const listener of epochListeners) {
    listener();
  }
}

export function isInitiativeDragging(): boolean {
  return initiativeDragging;
}

export function subscribeInitiativeDragEpoch(listener: () => void): () => void {
  epochListeners.add(listener);
  return () => {
    epochListeners.delete(listener);
  };
}

export function initiativeDragEpoch(): number {
  return dragEpoch;
}
