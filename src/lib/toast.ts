import { toast, type ExternalToast } from 'sonner';

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
 *
 * THE OPTIONS LIVE HERE ONCE (docs/17 row 280). A persistent notice acquired a
 * SECOND caller — the clean-cut report, which is a statement of fact rather than
 * a failure (`toastInfoPersistent`) — so the three options that MAKE a notice
 * persistent (`duration: Infinity`, `closeButton: true`, and the acknowledgement
 * hook) moved into `persistentNotice` below. Two hand-written option objects
 * would drift exactly as the AGENTS centralization rule warns: the next person
 * to add a persistent notice would copy one of them, and whichever option that
 * copy missed would be a silent regression in a surface whose whole job is not
 * to be missed. `tests/lib/toast-persistent-dismiss.test.tsx` holds the
 * population to this file with a source scan as well as by behaviour.
 */
function persistentNotice(
  level: 'error' | 'info',
  message: string,
  description: string | undefined,
  onAcknowledge?: () => void,
): void {
  const options: ExternalToast = { duration: Infinity, closeButton: true };
  if (description !== undefined) options.description = description;
  // `onDismiss` — and NOT `onAutoClose` — is the acknowledgement hook: sonner
  // fires it from the close button's own click handler and from a swipe-out
  // (`node_modules/sonner/dist/index.mjs:848` / `:772`), i.e. from a deliberate
  // user dismissal. With `duration: Infinity` the auto-close path never runs.
  if (onAcknowledge !== undefined) {
    options.onDismiss = () => {
      onAcknowledge();
    };
  }
  if (level === 'error') {
    toast.error(message, options);
  } else {
    toast.info(message, options);
  }
}

export function toastErrorPersistent(message: string, error?: unknown): void {
  persistentNotice('error', message, errorDescription(error));
}

/**
 * A persistent notice that is NOT a failure — it says what the app DID, and it
 * must not be missed (docs/17 row 280).
 *
 * THE OWNER'S REPORT, verbatim from the one real clean cut: he never saw the
 * sentence naming what was removed, because the notice was a 4-second
 * `toastInfo` fired on the same mount as the first-run wizard's auto-open, and
 * `AppShell` cleared `settings.cleanCut` in the same breath — so the ONE
 * notification a DESTRUCTIVE operation produces expired under a modal and left
 * no second chance and no record. The fix is not more copy: it is the SAME
 * persistence the failure seam already has.
 *
 * `onAcknowledge` is the caller's record that the owner has SEEN this. It runs
 * only from a deliberate dismissal, which is why the notice must be raised with
 * `closeButton: true` — a persistent notice with no reachable closer is a
 * permanent one (the row-136 defect, `tests/lib/toast-persistent-dismiss.test.tsx`).
 * The caller owns what acknowledgement means, because only the caller knows
 * where its durable record lives.
 */
export function toastInfoPersistent(message: string, onAcknowledge?: () => void): void {
  persistentNotice('info', message, undefined, onAcknowledge);
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
