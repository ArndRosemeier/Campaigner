import {
  CANVAS_PREMISE_NODE_KEY,
  canvasPartNodeKey,
  canvasPriorModuleNodeKey,
  type ModuleCanvasNode,
} from '@/domain';

/**
 * Whole-module canvas layout (08-MODULE-DESIGNER §Module canvas): the
 * deterministic seed positions for cards the user has not moved yet — the
 * same discipline as `lib/graphLayout` (fixed margins, even spacing, no
 * force simulation), read as a document instead of kind rows: prior modules
 * (oldest first) in a left column, the CURRENT module's premise + parts in a
 * reading spine to its right. Pure — the persisted `module.canvas` positions
 * win over these seeds at every read.
 */

/** Card width — fixed so positions stay deterministic without measuring. */
export const CANVAS_NODE_WIDTH = 420;

/** Vertical rhythm: card top-to-card top (cards cap their own height). */
export const CANVAS_ROW_HEIGHT = 560;

/** Canvas margin, mirroring graphLayout's MARGIN convention. */
export const CANVAS_MARGIN = 80;

/** Horizontal distance between the prior column and the current spine. */
export const CANVAS_COLUMN_GAP = 520;

export interface CanvasSeedInput {
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
export function seedCanvasNodePositions(
  input: CanvasSeedInput,
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  input.priorModuleIds.forEach((id, index) => {
    positions[canvasPriorModuleNodeKey(id)] = {
      x: CANVAS_MARGIN,
      y: CANVAS_MARGIN + index * CANVAS_ROW_HEIGHT,
    };
  });
  const spineX = CANVAS_MARGIN + CANVAS_COLUMN_GAP;
  positions[CANVAS_PREMISE_NODE_KEY] = { x: spineX, y: CANVAS_MARGIN };
  for (let planIndex = 0; planIndex < input.planCount; planIndex += 1) {
    positions[canvasPartNodeKey(planIndex)] = {
      x: spineX,
      y: CANVAS_MARGIN + (planIndex + 1) * CANVAS_ROW_HEIGHT,
    };
  }
  return positions;
}

/**
 * Merges the persisted canvas nodes over the seed layout: a persisted
 * position wins by node key, seeds fill every node the row does not know
 * (fresh plan entries, newly added prior modules). The caller only reads
 * positions for node keys that exist in the CURRENT module set, so a stale
 * persisted key (a removed plan entry) is inert. Pure.
 */
export function resolveCanvasNodePositions(
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
