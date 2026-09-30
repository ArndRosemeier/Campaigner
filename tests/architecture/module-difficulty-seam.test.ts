import { describe, expect, it } from 'vitest';

import { countsIn, readTree } from '../helpers/sourceCode';

/**
 * THE module difficulty seam (docs/17 row 190, docs/18 §2). Difficulty is the
 * SIBLING of the encounter budget policy: ONE domain module owns the five
 * steps, the labels, the multiplier ladder and the resolver; ONE seam in
 * `roomBudget.ts` applies the multiplier to the standard-encounter number for
 * both systems. The drift this scan catches is invisible: a second resolver, a
 * hand-spelled multiplier or a per-call-site read of the module field would
 * work today and diverge the first time the ladder changes.
 */

const DIFFICULTY_MODULE = 'src/domain/moduleDifficulty.ts';
const RUN_ENGINE = 'src/llm/runEngine.ts';
const ROOM_BUDGET = 'src/llm/roomBudget.ts';
const ARTIFACT_EDITOR = 'src/features/campaign/components/artifact-editor.tsx';
const RESTOCK_BUTTON = 'src/features/modules/module-restock-button.tsx';
const DIFFICULTY_CONTROL = 'src/features/modules/module-difficulty-control.tsx';
const SRC = readTree('src', ['.ts', '.tsx']);

function countsOf(needle: string): Map<string, number> {
  return new Map(countsIn(SRC, 'src/', needle));
}

describe('one module difficulty seam (SOURCE SCAN)', () => {
  it('defines the ONE resolver and reads the module field only through it', () => {
    const definitions = countsOf('export function resolveModuleDifficulty(');
    expect([...definitions.entries()]).toEqual([[DIFFICULTY_MODULE, 1]]);
    // Every consumer resolves through the ONE resolver: ONE run-time budget
    // resolver (docs/17 row 228), and (docs/17 row 195) the two UI surfaces
    // that must SHOW the value they act at — the encounter editor's difficulty
    // control and the module-level restock button's read-only badge. A UI site
    // reading the raw field instead would be a second resolver; reading it
    // through this function is exactly what keeps "no field read outside the
    // resolver" true.
    const calls = countsOf('resolveModuleDifficulty(');
    expect([...calls.entries()]).toEqual([
      [DIFFICULTY_MODULE, 1],
      [ARTIFACT_EDITOR, 1],
      [RESTOCK_BUTTON, 1],
      // ONE run-time site (docs/17 row 228 folded the old three — the
      // Cartographer brief, the roster-only repopulate finalize and the
      // in-place fill — onto `RunEngine.runEncounterBudget`, and the
      // single-room repopulate draft reads it too, so a fourth copy of the
      // resolution chain cannot reappear).
      [RUN_ENGINE, 1],
    ]);
    // The module row field itself is read in exactly one place — the resolver.
    const fieldReads = countsOf('module?.difficulty');
    expect([...fieldReads.entries()]).toEqual([[DIFFICULTY_MODULE, 1]]);
  });

  it('draws the five steps in exactly ONE component, mounted by both surfaces', () => {
    // A second five-step renderer is the duplication this row folded away: the
    // New Module dialog used to map the steps inline. Only the ONE control may
    // walk `MODULE_DIFFICULTIES`, so a copy reds by file here.
    const steppers = countsOf('MODULE_DIFFICULTIES.map(');
    expect([...steppers.entries()]).toEqual([[DIFFICULTY_CONTROL, 1]]);
    // The surface that chooses a difficulty mounts that ONE component: the
    // artifact editor's encounter section. (MIGRATED, docs/17 row 395: the New
    // Module dialog was the second mount and is DELETED — creation asks nothing;
    // the row is stamped with the default difficulty. The pin still names the
    // exact mount set, so a new mount reds.)
    const mounts = countsOf('<ModuleDifficultyControl');
    expect([...mounts.entries()]).toEqual([[ARTIFACT_EDITOR, 1]]);
  });

  it('defines the multiplier ladder once and applies it only in the budget seam', () => {
    const definitions = countsOf('export function difficultyBudgetMultiplier(');
    expect([...definitions.entries()]).toEqual([[DIFFICULTY_MODULE, 1]]);
    // All call sites live in the ONE budget module: the numeric seam
    // (`roomBudgetBandUpperFor`), the prompt clauses and the stocking line.
    const calls = countsOf('difficultyBudgetMultiplier(');
    expect([...calls.entries()]).toEqual([
      [DIFFICULTY_MODULE, 1],
      [ROOM_BUDGET, 4],
    ]);
    // No other file embeds a copy of the ladder's literals as a multiplier.
    const ladder = countsOf('MODULE_DIFFICULTY_MULTIPLIERS:');
    expect([...ladder.entries()]).toEqual([[DIFFICULTY_MODULE, 1]]);
  });

  it('states the party level and the difficulty clause through their ONE composers', () => {
    // The ONE level sentence (`partyLevelLine`) — the count is its template,
    // its own exclusion matcher and the two doc references beside them, all in
    // the ONE file. A hand-written "… adventurers at level N." anywhere else is
    // the exact defect docs/17 row 228 cured on the single-room repopulate
    // route (the Smith brief stated none), and it reds by file here.
    const levelSentences = countsOf('adventurers at level');
    expect([...levelSentences.entries()]).toEqual([[ROOM_BUDGET, 4]]);
    // The ONE module-difficulty clause: a second composer reds the same way.
    const difficultyClauses = countsOf('MODULE DIFFICULTY (');
    expect([...difficultyClauses.entries()]).toEqual([[ROOM_BUDGET, 1]]);
  });
});
