import { z } from 'zod';

import { comparableName } from '@/domain/artifactAlias';
import { assertedCastEntrySchema, type AssertedCastEntry } from '@/domain/artifact';
import { sceneSubstitutionSchema, type SceneSubstitution } from '@/llm/schemas';

/**
 * THE ASSERTION RULE on the encounter side (docs/11 §The scene is the truth,
 * docs/17 rows 89 and 309).
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
 * BINDING, and the tolerant reads of what the model declared about it. All of
 * it is CODE, not persona text — personas are user-editable stored rows, so a
 * persona edit would never reach an app the owner already has (docs/17 row 89).
 *
 * DIRECTIONAL, not a threshold. Nothing here asks the model to judge whether
 * the prose is "specific enough": whatever the text STATES is binding, and
 * where it states nothing nothing is constrained. That second half is
 * load-bearing and pinned by test — a rule that read as "always obey the text"
 * would make the pipeline timid on vague scenes, which the owner explicitly
 * does not want ("if the prose is vague then the mob generator can improvise").
 *
 * ROW 309 (owner-decided) makes the rule ENFORCEABLE, and its four pieces live
 * here too:
 *
 * 1. TRANSCRIBE — the step that READS the scene writes the asserted cast as
 *    structured data (`assertedCastEntrySchema` on the Smith draft contract),
 *    because the app may never read prose with a pattern (AGENTS rule 5).
 * 2. SURFACE — the transcribed list is persisted on the encounter row and named
 *    in the EXISTING advisory block (`data.budgetAdvisory` → the step notice),
 *    so a wrong read is correctable in one step (AGENTS rule 5's pattern).
 * 3. ENFORCE — every asserted figure must be in the final roster: one repair
 *    turn insists, then the run FAILS LOUDLY. Never a shipped fight with a
 *    note, never a silent substitution.
 * 4. EXEMPT — an asserted figure is exempt from the budget arithmetic
 *    (`roomBudget.checkRoomBudget`'s `assertedNames`): the cap governs the
 *    FILLER only, so an occasional overweight fight is accepted rather than
 *    "fixed" by dropping the figure the scene is about.
 *
 * There is NO hard cap on asserted figures: the model that reads the story
 * decides how many the story needs (the owner's own words — "what if there are
 * 3 mobs mentioned in the story that just HAVE to be there"). An occasional
 * overload is not too bad as long as it is not concentrated into one mob.
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
  'A figure the scene asserts is never substituted and never silently swapped: the only outcomes for it are FIELDED under the name the scene states it by — with a complete inline "statBlock" for exactly that creature when the library holds no such one — or a refused reply. A deviation declared in "substitutions" as { "asserted": what the scene states, "used": what you fielded instead, "reason": why } may name only something the scene does NOT assert (a place, a condition, an impression); a substitution that names an asserted figure is refused outright, and a declared substitution is reported to the GM.',
  'Where the scene states nothing you design freely: silence is not a constraint, and the roster, the map, the tactics, the treasure and the difficulty are yours. A vague scene is never a reason to invent an assertion the text does not make.',
].join('\n');

/**
 * The TRANSCRIPTION clause (docs/17 row 309), rendered ONLY where the reply
 * contract carries the field (`runDraft` for `kind === 'encounter'` — the step
 * whose brief is the scene). It is separate from `SCENE_AUTHORITY_SECTION`
 * deliberately: the Cartographer's brief renders that section too but carries
 * no scene text and no `assertedCast` field, so instructing it to transcribe
 * would be an instruction it cannot obey.
 */
export const ASSERTED_CAST_TRANSCRIPTION_SECTION = [
  'TRANSCRIBE the cast this scene ASSERTS into the reply\'s "assertedCast" list — the app checks that list against your roster and shows it to the GM, so it is how a wrong reading of the scene becomes visible and correctable in one step:',
  'one entry per figure the text names — { "name": the figure\'s name as the text writes it AND as your roster entry will carry it (the roster entry must carry exactly that name), "count": how many the text states, or 1 when it states none }.',
  'Every entry in that list is REQUIRED in this fight, with no cap on how many the story needs: field it, as a complete inline "statBlock" when the library holds no such creature. Reply with an EMPTY list when the scene names no figure at all — an invented assertion is a lie about the scene, and a vague scene is never a reason to invent one.',
].join('\n');

