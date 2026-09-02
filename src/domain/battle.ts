import { z } from 'zod';

import { BaseEntitySchema, type Id } from '@/domain/entity';

/**
 * Battle domain (09-MILESTONE-5 M5-B, retyped from GM Cockpit's
 * `host/types.ts`): the LIVE run — tokens on a board, veils, initiative,
 * per-encounter HP. Campaigner's word "encounter" is taken by the artifact
 * kind (designed content); a battle is the thing you run.
 *
 * Ported rules kept verbatim (the mechanism's substance):
 * - HP ownership split: players own current HP on their ARTIFACT (persists
 *   between battles); NPCs own current HP on the TOKEN instance (fresh per
 *   battle). An NPC artifact must never store current HP.
 * - Covered/hidden tokens are removed from the DOM and pruned from
 *   initiative — that IS the player-safe mechanic.
 * - Initiative bonus is frozen onto the token at roll time.
 * - One live battle per session, created lazily, deleted when it empties.
 */

export const battleTokenIdSchema = z.uuid();
export type BattleTokenId = z.infer<typeof battleTokenIdSchema>;

export const battleTokenShapeSchema = z.enum(['circle', 'square', 'portrait']);
export type BattleTokenShape = z.infer<typeof battleTokenShapeSchema>;

export const battleVeilKindSchema = z.enum(['veil', 'fog']);
export type BattleVeilKind = z.infer<typeof battleVeilKindSchema>;

/** Token CSS width multiplier vs `tokenSize` (stages 0.5, 1, 2, 3…). */
export const TOKEN_SCALE_MIN = 0.5;

export const TOKEN_STAMP_COLORS: readonly string[] = ['#ff0000', '#ffe600', '#000000'];

export function nextTokenScale(current: number, delta: -1 | 1): number {
  if (delta > 0) {
    if (current < 1) {
      return 1;
    }
    return Math.floor(current) + 1;
  }
  if (current <= 1) {
    return TOKEN_SCALE_MIN;
  }
  return Math.floor(current) - 1;
}

/** The player spawn area is a fixed 3×3 block of grid cells. */
export const STAGING_GROUND_CELLS = 3;

export const VEIL_DEFAULT_CELLS = 2;
export const VEIL_MIN_CELLS = 1;

export const GRID_SIZE_MIN = 16;
export const GRID_SIZE_MAX = 128;
export const GRID_SIZE_DEFAULT = 72;
export const TOKEN_SIZE_MIN = GRID_SIZE_MIN / 2;

/**
 * Outer box-shadow ring on a token (each side). Token CSS width + 2× this
 * should equal the grid cell so lines sit just outside.
 */
export const TOKEN_RING_OUTSET_PX = 4;

/** Token CSS width that fills a grid cell with the ring just inside the lines. */
export function tokenSizeFittingGrid(gridSize: number): number {
  const inner = gridSize - TOKEN_RING_OUTSET_PX * 2;
  const clamped = Math.min(GRID_SIZE_MAX, Math.max(GRID_SIZE_MIN, inner));
  return clamped % 2 === 0 ? clamped : clamped - 1;
}

export const TOKEN_SIZE_DEFAULT = tokenSizeFittingGrid(GRID_SIZE_DEFAULT);

export const battleVeilSchema = z.object({
  id: battleTokenIdSchema,
  kind: battleVeilKindSchema,
  /** Normalized board coords (0..1) of the veil CENTER. */
  x: z.number(),
  y: z.number(),
  /** Width/height in grid cells, or token-size units when the grid is off. */
  widthCells: z.number().int().min(VEIL_MIN_CELLS),
  heightCells: z.number().int().min(VEIL_MIN_CELLS),
});

export type BattleVeil = z.infer<typeof battleVeilSchema>;

export const battleTokenSchema = z.object({
  id: battleTokenIdSchema,
  /** Artifact-backed (pc/npc) or null for geometric stamps. */
  artifactId: z.uuid().nullable(),
  /** For npc-backed tokens: which roster entry instance this is ("Goblin 2"). */
  label: z.string(),
  /** Normalized board coords (1 = map width/height); may leave 0..1 while dragging. */
  x: z.number(),
  y: z.number(),
  visible: z.boolean(),
  /** Multiplier vs board.tokenSize. */
  scale: z.number(),
  shape: battleTokenShapeSchema,
  /** Stamp fill; null for portrait tokens. */
  color: z.string().nullable(),
  /** NPC instance HP (null for PCs — the pc artifact owns it — and stamps). */
  currentHp: z.number().int().min(0).nullable(),
  /** d20 result for this battle's initiative, when rolled. */
  initiativeRoll: z.number().int().min(1).max(20).nullable(),
  /** Frozen copy of the artifact's bonus at roll time. */
  initiativeBonus: z.number().int().nullable(),
  conditions: z.array(z.string()),
});

