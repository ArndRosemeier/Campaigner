import type { Artifact, Id, MonsterEntry, Rulebook, RuleChunk, StatBlock } from '@/domain';

/**
 * Monster source resolution (07-MILESTONE-3 M3-B): turns an encounter's
 * monster entry into a displayable StatBlock + origin label. Pure logic —
 * lookups are injected so the domain never touches Dexie; `src/db/
 * monsterResolve.ts` wires the repo-backed variant used by the UI.
 *
 * Dangling references (deleted NPC / book) never throw: they resolve to a
 * null stat block with origin "missing ref" so the UI can show a warning
 * badge instead of crashing.
 *
 * Content-identity fallback (chunk-hash-fallback arc): a rulebook citation
 * whose uuid misses but carries `contentHash` resolves through
 * `getChunkByContentHash` — a re-ingest under a new row id still satisfies a
 * byte-identical citation. Exact content-hash ONLY in this slice: a
 * same-creature chunk under a new hash stays 'missing ref' (L1 deferred;
 * the import dep dialog already reports that drift).
 */

export interface MonsterLookups {
  getArtifact: (id: Id) => Promise<Artifact | undefined>;
  getChunk: (id: Id) => Promise<RuleChunk | undefined>;
  /** Content-identity fallback for uuid-mismatched installs (exact hash only). */
  getChunkByContentHash: (contentHash: string) => Promise<RuleChunk | undefined>;
  /** The book a chunk belongs to — drives the origin label (12-BESTIARY-PACKS §8). */
  getRulebook: (bookId: Id) => Promise<Rulebook | undefined>;
}

export interface ResolvedMonster {
  statBlock: StatBlock | null;
  /** Display string: "NPC: Vexra" / "Bestiary p.132" / "inline" / "missing ref" / "" (none). */
  origin: string;
}

/**
 * Content identity stamped at citation birth (chunk-hash-fallback arc): the
 * cited chunk's SHA-256 plus the L1-reserved creature name
 * (`headingPath[0]`, roster entry-name fallback — the same fallback
 * `collectDependencies` uses for its manifest `creatureName`). Shared by
 * every rulebook-citation writer (runEngine finalize, the editor dialog,
 * the spawn picker) so all births agree.
 */
export function contentIdentityFor(
  contentHash: string,
  creatureHeading: string | undefined,
  entryName: string,
): { contentHash: string; creatureName: string } {
  const heading = creatureHeading?.trim();
  return {
    contentHash,
    creatureName: heading === undefined || heading === '' ? entryName : heading,
  };
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
      // Uuid first (the cited instance); on a miss the stamped content hash
      // falls back to whatever local chunk carries the identical bytes (a
      // re-ingest under a new row id). No L1 fuzzy: same creature, new
      // version stays 'missing ref'.
      const byId = await lookups.getChunk(entry.source.chunkId);
      const chunk = byId ??
        (entry.source.contentHash === undefined
          ? undefined
          : await lookups.getChunkByContentHash(entry.source.contentHash));
      if (chunk?.statBlock == null) {
        return { statBlock: null, origin: 'missing ref' };
      }
      const book = await lookups.getRulebook(chunk.bookId);
      const title = book?.title === undefined || book.title === '' ? 'Rulebook' : book.title;
      // Pack chunks have no page numbers (12-BESTIARY-PACKS §4/§8): the
      // label names the creature instead. PDF books keep the page label.
      if (book?.origin === 'pack') {
        const creature = chunk.headingPath[0]?.trim();
        return {
          statBlock: chunk.statBlock,
          origin: `${title}: ${creature === undefined || creature === '' ? entry.name : creature}`,
        };
      }
      return {
        statBlock: chunk.statBlock,
        origin: `${title} p.${chunk.pageStart}`,
      };
    }
    case 'none':
      return { statBlock: null, origin: '' };
  }
}
