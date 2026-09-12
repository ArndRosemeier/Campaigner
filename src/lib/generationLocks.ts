import type { Id } from '@/domain';

/**
 * Web Locks around a generation pass (docs/17 row 110, docs/18 §2.2/§4).
 *
 * TWO jobs, and both are stated here because they are the reason this is a
 * seam and not an inline `navigator.locks.request` call site:
 *
 * 1. **Freeze mitigation.** Chromium's desktop freeze criteria explicitly
 *    list "the page holds a Web Lock" (and an open IndexedDB transaction) as
 *    an opt-out. A multi-minute module forge that holds a lock for its whole
 *    pass is therefore a page the browser is told not to freeze — the cheap,
 *    documented half of the owner's "can we make the browser keep giving the
 *    app the resources" question.
 * 2. **The cross-tab LEASE for the module row.** The module row's
 *    `status: 'generating'` is a claim, not a fact: reconciliation rewrites
 *    such a row only when NOTHING in this page owns a live controller, and a
 *    held lock with the same name is the one signal that says "another tab is
 *    writing this module right now" (a second browser tab is the case where a
 *    page-local registry cannot know). `isGenerationLockHeld` is that read.
 *
 * ADVISORY, NEVER A DEPENDENCY. When `navigator.locks` is absent (older
 * browsers, jsdom, node) the pass runs unchanged; when the lock is held
 * elsewhere `ifAvailable` hands back `null` immediately and the pass STILL
 * runs (today's behaviour — a second tab generating the same module is
 * already possible and blocking it would be a new failure mode, not a fix).
 * Nothing in the app branches on whether the lock was granted: it is a
 * mitigation, so its absence must cost nothing but the mitigation.
 */

/** The namespace every generation lock shares (never a bare module id: lock
 * names are global to the origin, the app is not its only origin user). */
export const GENERATION_LOCK_PREFIX = 'campaigner:generation:';

/** The lock name for one module's forge pass (spine, parts, post-generation). */
export function moduleGenLockName(moduleId: Id): string {
  return `${GENERATION_LOCK_PREFIX}module-gen:${moduleId}`;
}

/** The subset of the Web Locks API this module uses (absent ⇒ no mitigation). */
interface LockManagerLike {
  request: (
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<unknown>,
  ) => Promise<unknown>;
  query?: () => Promise<{ held: { name?: string }[] }>;
}

function lockManager(): LockManagerLike | null {
  if (typeof navigator === 'undefined') return null;
  // Read through `unknown`: lib.dom already declares `navigator.locks` as a
  // non-optional LockManager, which would make the absence check statically
  // dead — and the absence is the whole point of the fallback.
  const candidate = (navigator as unknown as { locks?: unknown }).locks;
  if (candidate === undefined || candidate === null) return null;
  const manager = candidate as LockManagerLike;
  return typeof manager.request === 'function' ? manager : null;
}

/** True when a usable Web Locks API is present (tests pin BOTH branches). */
export function webLocksAvailable(): boolean {
  return lockManager() !== null;
}

/**
 * Runs `work` while holding `name`, releasing it when `work` settles
 * (`lockManager.request`'s callback promise IS the hold: the lock is released
 * in a `finally` the platform owns, so a throw, an abort or a resolved pass
 * all release it). With no Web Locks API the work runs directly — the
 * documented fallback, not an error.
 */
export async function withGenerationLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  const manager = lockManager();
  if (manager === null) return work();
  const result = await manager.request(name, { ifAvailable: true }, async () => work());
  return result as T;
}

/**
 * Is the named lock held (by any tab, including this one)? `false` when the
 * API is missing or the query fails: the app then falls back to the
 * page-local controller registry as its only liveness signal — stated here
 * rather than hidden, because it is the one case where reconciliation cannot
 * see another tab (docs/18 §4).
 */
export async function isGenerationLockHeld(name: string): Promise<boolean> {
  const manager = lockManager();
  if (manager === null || typeof manager.query !== 'function') return false;
  try {
    const state = await manager.query();
    return state.held.some((lock) => lock.name === name);
  } catch {
    return false;
  }
}
