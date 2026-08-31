import { toastError } from '@/lib/toast';

/**
 * Global handlers for errors that escape feature-level catches (00-OVERVIEW
 * §Global conventions "No silent fallbacks"): uncaught exceptions and
 * unhandled promise rejections surface as visible toasts — never only in the
 * console. Installed once from the app root.
 */

let installed = false;

export function installGlobalErrorHandlers(): void {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (event) => {
    // Resource-load errors (img/script) without an error object are noise.
    const detail = event.error instanceof Error ? event.error : undefined;
    toastError('Unexpected error', detail ?? event.message);
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    event.preventDefault();
    const reason: unknown = event.reason;
    toastError(
      'Unhandled error in a background task',
      reason instanceof Error ? reason : undefined,
    );
  });
}
