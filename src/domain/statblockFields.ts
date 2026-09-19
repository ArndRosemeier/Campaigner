import { z } from 'zod';

import { gameSystemSchema } from '@/domain/gameSystem';

/**
 * THE stat-block field definitions, shared by the STORED schema
 * (`domain/statblock.statBlockSchema`) and the system-aware REQUEST contract
 * (`llm/statBlockContract`). docs/17 row 205.
 *
 * WHY THIS FILE EXISTS. The two schemas must describe the SAME stat block —
 * one is what storage parses, the other is what a model is constrained to
 * return — but they cannot be the same INSTANCE: zod emits a `$ref` for a
 * reused schema instance and `llm/strictSchema` refuses `$ref` loudly, and the
 * request contract also has to vary its `spells` entry per system. So the
 * FIELDS are declared here once and every builder calls `statBlockBaseFields()`,
 * which returns a FRESH instance per call — one definition, no shared instance,
 * no drift, no `$ref`.
 */

/**
 * JSON number or numeric string ("18") — models frequently quote stats even
 * when the contract says number. A non-numeric string ("18 (plate)") is still
 * rejected: only meaning-preserving formatting is coerced.
 */
export function numericStat() {
  return z.preprocess((value) => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed);
    }
    return value;
  }, z.number());
}

/** The six d20 ability values, as stored (scores — docs/12 §5). */
export function abilitiesSchema() {
  return z.object({
    str: numericStat(),
    dex: numericStat(),
    con: numericStat(),
    int: numericStat(),
    wis: numericStat(),
    cha: numericStat(),
  });
}

/** A named block of rules text (trait, action, reaction, legendary action). */
export function namedTextSchema() {
  return z.object({
    name: z.string(),
    text: z.string(),
  });
}

export type NamedText = z.infer<ReturnType<typeof namedTextSchema>>;

/**
 * THE stored spell-assignment shape — the SUPERSET, carrying every system's
 * keys (docs/17 rows 194/205). It is the compatibility pin: a row written by
 * any past arc keeps parsing, including one carrying a field that belongs to
 * the OTHER system. It is NOT a request contract — a request is built per
 * system by `llm/statBlockContract.mobSpellAssignmentSchemaFor`, so the model
 * is never asked for the wrong system's keys. A fresh instance per call, like
 * every builder here.
 */
export function storedMobSpellAssignmentSchema() {
  return z.object(storedMobSpellAssignmentShape());
}

/**
 * THE assignment key set as a plain shape, so a caller can build a variant
 * without re-spelling a key (docs/17 rows 205/255c). The stored schema and the
 * copy-bearing stored schema (`domain/statblock.statBlockSchema`) share this:
 * a key added here reaches both, and neither can drift from the other.
 */
export function storedMobSpellAssignmentShape() {
  return {
    name: z.string(),
    castRank: z.number().int().positive().nullish(),
    autoHeightenLevel: z.number().int().positive().max(10).nullish(),
    casterLevel: z.number().int().positive().nullish(),
    characterLevel: z.number().int().positive().nullish(),
  };
}

/**
 * THE copy-only assignment key (docs/17 row 255c). It is deliberately NOT
 * declared by `storedMobSpellAssignmentShape()`: that shape is also a REQUEST
 * contract's no-corpus arm (`llm/statBlockContract.statBlockSchemaFor`), and a
 * model never authors a library payload — it names a spell from the prompt's
 * list. The stored SUPERSET adds it, so a copied assignment carries the whole
 * library entry without changing one request byte.
 */
export const COPIED_SPELL_ENTRY_KEY = 'spellData';

/**
 * The stored assignment's parsed shape — the SUPERSET. `domain/mobSpells` owns
 * the resolver and re-exports this type, so the two cannot describe two
 * different assignments.
 */
export type MobSpellAssignment = z.infer<ReturnType<typeof storedMobSpellAssignmentSchema>>;

/**
 * Every stat-block field EXCEPT the per-system `spells` entry, which the
 * caller adds: the stored superset adds the full assignment, a request contract
 * adds its OWN system's entry. A fresh object per call (see above).
 *
 * The per-system assignment is added by the CALLER rather than taken as a
 * parameter, deliberately: a parameter typed as a zod schema erases the parsed
 * output type, which then reads as an `unknown` stat block everywhere. Both
 * callers spread their own `spells` in the SAME position, so the two field
 * orders agree (`spells` between `extras` and `spellDC`).
 */
export function statBlockBaseFields() {
  return {
    system: gameSystemSchema,
    level: z.string(),
    size: z.string(),
    creatureType: z.string(),
    ac: numericStat(),
    acNote: z.string().default(''),
    hp: numericStat(),
    hpFormula: z.string().default(''),
    speed: z.string(),
    abilities: abilitiesSchema(),
    saves: z.string(),
    skills: z.string(),
    senses: z.string(),
    languages: z.string(),
    traits: z.array(namedTextSchema()).default([]),
    actions: z.array(namedTextSchema()).default([]),
    reactions: z.array(namedTextSchema()).default([]),
    legendary: z.array(namedTextSchema()).default([]),
    extras: z.record(z.string(), z.string()).default({}),
    spellDC: numericStat().nullish(),
    spellAttack: numericStat().nullish(),
    tradition: z.string().nullish(),
  };
}
