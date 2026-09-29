import {
  BOARD_PREMISE_NODE_KEY,
  boardLevelNodeKey,
  canvasPriorModuleNodeKey,
  levelForStoredCanvasNodeKey,
  type ModuleCanvasNode,
} from '@/domain';

/**
 * Whole-module board layout (08-MODULE-DESIGNER §Module board): the
 * deterministic seed positions for cards the user has not moved yet — the
 * same discipline as `lib/graphLayout` (fixed margins, even spacing, no
 * force simulation), read as a document instead of kind rows: prior modules
 * (oldest first) in a left column, the CURRENT module's premise (level 0) +
 * its level sections in a reading spine to its right. Pure — the persisted
 * `module.canvas` positions win over these seeds at every read.
 *
 * THE BOARD SPEAKS LEVELS (docs/23 §2.1, docs/17 row 388): a position is keyed
 * by `boardLevelNodeKey(level)` (`level-0` is the premise), and this file is
 * the READ half of the storage boundary — `resolveBoardNodePositions` maps the
 * row's FROZEN stored spelling (`'premise'` / `part-<planIndex>`) onto those
 * level keys through the ONE `levelForStoredCanvasNodeKey`, so an existing
 * arranged board reads exactly as it was left.
 */

/** Card width — fixed so positions stay deterministic without measuring. */
export const BOARD_NODE_WIDTH = 420;

/** Vertical rhythm: card top-to-card top (cards cap their own height). */
export const BOARD_ROW_HEIGHT = 560;

/** Board margin, mirroring graphLayout's MARGIN convention. */
export const BOARD_MARGIN = 80;

/** Horizontal distance between the prior column and the current spine. */
export const BOARD_COLUMN_GAP = 520;

export interface BoardSeedInput {
  /** Number of LEVEL SECTIONS (`spine.partPlan.length`); 0 = premise only. */
  levelCount: number;
  /** Prior module ids, oldest first (the caller owns the ASC order). */
  priorModuleIds: readonly string[];
}

/**
 * Seeds one position per node key. Current module: the premise (level 0) first,
 * then `level-<N>` in reading order down the right column. Prior modules: one
 * text-group node each, oldest first, down the left column.
 */
export function seedBoardNodePositions(
  input: BoardSeedInput,
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  input.priorModuleIds.forEach((id, index) => {
    positions[canvasPriorModuleNodeKey(id)] = {
      x: BOARD_MARGIN,
      y: BOARD_MARGIN + index * BOARD_ROW_HEIGHT,
    };
  });
  const spineX = BOARD_MARGIN + BOARD_COLUMN_GAP;
  positions[BOARD_PREMISE_NODE_KEY] = { x: spineX, y: BOARD_MARGIN };
  for (let level = 1; level <= input.levelCount; level += 1) {
    positions[boardLevelNodeKey(level)] = {
      x: spineX,
      y: BOARD_MARGIN + level * BOARD_ROW_HEIGHT,
    };
  }
  return positions;
}

/**
 * Merges the persisted board nodes over the seed layout: a persisted position
 * wins by node key, seeds fill every node the row does not know (fresh level
 * sections, newly added prior modules). The persisted keys are the row's FROZEN
 * spelling and are translated to the board's level keys HERE — this is the read
 * half of the ONE boundary (`domain/moduleDocument.storedCanvasNodeKeyForLevel` is the
 * write half). A key that is neither a stored level spelling nor a prior group
 * (`prior-<moduleId>`, identical on both sides) passes through unchanged; the
 * caller only reads positions for node keys that exist in the CURRENT module
 * set, so a stale persisted key is inert. Pure.
 */
export function resolveBoardNodePositions(
  persisted: readonly ModuleCanvasNode[] | null,
  seeds: Record<string, { x: number; y: number }>,
): Record<string, { x: number; y: number }> {
  const resolved = { ...seeds };
  if (persisted !== null) {
    for (const node of persisted) {
      const level = levelForStoredCanvasNodeKey(node.key);
      resolved[level === null ? node.key : boardLevelNodeKey(level)] = { x: node.x, y: node.y };
    }
  }
  return resolved;
}
