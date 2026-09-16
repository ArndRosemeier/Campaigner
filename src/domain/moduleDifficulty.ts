import { z } from 'zod';

/**
 * The module difficulty (docs/17 row 190, owner request): HOW HARD a module
 * should be for this group. It is a SIBLING of the encounter budget policy
 * (`domain/encounterBudget.ts`, docs/17 row 180) — not a second version of it.
 * The policy answers *which rule bounds a room's challenge* (`'system'` /
 * `'pf2e-budget'` / `'verbatim'`); difficulty answers *how hard the module
 * should be for this group* and scales whatever numeric budget that policy
 * produces. The two are independent: an owner may choose `'verbatim'` and
 * `'much-harder'` at once, and the two facts must never be conflated into one
 * enum.
 *
 * Exactly FIVE steps, with the middle one as the default:
 *
 * - `'much-easier'` / `'easier'` / `'normal'` / `'harder'` / `'much-harder'`.
 *
 * The field is persisted, zod-validated (module row + New Module draft),
 * resolved ONCE per run and threaded to every budget consumer — never
 * re-derived at a call site.
 *
 * LICENSING (docs/11 D12, docs/17 rows 180 and 190): the multipliers below are
 * Campaigner's OWN documented approximation, expressed in OUR words and OUR
 * units. They scale Campaigner's own numeric approximations of a standard
 * encounter budget (the dnd5e `T + 2` band and the pf2e `2 × party level`
 * approximation). Paizo's encounter-building tables (GM Core) and Wizards'
 * DMG tables are NOT licensable and are never embedded here; no licensed number
 * is quoted, paraphrased or restated. Under the `'verbatim'` budget policy no
 * numeric budget is computed at all, so the multiplier applies only where
 * numbers are computed at all — there difficulty is stated to the model as a
 * DIRECTION, never a number.
 */
export const MODULE_DIFFICULTIES = [
  'much-easier',
  'easier',
  'normal',
  'harder',
  'much-harder',
] as const;

export const moduleDifficultySchema = z.enum(MODULE_DIFFICULTIES);

export type ModuleDifficulty = z.infer<typeof moduleDifficultySchema>;

/** Human labels for the New Module dialog (one source, never re-spelled). */
export const MODULE_DIFFICULTY_LABELS: Readonly<Record<ModuleDifficulty, string>> = {
  'much-easier': 'Much easier',
  easier: 'Easier',
  normal: 'Normal',
  harder: 'Harder',
  'much-harder': 'Much harder',
};

/**
 * The middle step, and the reading of a row that predates the field: a legacy
 * module resolves here, so every module created before difficulty existed
 * behaves EXACTLY as today (multiplier 1, byte-identical budget numbers).
 */
export const DEFAULT_MODULE_DIFFICULTY: ModuleDifficulty = 'normal';

/**
 * The documented ladder (docs/17 row 190): the factor by which a difficulty
 * scales a standard encounter budget. Our own numbers, our own reasoning:
 *
 * - the middle is exactly 1× (today's behaviour);
 * - the extremes exactly HALVE / DOUBLE the standard budget — a legible
 *   "roughly half" / "roughly double" a model and a GM can act on;
 * - the adjacent steps are ±25–50% — big enough to move a room's verdict,
 *   small enough to read as a nudge rather than a different game;
 * - the ladder is monotone and symmetric-feeling around the middle
 *   (`0.5 ↔ 2`, `0.75 ↔ 1.5`), and every factor is a round number, so the
 *   scaled band stays legible in the prompt and in the advisories
 *   (`(targetLevel + 2) × 1.5`), never a long decimal.
 *
 * These are approximations of OUR OWN standard-encounter budget, never a
 * licensed table's numbers (see the licensing note above).
 */
export const MODULE_DIFFICULTY_MULTIPLIERS: Readonly<Record<ModuleDifficulty, number>> = {
  'much-easier': 0.5,
  easier: 0.75,
  normal: 1,
  harder: 1.5,
  'much-harder': 2,
};

/**
 * The ONE scaling rule (docs/17 row 190): the factor a resolved difficulty
 * applies to a standard-encounter budget. Every consumer reads THIS — the
 * numeric band (`roomBudget.roomBudgetBandUpperFor`) and the prompt clause —
 * so a second multiplier table cannot appear beside it.
 */
export function difficultyBudgetMultiplier(difficulty: ModuleDifficulty): number {
  return MODULE_DIFFICULTY_MULTIPLIERS[difficulty];
}

/**
 * The ONE difficulty resolver every run reads (docs/17 row 190): a module's OWN
 * recorded difficulty when it has one; `'normal'` otherwise. `'normal'` is the
 * legacy reading — a row written before the field, and any encounter with no
 * owning module at all — so old modules behave exactly as today. The unknown
 * case cannot reach here: the field is a zod enum at the row boundary.
 */
export function resolveModuleDifficulty(
  module: { difficulty?: ModuleDifficulty | null | undefined } | null | undefined,
): ModuleDifficulty {
  return module?.difficulty ?? DEFAULT_MODULE_DIFFICULTY;
}