/**
 * The BINDING asserted-cast section for a roster author whose own brief carries
 * no scene text (the Cartographer map/stocking run, and any later pass on an
 * encounter that already transcribed one). It renders the list the encounter
 * ROW holds — the scene-reading step's own transcription, persisted — so the
 * assertion survives into the pass that actually stocks the rooms instead of
 * being re-derived (or silently dropped) there. Null when there is nothing
 * asserted, so those prompts stay byte-identical.
 */
export function assertedCastSectionFor(cast: readonly AssertedCastEntry[]): string | null {
  if (cast.length === 0) return null;
  return [
    'ASSERTED CAST — this encounter\'s scene asserts these figures, and every one of them is REQUIRED in your roster (this list is checked against it):',
    ...cast.map(
      (entry) => `- "${entry.name}"${entry.count > 1 ? ` ×${String(entry.count)}` : ''}`,
    ),
    'Field every one under exactly that name; when the library holds no such creature, build it as a complete inline "statBlock" for exactly the creature described. You may NOT substitute an asserted figure — the rest of the roster is yours to design.',
  ].join('\n');
}

/**
 * The asserted cast a stored DRAFT read (docs/17 row 309). ABSENT and NULL
 * read as "the scene names no figure": a draft written before this field
 * existed parses and constrains nothing (pinned by test). A value that is
 * PRESENT but not a list of `{ name, count }` entries is a LOUD error — that
 * list is the model's own reading of the scene and the input to a hard gate, so
 * dropping it silently would be exactly the silent substitution this rule
 * forbids (AGENTS rule 1). Hand-edited run rows are the only way to reach that
 * branch; replies are parsed against the contract at the model boundary.
 */
export function assertedCastOf(value: unknown): AssertedCastEntry[] {
  if (value === null || value === undefined) return [];
  const parsed = z.array(assertedCastEntrySchema).safeParse(value);
  if (!parsed.success) {
    throw new Error(
      'the encounter draft\'s "assertedCast" field is unreadable — it must be a list of ' +
        '{ name, count } entries (an empty list when the scene names no figure)',
    );
  }
  return parsed.data;
}

/**
 * Are two figure names the SAME figure? THE ONE name comparison this rule is
 * built on — the same trimmed, case-insensitive form `comparableName` gives
 * every name comparison in the app — so the presence gate, the substitution
 * gate and the budget exemption can never disagree about what counts as "the
 * same figure".
 */
export function sameAssertedName(left: string, right: string): boolean {
  const key = comparableName(left);
  return key !== '' && key === comparableName(right);
}

/** Does `name` name one of the scene's asserted figures? */
export function isAssertedFigure(
  name: string,
  asserted: readonly AssertedCastEntry[],
): boolean {
  return asserted.some((entry) => sameAssertedName(entry.name, name));
}

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

/**
 * The EFFECTIVE asserted cast for one roster-authoring step (docs/17 row 309):
 * what THIS reply transcribed, plus what the encounter row already holds. The
 * scene-reading step is the only writer; every later pass on the same encounter
 * (a map/stocking run, an in-place refill) is BOUND by the persisted list, so
 * an assertion cannot be dropped by a lane whose brief carries no scene text.
 * Order: the reply's own reading first, then the stored list, deduplicated by
 * the ONE comparable form.
 */
