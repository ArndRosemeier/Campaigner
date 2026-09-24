import { creatureLookups } from '@/db/creatureRepo';
import { spellIndexLookup } from '@/db/spellRepo';
import {
  copyCreatureStats,
  copyStatBlockWithSpells,
  creatureCopyRefusal,
  type CreatureCopy,
  type CreatureCopyResult,
} from '@/domain/libraryCopy';
import type { CreatureRef } from '@/domain/creature';
import type { StatBlock } from '@/domain/statblock';
import { monsterEntrySchema, type Id, type MonsterEntry } from '@/domain';

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

/**
 * THE ONE entry SHAPE a copied library creature takes on a roster (docs/17 row
 * 349, folding `features/play/battle/spawn-picker-logic.buildMobPickEntry`'s
 * body down here).
 *
 * It exists because the clean-cut ROSTER REPAIR (`db/mobStatRepair`) must
 * produce the very entry the SPAWN PATH produces — a repaired row that minted
 * its own shape would be the second shape this project keeps paying for. The
 * shape is three fields off ONE `CreatureCopy`: the inline `statBlock`, the
 * STAMPED `sourceLine` and the opaque `originToken`. Nothing is composed here —
 * all three come off the copy seam (`copyCreatureStats`), which is why a repair
 * and a spawn cannot disagree about them.
 *
 * `name` is the roster row's OWN name (the library's spelling is display-only),
 * and `count`/`notes`/`treasure` are the freshly-created row's values — a
 * REPAIR of an EXISTING row takes only the three fields, so the row's own
 * count, notes, treasure and name are never rewritten (requirement 5 of the
 * row-349 slice).
 */
export function copiedMobEntryFrom(name: string, copy: CreatureCopy): MonsterEntry {
  return monsterEntrySchema.parse({
    name,
    count: 1,
    notes: '',
    treasure: '',
    source: { type: 'inline', statBlock: copy.statBlock },
    sourceLine: copy.sourceLine,
    originToken: copy.originToken,
  });
}

/**
 * THE builder for a core-mob pick: copy `chunkId`'s creature onto a fresh
 * single-instance roster entry. `features/play/battle/spawn-picker-logic
 * .buildMobPickEntry` delegates here, and the repair spends the SAME shape.
 *
 * A vanished chunk is a LOUD refusal (`creatureCopyRefusal`), never a
 * uuid-only pointer: there is nothing to copy, and minting a reference is
 * exactly what the owner's copy-only rule forbids.
 */
export async function buildCopiedMobEntry(chunkId: Id, entryName: string): Promise<MonsterEntry> {
  const result = await copyCreatureStatsFromDb({ chunkId }, entryName);
  if (result.status === 'unresolved') throw creatureCopyRefusal(entryName, result.reason);
  return copiedMobEntryFrom(entryName, result.copy);
}

