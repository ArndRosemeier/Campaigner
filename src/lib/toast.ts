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

export function toastSuccess(message: string): void {
  toast.success(message);
}
