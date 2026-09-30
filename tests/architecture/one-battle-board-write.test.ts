import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE BOARD HAS ONE WRITER (docs/17 row 336; owner, verbatim: *"when spawning
 * an authored mob it appears in the scene, but is gone at the next redraw"*).
 *
 * The lost update came from a SECOND, structurally different board write: the
 * surface handed `saveBattleBoard` a board derived from its RENDER SNAPSHOT and
 * the repo replaced the row's board wholesale, so a spawn that landed between
 * the render and the commit was erased. Removing that one call site is not
 * enough as prose — a fourth caller would be born silently, which is exactly
 * how the defect existed at all — so the population is pinned here as DATA.
 *
 * The pins are the call-site populations of the seam (a source scan, because a
 * re-added snapshot write compiles and behaves "fine" until two writers race),
 * plus the ABSENCE of the deleted replace-by-board API anywhere in the tree.
 *
 * The source list comes from Vite's own `import.meta.glob`, deliberately: the
 * hand-rolled `sourceFiles` walker is a BASELINED multi-site population in this
 * suite (docs/17 row 212), and adding a copy of it would be the very defect
 * this file exists to pin.
 */

const ROOT = process.cwd();
const SRC_FILES: readonly string[] = Object.keys(import.meta.glob('/src/**/*.{ts,tsx}'))
  .map((path) => path.replace(/^\//, ''))
  .sort();
const TEST_FILES: readonly string[] = Object.keys(import.meta.glob('/tests/**/*.{ts,tsx}'))
  .map((path) => path.replace(/^\//, ''))
  .sort();

/** Every file in `files` whose text contains `needle`, repo-relative, sorted. */
function filesContaining(files: readonly string[], needle: string): string[] {
  return files.filter((file) => readFileSync(join(ROOT, file), 'utf8').includes(needle));
}

describe('one battle-board writer (SOURCE SCAN, docs/17 row 336)', () => {
  it('has no snapshot-replace board API left anywhere in src or tests', () => {
    // `saveBattleBoard(id, board)` WAS the mechanism: it replaced the row's
    // board with whatever board the caller last rendered. A re-added call site
    // reds here by file name.
    expect(filesContaining(SRC_FILES, 'saveBattleBoard')).toEqual([]);
    expect(filesContaining(TEST_FILES, 'saveBattleBoard')).toEqual([]);
  });

  it('routes every board mutation through the ONE seam, from exactly the surface that owns the table', () => {
    // The seam's DEFINITION plus its one UI caller: the battle surface's commit.
    expect(filesContaining(SRC_FILES, 'mutateBattleBoard(')).toEqual([
      'src/db/battleRepo.ts',
      'src/features/play/battle/BattleSurface.tsx',
    ]);
    // The combined board + sibling-field writes (a spawn's seed rows, a
    // destructive re-seed) go through the row-level callback, which also
    // receives the CURRENT row. Any new file here is a new writer.
    expect(filesContaining(SRC_FILES, 'updateBattle(')).toEqual([
      'src/db/battleRepo.ts',
      'src/db/battleSeed.ts',
      // The statless-mob repair writes the healed seed rows and the tokens'
      // HP through the SAME row-level façade, never around it (docs/17 row
      // 349) — a fourth caller, declared rather than discovered by a red pin.
      'src/db/mobStatRepair.ts',
      'src/features/play/battle/spawn-picker-logic.ts',
    ]);
    // Every battle ROW write funnels through `saveBattle` /
    // `normalizeBattleOnOpen` in the repo — no surface and no other module puts
    // a battle row directly (that path is what skipped parse-normalization and
    // replaced a board wholesale). ONE declared exception, named rather than
    // silently allowed: `db/libraryAdopt` re-keys token/encounter IDS for a
    // library adoption INSIDE the caller's own transaction (its rows are read
    // from that transaction, so it is a reference remap, never a
    // render-snapshot board write — docs/17 row 336). Any OTHER file here reds.
    expect(filesContaining(SRC_FILES, 'db.battles.put(')).toEqual(['src/db/battleRepo.ts']);
    expect(filesContaining(SRC_FILES, 'battles.put(')).toEqual([
      'src/db/battleRepo.ts',
      'src/db/libraryAdopt.ts',
    ]);
  });

  it('keeps battle-row DELETION in the seam too — the empty-battle rule is decided in-transaction', () => {
    // `writeBattleRow` is the ONE transaction that both saves and deletes a
    // battle row (docs/17 row 336 fix-forward): the scrub's empty rule must be
    // decided on the board the scrub PRODUCED, in the same transaction, so no
    // other file may delete a battle row and no second decision site may
    // appear beside it.
    expect(filesContaining(SRC_FILES, 'writeBattleRow(')).toEqual(['src/db/battleRepo.ts']);
    expect(filesContaining(SRC_FILES, 'DELETE_BATTLE')).toEqual(['src/db/battleRepo.ts']);
    expect(filesContaining(SRC_FILES, 'battles.delete(')).toEqual(['src/db/battleRepo.ts']);
    // The scrub asks the seam to delete the emptied battle (a `null` board
    // outcome) instead of reading the row back — a second read judges the
    // NORMALIZED row, whose re-ensured PC token keeps the board alive.
    const repo = readFileSync('src/db/battleRepo.ts', 'utf8');
    expect(repo).toContain('isBattleEmpty({ ...current, board: next }) ? null : next');
    expect(repo).not.toContain('await deleteBattleIfEmpty(battle.id)');
  });

  it('keeps the surface off the raw row patcher — its board writes go through `commit`', () => {
    // `patchBattle` can no longer carry a board (the TYPE forbids it, pinned by
    // the `@ts-expect-error` arm in tests/db/battleRepo.test.ts); the surface
    // must not call the raw row patcher for board work at all.
    const surface = readFileSync('src/features/play/battle/BattleSurface.tsx', 'utf8');
    expect(surface).toContain('mutateBattleBoard(battle.id, mutate)');
    expect(surface).not.toContain('patchBattle(');
  });
});
