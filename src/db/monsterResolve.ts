import { resolveMonsterEntry, type ResolvedMonster } from '@/domain/encounterResolve';
import type { Id, MonsterEntry } from '@/domain';
import { getArtifact } from '@/db/artifactRepo';
import { db } from '@/db/db';

/**
 * Repo-wired monster resolution (07-MILESTONE-3 M3-B): the UI-facing variant
 * of `resolveMonsterEntry` (pure logic lives in
 * `/src/domain/encounterResolve.ts` with injected lookups).
 */
export function resolveMonsterEntryWithRepos(entry: MonsterEntry): Promise<ResolvedMonster> {
  return resolveMonsterEntry(entry, {
    getArtifact,
    getChunk: (id: Id) => db.chunks.get(id),
    bookTitle: async (bookId: Id) => (await db.rulebooks.get(bookId))?.title ?? '',
  });
}

/** Resolves a whole monster list in order (used by the Stat blocks panel). */
export async function resolveMonsterEntries(
  entries: readonly MonsterEntry[],
): Promise<ResolvedMonster[]> {
  return Promise.all(entries.map((entry) => resolveMonsterEntryWithRepos(entry)));
}
