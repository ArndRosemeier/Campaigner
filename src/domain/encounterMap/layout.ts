import { errorMessage } from '@/lib/errors';
import type { BattleVeil } from '@/domain/battle';
import {
  encounterLayoutSchema,
  encounterMapBriefSchema,
  cellKeyOf,
  entranceOutwardCell,
  entranceSideDelta,
  type EncounterLayout,
  type EncounterMapAspect,
  type EncounterMapBrief,
  type EncounterRoomSize,
  type LayoutCorridor,
  type LayoutEntrance,
  type LayoutEntranceSide,
  type LayoutRect,
  type LayoutRoom,
  type MonsterPlacement,
} from '@/domain/encounterMap/schema';

interface Cell {
  x: number;
  y: number;
}

const GRID_BY_ASPECT: Readonly<Record<EncounterMapAspect, { gridW: number; gridH: number }>> = {
  '4:3': { gridW: 24, gridH: 18 },
  '16:9': { gridW: 28, gridH: 16 },
  '1:1': { gridW: 20, gridH: 20 },
};

const BASE_SIZE: Readonly<Record<EncounterRoomSize, { w: number; h: number }>> = {
  small: { w: 4, h: 4 },
  medium: { w: 6, h: 5 },
  large: { w: 7, h: 6 },
};

