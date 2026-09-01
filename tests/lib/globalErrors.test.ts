import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installGlobalErrorHandlers } from '@/lib/globalErrors';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn() },
}));

import { toast } from 'sonner';

/**
 * Global error surface (00-OVERVIEW "No silent fallbacks"): uncaught
 * exceptions and unhandled rejections must reach the user as PERSISTENT
 * toasts — auto-dismissed toasts let errors scroll past unnoticed (the
 * "console-only error" failure mode), so the global handlers pin them.
 */

const toastErrorMock = vi.mocked(toast.error);

describe('installGlobalErrorHandlers', () => {
  beforeEach(() => {
    installGlobalErrorHandlers();
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('surfaces uncaught exceptions as a toast pinned until dismissal', () => {
    const error = new TypeError('Cannot read properties of undefined');

    window.dispatchEvent(new ErrorEvent('error', { error }));

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Unexpected error',
      expect.objectContaining({ duration: Infinity, description: error.message }),
    );
  });

  it('surfaces unhandled rejections as a toast pinned until dismissal', () => {
    const reason = new Error('background task blew up');
    const event = new PromiseRejectionEvent('unhandledrejection', {
      promise: Promise.resolve(),
      reason,
    });

    window.dispatchEvent(event);

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Unhandled error in a background task',
      expect.objectContaining({ duration: Infinity, description: reason.message }),
    );
  });

  it('still pins a message when the failure carries no Error object', () => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'opaque failure' }));

    expect(toastErrorMock).toHaveBeenCalledWith('Unexpected error', { duration: Infinity });
  });
});
