import { z } from 'zod';

import { sceneSubstitutionSchema, type SceneSubstitution } from '@/llm/schemas';

/**
 * THE ASSERTION RULE on the encounter side (docs/11 §The scene is the truth,
 * docs/17 row 89).
 *
 * The owner's report, verbatim: *"The encounter prose generator actually did a
 * good job here, and the mob generator was not too bad either. The problem is
 * the disconnect. The prose actually holds truth, but it might not always be
 * sufficient. If the prose is vague then the mob generator can improvise, if
 * its specific like here, it must follow that lead."* A scene that stated two
 * risen lumberjacks, axes in hand, on a boggy footbridge over a knee-deep icy
 * stream produced a sea hag, two ghoul soldiers and two skeletal guards —
 * because the scene reached the encounter prompt as *background* ("Where it is
 * mentioned:") and nothing in the contract obliged the roster to agree with it.
 *
 * This module is the pipeline's half: the section that makes the scene text
 * BINDING, and the tolerant read of the substitution declarations the model
 * files when it cannot honour an assertion. Both are CODE, not persona text —
 * personas are user-editable stored rows, so a persona edit would never reach
 * an app the owner already has (docs/17 row 89).
 *
 * DIRECTIONAL, not a threshold. Nothing here asks the model to judge whether
 * the prose is "specific enough": whatever the text STATES is binding, and
 * where it states nothing nothing is constrained. That second half is
 * load-bearing and pinned by test — a rule that read as "always obey the text"
 * would make the pipeline timid on vague scenes, which the owner explicitly
 * does not want ("if the prose is vague then the mob generator can improvise").
 */

/**
 * The scene-authority section, rendered into the encounter pipelines' prompts
 * ONLY (the Smith draft — `runDraft` for `kind === 'encounter'` — and the
 * Cartographer brief). Every other kind's prompt is byte-identical without it,
 * pinned by `tests/llm/sceneAuthority.test.ts`.
 */
export const SCENE_AUTHORITY_SECTION = [
  'THE SCENE IS THE TRUTH FOR THIS FIGHT.',
  'The brief above is the scene this encounter must stage. Whatever it states about the opposition — what the creatures are, roughly how many, what they carry, what they are doing — and about the place — its terrain and the conditions the party will fight in — is FIXED: the roster AND the map must match it.',
  'A stated creature you cannot honour as written is never silently swapped: either build it as a complete inline "statBlock" for exactly the creature the scene describes, or declare the deviation in "substitutions" as { "asserted": what the scene states, "used": what you fielded instead, "reason": why } — an undeclared swap is the failure this rule exists to prevent, and a declared one is reported to the GM.',
  'Where the scene states nothing you design freely: silence is not a constraint, and the roster, the map, the tactics, the treasure and the difficulty are yours. A vague scene is never a reason to invent an assertion the text does not make.',
].join('\n');

/**
 * The substitutions a stored draft declared (docs/11 assertion rule).
 *
 * ABSENT and NULL read as "none declared": a brief drafted before this field
 * existed parses and renders nothing (pinned by test). A value that is PRESENT
 * but not a substitution list is a LOUD error — it is the model's own account
 * of what it could not honour, and dropping it silently would be exactly the
 * silent substitution this rule forbids (AGENTS rule 1). Hand-edited run rows
 * are the only way to reach that branch; the model's own replies are parsed
 * against `sceneSubstitutionSchema` at the contract boundary.
 */
export function sceneSubstitutionsOf(value: unknown): SceneSubstitution[] {
  if (value === null || value === undefined) return [];
  const parsed = z.array(sceneSubstitutionSchema).safeParse(value);
  if (!parsed.success) {
    throw new Error(
      'the encounter draft\'s "substitutions" field is unreadable — it must be a list of ' +
        '{ asserted, used, reason } entries (an empty list when every stated creature and place was honoured)',
    );
  }
  return parsed.data;
}
