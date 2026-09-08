import {
  EFFECT_MIN_CELLS,
  type BattleEffect,
} from '@/domain/battle';
import { veilSpanNorm } from '@/domain/battle/veil';

/**
 * Effect markers (09-MILESTONE-5 M5-D, veil-parity arc): cell-quantized edge
 * resize for the geometric markers (`battleEffectSchema`). Unlike veils —
 * whose resize pins the opposite edge (`resizeVeilFromEdge`) — an effect is
 * a single `sizeCells` span (diameter for discs, side for squares), so the
 * resize is SYMMETRIC: the center stays fixed and every edge handle grows or
 * shrinks the same span. Cell quantization rides `veilSpanNorm` (the one
 * cell-quantization door); the floor is `EFFECT_MIN_CELLS`.
 */

export type EffectEdge = 'n' | 's' | 'e' | 'w';

export function resizeEffectFromEdge(
  effect: BattleEffect,
  edge: EffectEdge,
  pointer: { x: number; y: number },
  boardWidth: number,
  boardHeight: number,
  cellWidthPx: number,
  cellHeightPx: number = cellWidthPx,
): BattleEffect {
  if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) {
    throw new Error('Effect resize pointer must be finite board coordinates');
  }
  if (!Number.isFinite(effect.x) || !Number.isFinite(effect.y)) {
    throw new Error('Effect center must be finite board coordinates');
  }
  // Loud geometry validation rides veilSpanNorm (cell + board positivity).
  const cellX = veilSpanNorm(1, cellWidthPx, boardWidth);
  const cellY = veilSpanNorm(1, cellHeightPx, boardHeight);
  // Symmetric span: twice the center→pointer distance on the handle's axis,
  // quantized to whole cells, floored at one cell. The center never moves.
  const along = edge === 'e' || edge === 'w'
    ? Math.abs(pointer.x - effect.x) / cellX
    : Math.abs(pointer.y - effect.y) / cellY;
  const nextCells = Math.max(EFFECT_MIN_CELLS, Math.round(along * 2));
  return { ...effect, sizeCells: nextCells };
}
