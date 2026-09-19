import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE docs-only rule exists EXACTLY ONCE (docs/17 row 250, docs/18 §2).
 *
 * "May this gate skip the suite?" and "is this deployed build suite-verified?"
 * are the SAME question about the SAME paths, asked in two places that must
 * never disagree: `scripts/gate.sh` (diff against `origin/main`) and
 * `scripts/buildStatus.mjs` (diff HEAD against the newest GATE GREEN landing).
 * The rule — `^docs/` or a top-level `*.md` — therefore lives ONCE, in
 * `scripts/docsOnly.mjs`, and the gate shells out to that module instead of
 * spelling its own copy.
 *
 * The pin is a SOURCE SCAN because the drift it catches is invisible: two
 * copies answer identically today and diverge the first time the rule changes,
 * at which point the badge can call a build verified while the gate would have
 * run the whole suite. The needles are the RULE itself (the two patterns), not
 * a function or file name, so neither a rename nor a move can hide a copy; the
 * scan covers `scripts/`, `src/`, `tests/` and `.github/` — every surface where
 * the rule could be re-spelled. A second copy reds here BY FILE NAME.
 */
const ROOTS = ['scripts', 'src', 'tests', '.github'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js', '.sh', '.yml', '.yaml'];
const SEAM = 'scripts/docsOnly.mjs';
const GATE = 'scripts/gate.sh';
const STATUS_SCRIPT = 'scripts/buildStatus.mjs';
const SLASH = '/';
/** The two spellings a copy could use: as written in a JS regex, or in shell ERE. */
const DOCS_DIR_NEEDLES = [`^docs${SLASH}`, `^docs\\${SLASH}`];
/** Assembled from fragments so this FILE cannot match its own scan. */
const ROOT_MD_NEEDLE = `^[^${SLASH}]+` + '\\.md$';

describe('the docs-only rule is spelled exactly once (SOURCE SCAN, docs/17 row 250)', () => {
  it('carries the rule in exactly one file, the shared predicate', () => {
    const files = ROOTS.flatMap((root) =>
      readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name)),
    ).filter((file) => SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension)));

    // Non-vacuity: a walk that saw nothing would make the verdict meaningless.
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(SEAM);

    const offenders = files.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return (
        DOCS_DIR_NEEDLES.some((needle) => text.includes(needle)) && text.includes(ROOT_MD_NEEDLE)
      );
    });
    expect(offenders).toEqual([SEAM]);
  });

  it('has BOTH consumers go through the seam instead of re-spelling it', () => {
    const seam = readFileSync(SEAM, 'utf8');
    expect(DOCS_DIR_NEEDLES.some((needle) => seam.includes(needle))).toBe(true);
    expect(seam.includes(ROOT_MD_NEEDLE)).toBe(true);

    // The gate asks the seam and wraps it (the empty-diff PARITY policy is the
    // gate's, not the predicate's, so it lives at this call site).
    const gate = readFileSync(GATE, 'utf8');
    expect(gate).toContain('docsOnly.mjs');
    expect(gate).toContain('docs_only_diff');

    // The deploy's status script imports the SAME module, never a copy.
    expect(readFileSync(STATUS_SCRIPT, 'utf8')).toContain("from './docsOnly.mjs'");
  });

  it('answers the CLI verdicts both callers rely on', () => {
    const run = (input: string): string =>
      execFileSync('node', [SEAM], { input, encoding: 'utf8' }).trim();
    expect(run('docs/17-DECISION-LEDGER.md\nAGENTS.md\n')).toBe('docs-only');
    expect(run('docs/17-DECISION-LEDGER.md\nsrc/app/layout/TopBar.tsx\n')).toBe('not-docs-only');
    expect(run('scripts/gate.sh\n')).toBe('not-docs-only');
    // The PREDICATE says an empty list is vacuously docs-only; the GATE's own
    // PARITY rule (an empty diff must run the whole suite) is asserted
    // separately below, so a future reader cannot confuse the two.
    expect(run('')).toBe('docs-only');
  });

  it('keeps the gate empty-diff PARITY policy at the gate call site', () => {
    const gate = readFileSync(GATE, 'utf8');
    // An empty diff is refused as docs-only BEFORE the seam is consulted.
    expect(gate).toContain('[ "$#" -gt 0 ] || return 1');
  });
});
