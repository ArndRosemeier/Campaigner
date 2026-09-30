import { comparableName } from '@/domain/artifactAlias';
import type { AnyArtifact, Id } from '@/domain';
import { listArtifactsByModule } from '@/db/artifactRepo';

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
 * WHAT STILL COUNTS AS A LIBRARY CITATION (docs/17 row 278). A copied mob — a
 * roster entry with an `inline` block and an `originToken`, or an `npc-ref` to a
 * cast/copied NPC — is the campaign's OWN row (the owner's rule is that core
 * items are only ever copied), so it is not a library reference and must not be
 * reported as one. The one library reference that survives the clean cut is a
 * DANGLING `npc-ref`: its target row is gone, so the census cannot resolve it
 * and names it as unresolved — never drops it (AGENTS rule 1).
 */
export interface ModuleCreatureCitations {
  /** The distinct creatures cited, by the name the citing roster used, A→Z. */
  creatures: { name: string; resolved: boolean }[];
  /** The module's encounters whose rosters carry at least one citation. */
  citingEncounters: string[];
}

/**
 * KEY SPACE `LIBRARY_CREATURE_NAME_KEY` (docs/17 row 167): ONE library
 * creature prints ONCE — the identity of a creature this library HOLDS, keyed
 * by its name. The distinct dangling references one encounter roster carries,
 * deduped case-insensitively by the name the roster uses.
 */
function citedCreatures(encounter: AnyArtifact, byId: Map<Id, AnyArtifact>): string[] {
  if (encounter.kind !== 'encounter') return [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const entry of encounter.data.monsters) {
    const source = entry.source;
    if (source.type !== 'npc-ref') continue;
    // A resolvable target is an authored or CAST npc — this campaign's own row,
    // deleted with the module, not a library reference.
    if (byId.has(source.artifactId)) continue;
    const key = comparableName(entry.name);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(entry.name);
  }
  return found;
}

/** Counts the library creatures a module's encounters cite. */
export function countCreaturesCitedByModule(
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
    for (const name of cited) {
      const key = comparableName(name);
      if (seen.has(key)) continue;
      seen.add(key);
      // The target row is gone by construction (that is the only arm this census
      // speaks about), so the citation is unresolved for a reason the census
      // cannot resolve away: the ROW is missing, not the library entry.
      citations.push({ name, resolved: false });
    }
  }
  citations.sort((left, right) => left.name.localeCompare(right.name));
  return Promise.resolve({ creatures: citations, citingEncounters });
}

/** Convenience for a caller that does not already hold the module's rows. */
export async function countCreaturesCitedByModuleId(
  moduleId: Id,
): Promise<ModuleCreatureCitations> {
  return countCreaturesCitedByModule(await listArtifactsByModule(moduleId));
}
