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

/**
 * THE ONE LIBRARY-ADOPTION OPERATION (docs/17 row 257, AGENTS §Centralization
 * obligation 2) — family E of the owner's rule, the last reference family.
 *
 * A campaign's references to a GLOBAL LIBRARY artifact become references to a
 * CAMPAIGN-SCOPED COPY with a fresh id, CLONED images and a STORED origin id,
 * and the LIBRARY ROW SURVIVES (the library is shared; a move would strand
 * every other campaign pointing at the same entry). The shapes that drift
 * invisibly, and are therefore pinned here rather than in prose:
 *
 * 1. the copy is defined ONCE and is SHAPE-INDEPENDENT — a per-shape copy would
 *    be a second mechanism, which is exactly what the brief forbids;
 * 2. the repoint is a DECLARED set: the roster rewriter is the only place an
 *    `npc-ref` target is replaced, and the migration writes the same revision
 *    row the live writer writes (one revision contract, two transports);
 * 3. the adoption verb is NOT the scope MOVE verb — extending
 *    `adoptIntoCampaign`/`moveScope` would silently contradict the owner's
 *    "the library row survives" answer.
 *
 * These pins are FOLDED into this file deliberately: the scan walker above is a
 * BASELINED multi-site population (docs/17 row 212) and a new file carrying its
 * own copy of it reds the duplication tripwire, which is what happened on the
 * 255a and 255c drafts too.
 */
