import { expect, it } from 'vitest';

import { CODE, filesWith, rawSourceText } from '../helpers/sourceCode';

/**
 * THE BOARD'S NODE KEYS ARE LEVELS and the row's spelling is FROZEN behind ONE
 * boundary (docs/23 §2.1, docs/17 row 388, AGENTS §Centralization obligation 2).
 *
 * The module board was the last surface that ADDRESSED its cards by `planIndex`
 * (`part-<planIndex>` node keys, planIndex-keyed slices, a planIndex-keyed
 * rewrite target and staging record). It now addresses LEVELS — level N as N,
 * the premise at 0 — and the module row's `canvas` field keeps the pre-document
 * spelling it already holds, translated at ONE read/write boundary. Four
 * claims, each of which a behaviour test cannot hold:
 *
 * 1. the OLD vocabulary is DELETED, not renamed: `canvasPartNodeKey` and
 *    `planIndexFromCanvasNodeKey` are gone from both trees. A re-export, a
 *    "compatibility" helper or a stale comment reintroducing either one is how
 *    a second key grammar is born, and it would keep compiling.
 * 2. the level↔planIndex CONVERSION has exactly ONE definition
 *    (`planIndexForLevel` / `levelForPlanIndex`, `domain/moduleDocument`). The
 *    storage boundary below it reuses that pair and does no arithmetic of its
 *    own — a third `±1` would be invisible until the two disagreed.
 * 3. the board's key grammar and the stored (frozen) spelling are each defined
 *    ONCE, in the same module that owns the conversion.
 * 4. the BOARD files never spell a stored key and never translate it themselves:
 *    the stored pair is called from the two boundary sites only — the READ half
 *    in `boardLayout.resolveBoardNodePositions`, the WRITE half in
 *    `BoardPage.persistLayout`. That is the whole reason an existing board's
 *    bytes round-trip unchanged.
 *
 * NOT PINNED HERE, and named so the next reader does not mistake it for a
 * second canvas grammar: `boardEdges` parses the TREE-WIDE MENTION convention
 * (`'premise'` / `part-<planIndex>`, `domain/wikiGraph`, docs/18 §5) to find the
 * card a continuity edge ends on. That convention is written and parsed at eight
 * further sites (the entity panel's proposals, provenance, the orphan sweep, the
 * module grounding, the PDF planner) and folding it is its own slice — docs/18 §5
 * records it with the seam question answered.
 */

const MODULE_DOCUMENT = 'src/domain/moduleDocument.ts';
const BOARD_DIR = 'src/features/modules/board/';
const BOARD_LAYOUT = 'src/features/modules/board/boardLayout.ts';
const BOARD_PAGE = 'src/features/modules/board/BoardPage.tsx';
const BOARD_NODES = 'src/features/modules/board/boardNodes.tsx';
const BOARD_EDGES = 'src/features/modules/board/boardEdges.ts';
/** This file, as the both-tree raw scan reports paths. */
const SELF = 'tests/architecture/one-board-level-key.test.ts';

it('deletes the planIndex-keyed canvas node-key vocabulary, in both trees', async () => {
  const raw = await rawSourceText();
  // Non-vacuity: the walk saw both trees.
  expect(Object.keys(raw).length).toBeGreaterThan(400);
  for (const needle of ['canvasPartNodeKey', 'planIndexFromCanvasNodeKey']) {
    const carriers = Object.entries(raw)
      .filter(([, text]) => text.includes(needle))
      .map(([path]) => path)
      .sort();
    // The pin is the ONLY carrier, which proves the needle is greppable in this
    // very tree and reds by file the moment a second carrier appears.
    expect(carriers, needle).toEqual([SELF]);
  }
});

it('defines the level↔planIndex conversion exactly once, and no arithmetic beside it', () => {
  expect(filesWith('export function planIndexForLevel(')).toEqual([MODULE_DOCUMENT]);
  expect(filesWith('export function levelForPlanIndex(')).toEqual([MODULE_DOCUMENT]);
});

it('defines the board grammar and the frozen stored spelling once, with the conversion', () => {
  for (const definition of [
    'export function boardLevelNodeKey(',
    'export function levelFromBoardNodeKey(',
    'export function storedCanvasNodeKeyForLevel(',
    'export function levelForStoredCanvasNodeKey(',
  ]) {
    expect(filesWith(definition), definition).toEqual([MODULE_DOCUMENT]);
  }
  // Level 0 is the premise, and its board key is DERIVED from the level — never
  // a second literal that could drift from the grammar.
  expect(CODE[MODULE_DOCUMENT]).toContain(
    'export const BOARD_PREMISE_NODE_KEY = boardLevelNodeKey(MODULE_PREMISE_LEVEL)',
  );
});

it('translates the stored spelling at the TWO boundary sites, and nowhere else in the board', () => {
  // READ half + WRITE half. A third caller (a card, the store, the staging
  // record) would mean a key grammar leaking out of the boundary.
  expect(filesWith('levelForStoredCanvasNodeKey(')).toEqual([MODULE_DOCUMENT, BOARD_LAYOUT]);
  expect(filesWith('storedCanvasNodeKeyForLevel(')).toEqual([MODULE_DOCUMENT, BOARD_PAGE]);
  // The board addresses levels through the ONE grammar, from the pages and
  // components that build or read a node key.
  expect(filesWith('boardLevelNodeKey(')).toEqual([
    MODULE_DOCUMENT,
    BOARD_PAGE,
    BOARD_EDGES,
    BOARD_LAYOUT,
  ]);
  expect(filesWith('levelFromBoardNodeKey(')).toEqual([MODULE_DOCUMENT, BOARD_PAGE, BOARD_NODES]);
  // …and the board's own content/staging files name no node key at all: they
  // carry the LEVEL NUMBER, which is the address the board actually speaks.
  const boardFiles = Object.keys(CODE).filter((path) => path.startsWith(BOARD_DIR));
  expect(boardFiles.length).toBeGreaterThan(5);
  for (const needle of ['boardLevelNodeKey(', 'storedCanvasNodeKeyForLevel(']) {
    expect(
      boardFiles.filter((path) => CODE[path]?.includes(needle) === true).sort(),
      needle,
    ).toEqual(
      needle === 'boardLevelNodeKey(' ? [BOARD_PAGE, BOARD_EDGES, BOARD_LAYOUT] : [BOARD_PAGE],
    );
  }
});
