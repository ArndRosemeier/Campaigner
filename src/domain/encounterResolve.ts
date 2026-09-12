import type { AnyArtifact, Id, MonsterEntry, Rulebook, RuleChunk, StatBlock } from '@/domain';

/**
 * Monster source resolution (07-MILESTONE-3 M3-B; re-based on the library tier
 * by the owner-ratified core-mob arc, docs/11 D5 amendment). Turns an
 * encounter's monster entry into a displayable StatBlock + origin label. Pure
 * logic — lookups are injected so the domain never touches Dexie; `src/db/
 * monsterResolve.ts` wires the repo-backed variant used by the UI.
 *
 * A creature citation names a LIBRARY row, never a campaign artifact, so the
 * only way it can fail is that the library genuinely lacks the row (docs/11
 * D9). Deleting every campaign artifact and every module cannot produce a
 * `missing ref` here, because no citation names a campaign row — that is the
 * property the arc exists for, and it is pinned by test.
 *
 * Content-identity fallback (chunk-hash-fallback arc): a citation whose uuid
 * misses but carries `contentHash` resolves through `getChunkByContentHash` —
 * a re-ingest under a new row id still satisfies a byte-identical citation.
 * Exact content-hash ONLY: a same-creature chunk under a new hash stays
 * 'missing ref' (the import dep dialog already reports that drift). The
 * fallback is tried BEFORE the citation is declared missing, everywhere,
 * including the derived-stats path below.
 */

export interface MonsterLookups {
  /** Any scope: an encounter may cite a library-published NPC too, so the
   * lookup is the artifact repo's widest read. */
  getArtifact: (id: Id) => Promise<AnyArtifact | undefined>;
  getChunk: (id: Id) => Promise<RuleChunk | undefined>;
  /** Content-identity fallback for uuid-mismatched installs (exact hash only). */
  getChunkByContentHash: (contentHash: string) => Promise<RuleChunk | undefined>;
  /** The book a chunk belongs to — drives the origin label (12-BESTIARY-PACKS §8). */
  getRulebook: (bookId: Id) => Promise<Rulebook | undefined>;
}

export interface ResolvedMonster {
  statBlock: StatBlock | null;
  /**
   * Display string: "NPC: Vexra" / "NPC: Aunt Agatha (zombie stats from
   * Monster Manual p.316)" / "Bestiary p.132" / "Bestiary: Zombie" / "inline" /
   * "missing ref" / "missing ref (Zombie)" / "" (none).
   */
  origin: string;
}

/**
 * A LIBRARY CREATURE CITATION as written on a roster entry or on an authored
 * NPC's `creatureRef` (docs/11 D3): the chunk uuid, the content hash stamped
 * at citation birth, and the creature's own name where one is known. Both
 * citation sites spell it the same way, which is why the resolver below is ONE
 * function — a second resolution order would be a second answer to "which
 * numbers is this creature?".
 */
export interface CreatureCitation {
  chunkId?: string | undefined;
  contentHash?: string | undefined;
  creatureName?: string | undefined;
}

/**
 * Content identity stamped at citation birth (chunk-hash-fallback arc): the
 * cited chunk's SHA-256 plus the creature name
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

/**
 * Resolves a library creature CITATION to the chunk row that answers it — uuid
 * first (the cited instance); on a miss, the stamped content hash falls back to
 * whatever local chunk carries the identical bytes (a re-ingest under a new row
 * id). `undefined` means the library genuinely lacks the creature: the ONE
 * surviving failure mode (docs/11 D9).
 *
 * THE one resolution order. `resolveMonsterEntry` calls it for a `rulebook`
 * citation AND for an authored NPC's derived stat block, so an Aunt Agatha and
 * a cited zombie can never resolve differently.
 */
export async function resolveCreatureChunk(
  citation: CreatureCitation,
  lookups: Pick<MonsterLookups, 'getChunk' | 'getChunkByContentHash'>,
): Promise<RuleChunk | undefined> {
  const byId = citation.chunkId === undefined ? undefined : await lookups.getChunk(citation.chunkId);
  if (byId !== undefined) return byId;
  if (citation.contentHash === undefined) return undefined;
  return lookups.getChunkByContentHash(citation.contentHash);
}

/** The creature's display name for a citation: the stamped creature name, else
 * the caller's fallback (the roster entry / NPC name). */
export function creatureCitationName(citation: CreatureCitation, fallback: string): string {
  const named = citation.creatureName?.trim();
  return named === undefined || named === '' ? fallback : named;
}

