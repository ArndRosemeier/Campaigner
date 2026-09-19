import { useCallback, useEffect, useRef, useState } from 'react';

import { onPageResumed } from '@/lib/pageLiveness';
import { toastError } from '@/lib/toast';

/**
 * Screen Wake Lock for the battle surface (docs/17 row 262b, docs/18 §2.3).
 *
 * THE DEFECT: the iPad dims and locks mid-battle during a stretch of talking
 * or reading — nothing in the app ever asked the browser to keep the screen
 * on. This hook holds a screen wake lock for as long as the surface is
 * mounted, lets it go on unmount, and RE-ACQUIRES it on page resume, because
 * iOS drops the lock the moment the tab is backgrounded and a lock acquired
 * while hidden is refused.
 *
 * HONESTY, which is the point of the status: `navigator.wakeLock` is
 * feature-detected, and an unsupported browser is a NO-OP — no request, no
 * error, and above all no pretence. `status` reports what actually happened
 * (`unsupported` / `requesting` / `held` / `refused`); it is never set to
 * `held` because a request was merely issued. A refusal is surfaced loudly
 * (once per mount) because the iPad really will sleep.
 *
 * OWNER DECISION, FLAGGED IN docs/17 row 262b: the default is AUTO — the lock
 * is held whenever the battle surface is open, with no toggle. One line vetoes
 * it (`veto 262b`), after which this hook is given an explicit enable flag.
 *
 * jsdom cannot prove the iOS behaviours this exists for — it has no
 * Wake Lock, no real suspension and no screen. The device test is the owner's;
 * what the suite pins is the request/release/resume SEQUENCE against a stubbed
 * API.
 */

export type WakeLockStatus = 'unsupported' | 'requesting' | 'held' | 'refused';

/** The slice of `Navigator.wakeLock` this app uses, read through a runtime
 * check because the DOM types declare it unconditionally while browsers that
 * lack the API have `undefined` in that slot. */
interface ScreenWakeLockApi {
  request(type: 'screen'): Promise<WakeLockSentinel>;
}

function screenWakeLockApi(): ScreenWakeLockApi | null {
  if (typeof navigator === 'undefined') return null;
  const api = (navigator as { wakeLock?: unknown }).wakeLock;
  if (api === undefined || api === null) return null;
  const request = (api as { request?: unknown }).request;
  if (typeof request !== 'function') return null;
  return api as ScreenWakeLockApi;
}

/**
 * Holds a screen wake lock while the calling component is mounted. Call it
 * once, from the surface that must not let the tablet sleep.
 */
export function useScreenWakeLock(): WakeLockStatus {
  const [status, setStatus] = useState<WakeLockStatus>(() =>
    screenWakeLockApi() === null ? 'unsupported' : 'requesting',
  );
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  const refusedReportedRef = useRef(false);

  const acquire = useCallback(async (): Promise<void> => {
    const api = screenWakeLockApi();
    if (api === null) {
      setStatus('unsupported');
      return;
    }
    // A sentinel that the browser already released (the tab was hidden) is
    // stale: asking again is the whole point of the resume path.
    if (sentinelRef.current !== null && !sentinelRef.current.released) {
      setStatus('held');
      return;
    }
    try {
      const sentinel = await api.request('screen');
      sentinelRef.current = sentinel;
      setStatus('held');
    } catch (error) {
      sentinelRef.current = null;
      setStatus('refused');
      if (!refusedReportedRef.current) {
        refusedReportedRef.current = true;
        toastError('The screen may lock during this battle — the wake lock was refused', error);
      }
    }
  }, []);

  const release = useCallback(async (): Promise<void> => {
    const sentinel = sentinelRef.current;
    sentinelRef.current = null;
    if (sentinel === null || sentinel.released) return;
    try {
      await sentinel.release();
    } catch (error) {
      toastError('The screen wake lock could not be released', error);
    }
  }, []);

  useEffect(() => {
    if (screenWakeLockApi() === null) {
      setStatus('unsupported');
      return undefined;
    }
    void acquire();
    // iOS releases the lock when the tab backgrounds; the page-liveness seam
    // is THE resume event (docs/17 row 110) — no second visibility listener.
    const unsubscribe = onPageResumed(() => {
      void acquire();
    });
    return () => {
      unsubscribe();
      void release();
    };
  }, [acquire, release]);

  return status;
}