describe('one library-adoption operation (SOURCE SCAN, docs/17 row 257)', () => {
  it('DEFINES the copy once, shape-independent, and stamps the origin there alone', () => {
    expect(filesWith('export function adoptedArtifactRow(')).toEqual(['src/domain/libraryAdopt.ts']);
    // The ORIGIN STAMP is written in exactly one expression — a second writer
    // would be a second adoption identity.
    expect(filesWith('copiedFromArtifactId: source.id')).toEqual(['src/domain/libraryAdopt.ts']);
  });

  it('replaces an npc-ref target in ONE rewriter, paired with the ONE detector', () => {
    expect(filesWith('export function repointRosterArtifactIds(')).toEqual([
      'src/domain/rosterRefs.ts',
    ]);
    // The detector and its rewriter are callers of nothing else: the roster
    // shape is spelled in exactly ONE file.
    expect(filesWith('repointRosterArtifactIds(')).toEqual([
      'src/domain/libraryAdopt.ts',
      'src/domain/rosterRefs.ts',
    ]);
    expect(filesWith('export function rosterArtifactIds(')).toEqual(['src/domain/rosterRefs.ts']);
  });

  it('DEFINES the adoption seam once and routes the migration, the retry, the write path and the IMPORT path through it', () => {
    expect(filesWith('export async function adoptLibraryArtifacts(')).toEqual([
      'src/db/libraryAdopt.ts',
    ]);
    // The FOUR declared callers: the v26 upgrade body, the start-up retry, the
    // live write path (which adopts BEFORE a reference is born), and the IMPORT
    // path (docs/17 row 256 — a restored file's library references are adopted
    // after its transaction, so no restored campaign keeps a library pointer) —
    // no fifth copy of the operation anywhere.
    expect(filesWith('adoptLibraryArtifacts(')).toEqual([
      'src/db/db.ts',
      'src/db/libraryAdopt.ts',
      'src/db/libraryAdoptLive.ts',
      'src/db/libraryAdoptRetry.ts',
      'src/lib/exportImport.ts',
    ]);
    // The upgrade body and the retry are the ONLY callers of the copy half — no
    // per-site copy.
    expect(filesWith('adoptedArtifactRow(')).toEqual([
      'src/db/libraryAdopt.ts',
      'src/domain/libraryAdopt.ts',
    ]);
  });

  it('does NOT ride the scope MOVE verb: adoption is a copy, the library row survives', () => {
    // `adoptIntoCampaign`/`moveScope` keep their own callers and gain none from
    // the adoption seam — the owner's answer would be contradicted by a move.
    expect(CODE['src/db/libraryAdopt.ts']?.includes('adoptIntoCampaign(')).toBe(false);
    expect(CODE['src/db/libraryAdopt.ts']?.includes('moveScope(')).toBe(false);
    expect(CODE['src/db/libraryAdopt.ts']?.includes('reanchorImages(')).toBe(false);
  });

  /**
   * THE BATTLE HOLDER (docs/17 rows 259/268) — the LAST declared shape, and the
   * one whose write address is `db.battles` rather than an artifact revision. A
   * battle token's `artifactId`, its stage snapshot, the row's SEEDING ENCOUNTER
   * key and the re-seed stamp's copy of it are all references of the same kind;
   * the pin holds the facts that would drift invisibly: the shape is ON the
   * declared list, and the discovery and the rewrite live in the ONE seam rather
   * than at a call site.
   */
  it('declares the battle holder and rewrites its references through the ONE seam', () => {
    expect(CODE['src/domain/libraryAdopt.ts']).toContain(
      "LIBRARY_ADOPT_HOLDER_SHAPES = ['roster', 'links', 'battle']",
    );
    expect(filesWith('export function battleLibraryReferenceIds(')).toEqual([
      'src/domain/libraryAdopt.ts',
    ]);
    expect(filesWith('export function repointBattleRow<')).toEqual([
      'src/domain/libraryAdopt.ts',
    ]);
    // The collector, the rewriter and the dangling arm each have exactly ONE
    // caller — the tx-taking seam — so a fourth shape cannot grow a fourth path.
    expect(filesWith('battleLibraryReferenceIds')).toEqual([
      'src/db/libraryAdopt.ts',
      'src/domain/libraryAdopt.ts',
    ]);
    expect(filesWith('repointBattleRow')).toEqual([
      'src/db/libraryAdopt.ts',
      'src/domain/libraryAdopt.ts',
    ]);
    expect(filesWith('danglingBattleTokens')).toEqual([
      'src/db/libraryAdopt.ts',
      'src/domain/libraryAdopt.ts',
    ]);
    // THE SEEDING-ENCOUNTER KEY (docs/17 row 268, the REVERSAL of row 263's
    // deliberate exception): the battle's IDENTITY id is a stored library
    // reference like any other, so the ONE collector gathers it AND the re-seed
    // stamp's copy of it, the ONE rewriter re-keys both, and a key whose row is
    // in no table is NAMED through the ONE arm — all in the seam, never at a
    // call site.
    expect(filesWith('danglingBattleEncounter')).toEqual([
      'src/db/libraryAdopt.ts',
      'src/domain/libraryAdopt.ts',
    ]);
    expect(CODE['src/domain/libraryAdopt.ts']).toContain('ids.push(encounterArtifactId)');
    expect(CODE['src/domain/libraryAdopt.ts']).toContain(
      'encounterArtifactId !== null && encounterArtifactId !== undefined',
    );
    expect(CODE['src/domain/libraryAdopt.ts']).toContain('{ reseed: { ...reseed, encounterArtifactId: reseedReplacement } }');
    // THE SAME TRANSACTION: the seam reaches `battles` through the caller's tx,
    // so the copy and the battle repoint cannot land apart.
    expect(CODE['src/db/libraryAdopt.ts']).toContain("tx.table('battles')");
    for (const path of ['src/db/libraryAdoptRetry.ts', 'src/db/libraryAdoptLive.ts']) {
      expect(CODE[path]).toContain('db.battles');
    }
  });

  /**
   * THE IMAGE HALF (docs/17 row 270) — a SECOND ID SPACE of the SAME operation,
   * and the shapes that would drift invisibly: an image id is not an artifact
   * id, so a well-meaning per-site image copy (or a second image rewriter at
   * the seed) would look correct where it was written and leave the board's
   * `mapImageId` pointing at the library. The collector, the rewriter and the
   * gone arm live in the ONE seam, and `adoptedArtifactRow` remains the ONE
   * copy constructor whose `data` a caller may repoint.
   */
  it('collects, rewrites and NAMES the map image through the ONE seam', () => {
    // The two collectors and the map-image rewriter are DEFINED once…
    expect(filesWith('export function libraryImageIds(')).toEqual(['src/domain/libraryAdopt.ts']);
    expect(filesWith('export function battleMapImageIds(')).toEqual(['src/domain/libraryAdopt.ts']);
    expect(filesWith('export function danglingBattleMapImages(')).toEqual([
      'src/domain/libraryAdopt.ts',
    ]);
    // …and each has exactly ONE caller: the tx-taking seam.
    expect(filesWith('libraryImageIds')).toEqual([
      'src/db/libraryAdopt.ts',
      'src/domain/libraryAdopt.ts',
    ]);
    expect(filesWith('battleMapImageIds')).toEqual([
      'src/db/libraryAdopt.ts',
      'src/domain/libraryAdopt.ts',
    ]);
    expect(filesWith('danglingBattleMapImages')).toEqual([
      'src/db/libraryAdopt.ts',
      'src/domain/libraryAdopt.ts',
    ]);
    // The SAME `resolve` answers both id spaces: the battle rewriter's map arm
    // and the artifact rewriter's `data.mapImageId` arm take the copy map the
    // artifact half filled — never a second lookup of their own.
    expect(CODE['src/domain/libraryAdopt.ts']).toContain('const boardMap = repointMap(');
    expect(CODE['src/domain/libraryAdopt.ts']).toContain('const stageMap = repointMap(');
    expect(CODE['src/domain/libraryAdopt.ts']).toContain('data = { ...(data as object), mapImageId: replacement }');
    // The image clone is ONE expression, in the db half.
    expect(filesWith('bytes: new Uint8Array(image.bytes)')).toEqual(['src/db/libraryAdopt.ts']);
    // The spell half of the frozen seed takes the ONE spell seam: the seed never
    // reads the corpus index itself (that would be a second corpus read).
    expect(filesWith('copyStatBlockSpellsFromDb(')).toEqual([
      'src/db/battleSeed.ts',
      'src/db/libraryCopy.ts',
    ]);
    expect(filesWith('export function copyStatBlockSpellsFromDb(')).toEqual([
      'src/db/libraryCopy.ts',
    ]);
    expect(CODE['src/db/battleSeed.ts']?.includes('spellIndexLookup(')).toBe(false);
  });
});

