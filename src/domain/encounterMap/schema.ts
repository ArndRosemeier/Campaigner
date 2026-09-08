import { z } from 'zod';

export const encounterMapAspectSchema = z.enum(['4:3', '16:9', '1:1']);
export type EncounterMapAspect = z.infer<typeof encounterMapAspectSchema>;

export const encounterRoomSizeSchema = z.enum(['small', 'medium', 'large']);
export type EncounterRoomSize = z.infer<typeof encounterRoomSizeSchema>;

/**
 * The Dungeon preset (owner-ratified, docs/11 D10): a user-facing naming over
 * the existing layout engine — a fixed ×2 grid tier (each cell renders at
 * half the px, so the same viewport shows a bigger multi-room complex) with
 * the standard room size classes, monsters spread per room and the D4 room
 * veils. Persisted on the encounter artifact; the battle needs no field
 * (the board is a pure function of the layout, docs/11 D6).
 */
export const encounterPresetSchema = z.enum(['standard', 'dungeon']);
export type EncounterPreset = z.infer<typeof encounterPresetSchema>;

/**
 * Where an encounter takes place, classified by the encounter persona in its
 * EXISTING draft call (no extra LLM call, no verification pass — docs/11
 * D10 amendment). Persisted on the encounter artifact; owner-correctable in
 * the encounter editor. `'other'` is the unclassified value: legacy rows and
 * drafts that decline to classify parse to it via the zod default.
 */
export const encounterLocationKindSchema = z.enum([
  'dungeon',
  'building',
  'wilderness',
  'other',
]);
export type EncounterLocationKind = z.infer<typeof encounterLocationKindSchema>;

/**
 * The encounter's SHAPE (docs/11 D11): `'single'` is one arena (one room, no
 * corridors, no veils at seed — straight to melee); `'complex'` is a dungeon
 * (multi-room, sequential play over the layout's `path`, room veils). The
 * derived default: `locationKind === 'dungeon'` ⇒ complex, else single —
 * materialized for legacy rows by the v17 backfill and, at every read, by
 * `normalizeEncounterShapeData` (the parse-on-read convention). Editor
 * labels: "Encounter" (single) / "Dungeon" (complex).
 */
export const encounterSiteShapeSchema = z.enum(['single', 'complex']);
export type EncounterSiteShape = z.infer<typeof encounterSiteShapeSchema>;

/**
 * The encounter map's STYLE MODE (docs/11 natural-site mode, owner-ratified):
 * who holds ground truth for the rendered map. `'architectural'` — the layout
 * IS the truth: the schematic paints walls/corridors and the stylize prompt
 * preserves walls, openings and structure (the dungeon contract,
 * byte-identical to the pre-natural-site behavior). `'natural'` — the
 * encounter's own prose is the truth: the schematic encodes ONLY spawn
 * positions (soft organic patches + the entrance marker) and the stylize
 * prompt is prose-led (no materials line, no keep-walls clause; the usability
 * hard-bans stay). `undefined` on the artifact = derive (see
 * `resolveEncounterMapMode`); the owner's editor override wins over every
 * derived signal.
 */
export const encounterMapModeSchema = z.enum(['architectural', 'natural']);
export type EncounterMapMode = z.infer<typeof encounterMapModeSchema>;

/**
 * The Cartographer brief's `environment` classification ('dungeon' |
 * 'outdoor') — declared here so the pure mode derivation never imports llm.
 */
export type EncounterBriefEnvironment = 'dungeon' | 'outdoor';

/**
 * The natural-site mode resolution (docs/11 natural-site mode):
 *
 * 1. **Owner override** (`mapMode` on the encounter artifact, editor) — a
 *    forest dungeon (ruin in the woods) can be forced `'architectural'` and
 *    an open cave forced `'natural'`; it beats every derived signal.
 * 2. Derived — `'natural'` when EITHER signal says outdoors: the run's brief
 *    `environment === 'outdoor'` OR the persisted `locationKind ===
 *    'wilderness'`. The union is deliberate (an outdoor regeneration of a
 *    mis-classified row follows the fresh brief; an outdoor row re-briefed
 *    indoors stays natural until re-classified).
 * 3. Everything else — `'architectural'`, byte-identical to the pre-mode
 *    behavior (dungeon is the default; there is no silent third mode).
 */
export function resolveEncounterMapMode(input: {
  override: EncounterMapMode | null | undefined;
  briefEnvironment: EncounterBriefEnvironment | null | undefined;
  locationKind: EncounterLocationKind | null | undefined;
}): EncounterMapMode {
  if (input.override === 'architectural' || input.override === 'natural') return input.override;
  if (input.briefEnvironment === 'outdoor' || input.locationKind === 'wilderness') return 'natural';
  return 'architectural';
}

/**
 * The path order for a room-id list: the given order with `spawnId` moved to
 * the FRONT when present (derivable) — the first path room is where the
 * party starts. The Cartographer brief's room order IS the path
 * (`packAttempt` rotates `brief.rooms` for packing, so the packed array
 * order cannot be trusted — the path is stored explicitly).
 */
