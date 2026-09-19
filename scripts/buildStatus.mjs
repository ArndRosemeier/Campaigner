#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { isDocsOnlyDiff } from './docsOnly.mjs';

/**
 * THE build-status badge payload writer — the DEPLOY job's step (docs/17 row
 * 250, docs/18 §2).
 *
 * THE PROBLEM IT ANSWERS. A push to `main` deploys, and this repo's gate has
 * two tiers: a ~27s COMPILE tier that blocks the push and a FULL suite that
 * follows it in the background (AGENTS §Workflow). So the app the owner tests
 * can be a compile-clean build whose suite has not finished — and he asked to
 * SEE that state beside the title, so a rapid-testing build is never mistaken
 * for a verified one. The state has to be computed HERE, in the deploy job,
 * because that is the only place that holds git AND the board at once: it reads
 * the newest gate-verified landing off the board and asks whether everything
 * between that commit and HEAD is documentation-only, using the SAME predicate
 * the gate uses (`./docsOnly.mjs` — ONE rule, never a second copy).
 *
 * THE THREE HONEST STATES, and why there is no fourth:
 *   * `verified`   — a GATE GREEN landing exists on HEAD's ancestry and every
 *                    path changed since it is documentation.
 *   * `wip`        — such a landing exists and the diff since is NOT
 *                    documentation-only: this build is compile-clean and
 *                    unverified.
 *   * `cannot-tell` — no parseable GATE GREEN landing, or a named commit this
 *                    checkout does not have, or no verified landing is an
 *                    ancestor of HEAD, or any computation failure at all.
 * A build whose state could not be checked MUST read `cannot-tell`: reading
 * `verified` without having checked is the exact lie this slice exists to
 * prevent, and a missing/garbled payload file makes the badge fall back to
 * `cannot-tell` on the app side too.
 *
 * IT IS DEPLOY-CRITICAL, SO IT IS NON-FATAL BY CONSTRUCTION. The deploy
 * workflow runs it with `continue-on-error: true`, and this script still writes
 * a `cannot-tell` payload when the computation throws; a deploy that breaks the
 * owner's ability to test the app is the one failure he cannot work around.
 *
 * IT IS A TESTED SCRIPT, NOT INLINE WORKFLOW BASH: the workflow's step is one
 * `node scripts/buildStatus.mjs`, and the whole decision — board parsing, the
 * ancestry question, the docs-only comparison — is exercised end to end by
 * `tests/architecture/build-status-payload.test.ts` against throwaway git
 * repositories. The app validates the written payload at its own boundary
 * (`src/app/layout/build-status.ts`).
 *
 * Usage: node scripts/buildStatus.mjs [--board <path>] [--out <path>] [--head <rev>]
 * Defaults: --board docs/20-ORCHESTRATION.md, --out dist/build-status.json,
 *           --head HEAD. Exit 0 whenever a payload was computed (including
 *           cannot-tell); exit 1 when the computation or the write failed, after
 *           still trying to write the cannot-tell payload.
 */
export const DEFAULT_BOARD_PATH = 'docs/20-ORCHESTRATION.md';
export const DEFAULT_OUT_PATH = 'dist/build-status.json';

/**
 * The `LANDED | row=<n> | sha=<hex>` prefix of a record. The sha VALUE may
 * carry prose after the hex token — the board's own row 247 reads
 * `sha=68a401b (rebased from 98a935b; the code+tests trees are byte-identical …)`
 * — because the record grammar is `field=value` pairs and a value is not
 * guaranteed to be one bare token. Taking the leading hex token is what keeps
 * that real record READABLE instead of reporting it unparseable, which would
 * make the badge answer cannot-tell on a verified build (found against the live
 * board).
 */
const LANDED_ROW = /^LANDED \| row=(\d+) \| sha=([0-9a-f]{7,40})\b/;

/** The `verify=` field of a record, up to the next ` | retired=`/` | note=`. */
const VERIFY_FIELD = /\| verify=(.*?)(?: \| (?:retired|note)=|$)/;

/** The one payload a failure may write — never a state that claims a check. */
export function cannotTell(detail) {
  return { state: 'cannot-tell', detail };
}

