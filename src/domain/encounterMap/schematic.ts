import {
  cellKeyOf,
  entranceSideDelta,
  type EncounterLayout,
  type LayoutRect,
} from '@/domain/encounterMap/schema';

export interface RoomMarkerConfig {
  letter: string;
  hue: number;
  colorName: string;
  label: string;
}

/**
 * Canonical 10-hue palette (docs/11): rooms consume the entries strictly in
 * order for their LETTER labels, and the entrance marker reuses the entry
 * ONE PAST the room count for its painted schematic triangle, so the two
 * can never collide. Since the marker-path deletion (docs/11 deletion
 * record) these are paint/label vocabulary only — no pixel is ever read
 * back (D7).
 */
export const CANONICAL_ROOM_MARKERS: readonly RoomMarkerConfig[] = [
  { letter: 'A', hue: 300, colorName: 'magenta', label: 'Room A (Magenta disc, plaque A)' },
  { letter: 'B', hue: 180, colorName: 'cyan', label: 'Room B (Cyan disc, plaque B)' },
  { letter: 'C', hue: 60, colorName: 'yellow', label: 'Room C (Yellow disc, plaque C)' },
  { letter: 'D', hue: 120, colorName: 'green', label: 'Room D (Green disc, plaque D)' },
  { letter: 'E', hue: 225, colorName: 'blue', label: 'Room E (Electric-blue disc, plaque E)' },
  { letter: 'F', hue: 30, colorName: 'orange', label: 'Room F (Neon-orange disc, plaque F)' },
  { letter: 'G', hue: 270, colorName: 'purple', label: 'Room G (Neon-purple disc, plaque G)' },
  { letter: 'H', hue: 350, colorName: 'rose', label: 'Room H (Neon-rose disc, plaque H)' },
  { letter: 'I', hue: 90, colorName: 'lime', label: 'Room I (Neon-lime disc, plaque I)' },
  { letter: 'J', hue: 205, colorName: 'teal', label: 'Room J (Neon-teal disc, plaque J)' },
];

/**
 * The entrance marker's canonical hue: rooms consume the palette strictly
 * in order, so the entry ONE PAST the room count can never collide with a
 * room label. With all ten hues taken (10-room layouts) there is no free
 * hue and the schematic paints no triangle (the geometry stays
 * authoritative).
 */
export function entranceMarkerConfig(roomCount: number): RoomMarkerConfig | null {
  return CANONICAL_ROOM_MARKERS[roomCount] ?? null;
}

export interface SchematicResult {
  dataUrl: string;
  width: number;
  height: number;
}

export type CanvasFactory = (width: number, height: number) => HTMLCanvasElement;

/** The images-table map cap (docs/11: role 'map' keeps up to 4096px). */
export const SCHEMATIC_PX_CAP = 4096;

/** Default cell px for a base-tier schematic (docs/11 layout engine). */
const SCHEMATIC_CELL_PX = 96;

/**
 * Cell px for the run-engine schematic call: 96 while the grid fits the map
 * cap, scaled down just enough to stay inside it for larger grids (the
 * dungeon preset's fixed ×2 tier — 48×36 at 96 would be 4608px). Standard
 * layouts keep 96 byte-identical; line weights derive from cellPx, so the
 * drawing vocabulary survives the scale-down.
 */
export function schematicCellPx(layout: Pick<EncounterLayout, 'gridW' | 'gridH'>): number {
  const byWidth = Math.floor(SCHEMATIC_PX_CAP / layout.gridW);
  const byHeight = Math.floor(SCHEMATIC_PX_CAP / layout.gridH);
  return Math.max(1, Math.min(SCHEMATIC_CELL_PX, byWidth, byHeight));
}

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
  drawEntrance(context, layout, cellPx);

  return { dataUrl: canvas.toDataURL('image/png'), width, height };
}

/**
 * Paints a wall opening across the shared edge of `cell` and its `side`
 * neighbor — the corridor-door vocabulary (gap in the wall stroke, floor
 * color, same thickness/opening as before extraction).
 */
