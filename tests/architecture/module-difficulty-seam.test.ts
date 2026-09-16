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
    // Every consumer resolves once per run from the owning module row.
    const calls = countsOf('resolveModuleDifficulty(');
    expect([...calls.entries()]).toEqual([
      [DIFFICULTY_MODULE, 1],
      [RUN_ENGINE, 3],
    ]);
    // The module row field itself is read in exactly one place — the resolver.
    const fieldReads = countsOf('module?.difficulty');
    expect([...fieldReads.entries()]).toEqual([[DIFFICULTY_MODULE, 1]]);
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
});
