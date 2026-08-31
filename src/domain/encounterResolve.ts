import type { Artifact, Id, MonsterEntry, RuleChunk, StatBlock } from '@/domain';

/**
 * Monster source resolution (07-MILESTONE-3 M3-B): turns an encounter's
 * monster entry into a displayable StatBlock + origin label. Pure logic —
 * lookups are injected so the domain never touches Dexie; `src/db/
 * monsterResolve.ts` wires the repo-backed variant used by the UI.
 *
 * Dangling references (deleted NPC / book) never throw: they resolve to a
 * null stat block with origin "missing ref" so the UI can show a warning
 * badge instead of crashing.
 */

export interface MonsterLookups {
  getArtifact: (id: Id) => Promise<Artifact | undefined>;
  getChunk: (id: Id) => Promise<RuleChunk | undefined>;
  /** Book title for origin labels; '' when the book is gone. */
  bookTitle: (bookId: Id) => Promise<string>;
}

export interface ResolvedMonster {
  statBlock: StatBlock | null;
  /** Display string: "NPC: Vexra" / "Bestiary p.132" / "inline" / "missing ref" / "" (none). */
  origin: string;
}

export async function resolveMonsterEntry(
  entry: MonsterEntry,
  lookups: MonsterLookups,
): Promise<ResolvedMonster> {
  switch (entry.source.type) {
    case 'inline':
      return { statBlock: entry.source.statBlock, origin: 'inline' };
    case 'npc-ref': {
      const artifact = await lookups.getArtifact(entry.source.artifactId);
      if (artifact === undefined) return { statBlock: null, origin: 'missing ref' };
      if (artifact.kind !== 'npc' || artifact.data.statBlock === null) {
        return { statBlock: null, origin: `NPC: ${artifact.name}` };
      }
      return { statBlock: artifact.data.statBlock, origin: `NPC: ${artifact.name}` };
    }
    case 'rulebook': {
      const chunk = await lookups.getChunk(entry.source.chunkId);
      if (chunk?.statBlock == null) {
        return { statBlock: null, origin: 'missing ref' };
      }
      const title = await lookups.bookTitle(chunk.bookId);
      return {
        statBlock: chunk.statBlock,
        origin: `${title === '' ? 'Rulebook' : title} p.${chunk.pageStart}`,
      };
    }
    case 'none':
      return { statBlock: null, origin: '' };
  }
}
