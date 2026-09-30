import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GlobalErrorBoundary } from '@/app/GlobalErrorBoundary';
import { installGlobalErrorHandlers } from '@/lib/globalErrors';
import { Toaster } from '@/components/ui/sonner';
import { cleanup } from '@testing-library/react';

/**
 * Global error surface (00-OVERVIEW "No silent fallbacks"): render crashes
 * hit the error boundary's full-screen card; uncaught exceptions and
 * unhandled rejections surface as toasts.
 */

function Bomb(): never {
  throw new Error('render exploded');
}

afterEach(cleanup);

describe('GlobalErrorBoundary', () => {
  it('shows a loud full-screen card with the error message and a reload action', async () => {
    const user = userEvent.setup();
    const reload = vi.fn();
    // jsdom's location.reload is not configurable — swap the whole location
    // for a plain stand-in exposing just what the boundary touches.
    Object.defineProperty(window, 'location', {
      value: { href: 'http://localhost/', reload },
      writable: true,
      configurable: true,
    });

    render(
      <GlobalErrorBoundary>
        <Bomb />
      </GlobalErrorBoundary>,
    );

    expect(screen.getByTestId('global-error')).toBeInTheDocument();
    expect(screen.getByTestId('global-error-message').textContent).toContain('render exploded');
    await user.click(screen.getByRole('button', { name: 'Reload Campaigner' }));
    expect(reload).toHaveBeenCalled();
  });

  it('renders children when no error occurs', () => {
    render(
      <GlobalErrorBoundary>
        <p data-testid="fine">all good</p>
      </GlobalErrorBoundary>,
    );
    expect(screen.getByTestId('fine')).toBeInTheDocument();
  });
});

describe('global error handlers', () => {
  it('surfaces uncaught errors and unhandled rejections as toasts', async () => {
    installGlobalErrorHandlers();
    render(<Toaster position="bottom-right" />);

    window.dispatchEvent(
      new ErrorEvent('error', { error: new Error('boom from listener') }),
    );
    // Sonner renders on its own store tick — wait for the flush.
    await waitFor(() => {
      expect(screen.getByText('Unexpected error')).toBeInTheDocument();
    });
    expect(screen.getByText('boom from listener')).toBeInTheDocument();

    window.dispatchEvent(new Event('unhandledrejection'));
    await waitFor(() => {
      expect(screen.getByText('Unhandled error in a background task')).toBeInTheDocument();
    });
  });
});
