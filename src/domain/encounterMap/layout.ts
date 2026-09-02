import type { BattleVeil } from '@/domain/battle';
import {
  encounterLayoutSchema,
  encounterMapBriefSchema,
  type EncounterLayout,
  type EncounterMapAspect,
  type EncounterMapBrief,
  type EncounterRoomSize,
  type LayoutCorridor,
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
export function packRooms(input: EncounterMapBrief): EncounterLayout {
  const brief = encounterMapBriefSchema.parse(input);
  const attempts: string[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const layout = packAttempt(brief, attempt);
      const issues = validateEncounterLayout(layout, brief.rosterCounts);
      if (issues.length === 0) return encounterLayoutSchema.parse(layout);
      attempts.push(`attempt ${String(attempt + 1)}: ${issues.join(', ')}`);
    } catch (error) {
      attempts.push(
        `attempt ${String(attempt + 1)}: ${error instanceof Error ? error.message : String(error)}`,
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

  return { gridW, gridH, theme: brief.theme, rooms, corridors };
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

  const ownerByCell = new Map<string, string>();
  for (const room of layout.rooms) {
    const cells = cellsOfRects(room.rects);
    if (cells.size === 0 || !cellsConnected(cells)) issues.push(`${room.name}: room union is disconnected`);
    for (const rect of [...room.rects, room.mobsRect]) {
      if (!rectInBounds(rect, layout.gridW, layout.gridH)) issues.push(`${room.name}: rectangle outside grid`);
    }
    for (const key of cells) {
      const owner = ownerByCell.get(key);
      if (owner !== undefined && owner !== room.id) issues.push(`${room.name}: overlaps another room`);
      ownerByCell.set(key, room.id);
    }
    const mobCells = cellsOfRect(room.mobsRect);
    for (const key of mobCells) {
      if (!cells.has(key)) issues.push(`${room.name}: mobsRect leaves room union`);
      const cell = parseCell(key);
      if (neighbors(cell).some((neighbor) => !cells.has(cellKey(neighbor)))) {
        issues.push(`${room.name}: mobsRect is not inside the room border`);
        break;
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
