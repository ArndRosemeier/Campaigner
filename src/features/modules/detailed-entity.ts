import type { AnyArtifact } from '@/domain';
import type { WikiLinkResolution } from '@/lib/wikilinks';

/**
 * THE verdict on a wiki-link resolution: does this name have an authored,
 * DETAILED entity of its own? (Owner-reported bug this closes, verbatim: "In
 * the module there is a named zombie, and somehow this got an entity with JUST
 * the zombie picture, the global one, and nothing else. And this still counts
 * as a defined entity, so no 'generate x npcs' catches it.")
 *
 * Under the ratified core-mob model (docs/11 D5/D10) a bestiary creature is NOT
 * an artifact at all: it is a LIBRARY row cited by the text, and a wiki-link
 * that names one now resolves to a DERIVED creature node
 * (`lib/wikilinks.WikiLinkCreature`) instead of to a shared campaign artifact.
 * That kills the old bug at its root — there is no row to land on, so a
 * resolution that answers "creature" cannot also answer "detailed" — and it is
 * why this file no longer needs a "is this row really a creature?" predicate:
 * the resolution itself distinguishes the two.
 *
 * THE QUESTION, precisely: "does this name have an authored, detailed entity of
 * its own?" — NOT "does anything resolve?". The answer is read from the
 * resolution's own candidates (the winning scope tier, the module-context
 * answer: the module's rows beat the rest of the campaign, globals last), so a
 * name whose only resolution is a creature is NOT detailed and the entity panel
 * offers it (that is the "generate x npcs" catch the owner wanted).
 *
 * WHAT THIS IS NOT: the wiki-link tier rule and every display surface are
 * untouched (`lib/wikilinks.resolveWikiLink` is called exactly as before, the
 * same pool, the same precedence). The reader's chips, the campaign tree, the
 * encounter roster and battle seeding still show the name as RESOLVED (docs/11
 * D10) — only the "is this entity detailed/defined for GENERATION" verdict is
 * computed here. Two seams read this verdict and nothing else decides it:
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
   * nothing, or only to a library creature.
   */
  entity: AnyArtifact | undefined;
  /**
   * The library creature this name cites, when it cites one instead of naming
   * an authored entity. The panel names it in the row's marker so a
   * bare-looking row is never explained by silence.
   */
  creatureName: string | undefined;
}

/**
 * The ONE verdict, over the resolution the caller already has. Total and pure:
 * an unresolved name yields `{entity: undefined, creatureName: undefined}`.
 *
 * A candidate that is an authored entity wins even when the resolution also
 * carries a creature (an artifact always outranks a library creature inside
 * `resolveWikiLink`, so the two are never both set — this is stated for the
 * reader's sake, not enforced twice).
 */
export function detailedEntityVerdict(resolution: WikiLinkResolution): DetailedEntityVerdict {
  return {
    entity: resolution.candidates[0],
    creatureName: resolution.artifact === undefined ? resolution.creature?.name : undefined,
  };
}

/** The one-question form, for callers that only need the answer
 * (`post-generation.batchTargets`). */
export function hasDetailedEntity(resolution: WikiLinkResolution): boolean {
  return detailedEntityVerdict(resolution).entity !== undefined;
}

/**
 * The honest sentence the entity panel's row marker carries for a name that
 * resolves ONLY to a library creature: it names the creature and states the
 * remedy, so "not detailed yet" next to a mention of a creature the bestiary
 * DOES carry is never a puzzle.
 */
export function creatureOnlyNotice(name: string): string {
  return `«${name}» is a library creature — a bestiary stat block cited by this text, with no authored detail of its own. This name is therefore not detailed yet: generating it here creates this module's own NPC of that name.`;
}
