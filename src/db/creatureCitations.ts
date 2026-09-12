import type { AnyArtifact, CreatureRef, Id } from '@/domain';
import { listArtifactsByModule } from '@/db/artifactRepo';
import { resolveCreatureCitation } from '@/db/creatureRepo';

/**
 * The module-delete dialog's blast-radius census (docs/11 D5 amendment): the
 * LIBRARY creatures the encounters owned by a module CITE.
 *
 * This is a REFERENCE census, not an ownership one, and under the ratified
 * model it can no longer be an artifact census: a cited creature is a
 * read-only bestiary row (`docs/11` D8) with no campaign row behind it, so
 * `deleteModule` neither deletes nor releases anything for it. Naming the count
 * before the click is what makes the cascade's real reach visible — "deleting
 * this module removes its encounters; the creatures they cite are the
 * bestiary's and stay".
 *
 * A citation that cannot be resolved is reported BY NAME, never dropped
 * (AGENTS rule 1): the dialog must not under-count a module's reach because a
 * pack was uninstalled.
 */
export interface ModuleCreatureCitations {
  /** The distinct creatures cited, by the name the citing roster used, A→Z. */
  creatures: { name: string; resolved: boolean }[];
  /** The module's encounters whose rosters carry at least one citation. */
  citingEncounters: string[];
}

/** One library citation a roster carries, with the name the roster reads it
 * by. `citation` is absent when there is no LIBRARY pointer to resolve at all
 * (a dangling `npc-ref`): that case is unresolved by construction and is
 * reported as such, never fed to the resolver as an empty citation (which is a
 * loud write-side error, docs/11 D9). */
interface CitedCreature {
  name: string;
  citation?: CreatureRef;
  /** False when the citation points at a campaign row rather than a library
   * creature this census can speak about. */
  libraryRef: boolean;
}

/** The distinct library creatures one encounter roster cites, deduped
 * case-insensitively by the name the roster uses. */
function citedCreatures(
  encounter: AnyArtifact,
  byId: Map<Id, AnyArtifact>,
): CitedCreature[] {
  if (encounter.kind !== 'encounter') return [];
  const found: CitedCreature[] = [];
  const seen = new Set<string>();
  for (const entry of encounter.data.monsters) {
    const source = entry.source;
    let cited: CitedCreature | null = null;
    if (source.type === 'rulebook') {
      // The roster entry's OWN citation — resolved by the reader's seam, chunk
      // uuid first and content hash second.
      cited = {
        name: source.creatureName ?? entry.name,
        citation: {
          chunkId: source.chunkId,
          ...(source.contentHash === undefined ? {} : { contentHash: source.contentHash }),
          ...(source.creatureName === undefined ? {} : { creatureName: source.creatureName }),
        },
        libraryRef: true,
      };
    } else if (source.type === 'npc-ref') {
      const target = byId.get(source.artifactId);
      if (target === undefined) {
        // A citation whose target is gone is still a citation to census, and it
        // is unresolved for a reason this census cannot resolve away: the ROW
        // is missing, not the library entry (docs/11 D9).
        cited = { name: entry.name, libraryRef: true };
      } else if (target.kind === 'npc' && target.data.creatureRef !== undefined) {
        // A CAST npc (docs/11 D3): its own prose, the library's stats — so the
        // creature it cites IS a library creature, and this census speaks of it
        // under the LIBRARY's name, which is what the dialog must name.
        cited = { name: target.name, citation: target.data.creatureRef, libraryRef: true };
      } else {
        // A hand-authored NPC cites no library creature at all: it is this
        // module's OWN row (already the ownership half of the census), so it
        // must not appear as a library reference.
        cited = { name: target.name, libraryRef: false };
      }
    }
    if (cited?.libraryRef !== true) continue;
    const key = cited.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(cited);
  }
  return found;
}

/** Counts the library creatures a module's encounters cite. */
export async function countCreaturesCitedByModule(
  owned: readonly AnyArtifact[],
): Promise<ModuleCreatureCitations> {
  const byId = new Map<Id, AnyArtifact>();
  for (const artifact of owned) byId.set(artifact.id, artifact);
  const citations: { name: string; resolved: boolean }[] = [];
  const citingEncounters: string[] = [];
  const seen = new Set<string>();
  for (const artifact of owned) {
    if (artifact.kind !== 'encounter') continue;
    const cited = citedCreatures(artifact, byId);
    if (cited.length === 0) continue;
    citingEncounters.push(artifact.name);
    for (const creature of cited) {
      const key = creature.name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (creature.citation === undefined) {
        citations.push({ name: creature.name, resolved: false });
        continue;
      }
      // Resolved through the SAME library seam the reader uses, so the census
      // reports unresolved citations for exactly the reason the chip would.
      const listing = await resolveCreatureCitation(creature.citation, creature.name);
      citations.push({
        name: listing.chunk === null ? creature.name : listing.name,
        resolved: listing.chunk !== null,
      });
    }
  }
  citations.sort((left, right) => left.name.localeCompare(right.name));
  return { creatures: citations, citingEncounters };
}

/** Convenience for a caller that does not already hold the module's rows. */
export async function countCreaturesCitedByModuleId(
  moduleId: Id,
): Promise<ModuleCreatureCitations> {
  return countCreaturesCitedByModule(await listArtifactsByModule(moduleId));
}
