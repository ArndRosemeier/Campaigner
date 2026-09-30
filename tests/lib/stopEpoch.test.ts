import { describe, expect, it } from 'vitest';

import { bumpStopEpoch, getStopEpoch, stoppedSince } from '@/lib/stopEpoch';

/**
 * The stop epoch (owner report: "Stop all should stop all generations, but it
 * only stops the current type loop"). ONE counter bumped by the sweep: an
 * orchestration that captured the epoch at entry learns that a stop happened
 * since, so it must not start its next unit. Deliberately NOT a sticky global
 * "stopping" flag — a pass that starts AFTER the stop holds the fresh epoch
 * and runs normally, so one stop never silently disables the next
 * user-visible generation.
 */

describe('stop epoch', () => {
  // The module is a singleton for the whole test file (like the app); each
  // case reasons RELATIVELY — capture, bump, compare — so no reset seam is
  // needed (and none is offered: nothing in the app may clear the epoch).

  it('reports a stop that landed after the capture', () => {
    const captured = getStopEpoch();
    expect(stoppedSince(captured)).toBe(false);
    bumpStopEpoch();
    expect(stoppedSince(captured)).toBe(true);
  });

  it('keeps the verdict for the rest of the pass (a later bump changes nothing)', () => {
    const captured = getStopEpoch();
    bumpStopEpoch();
    expect(stoppedSince(captured)).toBe(true);
    bumpStopEpoch();
    expect(stoppedSince(captured)).toBe(true);
  });

  it('lets an orchestration that starts AFTER the stop run normally', () => {
    bumpStopEpoch();
    const fresh = getStopEpoch();
    expect(stoppedSince(fresh)).toBe(false);
  });

  it('bumps monotonically — the epoch is a counter, never a flag to reset', () => {
    const before = getStopEpoch();
    bumpStopEpoch();
    const after = getStopEpoch();
    expect(after).toBeGreaterThan(before);
    bumpStopEpoch();
    expect(getStopEpoch()).toBeGreaterThan(after);
  });
});