/**
 * THE ONE BOARD SCRUB (docs/17 row 263, row 259's finding 2).
 *
 * Removing an artifact's tokens from a board was implemented TWICE — the domain
 * `scrubArtifactFromBoard` and an inline copy in `db/battleRepo` — and the two
 * had already DRIFTED: the copy scrubbed ONLY the live token list (so deleting
 * an OWNED artifact could leave the stage snapshot's token dangling, and
 * `resetBattleToStage` would put it back on the board) and it dropped the
 * domain seam's `activeIndex` fighter clamp. The fold is the fix: the delete
 * path delegates to the domain seam, and this pin holds the ONE implementation.
 */
describe('one board scrub (SOURCE SCAN, docs/17 row 263)', () => {
  it('DEFINES the artifact scrub once, and the delete path delegates to it', () => {
    expect(filesWith('export function scrubArtifactFromBoard(')).toEqual([
      'src/domain/battle/board.ts',
    ]);
    // The scrub's own filter expression exists in the domain seam alone — a
    // re-implemented inline scrub reds here naming the second site.
    expect(filesWith('token.artifactId !== artifactId')).toEqual(['src/domain/battle/board.ts']);
    // The db delete path reaches it and owns no token surgery of its own.
    expect(CODE['src/db/battleRepo.ts']).toContain('scrubArtifactFromBoard(battle.board, artifactId)');
    expect(CODE['src/db/battleRepo.ts']).not.toContain('removedIds');
    expect(CODE['src/db/battleRepo.ts']).not.toContain('initiativeOrder.filter(');
  });
});