export type BattleToken = z.infer<typeof battleTokenSchema>;

export const stagingGroundSchema = z.object({
  /** Normalized center of the 3×3 block. */
  x: z.number(),
  y: z.number(),
  /** Normalized width/height of one grid cell (for the spawn layout). */
  cellWidth: z.number(),
  cellHeight: z.number(),
});

export type StagingGround = z.infer<typeof stagingGroundSchema>;

/** Saved opening layout for Reset; null until the GM sets the stage. */
export const stageSnapshotSchema = z.object({
  mapImageId: z.uuid().nullable(),
  gridSize: z.number().min(GRID_SIZE_MIN).max(GRID_SIZE_MAX).nullable(),
  tokenSize: z.number(),
  tokens: z.array(battleTokenSchema),
  veils: z.array(battleVeilSchema),
  stagingGround: stagingGroundSchema.nullable(),
});

export type StageSnapshot = z.infer<typeof stageSnapshotSchema>;

export const battleBoardSchema = z.object({
  mapImageId: z.uuid().nullable(),
  /** false = prep scratch, true = on the table. */
  live: z.boolean(),
  tokens: z.array(battleTokenSchema),
  veils: z.array(battleVeilSchema),
  /** Cell size in CSS px; null hides the grid. */
  gridSize: z.number().min(GRID_SIZE_MIN).max(GRID_SIZE_MAX).nullable(),
  tokenSize: z.number(),
  sceneryMovementLocked: z.boolean(),
  initiativeEnabled: z.boolean(),
  /** Turn order by token id; indexes `activeIndex` when initiative is on. */
  initiativeOrder: z.array(battleTokenIdSchema),
  activeIndex: z.number().int().min(0),
  stage: stageSnapshotSchema.nullable(),
  stagingGround: stagingGroundSchema.nullable(),
});

export type BattleBoard = z.infer<typeof battleBoardSchema>;

export const battleSchema = z.object({
  ...BaseEntitySchema.shape,
  campaignId: z.uuid(),
  /** The session artifact this battle belongs to (Play's active session). */
  sessionId: z.uuid(),
  /** The encounter artifact that seeded it (provenance), or null. */
  encounterArtifactId: z.uuid().nullable(),
  board: battleBoardSchema,
  /**
   * Monster fighters seeded from rulebook/inline roster entries have NO
   * backing artifact; their resolved stats are frozen here at seed time
   * (M5-C) and their tokens carry the synthetic `id` as `artifactId`. This
   * lets the repo's stats lookup treat them exactly like npc artifacts
   * (initiative, HP clamping) without re-resolving rulebooks on every write.
   * npc-ref/pc tokens resolve through the real artifacts instead.
   */
  seedFighters: z
    .array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        maxHp: z.number().int().min(0),
        initiativeBonus: z.number().int(),
      }),
    )
    .default([]),
});

export type Battle = z.infer<typeof battleSchema>;
export type SeedFighter = Battle['seedFighters'][number];

/**
 * Plain-number fighter view the engine consumes (never Dexie): max HP and
 * initiative bonus resolve through `resolveMonsterEntry` for NPCs and
 * `pcDataSchema` for PCs upstream; stats-less artifacts are simply absent
 * from the map — a loud "no stats" badge in the UI, excluded from
 * initiative, never a placeholder number.
 */
export interface FighterStats {
  kind: 'pc' | 'npc';
  name: string;
  maxHp: number;
  /** Initiative bonus at roll time: dex modifier (+ PC-style override). */
  initiativeBonus: number;
  /** PCs only: the artifact-owned current HP. NPCs report null (the token owns it). */
  currentHp: number | null;
}

export type FighterStatsLookup = (artifactId: Id) => FighterStats | undefined;

/** Builds a lookup from artifact id → resolved fighter stats. */
export function fighterStatsLookupOf(
  entries: readonly { artifactId: Id; stats: FighterStats }[],
): FighterStatsLookup {
  const byId = new Map(entries.map((entry) => [entry.artifactId, entry.stats]));
  return (artifactId) => byId.get(artifactId);
}
