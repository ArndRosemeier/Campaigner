import { creatureRefIsEmpty, libraryCreatureKey } from '@/domain/creature';
import type { CreatureRef } from '@/domain/creature';
import {
  creatureCitationName,
  creatureOriginLabel,
  resolveCreatureChunk,
  type MonsterLookups,
} from '@/domain/encounterResolve';
import type { StatBlock } from '@/domain/statblock';

/**
 * THE ONE copy-on-write operation for a library creature (docs/17 row 255a,
 * AGENTS §Centralization obligation 4).
 *
 * The owner's rule, verbatim: *"i would like to stop all references to core
 * items inside modules. Core items should always ever only be copied."* A mob
 * used to be represented by a POINTER into the imported library (an encounter
 * roster entry's `rulebook` source, an authored NPC's `creatureRef`) resolved at
 * read time. Under the one-representation model a module-scoped row owns an
 * authored COPY of the library's bytes.
 *
 * THE COPY IS THREE THINGS, and they are ONE operation because a caller that
 * could take one without the others would silently drop provenance or identity:
 *
 * - `statBlock` — the library bytes, copied in full;
 * - `sourceLine` — the label ("Bestiary p.132", or "Bestiary: Owlbear" for a
 *   pack book) that `creatureOriginLabel` composes at READ time today. It is
 *   STAMPED with the copy, because once the pointer is gone there is no live
 *   chunk+book read left to compose it from;
 * - `originToken` — the OPAQUE identity token (`domain/creature
 *   .libraryCreatureKey`, the `chunk:<id>` spelling) that keeps a copied mob the
 *   SAME creature to the portrait/image cache, so no `mobPortraits` /
 *   `creatureImages` row needs remapping.
 *
 * WHY THIS MODULE EXISTS AT ALL. The v24 upgrade (`db/mobCopyRepair`) is a
 * ONE-SHOT backfill; the app keeps MINTING pointers at four live write sites
 * (`llm/runEngine`, `features/campaign/monster-source`,
 * `features/play/battle/spawn-picker-logic`, `db/creatureRepo
 * .castCreatureAsNpc`), and the start-up retry only runs on an unconverted row.
 * So the migration alone can never satisfy the rule — the copy has to be born at
 * WRITE time, and the backfill must call the SAME operation or the two mechanisms
 * drift. Before this seam the copy logic lived inside the migration only, which
 * is exactly the fragmentation AGENTS §Centralization forbids.
 *
 * PURE AND IO-FREE: the caller injects the lookups (the migration its Dexie
 * transaction's tables, a write site the live `db`), so it is callable from
 * inside a `version(N).upgrade` body, where the upgraded `db` instance is not yet
 * usable (the v20 `creatureRepair` precedent).
 *
 * NOTHING HERE IS A SILENT FALLBACK. A citation whose chunk is gone, whose chunk
 * carries no stat block, or which names no chunk at all answers a NAMED
 * `unresolved` reason — never an empty or placeholder block (AGENTS rule 1). The
 * migration REPORTS the reason; a write path REFUSES the write with it.
 */

/** A copy of one library creature: the bytes, the stamped origin, the token. */
export interface CreatureCopy {
  statBlock: StatBlock;
  sourceLine: string;
  originToken: string;
}

/**
 * What one copy attempt produced: the copy, or the NAMED reason it could not be
 * made. THE one vocabulary, so the migration's report and a write path's refusal
 * cannot word the same data condition differently.
 */
export type CreatureCopyResult =
  | { status: 'copied'; copy: CreatureCopy }
  | { status: 'unresolved'; reason: string };

/** The lookups a copy needs — a subset of the resolver's, so the migration's
 * tx-backed tables and the live repos are the same shape. */
export type CreatureCopyLookups = Pick<
  MonsterLookups,
  'getChunk' | 'getChunkByContentHash' | 'getRulebook'
>;

export const EMPTY_CREATURE_CITATION_REASON =
  'its creature citation carries neither a chunk id nor a content hash — nothing can be copied';
export const MISSING_CREATURE_CHUNK_REASON =
  'the cited stat-block chunk is not in this workspace — install the pack that carries it';
export const STATLESS_CREATURE_CHUNK_REASON =
  'the cited chunk carries no stat block — re-import the book it came from';

/**
 * Copy a library creature's stats off its citation. The uuid is tried first, the
 * stamped content hash second (a re-ingest under a new row id) — the ONE
 * resolution order (`resolveCreatureChunk`), so a copy made here and a read made
 * anywhere else cannot disagree about WHICH creature the citation means.
 */
export async function copyCreatureStats(
  citation: CreatureRef,
  fallbackName: string,
  lookups: CreatureCopyLookups,
): Promise<CreatureCopyResult> {
  if (creatureRefIsEmpty(citation)) {
    return { status: 'unresolved', reason: EMPTY_CREATURE_CITATION_REASON };
  }
  const chunk = await resolveCreatureChunk(citation, lookups);
  if (chunk?.statBlock == null) {
    return {
      status: 'unresolved',
      reason:
        chunk === undefined ? MISSING_CREATURE_CHUNK_REASON : STATLESS_CREATURE_CHUNK_REASON,
    };
  }
  return {
    status: 'copied',
    copy: {
      statBlock: chunk.statBlock,
      // The citation's own creature name when it stamped one, else the row's
      // name — exactly what `creatureOriginLabel` has always been handed.
      sourceLine: await creatureOriginLabel(
        chunk,
        creatureCitationName(citation, fallbackName),
        lookups,
      ),
      originToken: libraryCreatureKey(chunk.id),
    },
  };
}

/**
 * THE refusal sentence a WRITE path throws when a copy cannot be made — one
 * spelling, so the encounter finalize, the editor picker, the battle spawn
 * picker and the cast all fail in the same words and name the same remedy. The
 * `reason` is the seam's own (`copyCreatureStats`), never re-worded by a caller.
 */
export function creatureCopyRefusal(name: string, reason: string): Error {
  return new Error(`copy creature stats: refusing to copy «${name}» — ${reason}`);
}
