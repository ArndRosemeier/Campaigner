import { z } from 'zod';

import { layoutEntranceSideSchema } from '@/domain/encounterMap/schema';
import { BaseEntitySchema, type Id } from '@/domain/entity';
import { statBlockSchema } from '@/domain/statblock';

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
 * - One live battle per module, created lazily, deleted when it empties.
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

/** Effect markers share the 1-cell floor (symmetric resize, `battle/effect`). */
export const EFFECT_MIN_CELLS = 1;

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
  /**
   * The layout room this veil covers (group veils, docs/11 D4): the Path
   * rail resolves rooms through `veil.id` AND `veil.roomId` — the first
   * group keeps `id = room.id`, later groups mint fresh ids — and "Reveal
   * next room" lifts every veil mapped to the room (reveal-all), so no room
   * reads revealed while its mobs stay covered. Optional: legacy rows and
   * GM-drawn veils parse without it (no room = none).
   */
  roomId: z.uuid().optional(),
});

export type BattleVeil = z.infer<typeof battleVeilSchema>;

/**
 * Geometric effect markers (D7, encounter-resume arc): GM-stamped showpieces
 * — a spell disc, a square zone. Geometry is layout-anchored (`sizeCells` in
 * grid cells), never screen pixels; the fill renders at ~70% transparency and
 * the marker is board material, visible in BOTH GM and player views.
 */
export const battleEffectShapeSchema = z.enum(['disc', 'square']);
export type BattleEffectShape = z.infer<typeof battleEffectShapeSchema>;

export const battleEffectSchema = z.object({
  id: battleTokenIdSchema,
  shape: battleEffectShapeSchema,
  /** Normalized content coords (0..1) of the marker CENTER. */
  x: z.number(),
  y: z.number(),
  /** Diameter (disc) / side (square) in grid cells — layout-anchored. */
  sizeCells: z.number().int().min(EFFECT_MIN_CELLS),
  /** Fill color; one of TOKEN_STAMP_COLORS. */
  color: z.string(),
  /** Optional caption. */
  label: z.string().default(''),
});

export type BattleEffect = z.infer<typeof battleEffectSchema>;

