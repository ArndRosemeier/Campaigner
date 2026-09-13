import { toast } from 'sonner';

import { humanizeZodIssues, zodIssuesOf } from '@/lib/zodErrorSummary';

/**
 * The `name` a module-busy refusal carries (`ModuleBusyError`,
 * `src/llm/moduleGen.ts`). Matched by NAME rather than `instanceof` because
 * `lib/` is the lower layer and `llm/moduleGen.ts` already imports THIS module,
 * so importing the class here would close an import cycle (docs/18 §2.3). The
 * contract is not left implicit: `tests/features/module-busy.test.tsx`
 * constructs the REAL class and pins the suppressed description, so a rename
 * fails loudly there instead of silently leaking the id back into a toast.
 */
const MODULE_BUSY_ERROR_NAME = 'ModuleBusyError';

/**
 * The single toast seam (00-OVERVIEW global conventions): errors shown to
 * users go through here, never through ad-hoc `sonner` calls in features.
 *
 * Humanize-at-the-seam rule (05-UI §Error surfaces): an error whose `.message`
 * is not a sentence for the owner is NEVER rendered verbatim in the
 * description, and the full raw error goes to the console (one click away in
 * devtools, never megabytes in the toast). Two cases need it:
 *
 * - a ZodError's `.message` IS the raw `[{code,path,message}...]` array → the
 *   description carries the counted/grouped/capped summary instead;
 * - a module-busy refusal (`src/llm/moduleGen.ts`) → the description is DROPPED
 *   and the raw error is logged instead (`tests/features/module-busy.test.ts`
 *   pins the real class here). Its `.message` used to be the internal row id
 *   ``Module <id> is already generating``; that reword landed in docs/17 row
 *   123 and the message is a sentence now — the branch STAYS, because its
 *   remaining reason is the copy, not the uuid: the caller's title already
 *   names the state and both ways out (`module-busy.MODULE_BUSY_TOAST_TITLE`),
 *   so rendering the refusal's own sentence under it would say the same thing
 *   twice in one toast. The raw error still goes to the console.
 *
 * The leading `message` title is untouched in both cases: only the description
 * is humanized, so every existing caller's copy reads exactly as before.
 */
function errorDescription(error: unknown): string | undefined {
  const issues = zodIssuesOf(error);
  if (issues !== null) {
    console.error(error);
    return humanizeZodIssues(issues);
  }
  if (error instanceof Error && error.name === MODULE_BUSY_ERROR_NAME) {
    console.error(error);
    return undefined;
  }
  return error instanceof Error ? error.message : undefined;
}

export function toastError(message: string, error?: unknown): void {
  const detail = errorDescription(error);
  if (detail === undefined) {
    toast.error(message);
  } else {
    toast.error(message, { description: detail });
  }
}

/**
 * Errors that arrive through the global handlers (uncaught exceptions,
 * unhandled rejections) must not blink away after the default auto-dismiss:
 * they are the only surface for a failure nothing else caught, so they stay
 * until the user dismisses them (00-OVERVIEW "No silent fallbacks").
 *
 * "UNTIL THE USER DISMISSES THEM" USED TO BE A LIE, and the owner found it
 * (docs/17 row 136, verbatim: *"That error message is still on my screen and
 * the little closer it has does not close it."*). MEASURED: `duration:
 * Infinity` with no dismiss affordance is not "persistent", it is PERMANENT —
 * sonner draws its close button only when `toast.closeButton ??
 * toaster.closeButton` is truthy (`node_modules/sonner/dist/index.mjs:521-526`,
 * conditional render at `:842`), and neither this seam nor the app's `Toaster`
 * (`components/ui/sonner.tsx`) passed it, so a persistent notice rendered with
 * NO control that could remove it. The "little closer" the owner was clicking
 * is the error ICON the app's `icons={{ error: <OctagonXIcon /> }}` map draws —
 * an octagon containing an X, which is decoration, not a button.
 *
 * SO THE PERSISTENT NOTICE CARRIES SONNER'S OWN CLOSE BUTTON, per toast:
 * `closeButton: true`. WHY PER TOAST and not on the `Toaster`
 * (`components/ui/sonner.tsx`): a global flag would put a close X on every
 * TRANSIENT toast too (each 4-second success/info/error), which is a UX change
 * to surfaces that never had this problem — scope creep, not this fix. WHY THIS
 * MECHANISM and not a labelled `ToastAction` ("Dismiss"): sonner already
 * answers "dismiss this toast" with a real button whose accessible name is
 * `closeButtonAriaLabel` (default `Close toast`), so wiring an action would be a
 * SECOND dismiss mechanism for one idea (AGENTS rule 4). The icon is
 * deliberately NOT touched: the X-in-octagon is the app's error iconography
 * (`components/ui/sonner.tsx`), and overriding it per toast would make the same
 * error look different depending on which seam raised it — a distinction with
 * no meaning for the owner. The closer is visually distinct from it by
 * construction: an out-of-flow 20px circle with its own background and border
 * at the toast's corner (`sonner/dist/styles.css:223-242`) versus an inline
 * 16px glyph inside the toast body.
 *
 * DISMISSING IS NOT FORGETTING (docs/05-UI §Error surfaces): nothing about this
 * control removes evidence. The reason a caller passes here is ALSO on a
 * surface that outlives the toast — every batch failure is written to the
 * console when it happens (`features/modules/entity-batch-report`, docs/17 row
 * 131) and its failed run row is in the Runs tab — so a dismissed notice is a
 * cleared screen, never a lost reason. `tests/lib/toast-persistent-dismiss.test.tsx`
 * pins both halves.
 */
export function toastErrorPersistent(message: string, error?: unknown): void {
  const detail = errorDescription(error);
  if (detail === undefined) {
    toast.error(message, { duration: Infinity, closeButton: true });
  } else {
    toast.error(message, { duration: Infinity, description: detail, closeButton: true });
  }
}

/** Optional one-click follow-up attached to a success toast. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export function toastSuccess(message: string, action?: ToastAction): void {
  if (action === undefined) {
    toast.success(message);
    return;
  }
  toast.success(message, { action: { label: action.label, onClick: action.onClick } });
}

export function toastInfo(message: string): void {
  toast.info(message);
}
