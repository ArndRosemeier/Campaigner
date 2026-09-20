import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The roster-side creature identity has ONE spelling (docs/17 rows 145 and
 * 165).
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
 * Row 165 then deleted the LIVE spelling's three arms: the key that a battle
 * token carries, the key the portrait batch writes under, the global cache key
 * and the module gap detector's reading were one fact with four spellings, and
 * two of them disagreed (a citation the library healed by content hash, and a
 * `creatureRef` with no chunk uuid). The live spelling is now
 * `domain/creature.rosterEntryCreatureIdentity`, called by the seeder and by
 * `features/campaign/mob-portrait-participants` alike, and the pins below hold
 * that NO key is born anywhere else in those two files.
 *
 * What this file CANNOT prove: that a future author will not write a fourth
 * spelling. It is a source-level guard over names and shapes, not a proof —
 * `tests/db/creature-identity-one-rule.test.ts` runs the arms against the same
 * inputs as the behavioural half, and
 * `tests/features/creature-portrait-agreement.test.tsx` pins what the surfaces
 * then RENDER.
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

  it('the LIVE roster-side spelling is ONE seam, and no key is born outside it', () => {
    // AMENDED (docs/17 row 165): this test used to pin `db/battleSeed`'s
    // `creatureKeyForEntry` and its THREE arms verbatim — the statless arm
    // switching on `source.type`, the resolved listing for a statful citation
    // and the invented identity. That is exactly what a source pin is for, and
    // it did its job: it made the three-arm shape impossible to change without
    // noticing. The three arms ARE the defect (one identity, three rules — a
    // healed citation and a chunk-less `creatureRef` got two different keys for
    // one creature), so the pin now states the ONE rule and the absence of any
    // second one.
    const seed = read('src/db/battleSeed.ts');
    // No key construction in the seeder at all: it asks the identity layer.
    expect(seed).not.toContain('creatureKeyForEntry');
    expect(seed).not.toContain('libraryCreatureKey(');
    expect(seed).not.toContain('contentCreatureKey(');
    expect(seed).not.toContain('inventedCreatureIdentity(');
    expect(seed).toContain('rosterEntryCreatureIdentity');
    // The router that keys the portrait batch and the module gap detector is
    // the same call, so a token's key and the presentation row's key cannot be
    // born apart.
    const participants = read('src/features/campaign/mob-portrait-participants.ts');
    expect(participants).not.toContain('libraryCreatureKey(');
    expect(participants).not.toContain('contentCreatureKey(');
    expect(participants).toContain('rosterEntryCreatureIdentity');
    // …and the ONE rule itself lives in the identity layer, on the roster
    // shapes it must cover.
    const creature = read('src/domain/creature.ts');
    expect(creature).toContain('export function rosterEntryCreatureIdentity(');
    // AMENDED (docs/17 row 278): the `rulebook` arm this needle named was
    // DELETED with the clean cut; the surviving arms are the copy's opaque
    // origin token (checked FIRST) and the `npc-ref` link.
    expect(creature).toContain('const token = entry.originToken?.trim()');
    expect(creature).toContain("if (source.type === 'npc-ref')");
    expect(creature).not.toContain("source.type === 'rulebook'");
  });

  it('the presentation-row table lost its dead reader with the same commit', () => {
    // `documentCoverImageId` was the blob reader of a presentation row; the ONE
    // portrait reading returns the row's `imageId` through the shared
    // resolution instead, which left it with NO caller anywhere.
    const images = read('src/db/creatureImages.ts');
    expect(images).not.toContain('documentCoverImageId');
  });
});
