import { db } from '@/db/db';
import { adoptLibraryArtifacts } from '@/db/libraryAdopt';
import type { LibraryAdoptReport } from '@/domain/settings';

/**
 * THE startup retry of the library-adoption migration (docs/17 row 257) — the
 * other half of the owner-decided failure arm.
 *
 * The arm is "copy what resolves, LEAVE the reference intact and name it" —
 * which is only a cure because a library row that was absent at upgrade time
 * can still be adopted: the reference is still on the row, so a later launch
 * re-runs the SAME seam and copies it. This is the ONE place that opens an
 * ordinary transaction for that, so AppShell does not have to know the table
 * list (the `db/mobCopyRetry` precedent, exactly).
 *
 * It is deliberately SEPARATE from `db/libraryAdopt.adoptLibraryArtifacts`,
 * which takes a transaction and must never touch the `db` singleton: the
 * upgrade body that calls the seam runs before the upgraded instance is usable.
 *
 * AppShell calls it only when the persisted report names unresolved references,
 * so a workspace with nothing to heal pays one settings read, not a full scan.
 */
export function retryLibraryAdoptions(): Promise<LibraryAdoptReport> {
  return db.transaction(
    'rw',
    [db.artifacts, db.revisions, db.images, db.campaigns, db.settings],
    (tx) => adoptLibraryArtifacts({ tx, reason: 'retry' }),
  );
}
