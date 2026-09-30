import { afterEach, describe, expect, it } from 'vitest';

import {
  activeElapsedMs,
  installPageLiveness,
  isPageSuspended,
  onPageResumed,
  resetPageLiveness,
} from '@/lib/pageLiveness';

/**
 * WHICH browser event pauses the watchdog clock (docs/17 row 415, owner
 * decision): a FROZEN tab (freeze / pagehide) credits its gap; a merely HIDDEN
 * tab does not — its timers are throttled, not stopped, and the owner's remote
 * screen can report a tab he is looking at as hidden, which froze every stream
 * limit while a dead call hung for 20+ minutes. Hidden → visible still notifies
 * the resume listeners (the wake lock, the app shell's title).
 */

/** A document stand-in whose visibility the test drives. */
function fakeDocument(): EventTarget & { hidden: boolean } {
  const target = new EventTarget() as EventTarget & { hidden: boolean };
  target.hidden = false;
  return target;
}

let uninstall: (() => void) | undefined;

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  resetPageLiveness();
});

describe('page liveness: hidden is not a suspension, frozen is', () => {
  it('a hidden tab credits NO time, so a dead stream still times out', () => {
    const doc = fakeDocument();
    uninstall = installPageLiveness(doc);
    const start = Date.now();

    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));

    expect(isPageSuspended()).toBe(false);
    expect(activeElapsedMs(start, start + 60_000)).toBe(60_000);
  });

  it('hidden → visible notifies the resume listeners (once), without a gap', () => {
    const doc = fakeDocument();
    uninstall = installPageLiveness(doc);
    let resumed = 0;
    const unsubscribe = onPageResumed(() => {
      resumed += 1;
    });
    try {
      doc.hidden = true;
      doc.dispatchEvent(new Event('visibilitychange'));
      doc.hidden = false;
      doc.dispatchEvent(new Event('visibilitychange'));
      // A second "visible" with no hidden in between is not a resume.
      doc.dispatchEvent(new Event('visibilitychange'));
    } finally {
      unsubscribe();
    }
    expect(resumed).toBe(1);
  });

  it('a FROZEN tab credits its gap, and resuming closes it and notifies', () => {
    const doc = fakeDocument();
    uninstall = installPageLiveness(doc);
    let resumed = 0;
    const unsubscribe = onPageResumed(() => {
      resumed += 1;
    });
    try {
      const start = Date.now();
      doc.dispatchEvent(new Event('freeze'));
      expect(isPageSuspended()).toBe(true);
      // Still open: measured up to "now", so nearly all of it is credited.
      expect(activeElapsedMs(start, Date.now() + 60_000)).toBeLessThan(1_000);
      doc.dispatchEvent(new Event('resume'));
      expect(isPageSuspended()).toBe(false);
    } finally {
      unsubscribe();
    }
    expect(resumed).toBe(1);
  });

  it('a tab frozen while hidden and then shown closes the gap when it becomes visible', () => {
    const doc = fakeDocument();
    uninstall = installPageLiveness(doc);
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    doc.dispatchEvent(new Event('pagehide'));
    expect(isPageSuspended()).toBe(true);

    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));

    expect(isPageSuspended()).toBe(false);
  });
});
