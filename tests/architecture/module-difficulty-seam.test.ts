import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE module difficulty seam (docs/17 row 190, docs/18 §2). Difficulty is the
 * SIBLING of the encounter budget policy: ONE domain module owns the five
 * steps, the labels, the multiplier ladder and the resolver; ONE seam in
 * `roomBudget.ts` applies the multiplier to the standard-encounter number for
 * both systems. The drift this scan catches is invisible: a second resolver, a
 * hand-spelled multiplier or a per-call-site read of the module field would
 * work today and diverge the first time the ladder changes.
 */

const SRC_DIR = join(process.cwd(), 'src');
const DIFFICULTY_MODULE = 'src/domain/moduleDifficulty.ts';
const RUN_ENGINE = 'src/llm/runEngine.ts';
const ROOM_BUDGET = 'src/llm/roomBudget.ts';
const ARTIFACT_EDITOR = 'src/features/campaign/components/artifact-editor.tsx';
const RESTOCK_BUTTON = 'src/features/modules/module-restock-button.tsx';
const DIFFICULTY_CONTROL = 'src/features/modules/module-difficulty-control.tsx';
const NEW_MODULE_DIALOG = 'src/features/modules/new-module-dialog.tsx';
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out.sort();
}

function countsOf(needle: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of sourceFiles(SRC_DIR)) {
    const hits = readFileSync(file, 'utf8').split(needle).length - 1;
    if (hits > 0) counts.set(relative(process.cwd(), file), hits);
  }
  return counts;
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
    // The two surfaces that choose a difficulty mount that ONE component:
    // the New Module dialog and the artifact editor's encounter section.
    const mounts = countsOf('<ModuleDifficultyControl');
    expect([...mounts.entries()]).toEqual([
      [ARTIFACT_EDITOR, 1],
      [NEW_MODULE_DIALOG, 1],
    ]);
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
