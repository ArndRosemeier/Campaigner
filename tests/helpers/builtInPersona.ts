import type { Persona } from '@/domain';
import { BUILT_IN_PERSONAS } from '@/llm/personas/builtins';

/**
 * The ONE lookup of a built-in persona by its code-facing slug.
 *
 * WHY IT IS A HELPER AND NOT A COPY (AGENTS §Centralization obligation 4):
 * `tests/llm/persona-extras.test.ts` carried its own private copy, and the
 * description-clause pins (docs/17 row 365) needed the same read — so the two
 * now share this function instead of a second spelling being born. It fails
 * LOUDLY on an unknown slug: a pin that looks a persona up must red when the
 * persona is gone, never read `undefined` and compare nothing.
 */
export function personaBySlug(slug: string): Persona {
  const persona = BUILT_IN_PERSONAS.find((candidate) => candidate.slug === slug);
  if (persona === undefined) throw new Error(`missing built-in persona "${slug}"`);
  return persona;
}