function shortSha(sha) {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

/**
 * Every LANDED record whose `verify=` field states `GATE GREEN`, in board
 * order. `unparsed` collects LANDED records that mention GATE GREEN but cannot
 * be read (no `verify=` field, or no `row=`/`sha=` prefix) — those are LOUD,
 * because a record that may be the newest verified landing must never be
 * skipped in silence (AGENTS rule 1). A record whose `verify=` says anything
 * else (a docs-only landing, a compile-tier result) is simply not a verified
 * point and is not an error.
 */
export function parseVerifiedLandings(boardText) {
  const landings = [];
  const unparsed = [];
  for (const line of boardText.split('\n')) {
    if (!line.startsWith('LANDED | ')) continue;
    const verify = VERIFY_FIELD.exec(line);
    if (verify === null) {
      if (line.includes('GATE GREEN')) {
        unparsed.push(`${line.slice(0, 80)}… (no verify= field)`);
      }
      continue;
    }
    if (!verify[1].includes('GATE GREEN')) continue;
    const row = LANDED_ROW.exec(line);
    if (row === null) {
      unparsed.push(`${line.slice(0, 80)}… (no parseable row=/sha= prefix)`);
      continue;
    }
    landings.push({ row: Number(row[1]), sha: row[2], verify: verify[1].trim() });
  }
  return { landings, unparsed };
}

/**
 * The whole decision, over injected git answers (see `createGitAdapter` for the
 * real one). Pure: same inputs, same payload.
 */
export function computeBuildStatus({ boardText, head, git }) {
  const { landings, unparsed } = parseVerifiedLandings(boardText);
  if (unparsed.length > 0) {
    return cannotTell(
      `the board holds ${unparsed.length} LANDED record(s) that cannot be parsed: ${unparsed[0]}`,
    );
  }
  if (landings.length === 0) {
    return cannotTell('no LANDED record on the board states GATE GREEN');
  }

  const resolved = landings.map((landing) => ({ ...landing, full: git.resolveCommit(landing.sha) }));
  // A GATE GREEN record whose commit this checkout does not have means the
  // history the record verified cannot be seen from here, so NOTHING about
  // HEAD's ancestry can be concluded from it — and it may be the newest
  // verified point. Answer cannot-tell rather than falling back to an older
  // record whose docs-only delta would read as `verified` (acceptance arm).
  const missing = resolved.filter((landing) => landing.full === null);
  if (missing.length > 0) {
    return cannotTell(
      `${missing.length} GATE GREEN LANDED record(s) name a commit this checkout does not have (newest: ${missing[missing.length - 1].sha})`,
    );
  }
  const points = resolved.filter((landing) => git.isAncestor(landing.full, head));
  if (points.length === 0) {
    return cannotTell(
      `no GATE GREEN LANDED record names a commit this checkout has as an ancestor of ${shortSha(head)} (board names: ${resolved.map((landing) => landing.sha).join(', ')})`,
    );
  }

  // The NEWEST verified point on HEAD's ancestry is the one closest to HEAD:
  // commit distance is the only ordering that survives board rows landing out
  // of row-number order (two writers, one board).
  let best = points[0];
  let bestDistance = git.distance(best.full, head);
  for (const point of points.slice(1)) {
    const distance = git.distance(point.full, head);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }

  const delta = git.changedFiles(best.full, head);
  if (isDocsOnlyDiff(delta)) {
    return {
      state: 'verified',
      detail:
        delta.length === 0
          ? `the FULL gate is GREEN at ${shortSha(best.full)} — this build is that tree`
          : `the FULL gate is GREEN at ${shortSha(best.full)}; the ${delta.length} changed file(s) since are documentation-only`,
    };
  }
  return {
    state: 'wip',
    detail: `compiles, but the FULL gate has not verified it: ${delta.length} changed file(s) since the last GATE GREEN landing ${shortSha(best.full)} are not documentation-only`,
  };
}

/** Run one git command in `cwd` and return its stdout. */
export function execGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The real git answers `computeBuildStatus` asks for. */
export function createGitAdapter(cwd) {
  const git = (...args) => execGit(cwd, args);
  return {
    /** The full commit id for a revision, or null when this checkout lacks it. */
    resolveCommit(rev) {
      try {
        return git('rev-parse', '--verify', '--quiet', `${rev}^{commit}`).trim();
      } catch {
        return null;
      }
    },
    /** Is `ancestor` an ancestor of (or equal to) `descendant`? */
    isAncestor(ancestor, descendant) {
      try {
        git('merge-base', '--is-ancestor', ancestor, descendant);
        return true;
      } catch {
        return false;
      }
    },
    /** How many commits `to` has that `from` does not. */
    distance(from, to) {
      return Number(git('rev-list', '--count', `${from}..${to}`).trim());
    },
    /** Every path whose content differs between the two commits. */
    changedFiles(from, to) {
      return git('diff', '--name-only', from, to)
        .split('\n')
        .filter((line) => line.length > 0);
    },
  };
}

export function parseArgs(argv) {
  const args = { board: DEFAULT_BOARD_PATH, out: DEFAULT_OUT_PATH, head: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== '--board' && flag !== '--out' && flag !== '--head') {
      throw new Error(
        `unknown argument '${flag}' (expected --board <path>, --out <path>, --head <rev>)`,
      );
    }
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--board') args.board = value;
    else if (flag === '--out') args.out = value;
    else args.head = value;
    index += 1;
  }
  return args;
}

function main() {
  let out = DEFAULT_OUT_PATH;
  let failed = false;
  let payload;
  try {
    const args = parseArgs(process.argv.slice(2));
    out = args.out;
    const boardText = readFileSync(args.board, 'utf8');
    const head = args.head ?? execGit(process.cwd(), ['rev-parse', 'HEAD']).trim();
    payload = computeBuildStatus({ boardText, head, git: createGitAdapter(process.cwd()) });
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`build-status: could not compute the status: ${message}\n`);
    // The badge must never be left claiming a state that was not computed.
    payload = cannotTell(`the build status could not be computed: ${message}`);
  }
  try {
    writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`build-status: could not write ${out}: ${message}\n`);
  }
  process.stdout.write(`build-status: ${payload.state} — ${payload.detail}\n`);
  process.exitCode = failed ? 1 : 0;
}

// The CLI runs only when this file is executed, never when it is imported.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
