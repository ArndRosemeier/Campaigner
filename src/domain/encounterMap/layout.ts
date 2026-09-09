import { errorMessage } from '@/lib/errors';
import { newId } from '@/domain/entity';
import type { z } from 'zod';
import type { BattleVeil } from '@/domain/battle';
import {
  encounterLayoutSchema,
  encounterMapBriefSchema,
  cellKeyOf,
  entranceOutwardCell,
  entranceSideDelta,
  spawnFirstPath,
  type EncounterLayout,
  type EncounterMapAspect,
  type EncounterMapBrief,
  type EncounterPreset,
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

/**
 * The Dungeon preset's FIXED finer grid (docs/11 D10): exactly ×2 the base
 * tier per aspect, independent of room count — the same viewport then shows
 * twice the cells per side (each cell at half the px), which is what makes a
 * multi-room dungeon complex fit on one board. Room size classes stay in
 * standard cells (cells keep their in-world meaning); the schema max (60)
 * already admits every dungeon dimension. All values ≤ 60 by construction.
 */
const GRID_BY_ASPECT_DUNGEON: Readonly<Record<EncounterMapAspect, { gridW: number; gridH: number }>> = {
  '4:3': { gridW: 48, gridH: 36 },
  '16:9': { gridW: 56, gridH: 32 },
  '1:1': { gridW: 40, gridH: 40 },
};

export function gridDimensionsFor(preset: EncounterPreset, aspect: EncounterMapAspect): { gridW: number; gridH: number } {
  return preset === 'dungeon' ? GRID_BY_ASPECT_DUNGEON[aspect] : GRID_BY_ASPECT[aspect];
}

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

/**
 * The packer's geometry (packer-internal): packed rooms always carry
 * rects + mobsRect by construction — the packer never sees vision-path
 * rooms. The guard is loud-if-violated (never a silent undefined spread).
 */
function requirePackedGeometry(room: LayoutRoom): { rects: LayoutRect[]; mobsRect: LayoutRect } {
  if (room.rects === undefined || room.mobsRect === undefined) {
    throw new EncounterLayoutError([`${room.name}: the room packer needs packed room geometry`]);
  }
  return { rects: room.rects, mobsRect: room.mobsRect };
}

/** Deterministic bounded packer. No coordinates ever come from the LLM.
 * The input is the brief's INPUT type: fields with schema defaults (`preset`)
 * stay optional for callers — the parse below fills them. */
export function packRooms(
  input: z.input<typeof encounterMapBriefSchema>,
  variant = 0,
): EncounterLayout {
  const brief = encounterMapBriefSchema.parse(input);
  const failures: string[] = [];
  const candidates: EncounterLayout[] = [];
  // A single valid packing is not enough: different slot assignments can turn
  // the same adjacency graph into a long U or a compact branching dungeon.
  // Keep this deterministic and bounded; there is no model call or randomness
  // in geometry selection.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const layout = packAttempt(brief, attempt + variant);
      const issues = validateEncounterLayout(layout, brief.rosterCounts);
      if (issues.length === 0) {
        candidates.push(encounterLayoutSchema.parse(layout));
      } else {
        failures.push(`attempt ${String(attempt + 1)}: ${issues.join(', ')}`);
      }
    } catch (error) {
      failures.push(`attempt ${String(attempt + 1)}: ${errorMessage(error)}`);
    }
  }
  if (candidates.length > 0) {
    return candidates.reduce((best, candidate) =>
      topologyScore(candidate, brief) < topologyScore(best, brief) ? candidate : best,
    );
  }
  throw new EncounterLayoutError(failures);
}

