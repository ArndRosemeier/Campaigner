import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useScreenWakeLock } from '@/features/play/battle/use-screen-wake-lock';
import { notePageResumed, notePageSuspended, resetPageLiveness } from '@/lib/pageLiveness';
import { toastError } from '@/lib/toast';

/**
 * Screen Wake Lock (docs/17 row 262b): the request/release/resume SEQUENCE,
 * against a stubbed `navigator.wakeLock` because jsdom has no Wake Lock at all.
 *
 * WHAT THIS CANNOT PROVE, stated rather than implied: jsdom has no screen, no
 * battery, no Low Power Mode and no real tab suspension, so none of these tests
 * show that an iPad stays awake. They show the ordering the device depends on —
 * acquire on mount, release on unmount, RE-acquire on page resume, and an
 * unsupported browser left alone. The on-device test is the owner's.
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn() }));

interface FakeSentinel {
  released: boolean;
  release: ReturnType<typeof vi.fn>;
}

function fakeSentinel(): FakeSentinel {
  const sentinel: FakeSentinel = {
    released: false,
    release: vi.fn(() => {
      sentinel.released = true;
      return Promise.resolve();
    }),
  };
  return sentinel;
}

function installWakeLock(request: (type: string) => Promise<WakeLockSentinel>): void {
  Object.defineProperty(navigator, 'wakeLock', {
    value: { request },
    configurable: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPageLiveness();
  Reflect.deleteProperty(navigator, 'wakeLock');
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'wakeLock');
  resetPageLiveness();
});

describe('useScreenWakeLock', () => {
  it('is a NO-OP where the API does not exist — no request, no error, no pretence of holding', async () => {
    const { result, unmount } = renderHook(() => useScreenWakeLock());
    expect(result.current).toBe('unsupported');
    await act(async () => {
      await Promise.resolve();
    });
    // Never "held": the status reports what actually happened.
    expect(result.current).toBe('unsupported');
    unmount();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('acquires on mount, reports held, and releases on unmount', async () => {
    const sentinel = fakeSentinel();
    const request = vi.fn(() => Promise.resolve(sentinel as unknown as WakeLockSentinel));
    installWakeLock(request);

    const { result, unmount } = renderHook(() => useScreenWakeLock());
    await waitFor(() => {
      expect(result.current).toBe('held');
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('screen');
    expect(sentinel.release).not.toHaveBeenCalled();

    unmount();
    await waitFor(() => {
      expect(sentinel.release).toHaveBeenCalledTimes(1);
    });
  });

  it('RE-acquires after a page resume, because iOS drops the lock with the tab hidden', async () => {
    const first = fakeSentinel();
    const second = fakeSentinel();
    const request = vi
      .fn<() => Promise<WakeLockSentinel>>()
      .mockResolvedValueOnce(first as unknown as WakeLockSentinel)
      .mockResolvedValueOnce(second as unknown as WakeLockSentinel);
    installWakeLock(request);

    const { result, unmount } = renderHook(() => useScreenWakeLock());
    await waitFor(() => {
      expect(result.current).toBe('held');
    });
    expect(request).toHaveBeenCalledTimes(1);

    // The browser releases the sentinel when the page hides; the resume path
    // must ask again rather than trusting the stale handle.
    first.released = true;
    act(() => {
      notePageSuspended();
      notePageResumed();
    });
    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
    });
    expect(result.current).toBe('held');

    unmount();
    await waitFor(() => {
      expect(second.release).toHaveBeenCalledTimes(1);
    });
  });

  it('reports a refusal out loud exactly once, and keeps retrying on resume', async () => {
    const refusal = new Error('Low Power Mode is on');
    const request = vi.fn<() => Promise<WakeLockSentinel>>().mockRejectedValue(refusal);
    installWakeLock(request);

    const { result } = renderHook(() => useScreenWakeLock());
    await waitFor(() => {
      expect(result.current).toBe('refused');
    });
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining('wake lock was refused'),
      refusal,
    );

    act(() => {
      notePageSuspended();
      notePageResumed();
    });
    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
    });
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