export function spawnFirstPath(
  ids: readonly string[],
  spawnId: string | null | undefined,
): string[] {
  if (spawnId === null || spawnId === undefined) return [...ids];
  const spawnIndex = ids.indexOf(spawnId);
  return spawnIndex <= 0 ? [...ids] : [...ids.slice(spawnIndex), ...ids.slice(0, spawnIndex)];
}

/**
 * The D10 preset resolution order (docs/11 D10 amendment):
 * 1. an explicit per-run choice (the run row's persisted preset — the
 *    persona-panel Auto select writes null here, Standard/Dungeon override),
 * 2. the encounter's own `locationKind` — `'dungeon'` generates on the D10
 *    dungeon tier, `'building'`/`'wilderness'` on the standard tier,
 * 3. `settings.encounterPreset` as the fallback for unclassified
 *    (`'other'`/unknown) encounters — the legacy opt-in keeps its meaning.
 *
 * `explicit` is null/undefined = Auto (no per-run override); the settings
 * fallback is null when the campaign never chose a preset — the terminal
 * default is 'standard' (the D10 base tier).
 */
export function resolveEncounterPreset(
  explicit: EncounterPreset | null | undefined,
  locationKind: EncounterLocationKind | null | undefined,
  settingsFallback: EncounterPreset | null | undefined,
): EncounterPreset {
  if (explicit !== null && explicit !== undefined) return explicit;
  if (locationKind === 'dungeon') return 'dungeon';
  if (locationKind === 'building' || locationKind === 'wilderness') return 'standard';
  return settingsFallback ?? 'standard';
}

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
  /** GM-only room key (read at the room's key marker); '' when the brief gave none. */
  key: z.string().default(''),
  /** This room's treasure checklist (one item per line); '' when none. */
  keyTreasure: z.string().default(''),
  /**
   * The room's own challenge target (docs/11 D12): the level this room alone
   * should challenge. The Cartographer brief may set it per room; the run
   * stamps the encounter's parsed levelHint when omitted. Optional — the
   * budget loop treats "no derivable target" as loud-unverified, never silent.
   */
  targetLevel: z.number().int().optional(),
});
export type EncounterMapRoomBrief = z.infer<typeof encounterMapRoomBriefSchema>;

export const encounterMapBriefSchema = z.object({
  theme: z.string(),
  aspect: encounterMapAspectSchema,
  /** Which grid tier the packer works on (dungeon = the fixed ×2 tier). */
  preset: encounterPresetSchema.default('standard'),
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
  /** Canonical marker letter (room labels; optional, never load-bearing). */
  letter: z.string().optional(),
  /**
   * GM-only room key (owner-ratified room-keys/treasure arc): the room
   * information the GM reads at the room's staging-point key marker, and the
   * room's own treasure checklist. Persisted ON the room — packRooms may
   * reorder rooms (packing rotation), so a parallel roomId-keyed array could
   * orphan; the key travels with the room through every rebuild. '' = none.
   */
  key: z.string().default(''),
  keyTreasure: z.string().default(''),
  /**
   * This room's own challenge target (docs/11 D12): the level this room
   * alone should challenge. Additive + optional — legacy rooms parse without
   * it. Stamped from the Cartographer brief (or the encounter's parsed
   * levelHint) at generation; the asymmetric budget loop may LOWER it a step
   * (floor 1) when the room's creatures overrun its band, and the final
   * (possibly lowered) value persists here, visible and owner-editable.
   */
  targetLevel: z.number().int().optional(),
  /**
   * The party's way in (entrance/exit spawn zones, doc 11): one opening in
   * the spawn room's outer wall. Only the spawn room may carry one, and a
   * layout carries at most one. Optional — legacy layouts have none and fall
   * back to the mobsRect-center staging ground.
   */
  entrance: layoutEntranceSchema.optional(),
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
    /**
     * Ordered play sequence of room ids (docs/11 D13): the Cartographer
     * brief's room order, spawn room first. Stored EXPLICITLY because
     * `packAttempt` rotates `brief.rooms`, so the rooms-array order cannot
     * be trusted. Optional: legacy layouts have none (the room-array order
     * is the fallback) and the v17 migration backfills it for complexes.
     */
    path: z.array(z.uuid()).optional(),
  })
  .superRefine((layout, context) => {
    if (layout.path !== undefined) {
      const roomIds = layout.rooms.map((room) => room.id);
      if (
        layout.path.length !== roomIds.length ||
        new Set(layout.path).size !== layout.path.length ||
        layout.path.some((id) => !roomIds.includes(id))
      ) {
        context.addIssue({
          code: 'custom',
          message: 'path must be a permutation of the layout room ids',
        });
      }
    }
    if (layout.rooms.filter((room) => room.spawn).length !== 1) {
      context.addIssue({ code: 'custom', message: 'layout must contain exactly one spawn room' });
    }
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
      for (const key of roomCells) {
        if (owners.has(key) && owners.get(key) !== room.id) {
          context.addIssue({ code: 'custom', message: `${room.name}: overlaps another room` });
        }
        owners.set(key, room.id);
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
