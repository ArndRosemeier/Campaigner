import { Component } from 'react';
import type { ErrorInfo, JSX, ReactNode } from 'react';

import { Button } from '@/components/ui/button';

/**
 * Global error boundary (00-OVERVIEW §Global conventions "No silent
 * fallbacks"): a render crash must be LOUD — a full-screen card with the
 * error message and a reload action — never a blank page or a silent
 * console entry. Errors from event handlers / async code that escape
 * feature-level catches surface through `lib/globalErrors.ts` toasts; this
 * boundary catches React render failures, which toasts cannot.
 */
export class GlobalErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Console remains for developer diagnosis; the UI below is the user surface.
    console.error('[campaigner] render crash:', error, info.componentStack);
  }

  override render(): JSX.Element {
    const error = this.state.error;
    if (error === null) return this.props.children as JSX.Element;
    return (
      <div
        role="alert"
        className="flex h-dvh flex-col items-center justify-center gap-4 p-8 text-center"
        data-testid="global-error"
      >
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="max-w-xl text-sm text-muted-foreground">
          Campaigner hit an unexpected error and stopped rendering this view. The error
          message below helps diagnose the problem — reloading usually restores the app.
        </p>
        <pre
          data-testid="global-error-message"
          className="max-w-xl overflow-auto rounded-md border bg-muted/40 p-3 text-left text-xs whitespace-pre-wrap text-muted-foreground"
        >
          {error.message}
        </pre>
        <Button
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload Campaigner
        </Button>
      </div>
    );
  }
}
