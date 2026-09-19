import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `scripts/buildStatus.mjs` — the deploy job's build-status writer (docs/17 row
 * 250, docs/18 §2), driven END TO END through its CLI against throwaway git
 * repositories.
 *
 * WHY END TO END AND NOT BY IMPORTING THE MODULE: the script's whole job is the
 * git question ("is everything between the newest GATE GREEN landing and HEAD
 * documentation-only?"), and a test that injects fake git answers cannot catch
 * a wrongly spelled `git diff`/`rev-list`/`merge-base` call — the wiring IS the
 * feature here. Each arm below therefore builds a real three-commit repo, runs
 * the real script with a real board file, and reads the JSON it wrote.
 *
 * The acceptance arms: a docs-only delta after the verified landing reads
 * `verified`; a `src/` delta reads `wip`; an unparseable board record and an
 * unknown SHA both write `cannot-tell` (and never throw); and a computation
 * failure still writes a `cannot-tell` file (exit 1) instead of leaving the
 * badge with nothing — the deploy step is `continue-on-error`, so a failure
 * here can never break a deploy but must stay visible.
 */
const STATUS_SCRIPT = join(process.cwd(), 'scripts/buildStatus.mjs');

const GREEN_VERIFY = 'MY OWN: GATE GREEN — 344 files / 4483 tests, 7/7 chunks';

/** A throwaway repo with a code commit, a docs commit and a second code commit. */
function makeRepo(): { repo: string; code: string; docs: string; wip: string } {
  const repo = mkdtempSync(join(tmpdir(), 'campaigner-build-status-'));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'dev@campaigner.local');
  git('config', 'user.name', 'Campaigner Dev');
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const version = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'the code');
  const code = git('rev-parse', 'HEAD').trim();
  writeFileSync(join(repo, 'docs', '17-DECISION-LEDGER.md'), 'the ledger\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'the records');
  const docs = git('rev-parse', 'HEAD').trim();
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const version = 2;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'unverified code');
  const wip = git('rev-parse', 'HEAD').trim();
  return { repo, code, docs, wip };
}

/** One `LANDED` record in the board's record grammar. */
function landedRecord(sha: string, verify: string): string {
  return `LANDED | row=9 | sha=${sha} | verify=${verify} | retired=none | note=x`;
}

/** Run the real script over `board` and return the payload it wrote. */
function runStatus(repo: string, board: string, head: string): { state: string; detail: string } {
  const boardPath = join(repo, 'board.md');
  const outPath = join(repo, 'build-status.json');
  writeFileSync(boardPath, board);
  execFileSync('node', [STATUS_SCRIPT, '--board', boardPath, '--out', outPath, '--head', head], {
    cwd: repo,
    encoding: 'utf8',
  });
  return JSON.parse(readFileSync(outPath, 'utf8')) as { state: string; detail: string };
}

describe('scripts/buildStatus.mjs (docs/17 row 250)', () => {
  it('reads verified when everything after the GATE GREEN landing is docs-only', () => {
    const { repo, code, docs } = makeRepo();
    const payload = runStatus(repo, landedRecord(code, GREEN_VERIFY), docs);
    expect(payload.state).toBe('verified');
    expect(payload.detail).toContain(code.slice(0, 7));
  });

  it('reads verified when HEAD IS the verified landing (empty delta)', () => {
    const { repo, docs } = makeRepo();
    expect(runStatus(repo, landedRecord(docs, GREEN_VERIFY), docs).state).toBe('verified');
  });

  it('reads wip when a src/ change follows the GATE GREEN landing', () => {
    const { repo, docs, wip } = makeRepo();
    const payload = runStatus(repo, landedRecord(docs, GREEN_VERIFY), wip);
    expect(payload.state).toBe('wip');
    expect(payload.detail).toContain('not documentation-only');
  });

  it('ignores a NEWER LANDED record that does not claim GATE GREEN', () => {
    const { repo, code, docs } = makeRepo();
    const board = [
      landedRecord(code, GREEN_VERIFY),
      landedRecord(docs, 'DOCS-ONLY (no product code): the compile tier is its check'),
    ].join('\n');
    // HEAD is the docs commit; the docs-only record must not become a verified
    // point, and the code commit's GREEN still covers it.
    expect(runStatus(repo, board, docs).state).toBe('verified');
  });

  it('writes cannot-tell, and does not throw, when a board record cannot be parsed', () => {
    const { repo, code, docs } = makeRepo();
    // An OLDER valid GATE GREEN record plus a NEWER unreadable one: silently
    // skipping the unreadable record would answer `verified` from the old one,
    // and the unreadable record may be the newest verified point.
    const board = [
      landedRecord(code, GREEN_VERIFY),
      'LANDED | row=9 | verify=MY OWN: GATE GREEN | retired=none | note=x',
    ].join('\n');
    const payload = runStatus(repo, board, docs);
    expect(payload.state).toBe('cannot-tell');
    expect(payload.detail).toContain('cannot be parsed');
  });

  it('writes cannot-tell, and does not throw, when a named SHA is unknown', () => {
    const { repo, code, docs } = makeRepo();
    // Same shape as the arm above: the unknown record may be the newest
    // verified point, so the answer is cannot-tell rather than a fallback to
    // the older record's docs-only delta.
    const board = [
      landedRecord(code, GREEN_VERIFY),
      landedRecord('deadbeefdeadbeef', GREEN_VERIFY),
    ].join('\n');
    const payload = runStatus(repo, board, docs);
    expect(payload.state).toBe('cannot-tell');
    expect(payload.detail).toContain('does not have');
  });

  it('accepts a sha field that carries prose after the hex token (row 247 shape)', () => {
    const { repo, code, docs } = makeRepo();
    // The REAL board wrote `sha=<hex> (rebased from <old>; the code+tests trees
    // are byte-identical — …)`. A parser that demands a bare token reports the
    // newest verified landing as unparseable, and the badge then says
    // cannot-tell on a verified build (found against the live board, row 247).
    const board = landedRecord(code, GREEN_VERIFY).replace(
      `sha=${code}`,
      `sha=${code} (rebased from deadbeef; the code+tests trees are byte-identical)`,
    );
    expect(runStatus(repo, board, docs).state).toBe('verified');
  });

  it('writes cannot-tell when no GATE GREEN landing exists at all', () => {
    const { repo, docs } = makeRepo();
    const board = landedRecord(docs, 'DOCS-ONLY: the compile tier is its check');
    expect(runStatus(repo, board, docs).state).toBe('cannot-tell');
  });

  it('still writes a cannot-tell payload (exit 1) when the computation itself fails', () => {
    const { repo } = makeRepo();
    const outPath = join(repo, 'build-status.json');
    let exitCode = 0;
    try {
      execFileSync(
        'node',
        [STATUS_SCRIPT, '--board', join(repo, 'absent-board.md'), '--out', outPath],
        { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      exitCode = (error as { status?: number }).status ?? -1;
    }
    // A failure is loud in the workflow (exit 1, `continue-on-error` keeps the
    // deploy alive) and honest in the badge (the file says cannot-tell).
    expect(exitCode).toBe(1);
    expect((JSON.parse(readFileSync(outPath, 'utf8')) as { state: string }).state).toBe(
      'cannot-tell',
    );
  });
});
