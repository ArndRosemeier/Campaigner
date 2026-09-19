import { db } from '@/db/db';
import { repairMobCopies } from '@/db/mobCopyRepair';
import type { MobCopyRepairReport } from '@/domain/settings';

/**
 * THE startup retry of the mob-copy migration (docs/17 row 248) — the other
 * half of the owner-decided failure arm.
 *
 * The owner's arm is "convert what resolves, keep the failing pointer, report
 * it" — which is only a cure because a mob whose pack was uninstalled at
 * upgrade time can still be healed: the pointer is still on the row, so a later
 * launch after the pack is imported re-runs the SAME seam and copies it. This
 * is the ONE place that opens an ordinary transaction for that, so AppShell
 * does not have to know the table list.
 *
 * It is deliberately SEPARATE from `db/mobCopyRepair.repairMobCopies`, which
 * takes a transaction and must never touch the `db` singleton: the upgrade body
 * that calls the seam runs before the upgraded instance is usable. A retry runs
 * after the database is open, so it owns the (ordinary) transaction here.
 *
 * AppShell calls it only when the persisted report names unresolved mobs, so a
 * workspace with nothing to heal pays one settings read, not a full scan.
 */
export function retryMobCopies(): Promise<MobCopyRepairReport> {
  return db.transaction(
    'rw',
    [db.artifacts, db.chunks, db.rulebooks, db.settings],
    (tx) => repairMobCopies({ tx, reason: 'retry' }),
  );
}
