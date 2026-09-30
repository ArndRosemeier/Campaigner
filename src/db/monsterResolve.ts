import { resolveMonsterEntry, type ResolvedMonster } from '@/domain/encounterResolve';
import type { MonsterEntry } from '@/domain';
import { creatureLookups } from '@/db/creatureRepo';

/**
 * Repo-wired monster resolution (07-MILESTONE-3 M3-B): the UI-facing variant
 * of the pure resolver (pure logic lives in `/src/domain/encounterResolve.ts`
 * with injected lookups).
 *
 * THE LOOKUPS COME FROM THE ONE SEAM (docs/17 row 263): `creatureLookups()`
 * (`db/creatureRepo`) is the repo-wired `MonsterLookups` — its `getArtifact` IS
 * the any-scope `getAnyArtifact`, exactly like the battle seeder, the portrait
 * queue and the cast path. This module used to assemble its own copy with the
 * CAMPAIGN-ONLY `getArtifact`, so a roster `npc-ref` at a GLOBAL library NPC
 * read as the loud `missing ref` in its own workspace while the battle seeded
 * it fine — one idea, two getters, drifted. A genuinely absent artifact is
 * still the loud missing arm; nothing here softens it.
 *
 * The clean cut (docs/17 row 278) deleted the `domain/mobCopyLegacy` dispatch
 * this used to go through: the `npc-ref` resolution is re-homed into the ONE
 * pure resolver, so there is exactly one dispatch again.
 */
export function resolveMonsterEntryWithRepos(entry: MonsterEntry): Promise<ResolvedMonster> {
  return resolveMonsterEntry(entry, creatureLookups());
}

/** Resolves a whole monster list in order (used by the Stat blocks panel). */
export async function resolveMonsterEntries(
  entries: readonly MonsterEntry[],
): Promise<ResolvedMonster[]> {
  return Promise.all(entries.map((entry) => resolveMonsterEntryWithRepos(entry)));
}
