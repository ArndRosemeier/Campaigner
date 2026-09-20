import { type ResolvedMonster } from '@/domain/encounterResolve';
import { resolveStoredMonsterEntry } from '@/domain/mobCopyLegacy';
import type { MonsterEntry } from '@/domain';
import { creatureLookups } from '@/db/creatureRepo';

/**
 * Repo-wired monster resolution (07-MILESTONE-3 M3-B): the UI-facing variant
 * of the pure resolver (pure logic lives in `/src/domain/encounterResolve.ts`
 * with injected lookups, and the ONE legacy read in
 * `/src/domain/mobCopyLegacy.ts`).
 *
 * Since docs/17 row 248c it dispatches through `resolveStoredMonsterEntry`: the
 * LIVE model has one representation (`inline` / `none`) and the pure resolver
 * carries no legacy arm, so a stored pointer the v24 migration could not
 * convert — the start-up retry's handle — is read and resolved by the seam
 * rather than by every consumer.
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
 * Content-hash fallback (chunk-hash-fallback arc): several local chunks may
 * share one hash (re-ingests) — prefer the one that actually carries stats,
 * mirroring the import verdict's L0 rule (a hash hit on a statless chunk
 * never satisfies).
 */
export function resolveMonsterEntryWithRepos(entry: MonsterEntry): Promise<ResolvedMonster> {
  return resolveStoredMonsterEntry(entry, creatureLookups());
}

/** Resolves a whole monster list in order (used by the Stat blocks panel). */
export async function resolveMonsterEntries(
  entries: readonly MonsterEntry[],
): Promise<ResolvedMonster[]> {
  return Promise.all(entries.map((entry) => resolveMonsterEntryWithRepos(entry)));
}
