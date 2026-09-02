import type { EncounterLayout, LayoutRect } from '@/domain/encounterMap/schema';

export interface SchematicResult {
  dataUrl: string;
  width: number;
  height: number;
}

export type CanvasFactory = (width: number, height: number) => HTMLCanvasElement;

/**
 * Renders the validated structure before any image model sees it. Geometry is
 * always read from layout JSON; pixels are output only and never authoritative.
 */
export function renderSchematic(
  layout: EncounterLayout,
  cellPx = 96,
  factory: CanvasFactory = browserCanvas,
): SchematicResult {
  if (!Number.isInteger(cellPx) || cellPx < 1) throw new Error('cellPx must be a positive integer');
  const width = layout.gridW * cellPx;
  const height = layout.gridH * cellPx;
  const canvas = factory(width, height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Canvas 2D context is unavailable');

  context.fillStyle = '#111827';
  context.fillRect(0, 0, width, height);

  // Corridors first; room floors cover the implied doorway cells cleanly.
  context.fillStyle = '#d1d5db';
  for (const corridor of layout.corridors) {
    for (const rect of corridor.rects) fillRect(context, rect, cellPx);
  }

  const roomPalette = ['#e5e7eb', '#dbeafe', '#dcfce7', '#fef3c7', '#f3e8ff'];
  for (const [index, room] of layout.rooms.entries()) {
    context.fillStyle = roomPalette[index % roomPalette.length] ?? '#e5e7eb';
    for (const rect of room.rects) fillRect(context, rect, cellPx);
    context.strokeStyle = '#1f2937';
    context.lineWidth = Math.max(2, Math.floor(cellPx / 12));
    for (const rect of room.rects) strokeRect(context, rect, cellPx);
  }
  drawDoorGaps(context, layout, cellPx);

  return { dataUrl: canvas.toDataURL('image/png'), width, height };
}

function drawDoorGaps(
  context: CanvasRenderingContext2D,
  layout: EncounterLayout,
  cellPx: number,
): void {
  const roomCells = new Set<string>();
  for (const room of layout.rooms) {
    for (const rect of room.rects) addRectCells(roomCells, rect);
  }
  const thickness = Math.max(2, Math.floor(cellPx / 8));
  const opening = cellPx * 0.55;
  context.fillStyle = '#d1d5db';
  for (const corridor of layout.corridors) {
    const corridorCells = new Set<string>();
    for (const rect of corridor.rects) addRectCells(corridorCells, rect);
    for (const key of corridorCells) {
      const [xText, yText] = key.split(',');
      const x = Number(xText);
      const y = Number(yText);
      if (roomCells.has(`${String(x - 1)},${String(y)}`)) {
        context.fillRect(x * cellPx - thickness / 2, y * cellPx + (cellPx - opening) / 2, thickness, opening);
      }
      if (roomCells.has(`${String(x + 1)},${String(y)}`)) {
        context.fillRect((x + 1) * cellPx - thickness / 2, y * cellPx + (cellPx - opening) / 2, thickness, opening);
      }
      if (roomCells.has(`${String(x)},${String(y - 1)}`)) {
        context.fillRect(x * cellPx + (cellPx - opening) / 2, y * cellPx - thickness / 2, opening, thickness);
      }
      if (roomCells.has(`${String(x)},${String(y + 1)}`)) {
        context.fillRect(x * cellPx + (cellPx - opening) / 2, (y + 1) * cellPx - thickness / 2, opening, thickness);
      }
    }
  }
}

function addRectCells(cells: Set<string>, rect: LayoutRect): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) cells.add(`${String(x)},${String(y)}`);
  }
}

function browserCanvas(width: number, height: number): HTMLCanvasElement {
  if (typeof document === 'undefined') throw new Error('Schematic rendering requires a canvas');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function fillRect(context: CanvasRenderingContext2D, rect: LayoutRect, cellPx: number): void {
  context.fillRect(rect.x * cellPx, rect.y * cellPx, rect.w * cellPx, rect.h * cellPx);
}

function strokeRect(context: CanvasRenderingContext2D, rect: LayoutRect, cellPx: number): void {
  context.strokeRect(rect.x * cellPx, rect.y * cellPx, rect.w * cellPx, rect.h * cellPx);
}
