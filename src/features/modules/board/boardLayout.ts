import {
  CANVAS_PREMISE_NODE_KEY,
  canvasPartNodeKey,
  canvasPriorModuleNodeKey,
  type ModuleCanvasNode,
} from '@/domain';

/**
 * Whole-module board layout (08-MODULE-DESIGNER §Module board): the
 * deterministic seed positions for cards the user has not moved yet — the
 * same discipline as `lib/graphLayout` (fixed margins, even spacing, no
 * force simulation), read as a document instead of kind rows: prior modules
 * (oldest first) in a left column, the CURRENT module's premise + parts in a
 * reading spine to its right. Pure — the persisted `module.canvas` positions
 * win over these seeds at every read.
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
  /** Number of part nodes (`spine.partPlan.length`); 0 = premise only. */
  planCount: number;
  /** Prior module ids, oldest first (the caller owns the ASC order). */
  priorModuleIds: readonly string[];
}

/**
 * Seeds one position per node key. Current module: premise first, then
 * `part-<planIndex>` in plan order down the right column. Prior modules:
 * one text-group node each, oldest first, down the left column.
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
  positions[CANVAS_PREMISE_NODE_KEY] = { x: spineX, y: BOARD_MARGIN };
  for (let planIndex = 0; planIndex < input.planCount; planIndex += 1) {
    positions[canvasPartNodeKey(planIndex)] = {
      x: spineX,
      y: BOARD_MARGIN + (planIndex + 1) * BOARD_ROW_HEIGHT,
    };
  }
  return positions;
}

/**
 * Merges the persisted board nodes over the seed layout: a persisted
 * position wins by node key, seeds fill every node the row does not know
 * (fresh plan entries, newly added prior modules). The caller only reads
 * positions for node keys that exist in the CURRENT module set, so a stale
 * persisted key (a removed plan entry) is inert. Pure.
 */
export function resolveBoardNodePositions(
  persisted: readonly ModuleCanvasNode[] | null,
  seeds: Record<string, { x: number; y: number }>,
): Record<string, { x: number; y: number }> {
  const resolved = { ...seeds };
  if (persisted !== null) {
    for (const node of persisted) {
      resolved[node.key] = { x: node.x, y: node.y };
    }
  }
  return resolved;
}
