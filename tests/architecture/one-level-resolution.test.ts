import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ONE seam resolves an entity's level (docs/17 row 206, AGENTS rule 4).
 *
 * The owner's regression was a MISSING COPY, not a wrong one: the artifact
 * editor's "Regenerate with AI" rebuilt `StartRunInput` without
 * `entityLevelHint`, so `runStatblock` silently fell back to a regex over a
 * brief whose only `level N` was the PARTY's. The cure is one resolution
 * expression inside `runStatblock` (`input.entityLevelHint ?? the stored module
 * grounding's recorded level`) plus ONE party-line exclusion shared by the
 * fallback — never a per-caller patch of the panel, the chain runner and the
 * change lane.
 *
 * The pin is a SOURCE SCAN because the drift it catches is invisible: a second
 * call site that rebuilds `StartRunInput` reads correctly today and silently
 * loses the level the day a caller is added. The needles are the resolution
 * expression and the exclusion call; the red is a second reader of the raw
 * brief regex that bypasses the exclusion.
 */

const SRC_DIR = join(process.cwd(), 'src');
const ENGINE = 'src/llm/runEngine.ts';
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

function rel(full: string): string {
  return relative(process.cwd(), full).split(sep).join('/');
}

/** Comments are skipped: the seam's own docstring NAMES the regex it removes. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('ONE seam resolves the entity level (docs/17 row 206)', () => {
  it('resolves the two structured sources at exactly one site', () => {
    const files = sourceFiles(SRC_DIR);
    // Non-vacuity: the walk must see the whole tree, or it proves nothing.
    expect(files.length).toBeGreaterThan(300);
    const stripped = files.map((file) => [rel(file), stripComments(readFileSync(file, 'utf8'))] as const);
    const resolvers = stripped
      .filter(([, text]) => text.includes('input.entityLevelHint ?? recordedLevel'))
      .map(([file]) => file);
    expect(resolvers).toEqual([ENGINE]);
  });

  it('routes the brief-text fallback through the ONE party-line exclusion, and leaves no raw-brief reader', () => {
    const files = sourceFiles(SRC_DIR);
    const stripped = files.map((file) => [rel(file), stripComments(readFileSync(file, 'utf8'))] as const);
    // Defined once, beside `partyLevelLine` whose shape it excludes…
    const definers = stripped
      .filter(([, text]) => text.includes('export function withoutPartyLevelLines'))
      .map(([file]) => file);
    expect(definers).toEqual([ROOM_BUDGET]);
    // …and consumed once, by the statblock fallback.
    const callers = stripped
      .filter(([, text]) => text.includes('withoutPartyLevelLines(input.brief)'))
      .map(([file]) => file);
    expect(callers).toEqual([ENGINE]);
    // The pre-row-206 raw regex over the brief is GONE: a second reader that
    // bypasses the party-line exclusion reds here.
    const rawReaders = stripped
      .filter(([, text]) => text.includes('.exec(input.brief)'))
      .map(([file]) => file);
    expect(rawReaders).toEqual([]);
  });
});
