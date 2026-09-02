import {
  VEIL_MIN_CELLS,
  type BattleToken,
  type BattleVeil,
} from '@/domain/battle';

/**
 * Veils (09-MILESTONE-5 M5-B, ported from GM Cockpit's `host/veil.ts`):
 * cell metrics, center-preserving cell-quantized edge resize, and the
 * covered-portrait test. A "fog" renders above tokens; a "veil" is plain
 * cover — both REMOVE covered fighters from the board and initiative.
 */

export type VeilEdge = 'n' | 's' | 'e' | 'w';

export function veilCellPx(gridSize: number | null, tokenSize: number): number {
  if (gridSize !== null) {
    if (!Number.isInteger(gridSize) || gridSize <= 0) {
      throw new Error(`Grid cell size must be a positive whole number, got ${String(gridSize)}`);
    }
    return gridSize;
  }
  if (!(tokenSize > 0)) {
    throw new Error(`Token size must be positive, got ${String(tokenSize)}`);
  }
  return tokenSize;
}

export function veilSpanNorm(cells: number, cellPx: number, boardPx: number): number {
  if (!Number.isInteger(cells) || cells < VEIL_MIN_CELLS) {
    throw new Error(`Veil span must be an integer of at least ${String(VEIL_MIN_CELLS)} cells, got ${String(cells)}`);
  }
  if (!(cellPx > 0)) {
    throw new Error(`Veil cell size must be positive, got ${String(cellPx)}`);
  }
  if (!(boardPx > 0)) {
    throw new Error(`Board size must be positive, got ${String(boardPx)}`);
  }
  return (cells * cellPx) / boardPx;
}

/** Resizes from an edge handle: the opposite edge stays put, spans stay cell-quantized. */
export function resizeVeilFromEdge(
  veil: BattleVeil,
  edge: VeilEdge,
  pointer: { x: number; y: number },
  boardWidth: number,
  boardHeight: number,
  cellWidthPx: number,
  cellHeightPx: number = cellWidthPx,
): BattleVeil {
  const cellX = veilSpanNorm(1, cellWidthPx, boardWidth);
  const cellY = veilSpanNorm(1, cellHeightPx, boardHeight);
  if (edge === 'e' || edge === 'w') {
    const next = resizeAxis(veil.x, veil.widthCells, pointer.x, cellX, edge === 'e' ? 1 : -1);
    return { ...veil, x: next.center, widthCells: next.cells };
  }
  const next = resizeAxis(veil.y, veil.heightCells, pointer.y, cellY, edge === 's' ? 1 : -1);
  return { ...veil, y: next.center, heightCells: next.cells };
}

export function portraitCoveredByVeil(
  token: BattleToken,
  veil: BattleVeil,
  unitSize: number,
  cellWidthPx: number,
  boardWidth: number,
  boardHeight: number,
  cellHeightPx: number = cellWidthPx,
): boolean {
  if (token.shape !== 'portrait') {
    return false;
  }
  return rectsOverlap(
    tokenRect(token, unitSize, boardWidth, boardHeight),
    veilRect(veil, cellWidthPx, boardWidth, boardHeight, cellHeightPx),
  );
}

export function portraitCoveredByVeils(
  token: BattleToken,
  veils: readonly BattleVeil[],
  unitSize: number,
  cellWidthPx: number,
  boardWidth: number,
  boardHeight: number,
  cellHeightPx: number = cellWidthPx,
): boolean {
  for (const veil of veils) {
    if (portraitCoveredByVeil(token, veil, unitSize, cellWidthPx, boardWidth, boardHeight, cellHeightPx)) {
      return true;
    }
  }
  return false;
}

function tokenRect(
  token: BattleToken,
  unitSize: number,
  boardWidth: number,
  boardHeight: number,
): { left: number; right: number; top: number; bottom: number } {
  if (!(unitSize > 0)) {
    throw new Error(`Token size must be positive, got ${String(unitSize)}`);
  }
  if (!(boardWidth > 0) || !(boardHeight > 0)) {
    throw new Error('Board size must be positive');
  }
  const halfX = (unitSize * token.scale) / boardWidth / 2;
  const halfY = (unitSize * token.scale) / boardHeight / 2;
  return {
    left: token.x - halfX,
    right: token.x + halfX,
    top: token.y - halfY,
    bottom: token.y + halfY,
  };
}

function veilRect(
  veil: BattleVeil,
  cellWidthPx: number,
  boardWidth: number,
  boardHeight: number,
  cellHeightPx: number = cellWidthPx,
): { left: number; right: number; top: number; bottom: number } {
  const halfX = veilSpanNorm(veil.widthCells, cellWidthPx, boardWidth) / 2;
  const halfY = veilSpanNorm(veil.heightCells, cellHeightPx, boardHeight) / 2;
  return {
    left: veil.x - halfX,
    right: veil.x + halfX,
    top: veil.y - halfY,
    bottom: veil.y + halfY,
  };
}

function resizeAxis(
  center: number,
  cells: number,
  pointer: number,
  cellNorm: number,
  edgeSign: -1 | 1,
): { center: number; cells: number } {
  const half = (cells * cellNorm) / 2;
  const min = center - half;
  const max = center + half;
  if (edgeSign === 1) {
    const nextCells = Math.max(VEIL_MIN_CELLS, Math.round((pointer - min) / cellNorm));
    return { center: min + (nextCells * cellNorm) / 2, cells: nextCells };
  }
  const nextCells = Math.max(VEIL_MIN_CELLS, Math.round((max - pointer) / cellNorm));
  return { center: max - (nextCells * cellNorm) / 2, cells: nextCells };
}

function rectsOverlap(
  a: { left: number; right: number; top: number; bottom: number },
  b: { left: number; right: number; top: number; bottom: number },
): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
