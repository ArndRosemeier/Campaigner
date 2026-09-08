import { toast } from 'sonner';

import { humanizeZodIssues, zodIssuesOf } from '@/lib/zodErrorSummary';

/**
 * The single toast seam (00-OVERVIEW global conventions): errors shown to
 * users go through here, never through ad-hoc `sonner` calls in features.
 *
 * Humanize-at-the-seam rule (05-UI §Error surfaces): a ZodError's `.message`
 * IS the raw `[{code,path,message}...]` array, so it is NEVER rendered
 * verbatim — the description carries the counted/grouped/capped summary
 * instead, and the full raw error goes to the console (one click away in
 * devtools, never megabytes in the toast). The leading `message` title is
 * untouched: only the description is humanized, so every existing caller's
 * copy reads exactly as before.
 */
function errorDescription(error: unknown): string | undefined {
  const issues = zodIssuesOf(error);
  if (issues !== null) {
    console.error(error);
    return humanizeZodIssues(issues);
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
