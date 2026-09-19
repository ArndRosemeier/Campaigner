#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * THE docs-only predicate — the ONE place this repo decides whether a changed
 * path is documentation (docs/17 row 250, docs/18 §2).
 *
 * WHY IT IS A SHARED MODULE AND NOT ONE LINE IN EACH CALLER. Two programs ask
 * this question, and their answers MUST agree:
 *   * `scripts/gate.sh` — diffs against `origin/main` and decides whether the
 *     suite may be skipped for a documentation-only change;
 *   * `scripts/buildStatus.mjs` — diffs the DEPLOYED head against the newest
 *     gate-verified landing and decides whether the owner's badge reads
 *     `verified` or `WIP`.
 * A badge that calls a diff verified while the gate would have run the whole
 * suite is a lie produced by two copies of one rule drifting apart, and the
 * reverse is the failure this whole slice exists to avoid. So the gate carries
 * NO pattern of its own: it runs THIS module as a CLI and reads the verdict,
 * and `tests/architecture/one-docs-only-rule.test.ts` reds by file name when a
 * second copy of the rule appears under `scripts/`, `src/`, `tests/` or
 * `.github/`.
 *
 * THE RULE, stated once here and nowhere else: a path is documentation when it
 * lives under `docs/`, or when it is a Markdown file at the repository root
 * (`AGENTS.md`, `README.md`, …). This is exactly the rule `scripts/gate.sh`
 * used to spell inline; a Markdown file in a SUBDIRECTORY is deliberately not
 * covered, because the gate never treated one as documentation.
 *
 * CLI: `node scripts/docsOnly.mjs` reads one path per line on stdin and prints
 * `docs-only` or `not-docs-only`. An empty stdin means "no paths", which this
 * module answers `docs-only` VACUOUSLY (every path in an empty list is
 * documentation). The gate's own policy — an EMPTY diff must still run the
 * whole suite, AGENTS §The gate and the clock 5, the PARITY trap — stays at the
 * gate's call site, where it belongs; it is a gate policy, not this rule.
 */
export const DOCS_ONLY_PATTERNS = [
  // anything under docs/ …
  /^docs\//,
  // … or a Markdown file at the repository root.
  /^[^/]+\.md$/,
];

/** Is this ONE path a documentation path? */
export function isDocsOnlyPath(path) {
  return DOCS_ONLY_PATTERNS.some((pattern) => pattern.test(path));
}

/** Is EVERY path in this changed-file list documentation? (an empty list ⇒ true) */
export function isDocsOnlyDiff(paths) {
  return paths.every((path) => isDocsOnlyPath(path));
}

// The CLI runs only when this file is executed, never when it is imported.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = readFileSync(0, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
  process.stdout.write(isDocsOnlyDiff(paths) ? 'docs-only\n' : 'not-docs-only\n');
}
