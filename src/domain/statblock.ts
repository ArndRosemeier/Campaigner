import { z } from 'zod';

import { gameSystemSchema } from '@/domain/gameSystem';

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
