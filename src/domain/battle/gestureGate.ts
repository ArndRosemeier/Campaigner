/**
 * Module-level gesture gates (09-MILESTONE-5 M5-B, ported verbatim from GM
 * Cockpit's `host/boardGestureGate.ts` + `host/initiativeDragGate.ts` —
 * ~53 LOC, zero deps): while a board pointer gesture is in flight, reactive
 * reconcile (initiative auto-roll/prune) must NOT fight the live drag; the
 * initiative gate also publishes an epoch so effects can re-run when the
 * last drag ends.
 */

// --- Board gesture gate ------------------------------------------------------

let gestureDepth = 0;

export function beginBoardGesture(): void {
  gestureDepth += 1;
}

export function endBoardGesture(): void {
  if (gestureDepth <= 0) {
    throw new Error('Board gesture ended without a matching begin');
  }
  gestureDepth -= 1;
}

export function isBoardGestureActive(): boolean {
  return gestureDepth > 0;
}

// --- Initiative reorder gate ---------------------------------------------------

let dragDepth = 0;
let dragEpoch = 0;
const epochListeners = new Set<() => void>();

export function beginInitiativeDrag(): void {
  dragDepth += 1;
}

export function endInitiativeDrag(): void {
  if (dragDepth <= 0) {
    throw new Error('Initiative drag ended without a matching begin');
  }
  dragDepth -= 1;
  if (dragDepth === 0) {
    dragEpoch += 1;
    for (const listener of epochListeners) {
      listener();
    }
  }
}

export function isInitiativeDragging(): boolean {
  return dragDepth > 0;
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
