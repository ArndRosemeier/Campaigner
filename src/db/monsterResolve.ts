import { resolveMonsterEntry, type ResolvedMonster } from '@/domain/encounterResolve';
import type { Id, MonsterEntry } from '@/domain';
import { getArtifact } from '@/db/artifactRepo';
import { getChunksByContentHash } from '@/db/chunkRepo';
import { db } from '@/db/db';

/**
 * Repo-wired monster resolution (07-MILESTONE-3 M3-B): the UI-facing variant
 * of `resolveMonsterEntry` (pure logic lives in
 * `/src/domain/encounterResolve.ts` with injected lookups).
 *
 * Content-hash fallback (chunk-hash-fallback arc): several local chunks may
 * share one hash (re-ingests) — prefer the one that actually carries stats,
 * mirroring the import verdict's L0 rule (a hash hit on a statless chunk
 * never satisfies).
 */
export function resolveMonsterEntryWithRepos(entry: MonsterEntry): Promise<ResolvedMonster> {
  return resolveMonsterEntry(entry, {
    getArtifact,
    getChunk: (id: Id) => db.chunks.get(id),
    getChunkByContentHash: async (contentHash: string) => {
      const rows = await getChunksByContentHash(contentHash);
      return rows.find((row) => row.statBlock !== null) ?? rows[0];
    },
    getRulebook: (bookId: Id) => db.rulebooks.get(bookId),
  });
}

/** Resolves a whole monster list in order (used by the Stat blocks panel). */
export async function resolveMonsterEntries(
  entries: readonly MonsterEntry[],
): Promise<ResolvedMonster[]> {
  return Promise.all(entries.map((entry) => resolveMonsterEntryWithRepos(entry)));
}
