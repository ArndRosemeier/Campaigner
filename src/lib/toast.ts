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
 * - a module-busy refusal's `.message` IS `Module <id> is already generating`
 *   (`src/llm/moduleGen.ts`), an internal row id handed to the owner for a
 *   condition its title already names together with both ways out → the
 *   description is DROPPED (`tests/features/module-busy.test.tsx` pins the
 *   real class here) and the raw error is logged instead.
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
 */
export function toastErrorPersistent(message: string, error?: unknown): void {
  const detail = errorDescription(error);
  if (detail === undefined) {
    toast.error(message, { duration: Infinity });
  } else {
    toast.error(message, { duration: Infinity, description: detail });
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
