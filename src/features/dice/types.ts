/**
 * Dice roller shared types (09-MILESTONE-5 M5-D amendment): the tray model
 * the picker edits, the intent that colors a roll, and the result the caller
 * receives. Pure data — no engine, no IO — so the math and the UI can be
 * tested without the 3D layer.
 */

/** The standard polyhedral set; 100 = percentile (displayed as d%). */
export const STANDARD_DICE = [4, 6, 8, 10, 12, 20, 100] as const;

export type DieSides = (typeof STANDARD_DICE)[number];

/** Modifier stepper denominations (both signs — ±1/±2/±5/±10/±20). */
export const MODIFIER_STEPS = [1, 2, 5, 10, 20] as const;

export type ModifierStep = (typeof MODIFIER_STEPS)[number];

/** One die in the tray; `id` exists only so a chip can be removed by tap. */
export interface TrayDie {
  id: string;
  sides: DieSides;
}

export interface DiceTray {
  dice: TrayDie[];
  modifier: number;
}

export const EMPTY_TRAY: DiceTray = { dice: [], modifier: 0 };

/**
 * Why the roller was opened: colors the title ("Damage — Goblin 2") and —
 * for damage/heal — records the caller's sign decision, so the roller itself
 * never knows what its total is used for and stays reusable for any future
 * roll surface (initiative, saves, …).
 */
export interface RollIntent {
  kind: 'damage' | 'heal' | 'generic';
  subject?: string;
}

/** One settled roll. `perDie` preserves each die face in engine order. */
export interface DiceRollResult {
  total: number;
  summary: string;
  perDie: number[];
}

/**
 * Last tray the user rolled, persisted as a genuine preference
 * ("dice.lastTray") so the next roll starts where the last one ended.
 * Validated on read by `parseStoredTray` — corrupt data is discarded loudly
 * (a fresh tray), never served as if it were the user's last roll.
 */
export const LAST_TRAY_STORAGE_KEY = 'dice.lastTray';