export class EncounterLayoutError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Encounter layout failed: ${issues.join('; ')}`);
    this.name = 'EncounterLayoutError';
    this.issues = issues;
  }
}

/** Deterministic bounded packer. No coordinates ever come from the LLM. */
export function packRooms(input: EncounterMapBrief, variant = 0): EncounterLayout {
  const brief = encounterMapBriefSchema.parse(input);
  const attempts: string[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const layout = packAttempt(brief, attempt + variant);
      const issues = validateEncounterLayout(layout, brief.rosterCounts);
      if (issues.length === 0) return encounterLayoutSchema.parse(layout);
      attempts.push(`attempt ${String(attempt + 1)}: ${issues.join(', ')}`);
    } catch (error) {
      attempts.push(
        `attempt ${String(attempt + 1)}: ${errorMessage(error)}`,
      );
    }
  }
  throw new EncounterLayoutError(attempts);
}

function packAttempt(brief: EncounterMapBrief, attempt: number): EncounterLayout {
  const { gridW, gridH } = GRID_BY_ASPECT[brief.aspect];
  const count = brief.rooms.length;
  const columns = Math.min(brief.aspect === '16:9' ? 4 : 3, count);
  const rows = Math.ceil(count / columns);
  const slotW = Math.floor(gridW / columns);
  const slotH = Math.floor(gridH / rows);
  const ordered = rotate(brief.rooms, attempt % count);
  const rooms = ordered.map((room, index): LayoutRoom => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const required = room.monsterIndexes.reduce(
      (total, rosterIndex) => total + (brief.rosterCounts[rosterIndex] ?? Number.POSITIVE_INFINITY),
      0,
    );
    const sized = roomRects(room.size, required, slotW, slotH, attempt);
    const xOffset = column * slotW + Math.floor((slotW - sized.bounds.w) / 2);
    const yOffset = row * slotH + Math.floor((slotH - sized.bounds.h) / 2);
    return {
      id: room.id,
      name: room.name,
      description: room.description,
      monsterIndexes: [...room.monsterIndexes],
      spawn: room.id === brief.entryRoomId,
      rects: sized.rects.map((rect) => translate(rect, xOffset, yOffset)),
      mobsRect: translate(sized.mobsRect, xOffset, yOffset),
    };
  });

  const occupied = roomCellSet(rooms);
  const corridorPairs = adjacencyPairs(brief);
  const corridorCells = new Set<string>();
  const corridors = corridorPairs.map(([a, b]): LayoutCorridor => {
    const roomA = requireRoom(rooms, a);
    const roomB = requireRoom(rooms, b);
    const path = routeCorridor(roomA, roomB, occupied, corridorCells, gridW, gridH);
    for (const cell of path) corridorCells.add(cellKey(cell));
    return { a, b, rects: compressPath(path) };
  });

  // Entrance zone: the spawn room's outer-wall cell farthest from its own
  // doors, opening toward the outside. Deterministic; omitted when the room
  // has no candidate wall (the field is optional enrichment, never invented).
  const spawn = rooms.find((room) => room.spawn);
  if (spawn !== undefined) {
    const entrance = placeEntrance(spawn, occupied, corridorCells, gridW, gridH);
    if (entrance !== undefined) spawn.entrance = entrance;
  }

  return { gridW, gridH, theme: brief.theme, rooms, corridors };
}

const ENTRANCE_SIDES: readonly LayoutEntranceSide[] = ['north', 'west', 'east', 'south'];

/**
 * Deterministic entrance placement (entrance/exit spawn zones, doc 11): the
 * spawn room's outer-wall cell FARTHEST from the room's own corridor doors —
 * the party enters at one end and fights toward the doors — opening toward
 * the outside world. Ties break toward the nearest grid edge, then
 * lexicographically ((y, x), then a fixed side order), so the same geometry
 * always yields the same entrance. A room with no candidate wall (every
 * boundary face is a corridor door or another room) gets no entrance: the
 * field is optional enrichment and is never invented.
 */
export function placeEntrance(
  room: LayoutRoom,
  occupied: ReadonlySet<string>,
  corridorCells: ReadonlySet<string>,
  gridW: number,
  gridH: number,
): LayoutEntrance | undefined {
  const roomCells = new Set<string>();
  for (const rect of room.rects) {
    for (const key of cellsOfRect(rect)) roomCells.add(key);
  }
  const doorCells: Cell[] = [];
  for (const key of roomCells) {
    const cell = parseCell(key);
    if (neighbors(cell).some((neighbor) => corridorCells.has(cellKey(neighbor)))) {
      doorCells.push(cell);
    }
  }
  interface EntranceCandidate {
    cell: Cell;
    side: LayoutEntranceSide;
    doorDistance: number;
    edgeSteps: number;
  }
  const candidates: EntranceCandidate[] = [];
  for (const key of roomCells) {
    const cell = parseCell(key);
    for (const side of ENTRANCE_SIDES) {
      const [dx, dy] = entranceSideDelta(side);
      const outward = { x: cell.x + dx, y: cell.y + dy };
      const outwardKey = cellKey(outward);
      // Not an outer wall of this room, a corridor door, or another room's
      // cell — the entrance opens into the void, the map edge, or a wall.
      if (roomCells.has(outwardKey) || corridorCells.has(outwardKey) || occupied.has(outwardKey)) {
        continue;
      }
      const doorDistance =
        doorCells.length === 0
          ? 0
          : Math.min(...doorCells.map((door) => Math.abs(door.x - cell.x) + Math.abs(door.y - cell.y)));
      // Steps from the outward cell to just past the grid edge; naturally 0
      // when the outward cell is off-grid (a map-edge entrance).
      const edgeSteps =
        dx > 0 ? gridW - outward.x : dx < 0 ? outward.x + 1 : dy > 0 ? gridH - outward.y : outward.y + 1;
      candidates.push({
        cell,
        side,
        doorDistance: Math.max(0, doorDistance),
        edgeSteps: Math.max(0, edgeSteps),
      });
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort(
    (left, right) =>
      right.doorDistance - left.doorDistance ||
      left.edgeSteps - right.edgeSteps ||
      left.cell.y - right.cell.y ||
      left.cell.x - right.cell.x ||
      ENTRANCE_SIDES.indexOf(left.side) - ENTRANCE_SIDES.indexOf(right.side),
  );
  const best = candidates[0];
  if (best === undefined) return undefined;
  return { x: best.cell.x, y: best.cell.y, side: best.side };
}

/**
 * The party staging block for the spawn room: the mobsRect-sized rectangle
 * slid along the entrance axis until it hugs the entrance wall while staying
 * inside the room union. Without an entrance (legacy layouts) this is
 * exactly the mobsRect — the pre-entrance staging-ground behavior.
 */
export function stagingBlockRect(room: LayoutRoom): LayoutRect {
  const entrance = room.entrance;
  if (entrance === undefined) return room.mobsRect;
  const [dx, dy] = entranceSideDelta(entrance.side);
  const roomCells = new Set<string>();
  for (const rect of room.rects) {
    for (const key of cellsOfRect(rect)) roomCells.add(key);
  }
  let current = room.mobsRect;
  for (;;) {
    const shifted: LayoutRect = { ...current, x: current.x + dx, y: current.y + dy };
    let inside = true;
    for (const key of cellsOfRect(shifted)) {
      if (!roomCells.has(key)) {
        inside = false;
        break;
      }
    }
    if (!inside) break;
    current = shifted;
  }
  return current;
}

function roomRects(
  size: EncounterRoomSize,
  requiredMonsters: number,
  slotW: number,
  slotH: number,
  attempt: number,
): { bounds: LayoutRect; rects: LayoutRect[]; mobsRect: LayoutRect } {
  if (!Number.isFinite(requiredMonsters)) throw new Error('room references a missing roster entry');
  const base = BASE_SIZE[size];
  const capacityWidth = Math.max(1, Math.ceil(Math.sqrt(requiredMonsters)));
  const capacityHeight = Math.max(1, Math.ceil(requiredMonsters / capacityWidth));
  const shrink = attempt;
  const w = Math.max(capacityWidth + 2, base.w - shrink);
  const h = Math.max(capacityHeight + 2, base.h - shrink);
  if (w > slotW - 1 || h > slotH - 1) {
    throw new Error(`room requiring ${String(requiredMonsters)} monster cells does not fit`);
  }

  const bounds = { x: 0, y: 0, w, h };
  if (size === 'small' || w < 5 || h < 5) {
    return { bounds, rects: [bounds], mobsRect: inset(bounds, 1) };
  }
  // An L footprint: the tall rectangle holds mobs; the lower arm adds shape.
  const tall = { x: 0, y: 0, w: w - 1, h };
  const arm = { x: 0, y: Math.max(0, h - 3), w, h: Math.min(3, h) };
  return { bounds, rects: [tall, arm], mobsRect: inset(tall, 1) };
}

export interface StagingRoomInput {
  id: string;
  name: string;
  description: string;
  monsterIndexes: number[];
  spawn: boolean;
  letter: string;
  markerHue: number;
  markerColorName: string;
  stagingPoint: { x: number; y: number };
}

export interface StagingLayoutInput {
  theme: string;
  aspect: EncounterMapAspect;
  rooms: StagingRoomInput[];
  rosterCounts?: readonly number[];
}

export function adaptiveGridDimensions(
  aspect: EncounterMapAspect,
  roomCount: number,
): { gridW: number; gridH: number } {
  if (aspect === '16:9') {
    if (roomCount <= 2) return { gridW: 28, gridH: 16 };
    if (roomCount <= 5) return { gridW: 42, gridH: 24 };
    return { gridW: 56, gridH: 32 };
  }
  if (aspect === '1:1') {
    if (roomCount <= 2) return { gridW: 20, gridH: 20 };
    if (roomCount <= 5) return { gridW: 30, gridH: 30 };
    return { gridW: 40, gridH: 40 };
  }
  // 4:3 default
  if (roomCount <= 2) return { gridW: 24, gridH: 18 };
  if (roomCount <= 5) return { gridW: 36, gridH: 27 };
  return { gridW: 48, gridH: 36 };
}

/**
 * Builds an encounter layout from detected marker staging points.
 * Generates generous room veils centered on each marker and adaptive grid sizing.
 */
export function layoutFromStagingMarkers(input: StagingLayoutInput): EncounterLayout {
  const { aspect, theme, rooms, rosterCounts = [] } = input;
  const { gridW, gridH } = adaptiveGridDimensions(aspect, rooms.length);

  const baseVeilW = Math.max(6, Math.round(gridW * 0.28));
  const baseVeilH = Math.max(5, Math.round(gridH * 0.28));

  const layoutRooms: LayoutRoom[] = rooms.map((room) => {
    const required = room.monsterIndexes.reduce(
      (total, idx) => total + (rosterCounts[idx] ?? 1),
      0,
    );
    let veilW = baseVeilW;
    let veilH = baseVeilH;
    while (veilW * veilH < required) {
      if (veilW < gridW - 2) veilW += 1;
      if (veilH < gridH - 2) veilH += 1;
      if (veilW >= gridW - 2 && veilH >= gridH - 2) break;
    }

    const cx = Math.round(room.stagingPoint.x * gridW);
    const cy = Math.round(room.stagingPoint.y * gridH);
    const x = Math.max(0, Math.min(gridW - veilW, cx - Math.floor(veilW / 2)));
    const y = Math.max(0, Math.min(gridH - veilH, cy - Math.floor(veilH / 2)));
    const mobsRect: LayoutRect = { x, y, w: veilW, h: veilH };

    return {
      id: room.id,
      name: room.name,
      description: room.description,
      monsterIndexes: [...room.monsterIndexes],
      spawn: room.spawn,
      letter: room.letter,
      markerHue: room.markerHue,
      markerColorName: room.markerColorName,
      stagingPoint: { ...room.stagingPoint },
      rects: [mobsRect],
      mobsRect,
    };
  });

  // Entrance zone (no corridors here): the spawn area's boundary cell whose
  // outward side faces the nearest grid edge — the party walks in off the map.
  const spawnRoom = layoutRooms.find((room) => room.spawn);
  if (spawnRoom !== undefined) {
    const entrance = placeEntrance(spawnRoom, new Set(), new Set(), gridW, gridH);
    if (entrance !== undefined) spawnRoom.entrance = entrance;
  }

  const layout: EncounterLayout = {
    gridW,
    gridH,
    theme,
    rooms: layoutRooms,
    corridors: [],
  };

  return encounterLayoutSchema.parse(layout);
}

/** Returns every structural problem; an empty list means the layout is safe. */
export function validateEncounterLayout(
  input: EncounterLayout,
  rosterCounts: readonly number[] = [],
): string[] {
  const parsed = encounterLayoutSchema.safeParse(input);
  if (!parsed.success) return parsed.error.issues.map((issue) => issue.message);
  const layout = parsed.data;
  const issues: string[] = [];
  if (layout.rooms.filter((room) => room.spawn).length !== 1) {
    issues.push('layout must contain exactly one spawn room');
  }

  const isStaging = layout.rooms.some((room) => room.stagingPoint !== undefined);
  const ownerByCell = new Map<string, string>();
  const corridorCellKeys = new Set<string>();
  for (const corridor of layout.corridors) {
    for (const key of cellsOfRects(corridor.rects)) corridorCellKeys.add(key);
  }
  if (layout.rooms.filter((room) => room.entrance !== undefined).length > 1) {
    issues.push('layout must contain at most one entrance');
  }
  for (const room of layout.rooms) {
    const cells = cellsOfRects(room.rects);
    if (cells.size === 0 || !cellsConnected(cells)) issues.push(`${room.name}: room union is disconnected`);
    const entrance = room.entrance;
    if (entrance !== undefined) {
      if (!room.spawn) issues.push(`${room.name}: only the spawn room may carry an entrance`);
      const cellSet = new Set(cells);
      if (!cellSet.has(cellKeyOf(entrance))) issues.push(`${room.name}: entrance cell is outside the room`);
      const outwardKey = cellKeyOf(entranceOutwardCell(entrance));
      if (cellSet.has(outwardKey)) issues.push(`${room.name}: entrance side does not face the outer wall`);
      if (corridorCellKeys.has(outwardKey)) issues.push(`${room.name}: entrance opens into a corridor`);
    }
    for (const rect of [...room.rects, room.mobsRect]) {
      if (!rectInBounds(rect, layout.gridW, layout.gridH)) issues.push(`${room.name}: rectangle outside grid`);
    }
    if (!isStaging) {
      for (const key of cells) {
        const owner = ownerByCell.get(key);
        if (owner !== undefined && owner !== room.id) issues.push(`${room.name}: overlaps another room`);
        ownerByCell.set(key, room.id);
      }
    }
    const mobCells = cellsOfRect(room.mobsRect);
    for (const key of mobCells) {
      if (!cells.has(key)) issues.push(`${room.name}: mobsRect leaves room union`);
      if (!isStaging) {
        const cell = parseCell(key);
        if (neighbors(cell).some((neighbor) => !cells.has(cellKey(neighbor)))) {
          issues.push(`${room.name}: mobsRect is not inside the room border`);
          break;
        }
      }
    }
    const required = room.monsterIndexes.reduce(
      (total, index) => total + (rosterCounts[index] ?? 1),
      0,
    );
    if (room.mobsRect.w * room.mobsRect.h < required) {
      issues.push(`${room.name}: mobsRect has insufficient monster cells`);
    }
  }

  if (rosterCounts.length > 0) {
    const assignments = new Map<number, number>();
    for (const room of layout.rooms) {
      for (const index of room.monsterIndexes) {
        assignments.set(index, (assignments.get(index) ?? 0) + 1);
      }
    }
    for (let index = 0; index < rosterCounts.length; index += 1) {
      if (assignments.get(index) !== 1) {
        issues.push(`roster entry ${String(index)} must belong to exactly one room`);
      }
    }
    for (const index of assignments.keys()) {
      if (rosterCounts[index] === undefined) issues.push(`room references missing roster entry ${String(index)}`);
    }
  }

  if (!isStaging) {
    const roomIds = new Set(layout.rooms.map((room) => room.id));
    const connectedPairs = new Set<string>();
    for (const corridor of layout.corridors) {
      if (!roomIds.has(corridor.a) || !roomIds.has(corridor.b)) {
        issues.push('corridor references an unknown room');
        continue;
      }
      if (corridor.rects.some((rect) => rect.w !== 1 && rect.h !== 1)) {
        issues.push('corridors must be one cell wide');
      }
      const cells = cellsOfRects(corridor.rects);
      if (!cellsConnected(cells)) issues.push('corridor path is disconnected');
      for (const key of cells) {
        const cell = parseCell(key);
        if (!rectInBounds({ ...cell, w: 1, h: 1 }, layout.gridW, layout.gridH)) {
          issues.push('corridor leaves grid');
        }
        if (ownerByCell.has(key)) issues.push('corridor crosses a room');
      }
      const aCells = cellsOfRects(requireRoom(layout.rooms, corridor.a).rects);
      const bCells = cellsOfRects(requireRoom(layout.rooms, corridor.b).rects);
      if (!touches(cells, aCells) || !touches(cells, bCells)) {
        issues.push('corridor does not connect door-to-door');
      }
      connectedPairs.add(pairKey(corridor.a, corridor.b));
    }

    if (!allRoomsReachSpawn(layout.rooms, connectedPairs)) {
      issues.push('room graph is disconnected from spawn');
    }
  }
  return unique(issues);
}

export function placeMonsters(
  layout: EncounterLayout,
  roster: readonly { count: number }[],
): MonsterPlacement[] {
  const issues = validateEncounterLayout(layout, roster.map((entry) => entry.count));
  if (issues.length > 0) throw new EncounterLayoutError(issues);
  const placements: MonsterPlacement[] = [];
  for (const room of layout.rooms) {
    const cells = cellsOfRect(room.mobsRect).map(parseCell);
    let cursor = 0;
    for (const monsterIndex of room.monsterIndexes) {
      const count = roster[monsterIndex]?.count;
      if (count === undefined) throw new EncounterLayoutError([`${room.name}: missing roster entry`]);
      for (let instanceIndex = 0; instanceIndex < count; instanceIndex += 1) {
        const cell = cells[cursor];
        if (cell === undefined) throw new EncounterLayoutError([`${room.name}: placement capacity exhausted`]);
        placements.push({
          roomId: room.id,
          monsterIndex,
          instanceIndex,
          x: (cell.x + 0.5) / layout.gridW,
          y: (cell.y + 0.5) / layout.gridH,
        });
        cursor += 1;
      }
    }
  }
  return placements;
}

export function veilsFromRooms(layout: EncounterLayout): BattleVeil[] {
  const issues = validateEncounterLayout(layout);
  if (issues.length > 0) throw new EncounterLayoutError(issues);
  return layout.rooms.map((room) => ({
    id: room.id,
    kind: 'fog',
    x: (room.mobsRect.x + room.mobsRect.w / 2) / layout.gridW,
    y: (room.mobsRect.y + room.mobsRect.h / 2) / layout.gridH,
    widthCells: room.mobsRect.w,
    heightCells: room.mobsRect.h,
  }));
}

export function spawnRoom(layout: EncounterLayout): LayoutRoom {
  const room = layout.rooms.find((candidate) => candidate.spawn);
  if (room === undefined) throw new EncounterLayoutError(['layout has no spawn room']);
  return room;
}

function adjacencyPairs(brief: EncounterMapBrief): [string, string][] {
  const roomIds = new Set(brief.rooms.map((room) => room.id));
  const pairs = new Map<string, [string, string]>();
  for (const room of brief.rooms) {
    for (const adjacent of room.adjacentRoomIds) {
      if (!roomIds.has(adjacent)) throw new Error(`${room.name} references an unknown adjacent room`);
      if (adjacent === room.id) throw new Error(`${room.name} cannot be adjacent to itself`);
      pairs.set(pairKey(room.id, adjacent), [room.id, adjacent]);
    }
  }
  if (brief.rooms.length > 1 && pairs.size === 0) throw new Error('multi-room layout has no adjacency');
  return [...pairs.values()];
}

function routeCorridor(
  a: LayoutRoom,
  b: LayoutRoom,
  occupied: ReadonlySet<string>,
  existing: ReadonlySet<string>,
  gridW: number,
  gridH: number,
): Cell[] {
  const aCells = cellsOfRects(a.rects);
  const bCells = cellsOfRects(b.rects);
  const starts = boundaryNeighbors(aCells, occupied, gridW, gridH);
  const goals = new Set(boundaryNeighbors(bCells, occupied, gridW, gridH).map(cellKey));
  const queue = starts.map((cell) => ({ cell, path: [cell] }));
  const seen = new Set(starts.map(cellKey));
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (goals.has(cellKey(current.cell))) return current.path;
    for (const next of neighbors(current.cell)) {
      const key = cellKey(next);
      if (seen.has(key) || !cellInBounds(next, gridW, gridH)) continue;
      if (occupied.has(key)) continue;
      seen.add(key);
      // Existing corridors are valid shared junctions and remain one cell wide.
      queue.push({ cell: next, path: [...current.path, next] });
      if (existing.has(key) && goals.has(key)) return [...current.path, next];
    }
  }
  throw new Error(`cannot route corridor ${a.name} → ${b.name}`);
}

function boundaryNeighbors(
  roomCells: ReadonlySet<string>,
  occupied: ReadonlySet<string>,
  gridW: number,
  gridH: number,
): Cell[] {
  const result = new Map<string, Cell>();
  for (const key of roomCells) {
    for (const neighbor of neighbors(parseCell(key))) {
      const neighborKey = cellKey(neighbor);
      if (cellInBounds(neighbor, gridW, gridH) && !occupied.has(neighborKey)) {
        result.set(neighborKey, neighbor);
      }
    }
  }
  return [...result.values()].sort((left, right) => left.y - right.y || left.x - right.x);
}

function compressPath(path: readonly Cell[]): LayoutRect[] {
  if (path.length === 0) return [];
  const result: LayoutRect[] = [];
  let start = path[0];
  let previous = path[0];
  if (start === undefined || previous === undefined) return result;
  let direction: 'horizontal' | 'vertical' | null = null;
  for (let index = 1; index < path.length; index += 1) {
    const cell = path[index];
    if (cell === undefined) continue;
    const nextDirection = cell.y === previous.y ? 'horizontal' : 'vertical';
    if (direction !== null && nextDirection !== direction) {
      result.push(rectFromSegment(start, previous));
      start = previous;
    }
    direction = nextDirection;
    previous = cell;
  }
  result.push(rectFromSegment(start, previous));
  return result;
}

function rectFromSegment(a: Cell, b: Cell): LayoutRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x) + 1,
    h: Math.abs(a.y - b.y) + 1,
  };
}

function allRoomsReachSpawn(rooms: readonly LayoutRoom[], pairs: ReadonlySet<string>): boolean {
  const spawn = rooms.find((room) => room.spawn);
  if (spawn === undefined) return false;
  const reached = new Set([spawn.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const room of rooms) {
      if (reached.has(room.id)) continue;
      if ([...reached].some((id) => pairs.has(pairKey(id, room.id)))) {
        reached.add(room.id);
        changed = true;
      }
    }
  }
  return reached.size === rooms.length;
}

function roomCellSet(rooms: readonly LayoutRoom[]): Set<string> {
  const cells = new Set<string>();
  for (const room of rooms) for (const key of cellsOfRects(room.rects)) cells.add(key);
  return cells;
}

function cellsOfRects(rects: readonly LayoutRect[]): Set<string> {
  const cells = new Set<string>();
  for (const rect of rects) for (const key of cellsOfRect(rect)) cells.add(key);
  return cells;
}

function cellsOfRect(rect: LayoutRect): string[] {
  const cells: string[] = [];
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) cells.push(`${String(x)},${String(y)}`);
  }
  return cells;
}

function cellsConnected(cells: ReadonlySet<string>): boolean {
  const first = cells.values().next().value;
  if (first === undefined) return false;
  const visited = new Set([first]);
  const queue = [parseCell(first)];
  while (queue.length > 0) {
    const cell = queue.shift();
    if (cell === undefined) break;
    for (const neighbor of neighbors(cell)) {
      const key = cellKey(neighbor);
      if (cells.has(key) && !visited.has(key)) {
        visited.add(key);
        queue.push(neighbor);
      }
    }
  }
  return visited.size === cells.size;
}

function touches(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const key of left) {
    if (neighbors(parseCell(key)).some((neighbor) => right.has(cellKey(neighbor)))) return true;
  }
  return false;
}

function neighbors(cell: Cell): Cell[] {
  return [
    { x: cell.x + 1, y: cell.y },
    { x: cell.x, y: cell.y + 1 },
    { x: cell.x - 1, y: cell.y },
    { x: cell.x, y: cell.y - 1 },
  ];
}

function cellKey(cell: Cell): string {
  return `${String(cell.x)},${String(cell.y)}`;
}

function parseCell(key: string): Cell {
  const [x, y] = key.split(',').map(Number);
  if (x === undefined || y === undefined) throw new Error(`Invalid cell key ${key}`);
  return { x, y };
}

function cellInBounds(cell: Cell, gridW: number, gridH: number): boolean {
  return cell.x >= 0 && cell.y >= 0 && cell.x < gridW && cell.y < gridH;
}

function rectInBounds(rect: LayoutRect, gridW: number, gridH: number): boolean {
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= gridW && rect.y + rect.h <= gridH;
}

function inset(rect: LayoutRect, amount: number): LayoutRect {
  const w = rect.w - amount * 2;
  const h = rect.h - amount * 2;
  if (w < 1 || h < 1) throw new Error('room is too small for an interior mobsRect');
  return { x: rect.x + amount, y: rect.y + amount, w, h };
}

function translate(rect: LayoutRect, x: number, y: number): LayoutRect {
  return { ...rect, x: rect.x + x, y: rect.y + y };
}

function rotate<T>(items: readonly T[], amount: number): T[] {
  return [...items.slice(amount), ...items.slice(0, amount)];
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function requireRoom(rooms: readonly LayoutRoom[], id: string): LayoutRoom {
  const room = rooms.find((candidate) => candidate.id === id);
  if (room === undefined) throw new Error(`Unknown room ${id}`);
  return room;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
