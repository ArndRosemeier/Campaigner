import type { AnyArtifact } from '@/domain';
import { isMobArtifact } from '@/db/mobArtifacts';
import { creatureLabel } from '@/features/campaign/creature-row-guard';
import type { WikiLinkResolution } from '@/lib/wikilinks';

/**
 * THE verdict on a wiki-link resolution: does this name have an authored,
 * DETAILED entity of its own? (Owner-reported bug this closes, verbatim: "In
 * the module there is a named zombie, and somehow this got an entity with JUST
 * the zombie picture, the global one, and nothing else. And this still counts
 * as a defined entity, so no 'generate x npcs' catches it.")
 *
 * A bestiary creature row is a REAL `npc` artifact — name + the additive
 * `data.monsterChunkId` marker (`db/mobArtifacts.isMobArtifact`, docs/11 D5):
 * ONE campaign-scoped row per cited rulebook chunk, shared by every encounter
 * that cites the creature, its portrait cached globally, battle seeding
 * resolving the creature's stats THROUGH it. Its name is a wiki-link identity,
 * never an authoring slot (`features/campaign/creature-row-guard`). Because the
 * module-creation pool excludes only `pc` (`domain/artifact.ts`), such a row
 * sits IN the pool, so a resolution that lands on one used to answer the module
 * entity view's question with "detailed" — and the panel then showed the global
 * portrait, offered no batch, and the reader showed no text. That is exactly
 * the "no 'generate x npcs' catches it" the owner reported.
 *
 * THE QUESTION, precisely: "does this name have an authored, detailed entity of
 * its own?" — NOT "does anything resolve?". The answer is read from the
 * resolution's own candidates (the winning scope tier, the module-context
 * answer: the module's rows beat the rest of the campaign, globals last), so a
 * name whose only resolution is a creature row is NOT detailed and the entity
 * panel offers it. The classification itself is `isMobArtifact` — this is the
 * ONE place that turns it into an ENTITY verdict, never a second reading of
 * "creature row" at a call site.
 *
 * WHAT THIS IS NOT: the wiki-link tier rule and every display surface are
 * untouched (`lib/wikilinks.resolveWikiLink` is called exactly as before, the
 * same pool, the same precedence). The reader's chips, the campaign tree, the
 * encounter roster and battle seeding still resolve `[[Zombie]]` to the real
 * creature row — only the "is this entity detailed/defined for GENERATION"
 * verdict changes. Two seams read this verdict and nothing else decides it:
 * - `features/modules/use-module-entities` (the entity panel's rows, buckets,
 *   "N detailed · M mentioned" line and the batch work queue), and
 * - `features/modules/post-generation`'s `batchTargets` (the automation sweep's
 *   target set, and through it the "Generate everything" / "Resume automatic
 *   module creation" deviation — the sweep and its confirmation can never
 *   disagree).
 *
 * `imageTargets` deliberately keeps its own (resolution-based) semantics: an
 * image job attaches to whatever row the name resolves to, and the panel's
 * images mode already refuses a not-detailed row ("Detail this entity first").
 */

/** The verdict for one wiki-link name. */
export interface DetailedEntityVerdict {
  /**
   * The authored entity this name has of its own, when it has one — the
   * artifact generation may open, adopt, illustrate, or the row the reader was
   * already showing. `undefined` ⇔ the name is NOT detailed: it resolves to
   * nothing, or only to a bestiary creature row.
   */
  entity: AnyArtifact | undefined;
  /**
   * The bestiary creature row among the resolution's candidates, when one is
   * there — the shared row the name does resolve to, which carries no authored
   * detail and is (by design) not where a generation writes. The panel names it
   * in the row's marker so a bare-looking row is never explained by silence.
   */
  creatureRow: AnyArtifact | undefined;
}

/**
 * The ONE verdict, over the resolution the caller already has. Total and pure:
 * an unresolved name yields `{entity: undefined, creatureRow: undefined}`.
 *
 * A candidate that is an authored entity wins even when a creature row is the
 * resolution's own winner (a same-tier pair is `ambiguous`, and answering "not
 * detailed" there would generate a SECOND row beside an authored one — the
 * duplication the batch's name-normalization gate exists to prevent).
 */
export function detailedEntityVerdict(resolution: WikiLinkResolution): DetailedEntityVerdict {
  return {
    entity: resolution.candidates.find((candidate) => !isMobArtifact(candidate)),
    creatureRow: resolution.candidates.find(isMobArtifact),
  };
}

/** The one-question form, for callers that only need the answer
 * (`post-generation.batchTargets`). */
export function hasDetailedEntity(resolution: WikiLinkResolution): boolean {
  return detailedEntityVerdict(resolution).entity !== undefined;
}

/**
 * The honest sentence the entity panel's row marker carries for a name that
 * resolves ONLY to a bestiary creature row: it names the shared row (the house
 * «Name» quoting convention, `creature-row-guard.creatureLabel`) and states the
 * remedy, so "not detailed yet" next to a campaign row that DOES carry that
 * name is never a puzzle.
 */
export function creatureRowOnlyNotice(name: string): string {
  return `${creatureLabel(name)} is the campaign's shared bestiary creature row — a rulebook stat block and a portrait, cited by every encounter that uses it, with no authored detail of its own. This name is therefore not detailed yet: generating it here creates this module's own NPC of that name.`;
}