export const battleTokenSchema = z.object({
  id: battleTokenIdSchema,
  /** Artifact-backed (pc/npc) or null for geometric stamps. */
  artifactId: z.uuid().nullable(),
  /** For npc-backed tokens: which roster entry instance this is ("Goblin 2"). */
  label: z.string(),
  /**
   * The token's CREATURE IDENTITY — `domain/creature`'s portrait key — when
   * the token stands for a cited library creature or for an invented mob
   * (docs/11 D5 amendment): the board resolves its portrait by identity alone,
   * with no artifact required. Absent for PCs, stamps and any token whose
   * creature has no identity (a plain authored NPC token keeps its portrait on
   * its own artifact cover).
   */
  creatureKey: z.string().optional(),
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
  /** Frozen copy of the roster entry's mob treasure at seed time (GM-only;
   *  roster rows can vanish, so the token keeps its own copy — same
   *  frozen-copy precedent as initiativeBonus). */
  treasure: z.string().default(''),
  conditions: z.array(z.string()).default([]),
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

/**
 * The entrance zone stamped at seed time (entrance/exit spawn zones, doc 11):
 * normalized CENTER of the entrance cell plus its outward side, so the table
 * surface can render the party's way in. null for legacy seeds.
 */
export const battleEntranceSchema = z.object({
  x: z.number(),
  y: z.number(),
  side: layoutEntranceSideSchema,
});

export type BattleEntrance = z.infer<typeof battleEntranceSchema>;

/** Saved opening layout for Reset; null until the GM sets the stage. */
export const battleMapLayoutSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type BattleMapLayout = z.infer<typeof battleMapLayoutSchema>;

export const stageSnapshotSchema = z.object({
  mapImageId: z.uuid().nullable().default(null),
  mapLayout: battleMapLayoutSchema.nullable().default(null),
  gridSize: z.number().min(GRID_SIZE_MIN).max(GRID_SIZE_MAX).nullable().default(null),
  tokenSize: z.number().default(TOKEN_SIZE_DEFAULT),
  tokens: z.array(battleTokenSchema).default([]),
  veils: z.array(battleVeilSchema).default([]),
  effects: z.array(battleEffectSchema).default([]),
  stagingGround: stagingGroundSchema.nullable().default(null),
  entrance: battleEntranceSchema.nullable().default(null),
});

export type StageSnapshot = z.infer<typeof stageSnapshotSchema>;

export const battleBoardSchema = z.object({
  mapImageId: z.uuid().nullable().default(null),
  mapLayout: battleMapLayoutSchema.nullable().default(null),
  /** false = prep scratch, true = on the table. */
  live: z.boolean().default(false),
  /**
   * The first-entry reveal (the source's `liveBoard` rule) is spent exactly
   * once per seed: entering the table reveals every token only while this is
   * false. A Lift → re-enter cycle resumes the board verbatim instead of
   * re-revealing hidden tokens (encounter-resume arc). Legacy rows read
   * `undefined`, which counts as unspent — the reveal runs once, then the
   * flag is written canonically.
   */
  everLive: z.boolean().default(false),
  tokens: z.array(battleTokenSchema).default([]),
  veils: z.array(battleVeilSchema).default([]),
  /** GM-stamped geometric effect markers (D7); rendered in both views. */
  effects: z.array(battleEffectSchema).default([]),
  /** Cell size in CSS px; null hides the grid. */
  gridSize: z.number().min(GRID_SIZE_MIN).max(GRID_SIZE_MAX).nullable().default(null),
  tokenSize: z.number().default(TOKEN_SIZE_DEFAULT),
  sceneryMovementLocked: z.boolean().default(false),
  initiativeEnabled: z.boolean().default(false),
  /** Turn order by token id; indexes `activeIndex` when initiative is on. */
  initiativeOrder: z.array(battleTokenIdSchema).default([]),
  activeIndex: z.number().int().min(0).default(0),
  stage: stageSnapshotSchema.nullable().default(null),
  stagingGround: stagingGroundSchema.nullable().default(null),
  /** Entrance zone (doc 11); null for legacy seeds and uploaded maps. */
  entrance: battleEntranceSchema.nullable().default(null),
});

export type BattleBoard = z.infer<typeof battleBoardSchema>;

export const battleSchema = z.object({
  ...BaseEntitySchema.shape,
  campaignId: z.uuid(),
  /** The module/play-view this live battle belongs to (10-MILESTONE-6 D10). */
  moduleId: z.uuid(),
  /** The encounter artifact that seeded it (provenance), or null. */
  encounterArtifactId: z.uuid().nullable(),
  /**
   * The last destructive re-seed — who/when/what replaced the board
   * (encounter-resume arc). `null` is the original seed: the row's
   * `createdAt` plus `encounterArtifactId` are the whole provenance. `at` is
   * epoch ms, matching the entity stamps.
   */
  reseed: z
    .object({
      at: z.number(),
      encounterArtifactId: z.uuid(),
      encounterName: z.string(),
    })
    .nullable()
    .default(null),
  board: battleBoardSchema,
  /**
   * The surface's persisted VIEW state — the player-safe flag, the board's
   * zoom/pan and the rail selections (docs/17 row 262b). A sibling of `board`,
   * not part of it: the board is domain material replaced wholesale by the
   * drag commit path, while this is presentation state the SURFACE owns.
   *
   * Deliberately `unknown`, parsed by `domain/battle/view.resolveBattleView`
   * and NOT by this schema: a corrupt preference must fail LOUD and SAFE (the
   * named player-safe fallback) instead of throwing here and taking the whole
   * battle row — and the GM's board — down with it. `null`/absent is the NAMED
   * default; see `view.ts` for both constants.
   */
  view: z.unknown().default(null),
  /**
   * Monster fighters seeded from rulebook/inline roster entries have NO
   * backing artifact; their resolved stats are frozen here at seed time
   * (M5-C). The synthetic `id` is what the repo's stats lookup keys on
   * (initiative, HP clamping), so no rulebook re-resolution is needed on
   * every write. npc-ref/pc tokens resolve through the real artifacts
   * instead — and since the ratified model (docs/11 D1/D5) NOTHING is a
   * creature artifact, so `creatureKey` is the row's stable identity and the
   * `id` is only a fresh per-expansion handle.
   */
  seedFighters: z
    .array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        maxHp: z.number().int().min(0),
        initiativeBonus: z.number().int(),
        /**
         * The CREATURE IDENTITY this row was frozen for (docs/11 D6). Two
         * expansions of the same roster entry resolve the same identity, so
         * this — not the synthetic `id` — is what dedupes the row. Absent on
         * rows written before the field existed and on npc-ref/pc fighters,
         * which resolve through a real artifact instead.
         */
        creatureKey: z.string().optional(),
        /**
         * The FROZEN STAT BLOCK for a row with no artifact behind it (docs/17
         * row 255b). A roster copy owns its library bytes (the owner's rule:
         * core items are only ever copied), so the battle's card is read off
         * THIS row — not re-resolved through the `chunk:<id>` identity token,
         * which used to make an uninstalled pack cost an already-seeded battle
         * its AC and attacks. `maxHp`/`initiativeBonus` above stay the numeric
         * view the engine consumes; this is the full block the card prints.
         * Optional because a battle seeded before the field existed still
         * parses (and its row genuinely has no frozen copy).
         */
        statBlock: statBlockSchema.optional(),
        /**
         * The STAMPED origin line the card discloses with the frozen block
         * ("Bestiary p.132", or `NPC: X (stats from …)` for a borrowed row) —
         * `tokenCreature`'s `identityLabel`, frozen at seed time for the same
         * reason the block is: the label used to be composed from a LIVE
         * library read, which an uninstalled pack takes away.
         */
        originLabel: z.string().optional(),
      }),
    )
    .default([]),
});

