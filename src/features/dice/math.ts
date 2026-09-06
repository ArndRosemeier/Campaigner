import type { DiceTray, DieSides, TrayDie } from './types';
import { STANDARD_DICE } from './types';

/** A settled die as the engine reports it: face value + the sides it rolled. */
export interface RolledDie {
  value: number;
  sides: number | string;
}

/** Display name — the percentile die renders as "d%". */
export function dieDisplayName(sides: DieSides): string {
  return sides === 100 ? 'd%' : `d${String(sides)}`;
}

function countDiceBySides(dice: TrayDie[]): Map<DieSides, number> {
  const counts = new Map<DieSides, number>();
  for (const die of dice) {
    counts.set(die.sides, (counts.get(die.sides) ?? 0) + 1);
  }
  return counts;
}

export function countPercentileDice(dice: TrayDie[]): number {
  return dice.filter((die) => die.sides === 100).length;
}

function formatDieGroup(sides: DieSides, qty: number): string {
  if (sides === 100) {
    return `${String(qty)}d%`;
  }
  return `${String(qty)}d${String(sides)}`;
}

/** Grouped engine notation ("1d4", "2d6", "1d100") in STANDARD_DICE order. */
export function buildNotation(dice: TrayDie[]): string[] {
  const counts = countDiceBySides(dice);
  const notation: string[] = [];
  for (const sides of STANDARD_DICE) {
    const qty = counts.get(sides) ?? 0;
    if (qty > 0) {
      notation.push(formatDieGroup(sides, qty));
    }
  }
  return notation;
}

/**
 * Human summary for the tray chip row and the roll log. The sign of a
 * non-zero modifier is always explicit ("2d6+3", "2d6-3", "+5", "-2");
 * an empty tray formats as "" (rolling one is the caller's guard).
 */
export function formatTraySummary(tray: DiceTray): string {
  const counts = countDiceBySides(tray.dice);
  const parts: string[] = [];
  for (const sides of STANDARD_DICE) {
    const qty = counts.get(sides) ?? 0;
    if (qty > 0) {
      parts.push(formatDieGroup(sides, qty));
    }
  }
  const dice = parts.join('+');
  if (tray.modifier > 0) {
    return dice.length > 0 ? `${dice}+${String(tray.modifier)}` : `+${String(tray.modifier)}`;
  }
  if (tray.modifier < 0) {
    return dice.length > 0 ? `${dice}-${String(Math.abs(tray.modifier))}` : `-${String(Math.abs(tray.modifier))}`;
  }
  return dice;
}

/** A percentile face of 0 means 100 — the engine rolls the tens/ones pair. */
export function percentileFaceTotal(value: number): number {
  return value === 0 ? 100 : value;
}

function numericDieSides(sides: number | string): number {
  if (typeof sides === 'number') {
    return sides;
  }
  const parsed = Number(sides.replace(/^d/u, ''));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Unknown die sides: ${sides}`);
  }
  return parsed;
}

/**
 * Settled roll total: Σdice + modifier. Percentile dice are fixed up
 * (0 → 100); a mismatch between the tray's percentile count and the engine
 * response is a contract error and throws — never a silently partial sum.
 */
export function sumRollTotal(
  dieResults: RolledDie[],
  modifier: number,
  percentileCount: number,
): number {
  const percentiles: number[] = [];
  let otherSum = 0;
  for (const die of dieResults) {
    const sides = numericDieSides(die.sides);
    if (sides === 100) {
      percentiles.push(die.value);
    } else {
      otherSum += die.value;
    }
  }
  if (percentiles.length !== percentileCount) {
    throw new Error(
      `Expected ${String(percentileCount)} percentile dice, got ${String(percentiles.length)}`,
    );
  }
  const percentileSum = percentiles.reduce((sum, value) => sum + percentileFaceTotal(value), 0);
  return percentileSum + otherSum + modifier;
}

/**
 * Restore guard for the persisted last-used tray: accepts only the exact
 * shape the picker writes (known die sizes, finite modifier) and returns
 * `null` for anything else, so a stale/corrupt storage entry can never
 * masquerade as the user's last roll.
 */
export function parseStoredTray(value: unknown): DiceTray | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const raw = value as { dice?: unknown; modifier?: unknown };
  if (!Array.isArray(raw.dice) || typeof raw.modifier !== 'number' || !Number.isFinite(raw.modifier)) {
    return null;
  }
  const dice: TrayDie[] = [];
  for (const entry of raw.dice) {
    if (typeof entry !== 'object' || entry === null) {
      return null;
    }
    const die = entry as { id?: unknown; sides?: unknown };
    if (typeof die.id !== 'string' || typeof die.sides !== 'number') {
      return null;
    }
    if (!STANDARD_DICE.includes(die.sides as DieSides)) {
      return null;
    }
    dice.push({ id: die.id, sides: die.sides as DieSides });
  }
  return { dice, modifier: raw.modifier };
}
