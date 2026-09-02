/**
 * Grid snapping (09-MILESTONE-5 M5-B, ported verbatim from GM Cockpit's
 * `host/gridSnap.ts`): board coordinates are normalized (1 = map
 * width/height); snapping quantizes a token's center to the middle of a
 * `spanCells`-wide grid block.
 */

/** Cell span a token occupies on the grid. Half-size tokens still use one cell. */
export function tokenSpanCells(scale: number): number {
  if (scale < 1) {
    return 1;
  }
  return Math.round(scale);
}

/** CSS grid tracks: generated layouts are normalized, uploaded maps retain px tracks. */
export function battleGridStyle(
  mapLayout: { cols: number; rows: number } | null,
  gridSize: number | null,
): { backgroundImage?: string; backgroundSize?: string } {
  if (mapLayout !== null) {
    return {
      backgroundImage:
        'linear-gradient(to right, rgba(255,255,255,0.14) 1px, transparent 1px), ' +
        'linear-gradient(to bottom, rgba(255,255,255,0.14) 1px, transparent 1px)',
      backgroundSize: `${String(100 / mapLayout.cols)}% ${String(100 / mapLayout.rows)}%`,
    };
  }
  if (gridSize === null) return {};
  return {
    backgroundImage:
      'repeating-linear-gradient(0deg, rgba(255,255,255,0.14) 0 1px, transparent 1px ' +
      String(gridSize) +
      'px), repeating-linear-gradient(90deg, rgba(255,255,255,0.14) 0 1px, transparent 1px ' +
      String(gridSize) +
      'px)',
  };
}

/** Layout-backed snapping is viewport-independent: only normalized cell count matters. */
export function snapAxisToLayoutGrid(
  norm: number,
  cellCount: number,
  spanCells: number,
): number {
  if (!Number.isInteger(cellCount) || cellCount <= 0) {
    throw new Error(`Layout cell count must be a positive integer, got ${String(cellCount)}`);
  }
  if (!Number.isInteger(spanCells) || spanCells <= 0) {
    throw new Error(`Token span must be a positive whole number of cells, got ${String(spanCells)}`);
  }
  const half = spanCells / 2;
  const origin = Math.round(norm * cellCount - half);
  return (origin + half) / cellCount;
}

/**
 * Snap a board coordinate (1 = map width/height; may be outside 0–1) to the
 * center of a grid block `spanCells` wide.
 */
export function snapAxisToGrid(
  norm: number,
  boardPx: number,
  gridSize: number,
  spanCells: number,
): number {
  if (!Number.isInteger(gridSize) || gridSize <= 0) {
    throw new Error(`Grid cell size must be a positive whole number, got ${String(gridSize)}`);
  }
  if (!Number.isInteger(spanCells) || spanCells <= 0) {
    throw new Error(`Token span must be a positive whole number of cells, got ${String(spanCells)}`);
  }
  if (!(boardPx > 0)) {
    throw new Error(`Board size must be positive, got ${String(boardPx)}`);
  }
  const half = spanCells / 2;
  const origin = Math.round((norm * boardPx) / gridSize - half);
  return ((origin + half) * gridSize) / boardPx;
}

export function snapPointToGrid(
  x: number,
  y: number,
  boardWidth: number,
  boardHeight: number,
  gridSize: number,
  spanCells: number,
): { x: number; y: number } {
  return snapBoxToGrid(x, y, boardWidth, boardHeight, gridSize, spanCells, spanCells);
}

export function snapBoxToGrid(
  x: number,
  y: number,
  boardWidth: number,
  boardHeight: number,
  gridSize: number,
  spanXCells: number,
  spanYCells: number,
): { x: number; y: number } {
  return {
    x: snapAxisToGrid(x, boardWidth, gridSize, spanXCells),
    y: snapAxisToGrid(y, boardHeight, gridSize, spanYCells),
  };
}
