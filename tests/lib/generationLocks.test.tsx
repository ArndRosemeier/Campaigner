import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GENERATION_LOCK_PREFIX,
  isGenerationLockHeld,
  moduleGenLockName,
  webLocksAvailable,
  withGenerationLock,
} from '@/lib/generationLocks';

/**
 * The generation lease (docs/17 row 110, docs/18 §2.2): a Web Lock held for the
 * duration of a generation pass, so a SECOND tab can tell "somebody is writing
 * this module" from "a tab died writing it" — app-start reconciliation must
 * never fail a module another tab is generating.
 *
 * The API is not universal, so the absence branch is a first-class case: no
 * lock manager means the helpers answer "not held" and the work runs anyway.
 * Never block, never throw, never silently pretend a lease exists — the page
 * without Web Locks falls back to the page-local registry alone, which docs/18
 * §4 states as a real limitation rather than papering over.
 */

interface ReleaseSpy {
  released: boolean;
}

function stubLocks(options: { held?: string[]; grantedElsewhere?: boolean }): {
  calls: { name: string; ifAvailable: boolean }[];
  release: ReleaseSpy;
  released: Promise<void>;
} {
  const calls: { name: string; ifAvailable: boolean }[] = [];
  const release: ReleaseSpy = { released: false };
  let markReleased: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    markReleased = resolve;
  });
  vi.stubGlobal('navigator', {
    locks: {
      request: (
        name: string,
        lockOptions: { ifAvailable?: boolean },
        callback: (lock: unknown) => Promise<unknown>,
      ): Promise<unknown> => {
        calls.push({ name, ifAvailable: lockOptions.ifAvailable === true });
        // The spec's `ifAvailable` branch: an unavailable lock hands the
        // callback `null` IMMEDIATELY (never queues, never blocks). Either way
        // the request's promise is the callback's promise, and settling it IS
        // the release.
        const held = options.grantedElsewhere === true ? null : { name };
        return Promise.resolve(callback(held)).finally(() => {
          release.released = true;
          markReleased();
        });
      },
      query: () =>
        Promise.resolve({
          held: (options.held ?? []).map((name) => ({ name })),
          pending: [],
        }),
    },
  });
  return { calls, release, released };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web locks as a generation lease', () => {
  it('is honestly absent when the API is missing, and the work still runs', async () => {
    // What jsdom and an old browser look like.
    vi.stubGlobal('navigator', {});

    expect(webLocksAvailable()).toBe(false);
    expect(await isGenerationLockHeld(moduleGenLockName('m1'))).toBe(false);
    // Never blocked, never swallowed: the caller's work runs and its value and
    // errors cross this seam untouched.
    await expect(
      withGenerationLock('campaigner:generation:module-gen:m1', () => Promise.resolve(42)),
    ).resolves.toBe(42);
    await expect(
      withGenerationLock('campaigner:generation:module-gen:m1', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
  });

  it('names the module lock predictably', () => {
    expect(moduleGenLockName('m1')).toBe(`${GENERATION_LOCK_PREFIX}module-gen:m1`);
  });

  it('holds the lock for the work and asks for it non-blocking, then RELEASES it', async () => {
    const locks = stubLocks({});
    const order: string[] = [];

    const result = await withGenerationLock(moduleGenLockName('m1'), () => {
      order.push('work');
      return Promise.resolve('done');
    });
    order.push('returned');

    expect(result).toBe('done');
    expect(order).toEqual(['work', 'returned']);
    // `ifAvailable`: a second tab must never be BLOCKED behind this lease — the
    // honest answer there is "not held", not a queue.
    expect(locks.calls).toEqual([{ name: 'campaigner:generation:module-gen:m1', ifAvailable: true }]);
    await locks.released;
    expect(locks.release.released).toBe(true);
  });

  it('releases the lease on the way out of a FAILING pass, and rethrows', async () => {
    const locks = stubLocks({});

    await expect(
      withGenerationLock(moduleGenLockName('m1'), () => Promise.reject(new Error('part failed'))),
    ).rejects.toThrow('part failed');

    await locks.released;
    expect(locks.release.released).toBe(true);
  });

  it('reads a held lock as a live lease for another tab', async () => {
    stubLocks({ held: [moduleGenLockName('m1')] });

    expect(webLocksAvailable()).toBe(true);
    expect(await isGenerationLockHeld(moduleGenLockName('m1'))).toBe(true);
    expect(await isGenerationLockHeld(moduleGenLockName('m2'))).toBe(false);
  });

  it('runs the pass anyway when another tab holds the lock (never blocks, never skips)', async () => {
    // `ifAvailable` hands the callback `null`: today's behaviour for a second
    // tab generating the same module must not change — a lease that blocked
    // generation would be a new failure mode, not a mitigation.
    const locks = stubLocks({ grantedElsewhere: true });

    await expect(
      withGenerationLock(moduleGenLockName('m1'), () => Promise.resolve('ran')),
    ).resolves.toBe('ran');

    expect(locks.calls).toEqual([{ name: 'campaigner:generation:module-gen:m1', ifAvailable: true }]);
  });
});
