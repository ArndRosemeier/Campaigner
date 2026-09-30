import { z } from 'zod';

import { battleTokenIdSchema } from '@/domain/battle';

/**
 * The battle surface's persisted VIEW state (docs/17 row 262b, docs/18 §2.3).
 *
 * THE DEFECT THIS EXISTS FOR: the surface kept `playerSafe`, `zoom`, `pan` and
 * its rail selections in component-local `useState`, so an iOS tab discard or a
 * plain reload silently flipped the table from Player view back to GM view with
 * mob cards and NPC stat blocks in front of the players. The board ROW survived
 * (`db/battleRepo`); the view did not. This module is the ONE reader/writer of
 * the view that now rides the row as an additive optional field, next to
 * `board` — the same shape the origin-token fields were added with.
 *
 * WHY THE STORED FIELD IS `unknown` (see `battleSchema.view`): a corrupt
 * PREFERENCE must never cost the GM the battle row itself. If the field were a
 * strict schema on `Battle`, a single bad `playerSafe` would make
 * `battleSchema.parse` throw and the whole board would fail to load. It is
 * therefore parsed at THIS boundary by `resolveBattleView`, which fails LOUD
 * and SAFE instead: an absent value is the NAMED default, and an unreadable
 * one is the NAMED player-safe fallback plus a reason the caller reports.
 *
 * NOT persisted here, deliberately: the arm-then-confirm states
 * (`stageArmed`, `reseedArmed`), the spawn picker, the dice intent and the
 * token lightbox. A destructive confirmation must be re-armed by a deliberate
 * act after a reload, never restored mid-press, and a transient overlay is not
 * view state a GM expects to survive.
 */

/** Zoom bounds of the battle board. They live HERE because the stored zoom is
 * validated against them; the surface's clamp reads the same two constants, so
 * a gesture and a restored value cannot disagree about the range. */
export const BATTLE_ZOOM_MIN = 0.35;
export const BATTLE_ZOOM_MAX = 4;

export const battleViewSchema = z.object({
  /** Player view (true) vs GM view (false) — the flag whose loss leaked. */
  playerSafe: z.boolean(),
  zoom: z.number().min(BATTLE_ZOOM_MIN).max(BATTLE_ZOOM_MAX),
  /** Pan offset in SCREEN px, exactly what the surface applies. `z.number()`
   * already rejects NaN/Infinity in zod v4 — a non-finite offset is corrupt. */
  pan: z.object({ x: z.number(), y: z.number() }),
  selectedTokenId: battleTokenIdSchema.nullable(),
  selectedVeilId: battleTokenIdSchema.nullable(),
  selectedEffectId: battleTokenIdSchema.nullable(),
  /** GM-only room-key selection (`string | null`, never a board mutation). */
  selectedKeyRoomId: z.string().nullable(),
});

export type BattleView = z.infer<typeof battleViewSchema>;

/**
 * The NAMED default restored when a row carries NO view at all: every board
 * written before this field existed, and a freshly seeded one. It is the
 * pre-262b behaviour (GM view, fit, nothing selected) as ONE exported constant
 * rather than three inline `useState(...)` literals — the absent case is
 * ordinary, so it is quiet, but it is a thing a reader and a test can name.
 */
export const DEFAULT_BATTLE_VIEW: BattleView = Object.freeze({
  playerSafe: false,
  zoom: 1,
  pan: { x: 0, y: 0 },
  selectedTokenId: null,
  selectedVeilId: null,
  selectedEffectId: null,
  selectedKeyRoomId: null,
});

/**
 * The NAMED fail-safe restored when a row CARRIES a view that does not
 * validate. It is PLAYER-SAFE: that is the one direction which cannot put the
 * GM's screen in front of the players, and the GM can always toggle back with
 * a deliberate press. Falling back to the GM default here would be the exact
 * silent reset this slice exists to prevent, so it cannot be the same constant
 * as the absent case.
 */
export const SAFE_FALLBACK_BATTLE_VIEW: BattleView = Object.freeze({
  ...DEFAULT_BATTLE_VIEW,
  playerSafe: true,
});

/** Why a row's own view was not used. `null` = it was valid and IS the view. */
export type BattleViewFallback = 'absent' | 'corrupt';

export interface BattleViewResolution {
  view: BattleView;
  fallback: BattleViewFallback | null;
  /** The validation failure (a ZodError) for diagnostics and tests; null
   * otherwise. The caller reports the STATE in a sentence rather than
   * rendering this raw — lib/toast humanizes a Zod error, an owner reads a
   * sentence. */
  problem: unknown;
}

/**
 * THE reader of the stored `view` field: validates what the row carries and
 * answers either it, the named absent default, or the named player-safe
 * fallback with the reason. NEVER throws — a bad preference is reported by the
 * caller (`useBattleView` toasts it) instead of taking the battle down.
 */
export function resolveBattleView(stored: unknown): BattleViewResolution {
  if (stored === null || stored === undefined) {
    return { view: DEFAULT_BATTLE_VIEW, fallback: 'absent', problem: null };
  }
  const parsed = battleViewSchema.safeParse(stored);
  if (!parsed.success) {
    return { view: SAFE_FALLBACK_BATTLE_VIEW, fallback: 'corrupt', problem: parsed.error };
  }
  return { view: parsed.data, fallback: null, problem: null };
}
