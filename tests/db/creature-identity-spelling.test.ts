import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The roster-side creature identity has no THIRD spelling (docs/17 row 145).
 *
 * `db/creatureImages.rosterCreatureKey` was a superseded spelling of "which
 * creature is this roster entry?" with ZERO callers anywhere in `src/`,
 * `tests/` or `docs/` (grepped, not assumed). It was kept dangerous by a doc
 * comment claiming it was the ONE spelling, and its `'none'` arm took a
 * `statBlock` parameter — so a caller that reached it could mint a key that
 * DISAGREES with the live spelling's `null` arm, i.e. a second identity for one
 * creature, which is the presentation-row key. Nothing called it, so no fixture
 * and no live behaviour can change by its deletion; what a test CAN state is
 * that it is GONE and that the live spelling it duplicated is still intact,
 * which is what this file does.
 *
 * What this file CANNOT prove: that a future author will not write a fourth
 * spelling. It is a source-level guard over a name and a shape, not a proof.
 */
const SRC = 'src';
const TESTS = 'tests';

function filesUnder(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), dir)).sort()) {
    const path = `${dir}/${entry}`;
    if (statSync(join(process.cwd(), path)).isDirectory()) out.push(...filesUnder(path, root));
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

const read = (file: string): string => readFileSync(join(process.cwd(), file), 'utf8');

describe('the deleted roster spelling is absent', () => {
  it('`rosterCreatureKey` is declared nowhere in `src/` and called nowhere in `tests/`', () => {
    const srcFiles = filesUnder(SRC);
    const testFiles = filesUnder(TESTS);
    // Non-vacuity: both walks must see their whole tree.
    expect(srcFiles.length).toBeGreaterThan(200);
    expect(testFiles.length).toBeGreaterThan(200);

    const offenders = [...srcFiles, ...testFiles]
      // THIS file names the deleted identifier on purpose — the one declared
      // exclusion, so the scan cannot be satisfied by its own subject.
      .filter((file) => file !== 'tests/db/creature-identity-spelling.test.ts')
      .filter((file) => read(file).includes('rosterCreatureKey'));
    expect(offenders).toEqual([]);
  });

  it('its two identity helpers are still imported only where they are USED', () => {
    // The deletion trimmed `db/creatureImages` back to the presentation-row
    // table: it no longer names `contentCreatureKey`/`libraryCreatureKey` at all
    // (an unused import is a lint error, so this pin also holds that boundary).
    const images = read('src/db/creatureImages.ts');
    expect(images).not.toContain('contentCreatureKey');
    expect(images).not.toContain('libraryCreatureKey');
    expect(images).not.toContain('MonsterEntry');
    expect(images).not.toContain('StatBlock');
    // …and what it DOES still own is intact: the table and its two row ops.
    expect(images).toContain('export async function getCreatureImageRow(');
    expect(images).toContain('export async function listCreatureImageRows(');
    expect(images).toContain('export async function insertCreatureImageRow(');
  });

  it('the LIVE roster-side spelling is intact, with its three arms', () => {
    const seed = read('src/db/battleSeed.ts');
    expect(seed).toContain('function creatureKeyForEntry(entry: MonsterEntry): string | null {');
    expect(seed).toContain("if (entry.source.type === 'rulebook') return libraryCreatureKey(entry.source.chunkId);");
    expect(seed).toContain(
      "if (entry.source.type === 'inline') return contentCreatureKey(entry.name, entry.source.statBlock);",
    );
    // The arm the deleted copy disagreed on: `null`, never a caller-supplied
    // stat block.
    expect(seed).toContain("if (entry.source.type === 'none') return contentCreatureKey(entry.name, null);");
  });
});