function packAttempt(brief: EncounterMapBrief, attempt: number): EncounterLayout {
  const { gridW, gridH } = gridDimensionsFor(brief.preset, brief.aspect);
  const count = brief.rooms.length;
  const columns = Math.min(brief.aspect === '16:9' ? 4 : 3, count);
  const rows = Math.ceil(count / columns);
  const slotW = Math.floor(gridW / columns);
  const slotH = Math.floor(gridH / rows);
  // The path is the BRIEF's room order (docs/11 D13), independent of the
  // geometric slot assignment below. First path room = spawn room.
  const path = spawnFirstPath(
    brief.rooms.map((room) => room.id),
    brief.entryRoomId,
  );
  const ordered = topologyOrderedRooms(brief, columns, rows, attempt);
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
      // The room's GM key travels WITH the room: packing rotates `brief.rooms`
      // (attempt % count), so any parallel key list would desync.
      key: room.key,
      keyTreasure: room.keyTreasure,
      // The room's own challenge target travels with it for the same reason.
      ...(room.targetLevel === undefined ? {} : { targetLevel: room.targetLevel }),
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

  return { gridW, gridH, theme: brief.theme, rooms, corridors, path };
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
  for (const rect of requirePackedGeometry(room).rects) {
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
  // Vision-path rooms carry no polygon geometry (docs/11 vision path) — the
  // observed point is their staging ground, resolved by the caller
  // (battleSeed). A rect here would be invented geometry, so this throws
  // loud instead of centering silently (AGENTS rule 1).
  if (room.mobsRect === undefined || room.rects === undefined) {
    throw new EncounterLayoutError([`${room.name}: vision room has no staging rect — seed at its observed point`]);
  }
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

/** Returns every structural problem; an empty list means the layout is safe. */
export function validateEncounterLayout(
  input: EncounterLayout,
  rosterCounts: readonly number[] = [],
): string[] {
  const parsed = encounterLayoutSchema.safeParse(input);
  if (!parsed.success) return parsed.error.issues.map((issue) => issue.message);
  const layout = parsed.data;
  // Vision-path layouts (docs/11 vision path) carry no packed geometry — the
  // image is the map — so they validate on a separate branch: observed
  // points, declared-graph connectivity and roster assignment only.
  if (layout.mapPath === 'vision') return validateVisionLayout(layout, rosterCounts);
  const issues: string[] = [];
  if (layout.rooms.filter((room) => room.spawn).length !== 1) {
    issues.push('layout must contain exactly one spawn room');
  }

  const ownerByCell = new Map<string, string>();
  const corridorCellKeys = new Set<string>();
  for (const corridor of layout.corridors) {
    // The schema refine already rejects a classic corridor without painted
    // geometry; this guard only satisfies the optional type (dead by
    // construction, loud if ever reached).
    if (corridor.rects === undefined) {
      issues.push('classic corridor carries no geometry');
      continue;
    }
    for (const key of cellsOfRects(corridor.rects)) corridorCellKeys.add(key);
  }
  if (layout.rooms.filter((room) => room.entrance !== undefined).length > 1) {
    issues.push('layout must contain at most one entrance');
  }
  for (const room of layout.rooms) {
    // Same construction as above: classic rooms always carry geometry past
    // the schema refine.
    if (room.rects === undefined || room.mobsRect === undefined) {
      issues.push(`${room.name}: classic room carries no geometry`);
      continue;
    }
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
    issues.push(...checkRosterAssignments(layout, rosterCounts));
  }

  const roomIds = new Set(layout.rooms.map((room) => room.id));
  const connectedPairs = new Set<string>();
  for (const corridor of layout.corridors) {
    if (!roomIds.has(corridor.a) || !roomIds.has(corridor.b)) {
      issues.push('corridor references an unknown room');
      continue;
    }
    if (corridor.rects === undefined) {
      issues.push('classic corridor carries no geometry');
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
    const aRoom = requireRoom(layout.rooms, corridor.a);
    const bRoom = requireRoom(layout.rooms, corridor.b);
    if (aRoom.rects === undefined || bRoom.rects === undefined) {
      issues.push('classic room carries no geometry');
      continue;
    }
    const aCells = cellsOfRects(aRoom.rects);
    const bCells = cellsOfRects(bRoom.rects);
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

/**
 * Vision-path validation (docs/11 vision path): the image is the map, so
 * there is no packed geometry to check — rooms resolve to their observed
 * plaque points and corridors are declared edges. Loud on: more than one
 * spawn room, a room without its observed point (never a defaulted spawn),
 * a corridor naming an unknown room, a declared graph disconnected from
 * spawn, and roster-assignment drift. Layout drift between the painted map
 * and the declared graph is ACCEPTED and known (docs/11 drift debt) — this
 * branch checks the declaration, never the pixels (no connectivity verifier
 * in this arc, explicit non-goal).
 */
function validateVisionLayout(
  layout: EncounterLayout,
  rosterCounts: readonly number[],
): string[] {
  const issues: string[] = [];
  if (layout.rooms.filter((room) => room.spawn).length !== 1) {
    issues.push('layout must contain exactly one spawn room');
  }
  for (const room of layout.rooms) {
    if (room.observedX === undefined || room.observedY === undefined) {
      issues.push(`${room.name}: vision room carries no observed plaque point — refusing a defaulted spawn`);
    }
  }
  const roomIds = new Set(layout.rooms.map((room) => room.id));
  const connectedPairs = new Set<string>();
  for (const corridor of layout.corridors) {
    if (!roomIds.has(corridor.a) || !roomIds.has(corridor.b)) {
      issues.push('corridor references an unknown room');
      continue;
    }
    connectedPairs.add(pairKey(corridor.a, corridor.b));
  }
  if (!allRoomsReachSpawn(layout.rooms, connectedPairs)) {
    issues.push('room graph is disconnected from spawn');
  }
  issues.push(...checkRosterAssignments(layout, rosterCounts));
  return unique(issues);
}

/** Roster↔room assignment checks, shared by the classic and vision branches. */
function checkRosterAssignments(
  layout: EncounterLayout,
  rosterCounts: readonly number[],
): string[] {
  const issues: string[] = [];
  if (rosterCounts.length === 0) return issues;
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
  return issues;
}

/**
 * Point-room cell order (docs/11 vision path): the deterministic spawn-cell
 * enumeration for a room WITHOUT packed geometry. First is the observed
 * plaque cell itself; the rest spiral outward in Chebyshev rings (ring d
 * lists every dx/dy with max(|dx|,|dy|) === d, ascending dx then dy),
 * skipping out-of-grid cells. `placeMonsters` and `veilsFromSpawnClusters`
 * share this ONE order with the same cursor slicing, so every spawn cell is
 * veiled by construction. No Math.random: the same observed point always
 * yields the same cells. A room without its observed point throws loud —
 * never a centered default (AGENTS rule 1).
 */
export function pointRoomCells(room: LayoutRoom, gridW: number, gridH: number): Cell[] {
  if (room.observedX === undefined || room.observedY === undefined) {
    throw new EncounterLayoutError([
      `${room.name}: vision room carries no observed plaque point — refusing a defaulted spawn`,
    ]);
  }
  const cx = Math.min(gridW - 1, Math.max(0, Math.floor(room.observedX * gridW)));
  const cy = Math.min(gridH - 1, Math.max(0, Math.floor(room.observedY * gridH)));
  const cells: Cell[] = [{ x: cx, y: cy }];
  const maxRing = Math.max(gridW, gridH);
  for (let ring = 1; ring <= maxRing; ring += 1) {
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= gridW || y >= gridH) continue;
        cells.push({ x, y });
      }
    }
  }
  return cells;
}

export function placeMonsters(
  layout: EncounterLayout,
  roster: readonly { count: number }[],
): MonsterPlacement[] {
  const issues = validateEncounterLayout(layout, roster.map((entry) => entry.count));
  if (issues.length > 0) throw new EncounterLayoutError(issues);
  const placements: MonsterPlacement[] = [];
  for (const room of layout.rooms) {
    // Vision-path rooms scatter around their observed plaque point (the
    // point-based fallback, docs/11 vision path); classic rooms enumerate
    // their mobsRect exactly as before.
    const cells = room.mobsRect === undefined
      ? pointRoomCells(room, layout.gridW, layout.gridH)
      : cellsOfRect(room.mobsRect).map(parseCell);
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
  return layout.rooms.map((room) => {
    // The legacy helper resolves veils from packed geometry — a vision-path
    // room has none, and its veil comes from the spawn-cluster fallback
    // below. Failing loud keeps the geometry-less room from ever reading a
    // centered default veil (AGENTS rule 1).
    if (room.mobsRect === undefined) {
      throw new EncounterLayoutError([`${room.name}: vision room has no mobsRect — veil it from its observed point`]);
    }
    return {
      id: room.id,
      kind: 'fog',
      x: (room.mobsRect.x + room.mobsRect.w / 2) / layout.gridW,
      y: (room.mobsRect.y + room.mobsRect.h / 2) / layout.gridH,
      widthCells: room.mobsRect.w,
      heightCells: room.mobsRect.h,
    };
  });
}

/**
 * One fog veil per monster spawn GROUP (docs/11 D4, owner-ratified): each
 * room's `mobsRect` is split per `monsterIndexes` entry — in the owner's
 * group order — into the cell bounding box of that group's `placeMonsters`
 * cells (the same row-major `mobsRect` enumeration, sliced by the roster
 * counts, so every spawn cell is covered by construction). Rooms with no
 * monster groups seed no veils.
 *
 * COVER CONVENTION (veil reachability): a seeded group veil covers its
 * group's spawn area PLUS a one-cell margin on every side, clamped to the
 * board bounds — the minimal group box on its own sits exactly coincident
 * with the mob tokens, and tokens paint strictly above veils, so a minimal
 * box leaves no grabbable veil body and no reachable edge handle (both 100%
 * occluded). The margin ring stays directly clickable for tokens (they win
 * hit-testing above) while exposing veil body for drags and edge pads for
 * resizes around them; a 1x1 group therefore seeds at most 3x3. GM-created
 * veils never pass through here and are untouched.
 *
 * Path-rail identity (BattleSurface resolves rooms through `veil.id` and
 * this module must not change the surface): the room's FIRST group keeps
 * `id = room.id`, so the rail's "Reveal next room" still resolves and lifts
 * the room's primary veil; later groups mint fresh ids and every group veil
 * carries `roomId = room.id` for the room resolution. All veils are kind
 * `'fog'` in the `battleVeilSchema` shape (int cells ≥ VEIL_MIN_CELLS holds
 * because every emitted group owns at least one placement cell, and the
 * margin only grows the span).
 *
 * OVERLAP MERGE (owner-observed stacked veils): same-room groups own
 * CONTIGUOUS runs of one mobsRect, so consecutive groups always own adjacent
 * cells and their +1-margin covers always share ground — without a merge a
 * single-room two-type encounter seeds a big veil plus a smaller one stacked
 * on top, painting above (DOM order) with no staged-reveal purpose. Same-room
 * covers that OVERLAP (share at least one cell) therefore merge into one veil
 * — the bounding box of the union, re-clamped to the board — keeping the
 * first-emitted identity (`id = room.id`, `roomId = room.id`), kind fog.
 * Disjoint same-room covers stay separate (staged reveal still works), and
 * cross-room covers NEVER merge (room-id rail semantics untouched). Net
 * effect: single-room adjacent spawns seed exactly one veil; spatially
 * separated groups seed several.
 */

/** One per-group cover entering the overlap merge: the room it belongs to,
 * the veil identity it would carry unmerged, and its clamped cell rect. */
export interface VeilCover {
  roomId: string;
  veilId: string;
  rect: LayoutRect;
}

/**
 * Pure overlap merge for seeded group-veil covers (docs/11 D4): covers merge
 * ONLY within one room, ONLY when they share at least one cell (strict area
 * overlap — edge-touching with no shared ground stays separate, staged
 * reveal still works). A merged component emits the bounding box of the
 * union (re-clamped to the board by the caller-supplied bounds) under the
 * first-emitted cover's identity. Cross-room covers never merge however much
 * they overlap — the rail resolves rooms per room id.
 */
export function mergeVeilCovers(
  covers: readonly VeilCover[],
  gridW: number,
  gridH: number,
): VeilCover[] {
  const merged: VeilCover[] = [];
  // Union-find over cover indexes, one component set per room (cross-room
  // covers never union, so components never span rooms by construction).
  const parent = covers.map((_, index) => index);
  const find = (index: number): number => {
    const root = parent[index];
    if (root === undefined || root === index) return index;
    const resolved = find(root);
    parent[index] = resolved;
    return resolved;
  };
  for (let left = 0; left < covers.length; left += 1) {
    for (let right = left + 1; right < covers.length; right += 1) {
      const a = covers[left];
      const b = covers[right];
      if (a === undefined || b === undefined) continue;
      if (a.roomId !== b.roomId) continue;
      if (!rectsOverlap(a.rect, b.rect)) continue;
      parent[find(left)] = find(right);
    }
  }
  const seen = new Map<number, { firstIndex: number; members: VeilCover[] }>();
  covers.forEach((cover, index) => {
    const root = find(index);
    const entry = seen.get(root);
    if (entry === undefined) {
      seen.set(root, { firstIndex: index, members: [cover] });
    } else {
      entry.members.push(cover);
    }
  });
  // Emission order stays stable: components in first-member order, so a
  // room's first component still carries the room id for the rail.
  const components = [...seen.values()].sort((left, right) => left.firstIndex - right.firstIndex);
  for (const { members } of components) {
    const first = members[0];
    if (first === undefined) throw new Error('Veil cover merge produced an empty component');
    if (members.length === 1) {
      merged.push(first);
      continue;
    }
    const x0 = Math.max(0, Math.min(...members.map((member) => member.rect.x)));
    const y0 = Math.max(0, Math.min(...members.map((member) => member.rect.y)));
    const x1 = Math.min(gridW, Math.max(...members.map((member) => member.rect.x + member.rect.w)));
    const y1 = Math.min(gridH, Math.max(...members.map((member) => member.rect.y + member.rect.h)));
    if (x1 <= x0 || y1 <= y0) throw new Error('Merged veil cover is empty after clamping');
    merged.push({ roomId: first.roomId, veilId: first.veilId, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
  }
  return merged;
}

/** Strict area overlap: the half-open rects share at least one cell. */
function rectsOverlap(a: LayoutRect, b: LayoutRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
export function veilsFromSpawnClusters(
  layout: EncounterLayout,
  rosterCounts: readonly number[],
): BattleVeil[] {
  const issues = validateEncounterLayout(layout, rosterCounts);
  if (issues.length > 0) throw new EncounterLayoutError(issues);
  const covers: VeilCover[] = [];
  for (const room of layout.rooms) {
    // Vision-path rooms slice the same deterministic point-cell order
    // `placeMonsters` assigns (the observed plaque point first), so every
    // spawn cell is covered by construction — the margin + merge below are
    // shared verbatim.
    const cells = room.mobsRect === undefined
      ? pointRoomCells(room, layout.gridW, layout.gridH)
      : cellsOfRect(room.mobsRect).map(parseCell);
    let cursor = 0;
    let emittedForRoom = 0;
    for (const monsterIndex of room.monsterIndexes) {
      const count = rosterCounts[monsterIndex];
      if (count === undefined) {
        throw new EncounterLayoutError([`${room.name}: missing roster entry`]);
      }
      const groupCells = cells.slice(cursor, cursor + count);
      cursor += count;
      // A zero-count group owns no spawn cells, so it seeds no veil; the
      // room's FIRST emitted veil still carries the room id for the rail.
      if (groupCells.length === 0) continue;
      const minX = Math.min(...groupCells.map((cell) => cell.x));
      const minY = Math.min(...groupCells.map((cell) => cell.y));
      const maxX = Math.max(...groupCells.map((cell) => cell.x));
      const maxY = Math.max(...groupCells.map((cell) => cell.y));
      // Cover convention: one-cell margin on every side, clamped to the
      // board bounds (Math.max/min clamp — no helper exists; rectInBounds
      // only tests). The span only grows, so VEIL_MIN_CELLS still holds.
      const coverX0 = Math.max(0, minX - 1);
      const coverY0 = Math.max(0, minY - 1);
      const coverX1 = Math.min(layout.gridW, maxX + 1 + 1);
      const coverY1 = Math.min(layout.gridH, maxY + 1 + 1);
      covers.push({
        roomId: room.id,
        veilId: emittedForRoom === 0 ? room.id : newId(),
        rect: { x: coverX0, y: coverY0, w: coverX1 - coverX0, h: coverY1 - coverY0 },
      });
      emittedForRoom += 1;
    }
  }
  // Overlap merge: same-room covers sharing ground collapse to their union
  // bounding box (first-emitted identity — the room id — survives, so the
  // rail's room-id resolution is untouched). The union only grows the span,
  // so VEIL_MIN_CELLS still holds for every merged veil.
  return mergeVeilCovers(covers, layout.gridW, layout.gridH).map((cover) => ({
    id: cover.veilId,
    kind: 'fog',
    x: (cover.rect.x + cover.rect.w / 2) / layout.gridW,
    y: (cover.rect.y + cover.rect.h / 2) / layout.gridH,
    widthCells: cover.rect.w,
    heightCells: cover.rect.h,
    roomId: cover.roomId,
  }));
}

export function spawnRoom(layout: EncounterLayout): LayoutRoom {
  const room = layout.rooms.find((candidate) => candidate.spawn);
  if (room === undefined) throw new EncounterLayoutError(['layout has no spawn room']);
  return room;
}

function topologyOrderedRooms(
  brief: EncounterMapBrief,
  columns: number,
  rows: number,
  attempt: number,
): EncounterMapBrief['rooms'] {
  const slots = Array.from({ length: columns * rows }, (_, index) => ({
    column: index % columns,
    row: Math.floor(index / columns),
  })).sort((left, right) => {
    const leftDistance = Math.abs(left.column - (columns - 1) / 2) + Math.abs(left.row - (rows - 1) / 2);
    const rightDistance = Math.abs(right.column - (columns - 1) / 2) + Math.abs(right.row - (rows - 1) / 2);
    return leftDistance - rightDistance ||
      ((left.column + left.row * columns + attempt) % (columns * rows)) -
        ((right.column + right.row * columns + attempt) % (columns * rows));
  });
  const byId = new Map(brief.rooms.map((room) => [room.id, room]));
  const neighborsById = new Map<string, Set<string>>(
    brief.rooms.map((room) => [room.id, new Set(room.adjacentRoomIds)]),
  );
  const remaining = new Set(brief.rooms.map((room) => room.id));
  const assigned = new Map<string, { column: number; row: number }>();
  const entry = byId.get(brief.entryRoomId) ?? brief.rooms[0];
  const firstSlot = slots[0];
  if (entry === undefined || firstSlot === undefined) return [...brief.rooms];
  assigned.set(entry.id, firstSlot);
  remaining.delete(entry.id);

  while (remaining.size > 0) {
    const nextId = [...remaining].sort((left, right) => {
      const leftLinks = [...(neighborsById.get(left) ?? [])].filter((id) => assigned.has(id)).length;
      const rightLinks = [...(neighborsById.get(right) ?? [])].filter((id) => assigned.has(id)).length;
      const leftDegree = neighborsById.get(left)?.size ?? 0;
      const rightDegree = neighborsById.get(right)?.size ?? 0;
      return rightLinks - leftLinks || rightDegree - leftDegree || left.localeCompare(right);
    })[0];
    if (nextId === undefined) break;
    const linkedSlots = [...(neighborsById.get(nextId) ?? [])]
      .map((id) => assigned.get(id))
      .filter((slot): slot is { column: number; row: number } => slot !== undefined);
    const freeSlots = slots.filter((slot) => ![...assigned.values()].some(
      (used) => used.column === slot.column && used.row === slot.row,
    ));
    const chosen = freeSlots.sort((left, right) => {
      const distance = (slot: { column: number; row: number }): number => linkedSlots.length === 0
        ? 0
        : Math.min(...linkedSlots.map((parent) => Math.abs(slot.column - parent.column) + Math.abs(slot.row - parent.row)));
      return distance(left) - distance(right) || left.row - right.row || left.column - right.column;
    })[0];
    if (chosen === undefined) break;
    assigned.set(nextId, chosen);
    remaining.delete(nextId);
  }

  // Disconnected inputs are rejected later by adjacencyPairs/validation, but
  // keep the ordering total so errors remain loud rather than dropping rooms.
  for (const room of brief.rooms) {
    if (assigned.has(room.id)) continue;
    const slot = slots.find((candidate) => ![...assigned.values()].some(
      (used) => used.column === candidate.column && used.row === candidate.row,
    ));
    if (slot !== undefined) assigned.set(room.id, slot);
  }
  return [...assigned.entries()]
    .sort((left, right) => left[1].row - right[1].row || left[1].column - right[1].column)
    .map(([id]) => byId.get(id))
    .filter((room): room is EncounterMapBrief['rooms'][number] => room !== undefined);
}

function topologyScore(layout: EncounterLayout, brief: EncounterMapBrief): number {
  const centers = new Map(layout.rooms.map((room) => {
    const { rects } = requirePackedGeometry(room);
    return [
      room.id,
      {
        x: rects.reduce((sum, rect) => sum + rect.x + rect.w / 2, 0) / rects.length,
        y: rects.reduce((sum, rect) => sum + rect.y + rect.h / 2, 0) / rects.length,
      },
    ];
  }));
  const pairs = adjacencyPairs(brief);
  const edgeDistance = pairs.reduce((sum, [left, right]) => {
    const a = centers.get(left);
    const b = centers.get(right);
    return a === undefined || b === undefined ? sum : sum + Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }, 0);
  const corridorLength = layout.corridors.reduce(
    (sum, corridor) => sum + (corridor.rects ?? []).reduce((inner, rect) => inner + rect.w * rect.h, 0),
    0,
  );
  const linePenalty = layout.rooms.reduce((sum, room) => {
    const linked = pairs
      .filter(([left, right]) => left === room.id || right === room.id)
      .map(([left, right]) => centers.get(left === room.id ? right : left))
      .filter((center): center is { x: number; y: number } => center !== undefined);
    if (linked.length < 3) return sum;
    const anchor = linked[0];
    const sameColumn = anchor !== undefined && linked.every((center) => center.x === anchor.x);
    const sameRow = anchor !== undefined && linked.every((center) => center.y === anchor.y);
    return sum + (sameColumn || sameRow ? 24 : 0);
  }, 0);
  return corridorLength * 2 + edgeDistance + linePenalty;
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
  const aCells = cellsOfRects(requirePackedGeometry(a).rects);
  const bCells = cellsOfRects(requirePackedGeometry(b).rects);
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
  for (const room of rooms) for (const key of cellsOfRects(requirePackedGeometry(room).rects)) cells.add(key);
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