/**
 * The origin label of a resolved LIBRARY CREATURE — what the number's source
 * IS, with no authored-NPC prefix. Shared by a `rulebook` citation (which
 * renders it verbatim) and by the derived path (which wraps it, see
 * `derivedStatOrigin`).
 */
export async function creatureOriginLabel(
  chunk: RuleChunk,
  citationName: string,
  lookups: Pick<MonsterLookups, 'getRulebook'>,
): Promise<string> {
  const book = await lookups.getRulebook(chunk.bookId);
  const title = book?.title === undefined || book.title === '' ? 'Rulebook' : book.title;
  // Pack chunks have no page numbers (12-BESTIARY-PACKS §4/§8): the label
  // names the creature instead. PDF books keep the page label.
  if (book?.origin === 'pack') {
    const creature = chunk.headingPath[0]?.trim();
    return `${title}: ${creature === undefined || creature === '' ? citationName : creature}`;
  }
  return `${title} p.${chunk.pageStart}`;
}

/**
 * The origin label of an AUTHORED NPC whose stat block is DERIVED from a
 * library creature (docs/11 D3). It LEADS with the NPC's own name — the row
 * the GM opened — and DISCLOSES the derivation, so nobody can mistake these
 * numbers for the NPC's own authored block. Pinned verbatim by test.
 */
export function derivedStatOrigin(npcName: string, creatureOrigin: string): string {
  return `NPC: ${npcName} (stats from ${creatureOrigin})`;
}

/** The `missing ref` label of a citation the library cannot satisfy. The cited
 * creature's own name rides along when the citation stamped one — a bare
 * "missing ref" tells a GM nothing about WHAT is missing. */
export function missingCreatureOrigin(citationName: string): string {
  const named = citationName.trim();
  return named === '' ? 'missing ref' : `missing ref (${named})`;
}

/**
 * Whether an origin is the missing-ref reason. THE one test every surface uses:
 * the reason is NAMED (`missing ref (Zombie)`), so a `=== 'missing ref'`
 * comparison silently never matches — a bug this predicate exists to make
 * unrepresentable (docs/18 §4).
 */
export function isMissingRefOrigin(origin: string): boolean {
  return origin.startsWith('missing ref');
}

/** One library creature citation resolved end to end: the stats plus the
 * disclosed origin. `undefined` chunk ⇒ `missing ref` (the ONE failure mode). */
export interface ResolvedCreature {
  statBlock: StatBlock | null;
  origin: string;
}

/**
 * The ONE library-creature read: citation → chunk → stats + origin label.
 * Every creature-stat reader in the app goes through this or through
 * `resolveMonsterEntry` below (which delegates here for its citation case), so
 * "which numbers, from where" has exactly one answer.
 */
export async function resolveCreatureCitation(
  citation: CreatureCitation,
  citationName: string,
  lookups: MonsterLookups,
): Promise<ResolvedCreature> {
  const chunk = await resolveCreatureChunk(citation, lookups);
  if (chunk?.statBlock == null) {
    return { statBlock: null, origin: missingCreatureOrigin(citationName) };
  }
  return {
    statBlock: chunk.statBlock,
    origin: await creatureOriginLabel(chunk, citationName, lookups),
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
      // An authored NPC whose row is gone is a real dangling reference — a
      // campaign row the GM can see and restore. No CREATURE citation can
      // reach this branch (docs/11 D9): it is the artifact row that is absent,
      // not a library one. The spelling is still the ONE shared reason, named
      // by the roster entry, so a reader never has to learn a second phrase to
      // find out WHAT is missing.
      if (artifact === undefined) {
        return { statBlock: null, origin: missingCreatureOrigin(entry.name) };
      }
      if (artifact.kind !== 'npc') return { statBlock: null, origin: `NPC: ${artifact.name}` };
      const creatureRef = artifact.data.creatureRef;
      if (creatureRef !== undefined) {
        // D3, the Aunt Agatha path: her prose, the library creature's stats —
        // resolved exactly like a `rulebook` citation (uuid, then content
        // hash) so the two can never answer differently.
        const creature = await resolveCreatureCitation(creatureRef, artifact.name, lookups);
        if (creature.statBlock === null) return creature;
        return {
          statBlock: creature.statBlock,
          origin: derivedStatOrigin(artifact.name, creature.origin),
        };
      }
      return { statBlock: artifact.data.statBlock, origin: `NPC: ${artifact.name}` };
    }
    case 'rulebook':
      return resolveCreatureCitation(
        entry.source,
        creatureCitationName(entry.source, entry.name),
        lookups,
      );
    case 'none':
      return { statBlock: null, origin: '' };
  }
}
