import type { Persona } from '@/domain';

/**
 * THE ONE decision behind a hand-off request's persona (docs/17 rows 374/376):
 * "is the live persona list loaded yet, and did it yield the persona this
 * hand-off needs?".
 *
 * WHY THIS SEAM EXISTS. The decision used to be written out at each caller as a
 * lookup plus `if (persona === undefined) return; // personas not loaded yet`,
 * which CONFLATES two different worlds:
 *
 * - `personas === undefined` — the live query has not resolved. Waiting is
 *   correct: the effect re-runs when the list arrives and the request must be
 *   KEPT;
 * - the list HAS loaded and yielded nothing — a FINAL answer (the canonical
 *   persona's row was deleted, its slug changed, or the kind has no assistant).
 *   It must SPEAK through the ONE error surface (`src/lib/toast.toastError`) and
 *   CLEAR its request, or a stale unhandled request sits in the store forever.
 *
 * The conflation shipped TWICE — the artifact editor's refill hand-off (docs/17
 * row 374) and its illustration hand-off (row 376) — so the DECISION lives here
 * ONCE and BOTH effects go through it. The result is deliberately a
 * DISCRIMINATED union and never a bare `Persona | undefined`: the bare shape is
 * exactly what each caller re-interpreted, and did so differently.
 *
 * THE SHARED THING IS THE DECISION ONLY. Each caller keeps its OWN request
 * store (`useContentRefillRequest` / `useIllustrationRequest`), its OWN
 * message and its OWN `find` rule — the refill's kind→persona rule stays in
 * `features/campaign/refillPersona.resolveRefillPersona`, and the illustration
 * hand-off's slug lookup stays with its caller. `find` is a plain function
 * (not a persona or an id) so neither rule is duplicated here and a third
 * hand-off can reuse the same decision without moving its own rule.
 */
export type HandoffPersona =
  | { status: 'loading' }
  | { status: 'unclaimed' }
  | { status: 'claimed'; persona: Persona };

export function resolveHandoffPersona(
  personas: readonly Persona[] | undefined,
  find: (personas: readonly Persona[]) => Persona | undefined,
): HandoffPersona {
  if (personas === undefined) return { status: 'loading' };
  const persona = find(personas);
  return persona === undefined ? { status: 'unclaimed' } : { status: 'claimed', persona };
}
