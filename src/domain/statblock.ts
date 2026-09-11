import { z } from 'zod';

import { gameSystemSchema, type GameSystem } from '@/domain/gameSystem';

/** A named block of rules text (trait, action, reaction, legendary action). */
export const namedTextSchema = z.object({
  name: z.string(),
  text: z.string(),
});

export type NamedText = z.infer<typeof namedTextSchema>;

/**
 * JSON number or numeric string ("18") — models frequently quote stats even
 * when the contract says number. A non-numeric string ("18 (plate)") is still
 * rejected: only meaning-preserving formatting is coerced.
 */
function numericStat() {
  return z.preprocess((value) => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed);
    }
    return value;
  }, z.number());
}

const abilitiesSchema = z.object({
  str: numericStat(),
  dex: numericStat(),
  con: numericStat(),
  int: numericStat(),
  wis: numericStat(),
  cha: numericStat(),
});

/**
 * Normalized d20 stat block (01-DATA-MODEL §StatBlock): one shared shape for
 * all d20 systems; system-specific bits go into `extras` (key = label as
 * printed). Sections a model may legitimately leave out (traits, actions,
 * reactions, legendary, extras, the two notes) default to empty — the prompt
 * defines empty as "section does not apply", so a missing section is the
 * same meaning, not a masked failure; identity/defense fields stay required.
 */
export const statBlockSchema = z.object({
  system: gameSystemSchema,
  level: z.string(),
  size: z.string(),
  creatureType: z.string(),
  ac: numericStat(),
  acNote: z.string().default(''),
  hp: numericStat(),
  hpFormula: z.string().default(''),
  speed: z.string(),
  abilities: abilitiesSchema,
  saves: z.string(),
  skills: z.string(),
  senses: z.string(),
  languages: z.string(),
  traits: z.array(namedTextSchema).default([]),
  actions: z.array(namedTextSchema).default([]),
  reactions: z.array(namedTextSchema).default([]),
  legendary: z.array(namedTextSchema).default([]),
  extras: z.record(z.string(), z.string()).default({}),
});

export type StatBlock = z.infer<typeof statBlockSchema>;

/** Standard d20 ability modifier: floor((score - 10) / 2). */
export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** Formats a modifier for display: 3 → '+3', -1 → '-1'. */
export function formatModifier(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

/**
 * The d20 SCORE a PRINTED ability modifier stands for: `10 + 2·modifier`, the
 * exact inverse of `abilityModifier` (docs/12 §5 is the authority — Pathfinder
 * 2e's `system.abilities.*.mod` is stored this way by the pack importer, and
 * the stat-block editor converts an owner-typed modifier with the same
 * function, so nothing derives the conversion a second time).
 */
export function abilityScoreFromModifier(modifier: number): number {
  return 10 + 2 * modifier;
}

/**
 * How a system PRINTS an ability (docs/12 §5, docs/05 §Artifact editor): the
 * app STORES d20-scale SCORES in every system — including Pathfinder 2e, whose
 * own stat blocks print signed MODIFIERS instead — and this predicate is the
 * ONE switch that decides which of the two a surface shows. It is display
 * only: no consumer may branch on it to change what is stored or computed.
 */
export function printsAbilityModifiers(system: GameSystem): boolean {
  return system === 'pathfinder2e';
}

/**
 * One ability as the shared stat-block display prints it: `"14 (+2)"` for
 * every system that prints scores, `"+2"` for Pathfinder 2e (which prints the
 * bonus only — owner decision, docs/17 row 95). The compact PDF stat boxes
 * keep their own one-value layout and compose `printsAbilityModifiers` with
 * `formatModifier` instead.
 */
export function formatAbilityValue(system: GameSystem, score: number): string {
  const modifier = formatModifier(abilityModifier(score));
  return printsAbilityModifiers(system) ? modifier : `${String(score)} (${modifier})`;
}
