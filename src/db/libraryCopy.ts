import { creatureLookups } from '@/db/creatureRepo';
import { spellIndexLookup } from '@/db/spellRepo';
import {
  copyCreatureStats,
  copyStatBlockWithSpells,
  type CreatureCopyResult,
} from '@/domain/libraryCopy';
import type { CreatureRef } from '@/domain/creature';
import type { StatBlock } from '@/domain/statblock';

/**
 * The LIVE half of the ONE copy-on-write operation (docs/17 row 255a): the
 * `db`-backed lookups the pure `domain/libraryCopy.copyCreatureStats` needs,
 * taken from the SAME `db/creatureRepo.creatureLookups` every library-creature
 * read uses — so a copy and a resolution cannot disagree about the
 * content-hash fallback's stat-block preference.
 *
 * THE SPELL ARM (docs/17 row 255c) is the SAME corpus read the read path
 * resolves against (`db/spellRepo.spellIndexLookup`, the ONE lazy
 * `loadSpellIndexesFor`): read once for the whole copy, skipped entirely for a
 * mob that assigns no spells. A system whose library holds no spells is absent
 * from the map, which the seam reads as "no library" rather than an error: the
 * copy carries the names it names and the resolver reports each one loudly,
 * exactly as before this row.
 *
 * Beside the migration (`db/mobCopyRepair`), which calls the same pure seam with
 * its Dexie TRANSACTION's tables: the backfill and the write paths share ONE
 * copy mechanism, which is the whole point of the slice. A migrated copy and a
 * live copy therefore carry the SAME spell entries — pinned differentially in
 * `tests/features/mob-spell-copy.test.ts`.
 */
export function copyCreatureStatsFromDb(
  citation: CreatureRef,
  fallbackName: string,
): Promise<CreatureCopyResult> {
  return copyCreatureStats(citation, fallbackName, {
    ...creatureLookups(),
    spellIndex: spellIndexLookup(),
  });
}

/**
 * THE SPELL HALF of the copy, live-wired for a caller that already HAS the
 * block (docs/17 row 270): `db/battleSeed.expandRosterEntries` freezes
 * `resolved.statBlock` onto the battle's `seedFighters[]`, and a frozen seed
 * row is the battle card's copy — it must render its spell entries with the
 * library ABSENT, exactly like a mob row the copy seam made.
 *
 * It is the SAME `domain/libraryCopy.copyStatBlockWithSpells` operation, and
 * the SAME corpus read (`db/spellRepo.spellIndexLookup`, the ONE lazy
 * `loadSpellIndexesFor`) the two other live copy callers use — a second
 * stamping expression or a second corpus read would be the fragmentation AGENTS
 * rule 4 forbids. The heap of `CreatureCopyLookups` is not needed: spell
 * stamping resolves against the corpus alone, never against a creature citation.
 */
export function copyStatBlockSpellsFromDb(statBlock: StatBlock): Promise<StatBlock> {
  return copyStatBlockWithSpells(statBlock, { spellIndex: spellIndexLookup() });
}
