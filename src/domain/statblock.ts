import { z } from 'zod';

import { gameSystemSchema } from '@/domain/gameSystem';

/** A named block of rules text (trait, action, reaction, legendary action). */
export const namedTextSchema = z.object({
  name: z.string(),
  text: z.string(),
});

export type NamedText = z.infer<typeof namedTextSchema>;

const abilitiesSchema = z.object({
  str: z.number(),
  dex: z.number(),
  con: z.number(),
  int: z.number(),
  wis: z.number(),
  cha: z.number(),
});

/**
 * Normalized d20 stat block (01-DATA-MODEL §StatBlock): one shared shape for
 * all d20 systems; system-specific bits go into `extras` (key = label as
 * printed).
 */
export const statBlockSchema = z.object({
  system: gameSystemSchema,
  level: z.string(),
  size: z.string(),
  creatureType: z.string(),
  ac: z.number(),
  acNote: z.string(),
  hp: z.number(),
  hpFormula: z.string(),
  speed: z.string(),
  abilities: abilitiesSchema,
  saves: z.string(),
  skills: z.string(),
  senses: z.string(),
  languages: z.string(),
  traits: z.array(namedTextSchema),
  actions: z.array(namedTextSchema),
  reactions: z.array(namedTextSchema),
  legendary: z.array(namedTextSchema),
  extras: z.record(z.string(), z.string()),
});

export type StatBlock = z.infer<typeof statBlockSchema>;
