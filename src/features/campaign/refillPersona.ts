import type { ArtifactKind, Persona } from '@/domain';

/**
 * WHICH PERSONA REFILLS WHICH KIND — the ONE rule (docs/17 rows 287/288, and
 * row 373 for the player character). It lives here, apart from the persona
 * panel that consumes it, because it is a pure function of the kind and the
 * persona list: the panel's rendered behaviour is pinned through it, and the
 * rule cannot drift into a second spelling at a surface.
 *
 * Canonical smith persona per refillable kind (the STUB_PERSONA_SLUGS
 * convention, 08 §M4-C, extended with the Arc Weaver for plotarcs): the slug
 * match wins over a producesKind scan so a user-created persona with the same
 * kind never outranks the built-in smith.
 */
export const REFILL_PERSONA_SLUGS: Readonly<Partial<Record<ArtifactKind, string>>> = {
  // THE PLAYER CHARACTER'S ONE ASSISTANT (docs/17 row 373): the player card's
  // "Generate with AI" resolves to this persona, which writes a full character
  // from the description already on the row. It is the ONE PC lane — no second
  // request channel, button or write path.
  pc: 'pc-smith',
  npc: 'npc-smith',
  location: 'worldbuilder',
  event: 'event-weaver',
  faction: 'faction-designer',
  note: 'plot-architect',
  plotarc: 'arc-weaver',
};

/** The generate-mode persona that refills artifacts of `kind` (undefined =
 * none exists — the panel then reports it through `toastError`, NAMING the
 * kind, and clears the request; docs/17 row 374. It is never a silent drop,
 * and it is never confused with "the persona list has not loaded yet"). */
export function resolveRefillPersona(
  personas: readonly Persona[],
  kind: ArtifactKind,
): Persona | undefined {
  const slug = REFILL_PERSONA_SLUGS[kind];
  if (slug !== undefined) {
    const bySlug = personas.find((persona) => persona.slug === slug && persona.mode === 'generate');
    if (bySlug !== undefined) return bySlug;
  }
  return personas.find((persona) => persona.mode === 'generate' && persona.producesKind === kind);
}
