import type { ArtifactData, ArtifactKind, Persona, PostCreateExtra, RunExtras } from '@/domain';

/**
 * Creation-dialog extras derived from a persona (ratified owner default 1):
 * a DECLARED `postCreateExtras` field on the persona wins; a persona without
 * one (custom personas, old seeded rows) falls back to this derivation from
 * `mode`/`producesKind`. The dialog and the engine's post-create executor
 * both go through this function — it is the single source of truth for
 * "which buttons does this persona offer".
 *
 * Derivation rules (owner-ratified):
 * - every artifact-creating persona may offer a cover image (`image`);
 * - NPC personas offer the stat-block extra (verification-only: the engine
 *   already runs the statblock step for npc personas — the extra controls
 *   the loud "no stat block" notice, never a fabricated one);
 * - encounter personas always offer mob portraits for the fresh roster;
 * - ONLY the content-only encounter variant (mode 'generate' +
 *   producesKind 'encounter', i.e. Encounter Smith) offers "generate a
 *   battlemap" — encounter-mode personas (Cartographer) already produce the
 *   map in-run, so offering it would duplicate the run's own work;
 * - review and image personas create artifacts too (continuity report
 *   notes) but are never targeted by the creation dialog — derive nothing.
 */
export function derivePostCreateExtras(persona: Persona): PostCreateExtra[] {
  if (persona.mode === 'review' || persona.mode === 'image') return [];
  if (persona.mode === 'encounter') {
    return persona.producesKind === 'encounter' ? ['image', 'mobPortraits'] : [];
  }
  // mode 'generate' from here.
  const extras: PostCreateExtra[] = ['image'];
  if (persona.producesKind === 'npc') extras.push('statBlock');
  if (persona.producesKind === 'encounter') {
    extras.push('mobPortraits');
    extras.push('battlemap');
  }
  return extras;
}

/** The extras a persona offers: declared field wins, else derived. */
export function extrasForPersona(persona: Persona): PostCreateExtra[] {
  if (persona.postCreateExtras !== undefined) return [...persona.postCreateExtras];
  return derivePostCreateExtras(persona);
}

/**
 * The stat-block extra is VERIFICATION-ONLY (ratified): the engine's
 * statblock step already ran for npc personas, so finalize only CHECKS the
 * created artifact's data — a null statBlock yields the loud persisted
 * notice; the engine never fabricates one (AGENTS rule 1). Non-npc kinds
 * and unticked extras never notice.
 */
export function statblockExtraNotice(
  kind: ArtifactKind,
  extras: RunExtras | undefined,
  data: ArtifactData,
): string | null {
  if (kind !== 'npc' || extras?.statBlock !== true) return null;
  return (data as { statBlock?: unknown }).statBlock == null
    ? 'No stat block was generated — add one in the artifact editor.'
    : null;
}
