import { creatureLookups } from '@/db/creatureRepo';
import { copyCreatureStats, type CreatureCopyResult } from '@/domain/libraryCopy';
import type { CreatureRef } from '@/domain/creature';

/**
 * The LIVE half of the ONE copy-on-write operation (docs/17 row 255a): the
 * `db`-backed lookups the pure `domain/libraryCopy.copyCreatureStats` needs,
 * taken from the SAME `db/creatureRepo.creatureLookups` every library-creature
 * read uses — so a copy and a resolution cannot disagree about the
 * content-hash fallback's stat-block preference.
 *
 * Beside the migration (`db/mobCopyRepair`), which calls the same pure seam with
 * its Dexie TRANSACTION's tables: the backfill and the write paths share ONE
 * copy mechanism, which is the whole point of the slice.
 */
export function copyCreatureStatsFromDb(
  citation: CreatureRef,
  fallbackName: string,
): Promise<CreatureCopyResult> {
  return copyCreatureStats(citation, fallbackName, creatureLookups());
}