export type Battle = z.infer<typeof battleSchema>;
export type SeedFighter = Battle['seedFighters'][number];

/**
 * Plain-number fighter view the engine consumes (never Dexie): max HP and
 * initiative bonus resolve through `resolveMonsterEntry` for NPCs and
 * `pcDataSchema` for PCs upstream.
 *
 * A DISCRIMINATED UNION, because the two kinds honestly differ (docs/17 row
 * 308): a statless NPC (and a statless seed roster row) is still simply ABSENT
 * from the lookup — a loud "no stats" badge in the UI, excluded from
 * initiative, never a placeholder number. A STATLESS PC is NOT absent: the
 * owner's rule is that every campaign player is in every battle, always, with
 * initiative and HP, and the owner's own ruling is that players carry no stat
 * block. Its `maxHp` is therefore `null` (UNKNOWN — never an invented 0 or 20)
 * and its initiative bonus is exactly `initiativeOverride ?? 0` (no dex, no
 * ability score invented).
 */
export type FighterStats =
  | {
      kind: 'pc';
      name: string;
      /**
       * The pc artifact's stat-block HP, or `null` when the pc has NO stat
       * block. `null` is a FACT, not a placeholder: a statless PC carries only
       * its own current HP, and the table surface renders an HP readout with
       * no ratio and no ceiling instead of inventing a maximum (rule 1).
       */
      maxHp: number | null;
      /** Initiative bonus at roll time: dex modifier (+ the PC's own override). */
      initiativeBonus: number;
      /** The artifact-owned current HP (the HP ownership split); null is loud. */
      currentHp: number | null;
    }
  | {
      kind: 'npc';
      name: string;
      maxHp: number;
      /** Initiative bonus at roll time: dex modifier (+ an npc override). */
      initiativeBonus: number;
      /** NPCs report null — the token instance owns current HP. */
      currentHp: null;
    };

export type FighterStatsLookup = (artifactId: Id) => FighterStats | undefined;

/** Builds a lookup from artifact id → resolved fighter stats. */
export function fighterStatsLookupOf(
  entries: readonly { artifactId: Id; stats: FighterStats }[],
): FighterStatsLookup {
  const byId = new Map(entries.map((entry) => [entry.artifactId, entry.stats]));
  return (artifactId) => byId.get(artifactId);
}
