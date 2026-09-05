import { z } from 'zod';

export const encounterMapAspectSchema = z.enum(['4:3', '16:9', '1:1']);
export type EncounterMapAspect = z.infer<typeof encounterMapAspectSchema>;

export const encounterRoomSizeSchema = z.enum(['small', 'medium', 'large']);
export type EncounterRoomSize = z.infer<typeof encounterRoomSizeSchema>;

export const layoutRectSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
});
export type LayoutRect = z.infer<typeof layoutRectSchema>;

export const encounterMapRoomBriefSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  description: z.string(),
  size: encounterRoomSizeSchema,
  monsterIndexes: z.array(z.number().int().nonnegative()),
  adjacentRoomIds: z.array(z.uuid()),
});
export type EncounterMapRoomBrief = z.infer<typeof encounterMapRoomBriefSchema>;

export const encounterMapBriefSchema = z.object({
  theme: z.string(),
  aspect: encounterMapAspectSchema,
  entryRoomId: z.uuid(),
  rosterCounts: z.array(z.number().int().positive()),
  rooms: z.array(encounterMapRoomBriefSchema).min(1).max(10),
});
export type EncounterMapBrief = z.infer<typeof encounterMapBriefSchema>;

/** Outward cardinal direction across the spawn room's outer wall. */
export const layoutEntranceSideSchema = z.enum(['north', 'south', 'east', 'west']);
export type LayoutEntranceSide = z.infer<typeof layoutEntranceSideSchema>;

export const layoutEntranceSchema = z.object({
  /** Grid cell of the spawn room's outer wall that carries the entrance. */
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  side: layoutEntranceSideSchema,
  /**
   * Detected marker position (normalized) from the stylized map — the
   * stagingPoint-style refinement. Positions only, never structure: the
   * cell/side stay layout-authoritative (doc 11 D7).
   */
  observed: z
    .object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    })
    .optional(),
});
export type LayoutEntrance = z.infer<typeof layoutEntranceSchema>;

const ENTRANCE_SIDE_DELTAS: Readonly<Record<LayoutEntranceSide, readonly [number, number]>> = {
  north: [0, -1],
  south: [0, 1],
  west: [-1, 0],
  east: [1, 0],
};

/** Unit step across the wall the entrance opens through (outward). */
export function entranceSideDelta(side: LayoutEntranceSide): readonly [number, number] {
  return ENTRANCE_SIDE_DELTAS[side];
}

/** The cell across the entrance's wall (may be off-grid for map-edge entrances). */
export function entranceOutwardCell(entrance: LayoutEntrance): { x: number; y: number } {
  const [dx, dy] = entranceSideDelta(entrance.side);
  return { x: entrance.x + dx, y: entrance.y + dy };
}

/** The cell one step into the room from the entrance cell. */
export function entranceInwardCell(entrance: LayoutEntrance): { x: number; y: number } {
  const [dx, dy] = entranceSideDelta(entrance.side);
  return { x: entrance.x - dx, y: entrance.y - dy };
}

export function cellKeyOf(cell: { x: number; y: number }): string {
  return `${String(cell.x)},${String(cell.y)}`;
}

export const layoutRoomSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  rects: z.array(layoutRectSchema).min(1).max(3),
  mobsRect: layoutRectSchema,
  description: z.string(),
  monsterIndexes: z.array(z.number().int().nonnegative()),
  spawn: z.boolean(),
  letter: z.string().optional(),
  markerHue: z.number().optional(),
  markerColorName: z.string().optional(),
  /**
   * The party's way in (entrance/exit spawn zones, doc 11): one opening in
   * the spawn room's outer wall. Only the spawn room may carry one, and a
   * layout carries at most one. Optional — legacy layouts have none and fall
   * back to the mobsRect-center staging ground.
   */
  entrance: layoutEntranceSchema.optional(),
  stagingPoint: z
    .object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    })
    .optional(),
});
export type LayoutRoom = z.infer<typeof layoutRoomSchema>;

export const layoutCorridorSchema = z.object({
  a: z.uuid(),
  b: z.uuid(),
  rects: z.array(layoutRectSchema).min(1),
});
export type LayoutCorridor = z.infer<typeof layoutCorridorSchema>;


export const encounterLayoutSchema = z
  .object({
    gridW: z.number().int().min(12).max(60),
    gridH: z.number().int().min(12).max(60),
    theme: z.string(),
    rooms: z.array(layoutRoomSchema).min(1).max(10),
    corridors: z.array(layoutCorridorSchema),
  })
  .superRefine((layout, context) => {
    if (layout.rooms.filter((room) => room.spawn).length !== 1) {
      context.addIssue({ code: 'custom', message: 'layout must contain exactly one spawn room' });
    }
    const isStaging = layout.rooms.some((room) => room.stagingPoint !== undefined);
    const owners = new Map<string, string>();
    const corridorCellKeys = new Set<string>();
    for (const corridor of layout.corridors) {
      for (const key of layoutCells(corridor.rects)) corridorCellKeys.add(key);
    }
    if (layout.rooms.filter((room) => room.entrance !== undefined).length > 1) {
      context.addIssue({ code: 'custom', message: 'layout must contain at most one entrance' });
    }
    for (const room of layout.rooms) {
      const roomCells = new Set(layoutCells(room.rects));
      const entrance = room.entrance;
      if (entrance !== undefined) {
        if (!room.spawn) {
          context.addIssue({
            code: 'custom',
            message: `${room.name}: only the spawn room may carry an entrance`,
          });
        }
        if (!roomCells.has(cellKeyOf(entrance))) {
          context.addIssue({
            code: 'custom',
            message: `${room.name}: entrance cell is outside the room`,
          });
        }
        const outward = entranceOutwardCell(entrance);
        if (roomCells.has(cellKeyOf(outward))) {
          context.addIssue({
            code: 'custom',
            message: `${room.name}: entrance side does not face the outer wall`,
          });
        }
        if (corridorCellKeys.has(cellKeyOf(outward))) {
          context.addIssue({
            code: 'custom',
            message: `${room.name}: entrance opens into a corridor`,
          });
        }
      }
      for (const rect of [...room.rects, room.mobsRect]) {
        if (rect.x + rect.w > layout.gridW || rect.y + rect.h > layout.gridH) {
          context.addIssue({ code: 'custom', message: `${room.name}: rectangle outside grid` });
        }
      }
      if (!isStaging) {
        for (const key of roomCells) {
          if (owners.has(key) && owners.get(key) !== room.id) {
            context.addIssue({ code: 'custom', message: `${room.name}: overlaps another room` });
          }
          owners.set(key, room.id);
        }
      }
      for (const key of layoutCells([room.mobsRect])) {
        if (!roomCells.has(key)) {
          context.addIssue({ code: 'custom', message: `${room.name}: mobsRect leaves room union` });
        }
      }
    }
    for (const corridor of layout.corridors) {
      if (corridor.rects.some((rect) => rect.w !== 1 && rect.h !== 1)) {
        context.addIssue({ code: 'custom', message: 'corridors must be one cell wide' });
      }
    }
  });
export type EncounterLayout = z.infer<typeof encounterLayoutSchema>;

function layoutCells(rects: readonly LayoutRect[]): string[] {
  const cells = new Set<string>();
  for (const rect of rects) {
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        cells.add(`${String(x)},${String(y)}`);
      }
    }
  }
  return [...cells];
}

export interface MonsterPlacement {
  roomId: string;
  monsterIndex: number;
  instanceIndex: number;
  /** Grid-cell center, normalized to the layout dimensions. */
  x: number;
  y: number;
}
