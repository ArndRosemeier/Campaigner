import { toast } from 'sonner';

/**
 * The single toast seam (00-OVERVIEW global conventions): errors shown to
 * users go through here, never through ad-hoc `sonner` calls in features.
 */
export function toastError(message: string, error?: unknown): void {
  const detail = error instanceof Error ? error.message : undefined;
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
  const detail = error instanceof Error ? error.message : undefined;
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
