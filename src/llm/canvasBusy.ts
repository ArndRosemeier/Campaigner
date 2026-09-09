import type { Id } from '@/domain';
import { ModuleBusyError } from '@/llm/moduleGen';

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
 */

const claimed = new Set<Id>();

/** Claims the module for one generation; throws ModuleBusyError if busy. */
export function claimModuleGeneration(moduleId: Id): void {
  if (claimed.has(moduleId)) throw new ModuleBusyError(moduleId);
  claimed.add(moduleId);
}

/** Releases the claim (caller's finally — idempotent). */
export function releaseModuleGeneration(moduleId: Id): void {
  claimed.delete(moduleId);
}

/** Test/inspection helper: is the module's canvas generation slot held? */
export function isModuleGenerationClaimed(moduleId: Id): boolean {
  return claimed.has(moduleId);
}
