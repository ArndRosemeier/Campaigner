import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE BOARD IS BOUNDED, AND THE BOUND IS A TEST (docs/17 row 303; owner-directed
 * 2026-09-21, verbatim: *"good call, that mega board is cluttering things up."*).
 *
 * WHY THIS EXISTS: `docs/20-ORCHESTRATION.md` is the CoS's memory that outlives
 * its own session — the thing a successor must be able to ACT from inside a
 * session start — and it had grown to 349 dense lines, most of them LANDED
 * history its own closing note assigns to `docs/17`. The file's contract
 * ("must stay ONE SCREEN") was prose, and prose had already failed: every
 * individual landing was correct, which is exactly the decentralization class
 * AGENTS rule 4 names, so the bound is mechanical here instead of remembered.
 *
 * TWO DIFFERENT FAILURES ARE PINNED, and the second is why the REAL badge script
 * runs in the last arm:
 *   1. REGROWTH — a historical tail that nobody prunes. A landing now PRUNES the
 *      oldest LANDED row (`docs/20` §The contract 6), so the caps below are red
 *      the moment the habit comes back.
 *   2. UNREADABLE — a compaction that is beautiful and unparseable. The deploy
 *      job resolves the badge from THIS file (`scripts/buildStatus.mjs` reads the
 *      newest `GATE GREEN` LANDED record on HEAD's ancestry, `docs/18` §2.3), and
 *      a board it cannot parse makes the owner's badge answer `cannot-tell`. The
 *      last arm therefore runs the real script over the real board rather than
 *      re-implementing its parser — a second copy of the grammar is the very
 *      defect AGENTS rule 4 forbids, and this file's format arm deliberately
 *      checks only the SHAPE the board owes the parser (prefix + `verify=`),
 *      never the parser's resolution logic.
 *
 * The archive for everything this file no longer restates is one command, and
 * the board names it in its own header: `git show 3200807:docs/20-ORCHESTRATION.md`.
 */

const BOARD = 'docs/20-ORCHESTRATION.md';
const STATUS_SCRIPT = join(process.cwd(), 'scripts/buildStatus.mjs');

const MAX_BOARD_LINES = 140;
const MAX_BOARD_LINE_CHARS = 500;
const MAX_LANDED_ROWS = 12;
const LANDED_ROW_SHAPE = /^LANDED \| row=[0-9]+ \| sha=[0-9a-f]{7,40} \| verify=/;

describe('ONE board rule: docs/20 stays bounded, and stays a board the badge can read (docs/17 row 303)', () => {
  const text = readFileSync(BOARD, 'utf8');
  const lines = text.split('\n');
  const landed = lines.filter((line) => line.startsWith('LANDED | '));

  it('stays inside the line budget', () => {
    expect(lines.length).toBeLessThanOrEqual(MAX_BOARD_LINES);
  });

  it('keeps every line inside the width budget — a mega line is how this file rotted', () => {
    const tooWide = lines
      .filter((line) => line.length > MAX_BOARD_LINE_CHARS)
      .map((line) => `${line.length} chars: ${line.slice(0, 60)}`);
    expect(tooWide).toEqual([]);
  });

  it('prunes: the LANDED tail never passes its cap, so a landing drops the oldest row', () => {
    expect(landed.length).toBeLessThanOrEqual(MAX_LANDED_ROWS);
  });

  it('keeps every LANDED row in the shape the badge parser requires', () => {
    const malformed = landed
      .filter((line) => !LANDED_ROW_SHAPE.test(line) || !line.includes('| verify='))
      .map((line) => line.slice(0, 60));
    expect(malformed).toEqual([]);
    expect(landed.length).toBeGreaterThan(0);
  });

  it('names a reconciled commit for scripts/board.sh to check against origin/main', () => {
    const reconciled = lines.find((line) => line.startsWith('reconciled: '));
    expect(reconciled ?? '').toMatch(/^reconciled: [0-9a-f]{7,40} /);
  });

  it('is readable by the REAL badge script, so the deployed badge cannot fall to cannot-tell off this board', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'board-rule-')), 'build-status.json');
    execFileSync('node', [STATUS_SCRIPT, '--board', BOARD, '--out', out, '--head', 'HEAD'], {
      cwd: process.cwd(),
    });
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { state: string; detail: string };
    expect(`${payload.state}: ${payload.detail}`).not.toMatch(/^cannot-tell/);
  });
});