export function effectiveAssertedCast(
  transcribed: readonly AssertedCastEntry[],
  stored: readonly AssertedCastEntry[],
): AssertedCastEntry[] {
  const merged: AssertedCastEntry[] = [];
  const seen = new Set<string>();
  for (const entry of [...transcribed, ...stored]) {
    const key = comparableName(entry.name);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

/**
 * The REQUIRED-presence issues for a roster (docs/17 row 309): one issue per
 * asserted figure the roster does not field under that name. Pure, so the
 * repair turn and the finalize belt read the SAME finding — a second check
 * written at the second call site is how a gate drifts.
 */
export function assertedCastIssues(
  encounterName: string,
  asserted: readonly AssertedCastEntry[],
  roster: readonly { name: string }[],
): string[] {
  return asserted
    .filter((entry) => !roster.some((member) => sameAssertedName(member.name, entry.name)))
    .map(
      (entry) =>
        `assertedCast: the scene for "${encounterName}" asserts "${entry.name}"` +
        `${entry.count > 1 ? ` (×${String(entry.count)})` : ''}, and no roster entry carries that name. ` +
        'Every asserted figure must be fielded as written — add it under exactly that name (a complete ' +
        'inline "statBlock" when no library creature matches), or the reply is refused.',
    );
}

/**
 * The SUBSTITUTION refusal (docs/17 row 309): a substitution may not cover an
 * asserted figure. The only legal outcomes for an assertion are "included" or
 * "authored inline" — so a declaration naming one is not a report to surface
 * but a broken reply, and it is refused (after the run's one repair turn, like
 * every other contract gate). Substitutions stay legitimate for everything the
 * scene does not assert.
 */
export function assertedSubstitutionIssues(
  encounterName: string,
  asserted: readonly AssertedCastEntry[],
  substitutions: readonly SceneSubstitution[],
): string[] {
  return substitutions
    .filter((entry) => isAssertedFigure(entry.asserted, asserted))
    .map(
      (entry) =>
        `substitutions: "${entry.asserted.trim()}" is a figure the scene for "${encounterName}" ASSERTS, ` +
        `so it may not be substituted (declared as "${entry.used.trim()}"` +
        `${entry.reason.trim() === '' ? '' : `, reason: ${entry.reason.trim()}`}). The only outcomes for an ` +
        'asserted figure are fielded as written or built as a complete inline "statBlock" — drop the ' +
        'declaration and honour the assertion, or remove the figure from "assertedCast" if the scene ' +
        'does not actually assert it.',
    );
}

/**
 * The user-visible SURFACE line for the transcribed cast (docs/17 row 309): it
 * rides the encounter's EXISTING advisory block (`data.budgetAdvisory` — the
 * same seam the budget verdicts, the fixed cast and the substitution reports
 * use; the step notice renders it too). Naming the figures the model read is
 * what makes a wrong read correctable in one step (AGENTS rule 5), and it is
 * the ONLY reporting channel this rule uses. Null when nothing was asserted —
 * never an empty advisory line.
 */
export function assertedCastAdvisory(
  encounterName: string,
  asserted: readonly AssertedCastEntry[],
): string | null {
  if (asserted.length === 0) return null;
  const figures = asserted
    .map((entry) => `"${entry.name}"${entry.count > 1 ? ` ×${String(entry.count)}` : ''}`)
    .join(', ');
  return (
    `Scene assertions transcribed for "${encounterName}": ${figures}. Every one of them is fielded in the ` +
    'roster as written (asserted figures are exempt from the challenge budget — the band bounds the ' +
    'rest of the roster). If the scene does not actually assert one of these, regenerate: the roster is following it.'
  );
}

/**
 * THE FINALIZE BELT (docs/17 row 309): the last write of an encounter's roster
 * refuses while an asserted figure is absent, so a fight can never SHIP with a
 * note where the scene asserted a participant. The roster-authoring gates
 * already repair-then-fail, so reaching this is a programming error or a
 * hand-edited run row — and it is loud rather than an advisory by construction
 * (AGENTS rule 1). It reads the SAME `assertedCastIssues` the gates read.
 */
export function assertAssertedCastPresent(
  encounterName: string,
  asserted: readonly AssertedCastEntry[],
  roster: readonly { name: string }[],
): void {
  const issues = assertedCastIssues(encounterName, asserted, roster);
  if (issues.length > 0) {
    throw new Error(
      `finalize: refusing to save "${encounterName}" — the scene asserts figures the roster does not ` +
        `field: ${issues.join(' ')}`,
    );
  }
}
