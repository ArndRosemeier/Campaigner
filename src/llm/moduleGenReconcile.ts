import type { Id } from '@/domain';
import { failInterruptedModuleGen, getModule, listGeneratingModules } from '@/db/moduleRepo';
import { isGenerationLockHeld, moduleGenLockName } from '@/lib/generationLocks';
import { toastError, toastInfo } from '@/lib/toast';
import { cancelModuleGen, hasLiveModuleGen } from '@/llm/moduleGen';

/**
 * Interrupted module-generation reconciliation (docs/17 row 110, docs/18 §2.2).
 *
 * THE defect this exists for: `runEngine`'s runs are reconciled loudly at boot
 * (`runRepo.failRunningRuns` marks every `status: 'running'` row failed with
 * "Interrupted by reload"), but a MODULE row had no reconciliation anywhere.
 * A generation interrupted mid-pass — a reloaded tab, a discarded tab, a
 * browser that killed the page — left the module at `status: 'generating'`
 * FOREVER: a permanent spinner, a Stop button that is a silent no-op
 * (`cancelModuleGen` on a module with no live controller is
 * `controllers.get(id)?.abort()` — nothing), every restart affordance gated
 * behind `!busy`, and "Stop all generations" counting the dead row as stopped
 * and toasting that it stopped it. The owner saw all four.
 *
 * A `'generating'` status is a LEASE, and a lease needs a liveness guard: the
 * row is only a claim that SOMEBODY is writing, and the only authority for
 * "somebody" is a live controller in this page plus a held generation lock
 * (another tab). This module is the ONE place that reads both and decides.
 *
 * The reconcile is deliberately LOUD and never a silent reset (AGENTS rules
 * 1–2): the row lands `'failed'` with a named sentence saying what happened
 * and which control recovers, every part slot still at `'generating'` rewinds
 * to `'pending'` (so the EXISTING `generateMissingParts` path re-runs exactly
 * the unfinished parts and the reader's `!busy` gate opens), and the batch
 * entry point toasts the count. Text already written is never touched.
 *
 * It is IDEMPOTENT by construction: after it lands, the row no longer says
 * `'generating'`, so a second pass (boot, a visibility resume, the Stop
 * button, Stop all) finds nothing to do and writes nothing.
 */

/**
 * The named sentence on the reconciled row — what happened, and what to do
 * about it. One constant, so the reader's failed-module banner and the tests
 * cannot drift from each other.
 */
export const INTERRUPTED_MODULE_GEN_MESSAGE =
  'This module generation was interrupted: the page that was writing it is gone (the tab was ' +
  'reloaded, discarded or closed), so nothing is writing this module any more. Parts that were ' +
  'already finished are untouched; every part that was still being written is back to pending. ' +
  'Press "Resume module generation" to write them again.';

/** Can another page (another tab) legitimately be writing this module? */
async function claimedElsewhere(moduleId: Id): Promise<boolean> {
  return isGenerationLockHeld(moduleGenLockName(moduleId));
}

/**
 * The liveness guard, both halves, evaluated at the caller's moment:
 * `hasLiveModuleGen` is THIS page's controller registry (the authority the
 * brief pins) and the generation lock is the cross-tab lease. When the Web
 * Locks API is absent the second half answers `false` — the page-local
 * registry is then the only liveness signal there is, which is stated in
 * docs/18 §4 rather than pretended away.
 */
export async function isModuleGenClaimed(moduleId: Id): Promise<boolean> {
  if (hasLiveModuleGen(moduleId)) return true;
  return claimedElsewhere(moduleId);
}

/**
 * Reconciles ONE module: `true` when this call failed an interrupted
 * generation, `false` when there was nothing to do (not generating, gone, or
 * claimed by a live controller / another tab — the guard, pinned both ways in
 * `tests/llm/moduleGenReconcile.test.ts`).
 *
 * The claim is re-checked inside the write transaction (`failInterruptedModuleGen`
 * takes the predicate), so a forge that registers between the read and the write
 * cannot be failed by this path.
 */
export async function reconcileInterruptedModuleGen(moduleId: Id): Promise<boolean> {
  const module = await getModule(moduleId);
  if (module?.status !== 'generating') return false;
  if (await isModuleGenClaimed(moduleId)) return false;
  const failed = await failInterruptedModuleGen(
    moduleId,
    INTERRUPTED_MODULE_GEN_MESSAGE,
    () => hasLiveModuleGen(moduleId),
  );
  return failed !== undefined;
}

/**
 * Reconciles the given modules (default: EVERY module row that says
 * `'generating'`). Returns the ids it actually failed, in row order.
 *
 * `notify` (default true) is the loud half for the paths where the owner is
 * NOT looking at the module — app start and a visibility resume; the caller
 * that reports the outcome itself ("Stop all generations") passes `false` and
 * folds the count into its own honest summary instead of double-toasting.
 */
export async function reconcileInterruptedModuleGens(
  moduleIds?: readonly Id[],
  options: { notify?: boolean } = {},
): Promise<Id[]> {
  const targets = moduleIds ?? (await listGeneratingModules()).map((module) => module.id);
  const reconciled: Id[] = [];
  for (const moduleId of targets) {
    if (await reconcileInterruptedModuleGen(moduleId)) reconciled.push(moduleId);
  }
  if (reconciled.length > 0 && options.notify !== false) {
    toastError(formatInterruptedModuleGenReport(reconciled.length));
  }
  return reconciled;
}

/** The loud report for `count` reconciled modules (one sentence, no jargon). */
export function formatInterruptedModuleGenReport(count: number): string {
  const plural = count === 1 ? '' : 's';
  return (
    `Interrupted ${String(count)} module generation${plural} — the page writing ${count === 1 ? 'it' : 'them'} ` +
    `was reloaded, discarded or closed, so ${count === 1 ? 'its' : 'their'} unfinished parts were reset to pending. ` +
    `Open the module${plural} and press "Resume module generation" to write ${count === 1 ? 'it' : 'them'} again.`
  );
}

/** What pressing a Stop control on a `'generating'` row actually did. */
export type ModuleStopOutcome = 'cancelled' | 'reconciled' | 'elsewhere' | 'idle';

/**
 * The ONE behaviour behind every Stop control a `'generating'` module row can
 * show (the reader's `module-stop`, the board's `board-stop`, docs/17 row 110).
 *
 * A Stop that cannot act must never look like one that did: `cancelModuleGen`
 * on a row with no live controller in THIS page is `controllers.get(id)?.abort()`
 * — a silent no-op — so the four cases are told apart and each ends in
 * something the owner can see:
 *
 * - `'cancelled'` — this page owns the forge; the abort is real (unchanged).
 * - `'reconciled'` — nobody owns it (the page that was writing it is gone): the
 *   row lands failed with the named recovery sentence.
 * - `'elsewhere'` — another tab holds the generation lock, so stopping HERE is
 *   impossible and failing the row would be a lie about live work: said out loud.
 * - `'idle'` — the row is no longer generating at all (it settled between the
 *   render and the press): also said out loud, because silence is the bug.
 */
export async function stopModuleGeneration(moduleId: Id): Promise<ModuleStopOutcome> {
  if (hasLiveModuleGen(moduleId)) {
    cancelModuleGen(moduleId);
    return 'cancelled';
  }
  if (await claimedElsewhere(moduleId)) {
    toastInfo('Another tab is generating this module — press Stop there.');
    return 'elsewhere';
  }
  if (await reconcileInterruptedModuleGen(moduleId)) return 'reconciled';
  toastInfo('That generation is no longer running.');
  return 'idle';
}