function paintWallGap(
  context: CanvasRenderingContext2D,
  cell: { x: number; y: number },
  side: 'north' | 'south' | 'west' | 'east',
  cellPx: number,
): void {
  const thickness = Math.max(2, Math.floor(cellPx / 8));
  const opening = cellPx * 0.55;
  if (side === 'west') {
    context.fillRect(cell.x * cellPx - thickness / 2, cell.y * cellPx + (cellPx - opening) / 2, thickness, opening);
    return;
  }
  if (side === 'east') {
    context.fillRect((cell.x + 1) * cellPx - thickness / 2, cell.y * cellPx + (cellPx - opening) / 2, thickness, opening);
    return;
  }
  if (side === 'north') {
    context.fillRect(cell.x * cellPx + (cellPx - opening) / 2, cell.y * cellPx - thickness / 2, opening, thickness);
    return;
  }
  context.fillRect(cell.x * cellPx + (cellPx - opening) / 2, (cell.y + 1) * cellPx - thickness / 2, opening, thickness);
}

/**
 * The entrance zone (entrance/exit spawn zones, doc 11): an opening in the
 * spawn room's outer wall drawn with the door-gap vocabulary, a one-cell
 * landing pad outside it, and the marker — a solid neon triangle just inside
 * the gap pointing into the room. Geometry comes from the layout only (D7);
 * the marker hue is the canonical palette entry one past the room count.
 */
function drawEntrance(
  context: CanvasRenderingContext2D,
  layout: EncounterLayout,
  cellPx: number,
): void {
  const spawnRoom = layout.rooms.find((room) => room.spawn);
  const entrance = spawnRoom?.entrance;
  if (spawnRoom === undefined || entrance === undefined) return;

  context.fillStyle = '#d1d5db';
  paintWallGap(context, entrance, entrance.side, cellPx);

  const [dx, dy] = entranceSideDelta(entrance.side);
  const outward = { x: entrance.x + dx, y: entrance.y + dy };
  const roomCells = new Set<string>();
  for (const room of layout.rooms) {
    for (const rect of room.rects) addRectCells(roomCells, rect);
  }
  const corridorCells = new Set<string>();
  for (const corridor of layout.corridors) {
    for (const rect of corridor.rects) addRectCells(corridorCells, rect);
  }
  const outwardInGrid =
    outward.x >= 0 && outward.y >= 0 && outward.x < layout.gridW && outward.y < layout.gridH;
  if (outwardInGrid && !roomCells.has(cellKeyOf(outward)) && !corridorCells.has(cellKeyOf(outward))) {
    context.fillRect(outward.x * cellPx, outward.y * cellPx, cellPx, cellPx);
  }

  const marker = entranceMarkerConfig(layout.rooms.length);
  if (marker === null) return;
  const center = { x: (entrance.x + 0.5) * cellPx, y: (entrance.y + 0.5) * cellPx };
  // Inward = opposite of the outward side; perpendicular for the base corners.
  const inward = { x: -dx, y: -dy };
  const perp = { x: -inward.y, y: inward.x };
  const tip = { x: center.x + inward.x * 0.3 * cellPx, y: center.y + inward.y * 0.3 * cellPx };
  const baseMid = { x: center.x - inward.x * 0.22 * cellPx, y: center.y - inward.y * 0.22 * cellPx };
  const halfBase = 0.3 * cellPx;
  context.beginPath();
  context.moveTo(tip.x, tip.y);
  context.lineTo(baseMid.x + perp.x * halfBase, baseMid.y + perp.y * halfBase);
  context.lineTo(baseMid.x - perp.x * halfBase, baseMid.y - perp.y * halfBase);
  context.closePath();
  context.fillStyle = `hsl(${String(marker.hue)}, 100%, 50%)`;
  context.fill();
  context.strokeStyle = '#000';
  context.lineWidth = Math.max(2, Math.floor(cellPx / 12));
  context.stroke();
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
  context.fillStyle = '#d1d5db';
  for (const corridor of layout.corridors) {
    const corridorCells = new Set<string>();
    for (const rect of corridor.rects) addRectCells(corridorCells, rect);
    for (const key of corridorCells) {
      const [xText, yText] = key.split(',');
      const x = Number(xText);
      const y = Number(yText);
      if (roomCells.has(`${String(x - 1)},${String(y)}`)) paintWallGap(context, { x, y }, 'west', cellPx);
      if (roomCells.has(`${String(x + 1)},${String(y)}`)) paintWallGap(context, { x, y }, 'east', cellPx);
      if (roomCells.has(`${String(x)},${String(y - 1)}`)) paintWallGap(context, { x, y }, 'north', cellPx);
      if (roomCells.has(`${String(x)},${String(y + 1)}`)) paintWallGap(context, { x, y }, 'south', cellPx);
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
