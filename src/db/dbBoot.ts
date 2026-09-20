import { db } from '@/db/db';
import { DECLARED_DB_VERSION } from '@/db/cleanCut';

/**
 * THE boot gate (docs/17 row 278, inventory §f.6) — the ONE place the app first
 * touches the database, so the ONE place a failed clean-cut upgrade can be
 * caught and NAMED instead of reaching the generic error boundary.
 *
 * The `version(31)` upgrade body purges the campaign-scoped stores INSIDE the
 * IndexedDB versionchange transaction. If it throws, Dexie aborts that
 * transaction atomically (the stored version stays put, every row survives) and
 * `db.open()` rejects. `openCampaignerDatabase` turns that rejection into a
 * named result the recovery card renders — it never swallows the error, and it
 * never retries in a loop.
 *
 * It also reports two non-failure states:
 *  - a BLOCKED upgrade (another tab holds the database open) is a WAIT, surfaced
 *    by `onBlocked` so the caller can render the named line; the promise still
 *    resolves normally once the other connection closes, and NOTHING is deleted;
 *  - a NEWER stored database (a newer build wrote it) opens through Dexie's
 *    VersionError fallback. The app still starts; the caller shows a
 *    non-blocking notice naming both numbers and performs NO delete.
 */
export interface DatabaseOpenResult {
  status: 'ready' | 'failed';
  /** Present when `status === 'failed'` — the error's own message. */
  error?: Error;
  /** Present when the stored database is NEWER than this build declares. */
  newerVersion?: { stored: number; declared: number };
}

/** The named line a blocked upgrade shows while it waits for the other tab. */
export const BLOCKED_UPGRADE_MESSAGE =
  'Another Campaigner tab is still using this browser’s data — close it to let the update finish.';

/**
 * Open the app database, running the clean-cut upgrade if the stored version is
 * older. `onBlocked` is called ONCE if another connection delays the upgrade.
 * Never throws: a rejection is returned as `status: 'failed'` with the error.
 */
export async function openCampaignerDatabase(options: {
  onBlocked?: () => void;
} = {}): Promise<DatabaseOpenResult> {
  // `db.on('blocked', …)` is Dexie's own hook (the `versionchange` counterpart
  // is what closes a responsive other tab; a frozen one keeps holding it).
  // `onBlocked` is guarded so a repeated event cannot re-render the line.
  let blockedFired = false;
  const onBlocked = (): void => {
    if (blockedFired) return;
    blockedFired = true;
    options.onBlocked?.();
  };
  db.on('blocked', onBlocked);
  try {
    await db.open();
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  // The STORED native version is read off the open backend connection, NOT off
  // `db.verno` (MEASURED: Dexie's VersionError fallback opens the newer database
  // versionlessly but leaves the DECLARED `verno` in place, so `db.verno` is
  // still 31 here). Never delete: a newer database may belong to a newer build.
  const stored = Math.round(db.backendDB().version / 10);
  if (stored > DECLARED_DB_VERSION) {
    return { status: 'ready', newerVersion: { stored, declared: DECLARED_DB_VERSION } };
  }
  return { status: 'ready' };
}
