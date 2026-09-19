import { describe, expect, it } from 'vitest';

/**
 * THE ONE COPY OPERATION (docs/17 row 255a, AGENTS §Centralization obligation 2).
 *
 * The owner's rule is *"Core items should always ever only be copied"*, and the
 * discovery that shaped this slice is that the app keeps MINTING pointers at live
 * write sites — so the copy is born at WRITE time and the Dexie migration is its
 * BACKFILL half. Two mechanisms for one copy would drift silently (each is
 * correct where it was written), which is exactly the fragmentation the
 * centralization rule forbids. This pin holds the facts that drift invisibly:
 *
 * 1. the copy's ORIGIN TOKEN (`chunk:<id>`, the portrait identity) is minted by
 *    the identity layer and the copy seam alone — never re-composed at a write
 *    site;
 * 2. the pure copy operation is DEFINED once, and the write paths reach it
 *    through the live wrapper rather than re-implementing a resolution;
 * 3. a write path takes the stamped line from the copy — it composes no origin
 *    label of its own (`creatureOriginLabel` is a READ-path formatter now).
 *
 * The source list comes from Vite's own `import.meta.glob` with `?raw` — the
 * hand-rolled source walker (`codeOf`) is a BASELINED multi-site population in
 * this suite (docs/17 row 212), and adding a second copy of it would be the very
 * defect this file exists to pin.
 */

const RAW: Record<string, string> = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Comment-stripped, whitespace-collapsed source per repo-relative path. */
const CODE: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([path, text]) => [
    path.replace(/^\//, ''),
    text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/\s+/g, ' '),
  ]),
);

/** The `src/` files whose CODE contains the needle. */
function filesWith(needle: string): string[] {
  return Object.keys(CODE)
    .filter((path) => CODE[path]?.includes(needle) === true)
    .sort();
}

describe('one library-copy operation (SOURCE SCAN, docs/17 row 255a)', () => {
  it('mints the origin token in the identity layer and the copy seam alone', () => {
    // Non-vacuity: the glob sees the whole source tree.
    expect(Object.keys(CODE).length).toBeGreaterThan(300);
    expect(filesWith('libraryCreatureKey(')).toEqual([
      'src/db/creatureRepo.ts',
      'src/domain/creature.ts',
      'src/domain/libraryCopy.ts',
    ]);
  });

  it('DEFINES the copy operation once and routes every write path through it', () => {
    const definitions = filesWith('export async function copyCreatureStats(');
    expect(definitions).toEqual(['src/domain/libraryCopy.ts']);
    // The live wrapper is the one DB-bound door, and it delegates rather than
    // resolving for itself.
    expect(filesWith('creatureOriginLabel(')).toContain('src/domain/libraryCopy.ts');
    // The declared callers: the migration's backfill (twice — roster + NPC), the
    // CAST path (`db/creatureRepo.castCreatureAsNpc`, which owns
    // `creatureLookups` and therefore calls the PURE seam directly — importing
    // the live wrapper from the module the wrapper imports would be a cycle),
    // and the three ROSTER write paths, each through the live wrapper.
    expect(filesWith('copyCreatureStats(')).toEqual([
      'src/db/creatureRepo.ts',
      'src/db/libraryCopy.ts',
      'src/db/mobCopyRepair.ts',
      'src/domain/libraryCopy.ts',
    ]);
    expect(filesWith('copyCreatureStatsFromDb(')).toEqual([
      'src/db/libraryCopy.ts',
      'src/features/campaign/components/monster-source.tsx',
      'src/features/play/battle/spawn-picker-logic.ts',
      'src/llm/runEngine.ts',
    ]);
  });

  it('composes no origin label at a write path — the stamped line comes from the copy', () => {
    const writePaths = [
      'src/features/campaign/components/monster-source.tsx',
      'src/features/play/battle/spawn-picker-logic.ts',
      'src/llm/runEngine.ts',
    ];
    const offenders = writePaths.filter(
      (path) =>
        CODE[path]?.includes('creatureOriginLabel(') === true ||
        CODE[path]?.includes('contentIdentityFor(') === true,
    );
    expect(offenders).toEqual([]);
  });

  /**
   * THE SPELL HALF (docs/17 row 255c). A copied mob's spells travel with the
   * copy because this SAME operation stamps them — the last content family of
   * the owner's rule, and the one a second seam would fragment silently: a copy
   * and a re-resolution of the same assignment produce the same chip bytes BY
   * CONSTRUCTION, so only a source scan can see a second spell-copy path.
   *
   * These pins live HERE rather than in a file of their own deliberately: the
   * scan walker above is a BASELINED multi-site population (docs/17 row 212),
   * and a second copy of it reds the tripewire — which it did on this slice's
   * first draft, and this is the fold (AGENTS §Centralization obligation 4,
   * applied to the test tree).
   */
  it('stamps a library entry onto an assignment in the copy seam alone', () => {
    // `spellData` is a FIELD on a corpus row, a spell card and the resolver's
    // index; only ONE expression puts one onto a stat block's ASSIGNMENT.
    expect(filesWith('spellData: entry.spellData')).toEqual(['src/domain/libraryCopy.ts']);
  });

  it('reads a copied entry through the ONE accessor, never the raw key', () => {
    expect(filesWith('copiedSpellEntry(')).toEqual([
      'src/domain/libraryCopy.ts',
      'src/domain/mobSpells.ts',
      'src/domain/statblock.ts',
    ]);
    // …and the raw copy-only key is read in that ONE accessor.
    expect(filesWith('spellData ?? null')).toEqual(['src/domain/statblock.ts']);
  });

  it('reads the spell corpus through the ONE seam and builds its index in ONE place', () => {
    // The copy's live arm builds its lookup from `db/spellRepo`, the module
    // that owns the corpus read and the index builder — the file list is the
    // assertion, so a copy that queried chunks itself would red here.
    expect(filesWith('spellIndexLookup(')).toEqual([
      'src/db/creatureRepo.ts',
      'src/db/libraryCopy.ts',
      'src/db/spellRepo.ts',
    ]);
    // The migration's transaction-backed spell arm reuses the ONE corpus
    // projection instead of reading stored spell rows its own way.
    expect(filesWith('spellCorpusEntries(')).toEqual([
      'src/db/mobCopyRepair.ts',
      'src/db/spellRepo.ts',
      'src/domain/spellData.ts',
      'src/features/rules/hooks.ts',
      'src/features/spells/mob-spell-chips.tsx',
      'src/ingest/packImport.ts',
      'src/llm/runEngine.ts',
    ]);
  });
});
