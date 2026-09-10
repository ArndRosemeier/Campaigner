import { ModuleBusyError } from '@/llm/moduleGen';
import type { Id } from '@/domain';

/**
 * The shared canvas generation registry (18-ARCHITECTURE §2.3): ONE
 * generation per module across EVERY canvas AI surface — the selection/
 * whole-part refine (`canvasRefine`) AND the chat co-editor
 * (`canvasChat`). The claim is taken SYNCHRONOUSLY at entry (before any
 * await — two concurrent calls must never both pass the check) and
 * released in the caller's `finally`; a second claimant throws
 * `ModuleBusyError` (loud, never queued). The forge's own row state
 * (`status: 'generating'`) is the other authority and stays a caller
 * check, as before.
 *
 * The registry ALSO publishes an ABORT HANDLE per live claim (owner report:
 * "Stop all should stop all generations, but it only stops the current type
 * loop"). A canvas turn streams straight from `canvasChat`/`canvasRefine`
 * — no run row — so before this the app-level sweep had nothing to cancel
 * and a chat reply kept streaming after Stop all. `registerCanvasAbort`
 * wires one turn to the sweep and relays both directions:
 *
 * - aborting through `cancelCanvasGenerations` (the sweep) aborts the
 *   CALLER's own controller as well, so every existing "the user stopped
 *   this" branch (`controller.signal.aborted` → the partial reply is marked
 *   'aborted' in place, no error toast) keeps working unchanged;
 * - aborting the caller's controller aborts the registry handle, so the
 *   claim is released through the ordinary `finally` path.
 *
 * The signal returned by `registerCanvasAbort` is what the model call must
 * carry.
 */

const claimed = new Set<Id>();

/** One live canvas turn's abort handle: the registry's per-module controller,
 * paired with the CALLER's controller so a sweep abort is visible to the UI
 * branches that decide "the user stopped this". */
const handles = new Map<Id, { handle: AbortController; turn: AbortController }>();

/** Claims the module for one generation; throws ModuleBusyError if busy. */
export function claimModuleGeneration(moduleId: Id): void {
  if (claimed.has(moduleId)) throw new ModuleBusyError(moduleId);
  claimed.add(moduleId);
}

/** Releases the claim (caller's finally — idempotent). */
export function releaseModuleGeneration(moduleId: Id): void {
  claimed.delete(moduleId);
}

/**
 * Publishes this turn's abort handle to the registry and returns the signal
 * the model call must carry. Call it right after `claimModuleGeneration`
 * (the claim already guarantees the module is free of a second handle).
 * `turn` is the caller's own per-turn controller — the relay keeps cancel
 * semantics exactly what the canvas surfaces implement.
 * The returned function is released in the same `finally` as the claim.
 */
export function registerCanvasAbort(moduleId: Id, turn: AbortController): {
  signal: AbortSignal;
  releaseHandle: () => void;
} {
  // The caller's CONTROLLER (not a copy of its signal) is what the sweep must
  // abort: `handle.signal` is what the model call carries, but the canvas UI
  // decides "this was a cancel, not an error" from its own controller — so a
  // sweep abort has to land there to keep that branch working.
  const controller = new AbortController();
  const entry = { handle: controller, turn };
  handles.set(moduleId, entry);
  // ONE listener on the caller's controller, alive for the turn: the caller
  // drops that controller when its turn ends, so listeners never accumulate.
  const relay = (): void => {
    controller.abort();
  };
  if (turn.signal.aborted) {
    controller.abort();
  } else {
    turn.signal.addEventListener('abort', relay);
  }
  let released = false;
  return {
    signal: controller.signal,
    releaseHandle: (): void => {
      if (released) return;
      released = true;
      turn.signal.removeEventListener('abort', relay);
      if (handles.get(moduleId) === entry) handles.delete(moduleId);
    },
  };
}

/**
 * Aborts every LIVE canvas turn and returns the modules whose turn was
 * cancelled (the sweep's count contribution). The turn's own error path
 * settles it: the partial reply is marked 'aborted' in place, nothing is
 * applied, and the caller's `finally` releases the claim and the handle.
 */
export function cancelCanvasGenerations(): Id[] {
  const moduleIds = [...handles.keys()];
  // Both directions, in order: the turn's own signal first (the streaming
  // model call), then the caller's controller (the UI's "cancelled, not
  // failed" branch — the partial reply is marked 'aborted' in place).
  for (const entry of handles.values()) {
    entry.handle.abort();
    entry.turn.abort();
  }
  return moduleIds;
}

/** Test/inspection helper: is the module's canvas generation slot held? */
export function isModuleGenerationClaimed(moduleId: Id): boolean {
  return claimed.has(moduleId);
}
