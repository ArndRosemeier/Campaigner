import type { MonsterEntry } from '@/domain/artifact';
import type { Id } from '@/domain/entity';

/**
 * THE ONE interpretation of an encounter roster entry's `npc-ref` TARGET
 * (docs/17 rows 248c/257). Both halves of family E's repoint live here, in one
 * file, because a second place that spells `source.type === 'npc-ref'` is a
 * second opinion about which field holds the target — the exact fragmentation
 * AGENTS §Centralization obligation 4 forbids.
 *
 * - `rosterArtifactIds` — the DETECTOR: "which artifact ids does this roster
 *   point at", the reader every roster consumer already uses (the auto-promote
 *   ROSTER/BATTLE hook, the delete census). It moved here from
 *   `db/artifactAutoPromote` so the adoption seam can reach it WITHOUT
 *   importing a `db`-bound module: the Dexie v26 upgrade body must not touch
 *   the `db` singleton (the v20/v24 precedent), and a
 *   `db/db.ts` → `db/libraryAdopt` → `db/artifactAutoPromote` → `db/db.ts`
 *   cycle would be a module-initialization hazard for one function.
 *
 * - `repointRosterArtifactIds` — the REWRITER: the ONE way an `npc-ref` target
 *   is replaced. `resolve` answers the id to point at, or `undefined` to LEAVE
 *   THE ENTRY ALONE (a target the seam has no copy for — a collection, a
 *   non-global, an id that vanished). It answers `null` when nothing changed,
 *   so a caller can tell "nothing to do" from "the same rows came back".
 *
 * A `rulebook` entry is a LIBRARY CREATURE CITATION and contributes no id
 * (docs/11 D5 amendment): it names a read-only chunk, not a row this app owns.
 */

/** The artifact ids a roster points at: its `npc-ref` entries' targets, and
 * nothing else. ONE reader for every roster consumer. */
export function rosterArtifactIds(monsters: readonly MonsterEntry[]): Id[] {
  const ids: Id[] = [];
  for (const monster of monsters) {
    if (monster.source.type === 'npc-ref') ids.push(monster.source.artifactId);
  }
  return ids;
}

/**
 * Rewrite every `npc-ref` target in a roster through `resolve`; `null` when the
 * roster is already correct (so an idempotent pass writes nothing).
 */
export function repointRosterArtifactIds(
  monsters: readonly MonsterEntry[],
  resolve: (id: Id) => Id | undefined,
): MonsterEntry[] | null {
  const next = monsters.map((monster) => {
    if (monster.source.type !== 'npc-ref') return monster;
    const replacement = resolve(monster.source.artifactId);
    if (replacement === undefined || replacement === monster.source.artifactId) return monster;
    return { ...monster, source: { type: 'npc-ref' as const, artifactId: replacement } };
  });
  // "Did anything change?" by IDENTITY: an untouched entry is the SAME object,
  // so this needs no flag the compiler would read as always-false inside the
  // callback (the lint trap the row-255a writer hit).
  return next.some((entry, index) => entry !== monsters[index]) ? next : null;
}
