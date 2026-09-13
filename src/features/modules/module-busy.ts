import { toastError } from '@/lib/toast';

/**
 * ONE way to say "this module already has a generation running"
 * (docs/18 §2.3, docs/17 row 120).
 *
 * The CONDITION is one fact; the owner meets it in two different situations, so
 * the copy is deliberately TWO sentences and never one:
 *
 * - `MODULE_BUSY_TOAST_TITLE` — a toast about a refused ACTION. The owner
 *   pressed something (Send, Refine, Rewrite, Apply) that the module's single
 *   generation slot refused, so the sentence names the refusal and both ways
 *   out.
 * - `MODULE_GENERATING_REASON` — the reason attached to a blocked CONTROL
 *   (`BlockedControl`, docs/05 §Why a control cannot act). Nothing was pressed:
 *   the control is disabled and the sentence explains the state holding it.
 *
 * Collapsing those into one string would answer the wrong question at one of
 * the two audiences — a disabled control has no action to have been refused,
 * and a refusal toast is not a statement about a control's state. That is the
 * "two different questions merged" failure, which AGENTS rule 4 forbids as
 * firmly as the duplication it is fixing: what is shared is the FACT (one
 * module, one generation), not the sentence.
 *
 * THE GATE IS NOT HERE, ON PURPOSE. `src/llm/canvasBusy.ts` (the in-page
 * registry) and `src/lib/generationLocks.ts` (the cross-tab advisory lease) are
 * TWO deliberate authorities for that fact, each documented at its own seam;
 * this module owns the COPY they make the owner read and checks, holds, claims
 * or releases NOTHING. Folding the two mechanisms together would be a behaviour
 * change, not a copy fold.
 *
 * THE RAW ERROR IS NOT THE DESCRIPTION. `ModuleBusyError`'s own message is
 * `Module <id> is already generating` — an internal row id, not a sentence for
 * the owner (the audit found it rendering as this toast's detail line, so one
 * fact reached the owner as a friendly title plus a uuid). The helper still
 * passes the ERROR OBJECT through unchanged: it remains the toast seam's cause,
 * and the raw uuid-bearing text goes to the console — one click away in
 * devtools — exactly like the ZodError branch at that seam. That suppression is
 * pinned against the REAL error class in `tests/features/module-busy.test.tsx`,
 * so renaming the class turns the pin red instead of leaking the id back into a
 * toast.
 */

/**
 * The toast title for an action this module's single generation slot refused.
 * The SAME sentence the seven call sites used to each carry as a literal
 * (byte-identical: this is a fold, not a reword).
 */
export const MODULE_BUSY_TOAST_TITLE =
  'A generation is already running for this module — wait for it or stop it first';

/**
 * The reason a control blocked by this module's generation states. The SAME
 * sentence the three private `MODULE_GENERATING_REASON` constants used to each
 * carry (byte-identical).
 */
export const MODULE_GENERATING_REASON =
  'The module is generating right now — wait for it (or press Stop).';

/**
 * Surfaces a refused action whose cause is `ModuleBusyError` — the ONE call for
 * every canvas/board surface that used to repeat the title literal
 * (docs/18 §2.3). The error is passed through as the cause; the toast seam
 * drops its uuid-bearing message from the detail line and logs it instead.
 */
export function toastModuleBusy(error: unknown): void {
  toastError(MODULE_BUSY_TOAST_TITLE, error);
}