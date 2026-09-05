import { loadAll } from 'js-yaml';
import { z } from 'zod';

import { abilityModifier, formatModifier, type StatBlock } from '@/domain/statblock';
import { errorMessage } from '@/lib/errors';

import type { PackAdapter, PackEntry, PackFileParse } from './types';

/**
 * `foundry-dnd5e-srd` pack adapter (12-BESTIARY-PACKS §2/§5/§11): creature
 * entries from the Foundry VTT dnd5e system SRD content ([foundryvtt/dnd5e]
 * (https://github.com/foundryvtt/dnd5e) branch `6.0.x`, `packs/_source/
 * monsters/<creatureType>/<slug>.yml` — one YAML file per creature, 337 SRD
 * monsters). SRD 5.1/5.2 scope only: the source contains no Monster Manual
 * Product Identity creatures. Non-NPC documents are skipped by design and
 * counted, never silently dropped.
 *
 * Field mapping verified against the LIVE 6.0.x corpus (all 337 documents,
 * 2026-09-05); the fixture tests (real trimmed `ape.yml`/`wolf.yml`/
 * `kobold.yml`/`goblin.yml`/`satyr.yml`/… subsets) pin the consumed subset.
 * The consumed sub-fields, all fixture-pinned:
 *
 * - `system.abilities.<abil>.value` → StatBlock scores **directly** (dnd5e
 *   stores scores, the exact inverse information of the pf2e adapter);
 *   `<abil>.proficient` (0/1) → rendered save strings.
 * - AC: `system.attributes.ac.flat` → `ac` when the document stores one
 *   (`calc: 'flat'`/`'natural'`). For armor-wearers the document stores NO
 *   number (`calc: 'default'`, e.g. Goblin, Satyr, Fire Giant): there the AC
 *   is derived with the dnd5e system's own published formula (6.0.x
 *   `module/data/actor/templates/attributes.mjs` `prepareArmorClass` +
 *   `CONFIG.DND5E.armorClasses`, verified equal to the printed SRD value for
 *   every one of the 34 corpus creatures that store `calc: 'default'`):
 *   armored `armor.value + min(dexMod, armor.dex ?? ∞)` (heavy armor clamps
 *   dex to 0), unarmored `10 + dexMod` when no armor is equipped, plus the
 *   first equipped shield's `armor.value`; the equipped armor/shield names
 *   become the printed `acNote` ("Leather Armor, Shield"). Any other gear
 *   shape (multiple armors/shields, unsupported armor type, armor without a
 *   numeric value) fails the entry loudly — exact or loud, never best-effort.
 * - `system.attributes.hp.max` + `.formula` → `hp` + `hpFormula`.
 * - `system.details.cr` (number, `0.125/0.25/0.5` allowed; string accepted;
 *   `null` = the system's printed "—", proficiency null) → `level` in the
 *   printed convention (`"1/2"`, `"—"`) + numeric `levelSort`.
 * - `system.traits.size`, `system.details.type.value` (+ `.subtype` tag),
 *   `system.attributes.movement` (per-type feet values; the summons documents
 *   store `null` for absent speeds and numeric strings such as `"30"` — both
 *   accepted, `null` → 0, `units: null` → `'ft'`), `senses` (per-sense feet +
 *   `special`; `units: null` → `'ft'`), `system.traits.languages.value`/
 *   `.custom`, `system.skills.<id>.{value, ability}` (proficiency level →
 *   rendered "Stealth +6"-style strings), `di`/`dr`/`dv`/`ci` → extras.
 * - `items[]` `feat` bucketed by activity activation: no activities/passive →
 *   `traits`, `reaction` → `reactions`, else → `actions`; `items[]` `weapon`
 *   → one rendered attack line from the first attack activity.
 *
 * Attack activities (to-hit; the corpus forms are pinned by fixtures): a FLAT
 * attack (`attack.flat: true`, e.g. the animated objects' Slam and the tiny
 * beasts' flat bites) stores the complete bonus and maps as-is. Otherwise the
 * to-hit is `abilityMod + proficiency + stored bonus`, exactly the system's
 * roll parts: `attack.ability: 'none'` contributes NO ability modifier (the
 * stored bonus makes up the printed total, e.g. camel Bite +5 = prof +2 +
 * stored 3; swarm bonus formulas `@abilities.dex.mod` resolve to the ability
 * modifier), `attack.ability: 'spellcasting'` uses the creature's stored
 * `system.attributes.spellcasting.ability`, and an empty ability falls back
 * to the weapon rules (ranged → Dex, finesse → better of Str/Dex, else Str —
 * the system's `availableAbilities` defaulting). Damage: normal base dice add
 * the ability modifier (unless the attack is flat or ability-less, which add
 * none — matching the printed blocks); a custom base formula
 * (`damage.base.custom.enabled`, e.g. the badger's flat `"1"` or the
 * saber-toothed tiger's `"1d10 + @mod + 1"`) resolves `@mod`/`@abilities.<x>
 * .mod` and NdM/integer terms exactly and renders in the compact `NdM±K`
 * convention; attacks with no damage at all (roper Tendril, guardian naga
 * Spit Poison) render name + range/properties without a damage term.
 *
 * The source stores no computed totals, so save/skill/attack modifiers are
 * rendered with the standard printed-convention derivation from the pinned
 * sub-fields: ability modifier = `abilityModifier(score)` (the shared
 * StatBlock inverse), proficiency bonus = `floor(CR / 4) + 2` (0 for the
 * CR-less "—" summons, whose stored proficiency is null). No other roll math
 * is performed (§9: no Foundry system code) — spell items, equipment and
 * carried weapons without an attack activity are not represented in v1
 * (documented scope cut, not a failure path).
 */

export const FOUNDRY_DND5E_SRD_ADAPTER_ID = 'foundry-dnd5e-srd';

export const FOUNDRY_DND5E_SRD_LICENSE =
  'Dungeons & Dragons SRD 5.1/5.2 creature content from the Foundry VTT dnd5e ' +
  'system packs (Wizards of the Coast), licensed CC-BY-4.0. SRD scope only — ' +
  'no Monster Manual Product Identity creatures. User-imported for personal ' +
  'use — not for redistribution.';

const SIZE_LABELS: Readonly<Record<string, string>> = {
  tiny: 'Tiny',
  sm: 'Small',
  med: 'Medium',
  lg: 'Large',
  huge: 'Huge',
  grg: 'Gargantuan',
};

const ABILITY_ORDER: readonly string[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

const ABILITY_LABELS: Readonly<Record<string, string>> = {
  str: 'Str', dex: 'Dex', con: 'Con', int: 'Int', wis: 'Wis', cha: 'Cha',
};

const SKILL_LABELS: Readonly<Record<string, string>> = {
  acr: 'Acrobatics', ani: 'Animal Handling', arc: 'Arcana', ath: 'Athletics',
  dec: 'Deception', his: 'History', ins: 'Insight', itm: 'Intimidation',
  inv: 'Investigation', med: 'Medicine', nat: 'Nature', prc: 'Perception',
  prf: 'Performance', per: 'Persuasion', rel: 'Religion', slt: 'Sleight of Hand',
  ste: 'Stealth', sur: 'Survival',
};

const PROPERTY_LABELS: Readonly<Record<string, string>> = {
  amm: 'ammunition', fin: 'finesse', hvy: 'heavy', lgt: 'light', ldd: 'lodged',
  rch: 'reach', rel: 'reload', ret: 'returning', spc: 'special', th: 'thrown',
  two: 'two-handed', trs: 'trip', ver: 'versatile',
};

/** Printed CR fractions for the fractional SRD challenge ratings. */
const CR_FRACTIONS: Readonly<Record<string, string>> = {
  '0.125': '1/8',
  '0.25': '1/4',
  '0.5': '1/2',
};

// --- Source schemas (consumed subset of the Foundry document; unknown keys
// are ignored — the document is never re-serialized). ------------------------

const defenseListSchema = z.object({
  value: z.array(z.string()).default([]),
  custom: z.string().default(''),
});

/**
 * A stored movement/sense scalar: a number, `null` (absent speed — the
 * summons documents), or a numeric string (`walk: "30"`). Narrowed to an
 * exact number by `feetValue` below — never silently.
 */
const scalarFeetSchema = z.union([z.number(), z.string()]).nullish();

/**
 * Exact numeric feet from a stored movement/sense scalar: numbers pass,
 * `null`/`''` mean 0 (the system's default for absent speeds), numeric
 * strings (the summons documents store `walk: "30"`) convert, and anything
 * else is a loud per-entry failure — never a silent 0.
 */
function feetValue(value: number | string | null | undefined, what: string): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const trimmed = value.trim();
  if (trimmed === '') return 0;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`unsupported ${what} "${value}"`);
  }
  return parsed;
}

/** Units: a stored string, or `null` → the system default `'ft'`. */
function unitsValue(value: string | null | undefined): string {
  return value ?? 'ft';
}

const dnd5eNpcSchema = z.object({
  name: z.string().min(1),
  type: z.literal('npc'),
  items: z.array(z.unknown()).default([]),
  system: z.object({
    abilities: z.record(
      z.string(),
      z.object({ value: z.number(), proficient: z.number().default(0) }),
    ),
    attributes: z.object({
      ac: z.object({ flat: z.number().nullish(), calc: z.string().default('') }),
      hp: z.object({
        max: z.number(),
        formula: z.union([z.string(), z.number()]).default(''),
      }),
      movement: z
        .object({
          burrow: scalarFeetSchema.default(0),
          climb: scalarFeetSchema.default(0),
          fly: scalarFeetSchema.default(0),
          swim: scalarFeetSchema.default(0),
          walk: scalarFeetSchema.default(0),
          units: z.string().nullish().default('ft'),
          hover: z.boolean().default(false),
        })
        .default({ burrow: 0, climb: 0, fly: 0, swim: 0, walk: 0, units: 'ft', hover: false }),
      senses: z
        .object({
          darkvision: scalarFeetSchema.default(0),
          blindsight: scalarFeetSchema.default(0),
          tremorsense: scalarFeetSchema.default(0),
          truesight: scalarFeetSchema.default(0),
          units: z.string().nullish().default('ft'),
          special: z.string().default(''),
        })
        .default({
          darkvision: 0, blindsight: 0, tremorsense: 0, truesight: 0, units: 'ft', special: '',
        }),
      // The creature's spellcasting ability id ('' when it has none) — used
      // by `attack.ability: 'spellcasting'` attacks (druid, lich).
      spellcasting: z.string().default(''),
    }),
    details: z.object({
      // `null` CR is the system's printed "—" (CR-less summons such as the
      // Avatar of Death and the animated objects); their proficiency is null.
      cr: z.union([z.number(), z.string()]).nullable(),
      type: z
        .object({ value: z.string().default(''), subtype: z.string().default('') })
        .default({ value: '', subtype: '' }),
      alignment: z.string().optional(),
      environment: z.string().optional(),
    }),
    traits: z.object({
      size: z.string(),
      di: defenseListSchema.optional(),
      dr: defenseListSchema.optional(),
      dv: defenseListSchema.optional(),
      ci: defenseListSchema.optional(),
      languages: defenseListSchema.default({ value: [], custom: '' }),
    }),
    skills: z
      .record(z.string(), z.object({ value: z.number(), ability: z.string() }))
      .default({}),
  }),
});

const featItemSchema = z.object({
  name: z.string().min(1),
  type: z.literal('feat'),
  system: z.object({
    description: z.object({ value: z.string().default('') }).default({ value: '' }),
    activities: z
      .record(
        z.string(),
        z.object({
          type: z.string().default(''),
          activation: z.object({ type: z.string().default('') }).default({ type: '' }),
        }),
      )
      .default({}),
  }),
});

const attackActivitySchema = z.object({
  type: z.string().default(''),
  activation: z.object({ type: z.string().default('') }).default({ type: '' }),
  attack: z
    .object({
      ability: z.string().default(''),
      bonus: z.union([z.string(), z.number()]).default(''),
      // `flat: true` = the stored bonus IS the complete attack bonus (no
      // ability modifier, no proficiency — the animated objects' Slam, the
      // tiny beasts' flat bites).
      flat: z.boolean().default(false),
      type: z.object({ value: z.string().default('') }).default({ value: '' }),
    })
    .default({ ability: '', bonus: '', flat: false, type: { value: '' } }),
});

const weaponItemSchema = z.object({
  name: z.string().min(1),
  type: z.literal('weapon'),
  system: z.object({
    proficient: z.number().nullish().default(null),
    properties: z.array(z.string()).default([]),
    type: z.object({ value: z.string().default('') }).default({ value: '' }),
    range: z
      .object({
        value: z.number().nullish().default(null),
        long: z.number().nullish().default(null),
      })
      .default({ value: null, long: null }),
    damage: z
      .object({
        base: z
          .object({
            number: z.number().nullish().default(null),
            denomination: z.number().nullish().default(null),
            bonus: z.union([z.string(), z.number()]).default(''),
            types: z.array(z.string()).default([]),
            // Custom base damage (no dice): the badger's flat `"1"`, the
            // saber-toothed tiger's `"1d10 + @mod + 1"`.
            custom: z
              .object({ enabled: z.boolean().default(false), formula: z.string().default('') })
              .nullish()
              .default(null),
          })
          .nullish()
          .default(null),
      })
      .default({ base: null }),
    activities: z.record(z.string(), attackActivitySchema).default({}),
  }),
});

/**
 * One equipped armor/shield piece (`items[]` `type: 'equipment'`): the exact
 * inputs of the dnd5e system's published AC formula. Parsed tolerantly so
 * every real equipment item narrows; the mapping below fails loudly when an
 * equipped piece is not exactly mappable.
 */
const armorPieceSchema = z.object({
  name: z.string().min(1),
  type: z.literal('equipment'),
  system: z.object({
    equipped: z.boolean().nullish().default(false),
    type: z.object({ value: z.string().nullish().default('') }).nullish().default({ value: '' }),
    armor: z
      .object({
        value: z.number().nullish().default(null),
        dex: z.number().nullish().default(null),
      })
      .nullish()
      .default(null),
  }),
});

type ParsedNpc = z.infer<typeof dnd5eNpcSchema>;
type ParsedFeat = z.infer<typeof featItemSchema>;
type ParsedWeapon = z.infer<typeof weaponItemSchema>;
type ParsedArmorPiece = z.infer<typeof armorPieceSchema>;

// --- Helpers ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whole-file YAML (or a multi-document YAML stream) via js-yaml. A file that
 * fails to parse fails the file loudly with its name and the parser message.
 */
function parseDocs(text: string, fileName: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed === '') throw new Error(`${fileName}: file is empty`);
  try {
    return loadAll(trimmed);
  } catch (error) {
    throw new Error(`${fileName}: invalid YAML: ${errorMessage(error)}`, { cause: error });
  }
}

/** Strips dnd5e description HTML to plain text, resolving link notation. */
function stripDescription(html: string): string {
  return html
    .replace(/\[\[[^\]]*\]\]\{([^}]*)\}/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, (_match, inner: string) => {
      // [[/condition conditions:Incapacitated|incapacitated]] → last label;
      // bracket links without a label segment render as nothing.
      const segments = inner.split('|');
      return segments.length > 1 ? (segments[segments.length - 1] ?? '') : '';
    })
    .replace(/&(amp;)?reference\[([^\]]*)\]/g, '$2')
    .replace(/@(\w+)\[([^\]]*)\]/g, (_match, _kind: string, inner: string) => {
      return (inner.split('|')[0] ?? '').split('.').pop() ?? '';
    })
    .replace(/<hr\s*\/?>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function titleCase(slug: string): string {
  return slug
    .split(/[\s-]+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Numeric bonus from a stored numeric scalar; formula strings fail loudly. */
function numericBonus(value: string | number, what: string): number {
  if (typeof value === 'number') return value;
  const parsed = Number(value.trim());
  if (value.trim() !== '' && !Number.isFinite(parsed)) {
    throw new Error(`unsupported ${what} "${value}"`);
  }
  return parsed;
}

/** Printed challenge rating: `0.5` → `"1/2"`, `2` → `"2"`, `null` → `"—"` (the
 * dnd5e system's `formatCR` output for the CR-less summons; their proficiency
 * is null, i.e. 0 for rendered bonuses). */
function levelFromCr(cr: number | string | null): { level: string; sort: number | null } {
  if (cr === null) return { level: '—', sort: null };
  if (typeof cr === 'number') {
    const fraction = CR_FRACTIONS[String(cr)];
    if (fraction !== undefined) return { level: fraction, sort: cr };
    if (Number.isInteger(cr) && cr >= 0) return { level: String(cr), sort: cr };
    throw new Error(`unsupported CR "${String(cr)}"`);
  }
  const trimmed = cr.trim();
  if (/^\d+\s*\/\s*\d+$/.test(trimmed)) {
    const [numerator, denominator] = trimmed.split('/').map((part) => Number(part.trim()));
    if (numerator !== undefined && denominator !== undefined && denominator !== 0) {
      return { level: trimmed.replace(/\s+/g, ''), sort: numerator / denominator };
    }
  }
  const asNumber = Number(trimmed);
  if (trimmed !== '' && Number.isFinite(asNumber)) return levelFromCr(asNumber);
  throw new Error(`unsupported CR "${cr}"`);
}

/** d20 proficiency bonus by challenge rating: CR 0–4 → +2, 5–8 → +3, … */
function proficiencyBonus(cr: number): number {
  return Math.floor(cr / 4) + 2;
}

/** A `value: []` + `custom` defense list ("Damage immunities …") as a string. */
function defenseList(list: z.infer<typeof defenseListSchema> | undefined): string {
  if (list === undefined) return '';
  return [...list.value.map((entry) => titleCase(entry)), list.custom.trim()]
    .filter((part) => part !== '')
    .join(', ');
}

// --- Armor Class (12-BESTIARY-PACKS §5, exact-or-loud) ----------------------

const ARMOR_TYPES: ReadonlySet<string> = new Set(['light', 'medium', 'heavy']);
const SHIELD_TYPE = 'shield';

interface DerivedAc {
  ac: number;
  acNote: string;
}

/**
 * Derives the exact AC for `ac.calc: 'default'` documents (armor wearers that
 * store no flat number) with the dnd5e system's own published formula
 * (6.0.x `prepareArmorClass` + `CONFIG.DND5E.armorClasses`): the armored
 * formula `armor.value + min(dexMod, armor.dex ?? ∞)` — heavy armor clamps
 * Dexterity to 0 — or the unarmored formula `10 + dexMod` when nothing is
 * equipped, plus the first equipped shield. Verified equal to the printed SRD
 * value for all 34 corpus creatures that store `calc: 'default'`. Any gear
 * shape outside the formula's exact inputs fails loudly.
 */
function deriveAcFromGear(
  items: readonly unknown[],
  abilities: Readonly<Record<string, number>>,
): DerivedAc {
  let armor: ParsedArmorPiece | null = null;
  let shield: ParsedArmorPiece | null = null;
  for (const item of items) {
    const parsed = armorPieceSchema.safeParse(item);
    if (parsed.success) {
      if (parsed.data.system.equipped !== true) continue;
      const typeValue = parsed.data.system.type?.value ?? '';
      if (typeValue === SHIELD_TYPE) {
        if (shield !== null) {
          throw new Error(`multiple equipped shields ("${shield.name}", "${parsed.data.name}") — the adapter maps only the system's exact single-shield AC inputs`);
        }
        shield = parsed.data;
      } else if (ARMOR_TYPES.has(typeValue)) {
        if (armor !== null) {
          throw new Error(`multiple equipped armors ("${armor.name}", "${parsed.data.name}") — the adapter maps only the system's exact single-armor AC inputs`);
        }
        armor = parsed.data;
      } else {
        throw new Error(
          `equipped armor "${parsed.data.name}" has unsupported armor type "${typeValue}"`,
        );
      }
      continue;
    }
    // An equipment item that carries armor data but does not narrow (e.g. a
    // non-numeric armor value) must never be silently ignored: the AC would
    // silently diverge. Fail loudly instead.
    if (
      isRecord(item) &&
      item.type === 'equipment' &&
      isRecord(item.system) &&
      'armor' in item.system
    ) {
      throw new Error(
        `equipped armor "${typeof item.name === 'string' ? item.name : '?'}" stores unreadable armor data — cannot map an exact AC`,
      );
    }
  }

  const dexMod = abilityModifier(abilities.dex ?? 0);
  let ac: number;
  const notes: string[] = [];
  if (armor === null) {
    // Unarmored formula: `10 + @abilities.dex.mod`.
    ac = 10 + dexMod;
  } else {
    const armorValue = armor.system.armor?.value ?? null;
    if (armorValue === null) {
      throw new Error(`equipped armor "${armor.name}" has no armor value — cannot map an exact AC`);
    }
    // Armored formula: `@attributes.ac.armor + @attributes.ac.clamped.dex`
    // where clamped dex = `isHeavy ? 0 : min(dexMod, armor.dex ?? ∞)`.
    const isHeavy = (armor.system.type?.value ?? '') === 'heavy';
    const dexCap = armor.system.armor?.dex ?? null;
    const clampedDex = isHeavy ? 0 : Math.min(dexMod, dexCap ?? Infinity);
    ac = armorValue + clampedDex;
    notes.push(armor.name);
  }
  if (shield !== null) {
    const shieldValue = shield.system.armor?.value ?? null;
    if (shieldValue === null) {
      throw new Error(`equipped shield "${shield.name}" has no armor value — cannot map an exact AC`);
    }
    ac += shieldValue;
    notes.push(shield.name);
  }
  return { ac, acNote: notes.join(', ') };
}

// --- Attack bonus / damage ---------------------------------------------------

/**
 * The stored per-attack `bonus` term: `''` contributes nothing, integers are
 * exact, and the `@abilities.<abil>.mod` formula (swarms, Hurl Flame) resolves
 * to that ability's modifier. Any other formula fails loudly.
 */
function resolveAttackBonus(
  bonus: string | number,
  abilities: Readonly<Record<string, number>>,
): number {
  if (typeof bonus === 'number') return bonus;
  const trimmed = bonus.trim();
  if (trimmed === '') return 0;
  const formula = /^@abilities\.([a-z]+)\.mod$/.exec(trimmed);
  if (formula !== null) {
    const score = abilities[formula[1] ?? ''];
    if (score === undefined) {
      throw new Error(`attack bonus "${trimmed}" references unknown ability`);
    }
    return abilityModifier(score);
  }
  const parsed = Number(trimmed);
  if (Number.isInteger(parsed)) return parsed;
  throw new Error(`unsupported attack bonus "${bonus}"`);
}

/**
 * Resolves a stored custom base-damage formula into the compact `NdM±K`
 * printed convention. Exact forms (corpus-pinned): dice terms `NdM`, integer
 * constants, `@mod` (the attack's ability modifier) and
 * `@abilities.<abil>.mod`, joined by `+`/`-`. Anything else — parentheses
 * (e.g. the arcane hand's summon-level dice count), other `@`-references,
 * mixed dice denominations, empty — fails loudly.
 */
function resolveDamageFormula(
  formula: string,
  mod: number,
  extraBonus: number,
  what: string,
): string {
  const trimmed = formula.trim();
  if (trimmed === '') throw new Error(`${what} stores an empty custom damage formula`);
  // Normalize sign spacing so the no-space corpus form ("2d4 + @mod -3")
  // tokenizes like the spaced form — then require strict term/operator
  // alternation (anything else is loud, e.g. parentheses).
  const tokens = trimmed.replace(/([+-])(?=[\d@])/g, '$1 ').split(/\s+/);
  let diceCount = 0;
  let die = 0;
  let flat = extraBonus;
  let sign = 1;
  for (const [index, token] of tokens.entries()) {
    const isOperator = index % 2 === 1;
    if (isOperator) {
      if (token === '+') {
        sign = 1;
      } else if (token === '-') {
        sign = -1;
      } else {
        throw new Error(`${what} stores an unsupported damage formula "${formula}"`);
      }
      continue;
    }
    const dice = /^(\d+)d(\d+)$/.exec(token);
    if (dice !== null) {
      if (sign === -1) throw new Error(`${what} stores an unsupported damage formula "${formula}"`);
      const count = Number(dice[1]);
      const denomination = Number(dice[2]);
      if (die !== 0 && die !== denomination) {
        throw new Error(`${what} stores an unsupported damage formula "${formula}"`);
      }
      die = denomination;
      diceCount += count;
      continue;
    }
    let value: number;
    if (token === '@mod') {
      value = mod;
    } else if (/^\d+$/.test(token)) {
      value = Number(token);
    } else {
      throw new Error(`${what} stores an unsupported damage formula "${formula}"`);
    }
    flat += sign * value;
  }
  const dicePart = diceCount === 0 ? '' : `${String(diceCount)}d${String(die)}`;
  if (dicePart === '') return `${flat}`;
  return `${dicePart}${flat === 0 ? '' : formatModifier(flat)}`;
}

// --- Mapping ---------------------------------------------------------------

function mapFeat(item: ParsedFeat): { name: string; text: string; bucket: 'traits' | 'actions' | 'reactions' } {
  const activations = Object.values(item.system.activities)
    .map((activity) => activity.activation.type)
    .filter((type) => type !== '');
  const text = stripDescription(item.system.description.value);
  if (activations.includes('reaction')) return { name: item.name, text, bucket: 'reactions' };
  // Feats with no activity (Pack Tactics, Keen Hearing and Smell) or a
  // passive/none activation cost nothing — they are the printed traits.
  const passive = activations.length === 0 || activations.every((type) => type === 'passive' || type === 'none');
  return { name: item.name, text, bucket: passive ? 'traits' : 'actions' };
}

interface WeaponContext {
  abilities: Readonly<Record<string, number>>;
  pb: number;
  /** `system.attributes.spellcasting.ability` ('' when absent). */
  spellcastingAbility: string;
}

function mapWeapon(
  item: ParsedWeapon,
  ctx: WeaponContext,
): { name: string; text: string; ranged: boolean } {
  const { abilities, pb } = ctx;
  const attack = Object.values(item.system.activities).find((activity) => activity.type === 'attack');
  if (attack === undefined) {
    throw new Error(`weapon "${item.name}" has no attack activity`);
  }
  const base = item.system.damage.base;
  const noBaseDamage = `weapon "${item.name}" has no base damage`;

  const typeValue = item.system.type.value;
  const ranged = attack.attack.type.value === 'ranged' || typeValue.endsWith('R');
  const strMod = abilityModifier(abilities.str ?? 0);
  const dexMod = abilityModifier(abilities.dex ?? 0);
  // Ability resolution (exact, system-pinned): 'none' has no ability at all,
  // 'spellcasting' uses the creature's stored spellcasting ability, an explicit
  // key must exist, and '' falls back to the weapon rules (ranged → DEX,
  // finesse → better of Str/Dex, else Str — the system's `availableAbilities`
  // defaulting, with the empty attack type defaulting to melee).
  let abilityKey: string | null;
  if (attack.attack.ability === 'none') {
    abilityKey = null;
  } else if (attack.attack.ability === 'spellcasting') {
    if (ctx.spellcastingAbility === '') {
      throw new Error(`weapon "${item.name}" attacks with "spellcasting" but the creature stores no spellcasting ability`);
    }
    abilityKey = ctx.spellcastingAbility;
  } else if (attack.attack.ability !== '') {
    abilityKey = attack.attack.ability;
  } else if (ranged) {
    abilityKey = 'dex';
  } else if (item.system.properties.includes('fin')) {
    abilityKey = dexMod >= strMod ? 'dex' : 'str';
  } else {
    abilityKey = 'str';
  }
  const abilityScore = abilityKey === null ? null : abilities[abilityKey];
  if (abilityKey !== null && abilityScore === undefined) {
    throw new Error(`weapon "${item.name}" attacks with unknown ability "${abilityKey}"`);
  }
  const abilityMod = abilityScore === null || abilityScore === undefined ? null : abilityModifier(abilityScore);

  // To-hit = the roll parts the system assembles: `mod + prof + bonus`, with
  // `mod` dropped for `none`, `prof` dropped for the CR-less summons (stored
  // proficiency is null), and flat attacks storing the complete bonus as-is.
  let toHit: number;
  if (attack.attack.flat) {
    toHit = numericBonus(attack.attack.bonus, 'attack bonus');
  } else {
    const prof = item.system.proficient === 0 ? 0 : pb;
    toHit = (abilityMod ?? 0) + prof + resolveAttackBonus(attack.attack.bonus, abilities);
  }

  // Damage: normal base dice add the ability modifier — except for flat and
  // `none` attacks, whose printed blocks carry no ability damage bonus. A
  // custom base formula resolves exactly (its `@mod` already carries the
  // ability term); no dice and no custom formula is a damage-less attack
  // (roper Tendril, guardian naga Spit Poison), rendered without damage.
  let damage: string;
  const baseBonus = numericBonus(base?.bonus ?? 0, 'damage bonus');
  if (base === null) {
    damage = '';
  } else if (base.number !== null && base.denomination !== null) {
    const damageBonus = (attack.attack.flat || abilityMod === null ? 0 : abilityMod) + baseBonus;
    damage = `${String(base.number)}d${String(base.denomination)}${damageBonus === 0 ? '' : formatModifier(damageBonus)}`;
  } else if (base.custom?.enabled === true) {
    damage = resolveDamageFormula(
      base.custom.formula,
      abilityMod ?? 0,
      baseBonus,
      `weapon "${item.name}"`,
    );
  } else if (baseBonus !== 0 || base.types.length > 0) {
    // Dice-less but carrying damage data we cannot represent exactly.
    throw new Error(noBaseDamage);
  } else {
    damage = '';
  }

  const properties = item.system.properties
    .map((property) => PROPERTY_LABELS[property])
    .filter((label) => label !== undefined);
  const notes = [...properties];
  if (ranged && item.system.range.value !== null && item.system.range.value > 0) {
    const long = item.system.range.long === null ? '' : `/${String(item.system.range.long)}`;
    notes.push(`range ${String(item.system.range.value)}${long} ft.`);
  }
  const parts = [damage, base?.types.join(' ') ?? ''];
  if (notes.length > 0) parts.push(`(${notes.join(', ')})`);
  return {
    name: `${item.name} ${formatModifier(toHit)}`,
    text: parts.filter((part) => part !== '').join(' '),
    ranged,
  };
}

function mapNpc(doc: ParsedNpc): PackEntry {
  const system = doc.system;
  const details = system.details;

  const sizeLabel = SIZE_LABELS[system.traits.size];
  if (sizeLabel === undefined) {
    throw new Error(`unknown size "${system.traits.size}"`);
  }
  const { level, sort: cr } = levelFromCr(details.cr);
  // The CR-less "—" summons (system prints "—", stores prof: null).
  const pb = cr === null ? 0 : proficiencyBonus(cr);

  const abilities: Record<string, number> = {};
  const saveProficiencies: Record<string, number> = {};
  for (const key of ABILITY_ORDER) {
    const ability = system.abilities[key];
    if (ability === undefined) throw new Error(`missing ${key} score`);
    abilities[key] = ability.value;
    saveProficiencies[key] = ability.proficient;
  }
  const abilityMod = (key: string): number => {
    const score = abilities[key];
    if (score === undefined) throw new Error(`unknown ability "${key}"`);
    return abilityModifier(score);
  };

  // AC: an exactly stored flat value, or — for `calc: 'default'` armor
  // wearers — the dnd5e system's published formula over the equipped gear
  // (exact for every corpus document; any other shape fails loudly).
  let ac: number;
  let acNote = '';
  if (system.attributes.ac.calc === 'default') {
    const derived = deriveAcFromGear(doc.items, abilities);
    ac = derived.ac;
    acNote = derived.acNote;
  } else {
    const flat = system.attributes.ac.flat;
    if (flat === null || flat === undefined) {
      throw new Error(
        `no flat Armor Class stored (ac.calc "${system.attributes.ac.calc}") — ` +
          'the adapter maps only exact, stored AC values',
      );
    }
    ac = flat;
  }

  const saves = ABILITY_ORDER
    .filter((key) => (saveProficiencies[key] ?? 0) > 0)
    .map(
      (key) =>
        `${ABILITY_LABELS[key] ?? key} ${formatModifier(abilityMod(key) + (saveProficiencies[key] ?? 0) * pb)}`,
    );

  const skills = Object.entries(system.skills)
    .filter(([, skill]) => skill.value > 0)
    .map(([id, skill]) => {
      const score = abilities[skill.ability];
      if (score === undefined) {
        throw new Error(`skill "${id}" references unknown ability "${skill.ability}"`);
      }
      const label = SKILL_LABELS[id] ?? titleCase(id);
      return `${label} ${formatModifier(abilityModifier(score) + skill.value * pb)}`;
    });

  const perceptionSkill = system.skills.prc;
  const passivePerception =
    10 +
    (perceptionSkill === undefined
      ? abilityMod('wis')
      : abilityMod(perceptionSkill.ability) + perceptionSkill.value * pb);

  if (unitsValue(system.attributes.senses.units) !== 'ft') {
    throw new Error(`unsupported sense units "${String(system.attributes.senses.units)}"`);
  }
  const senses: string[] = (
    [
      ['darkvision', 'Darkvision'],
      ['blindsight', 'Blindsight'],
      ['tremorsense', 'Tremorsense'],
      ['truesight', 'Truesight'],
    ] as const
  )
    .map(([key, label]) => {
      const range = feetValue(system.attributes.senses[key], `${key} sense range`);
      return range > 0 ? `${label} ${String(range)} ft.` : '';
    })
    .filter((part) => part !== '');
  const special = system.attributes.senses.special.trim();
  if (special !== '') senses.push(special);
  senses.push(`passive Perception ${String(passivePerception)}`);

  const languages = [
    ...system.traits.languages.value.map((language) => titleCase(language)),
    system.traits.languages.custom.trim(),
  ].filter((part) => part !== '');

  if (unitsValue(system.attributes.movement.units) !== 'ft') {
    throw new Error(`unsupported movement units "${String(system.attributes.movement.units)}"`);
  }
  const movement = system.attributes.movement;
  const walk = feetValue(movement.walk, 'walk speed');
  const speeds: string[] = [];
  if (walk > 0) speeds.push(`${String(walk)} feet`);
  for (const [key, label] of [['burrow', 'burrow'], ['climb', 'climb'], ['fly', 'fly'], ['swim', 'swim']] as const) {
    const value = feetValue(movement[key], `${key} speed`);
    if (value > 0) speeds.push(`${label} ${String(value)} feet${key === 'fly' && movement.hover ? ' (hover)' : ''}`);
  }

  const creatureType = details.type.value;
  const traits = [creatureType, details.type.subtype.trim().toLowerCase()].filter((part) => part !== '');

  const attacks: { name: string; text: string; ranged: boolean }[] = [];
  const featActions: { name: string; text: string }[] = [];
  const passiveTraits: StatBlock['traits'] = [];
  const reactions: StatBlock['reactions'] = [];
  for (const item of doc.items) {
    const feat = featItemSchema.safeParse(item);
    if (feat.success) {
      const mapped = mapFeat(feat.data);
      if (mapped.bucket === 'traits') passiveTraits.push({ name: mapped.name, text: mapped.text });
      else if (mapped.bucket === 'reactions') reactions.push({ name: mapped.name, text: mapped.text });
      else featActions.push({ name: mapped.name, text: mapped.text });
      continue;
    }
    const weapon = weaponItemSchema.safeParse(item);
    if (weapon.success) {
      attacks.push(
        mapWeapon(weapon.data, {
          abilities,
          pb,
          spellcastingAbility: system.attributes.spellcasting,
        }),
      );
      continue;
    }
    // Equipment, spells and other non-stat-block items are not represented
    // (12-BESTIARY-PACKS §9: no spell data in v1).
  }

  const modifiers = ABILITY_ORDER.map(
    (key) => `${ABILITY_LABELS[key] ?? key} ${formatModifier(abilityMod(key))}`,
  );

  const extras: Record<string, string> = {
    Traits: traits.join(', '),
    'Ability modifiers': modifiers.join(', '),
  };
  const alignment = details.alignment?.trim() ?? '';
  if (alignment !== '') extras.Alignment = alignment;
  const environment = details.environment?.trim() ?? '';
  if (environment !== '') extras.Environment = environment;
  const immunities = defenseList(system.traits.di);
  if (immunities !== '') extras['Damage immunities'] = immunities;
  const resistances = defenseList(system.traits.dr);
  if (resistances !== '') extras['Damage resistances'] = resistances;
  const vulnerabilities = defenseList(system.traits.dv);
  if (vulnerabilities !== '') extras['Damage vulnerabilities'] = vulnerabilities;
  const conditionImmunities = defenseList(system.traits.ci);
  if (conditionImmunities !== '') extras['Condition immunities'] = conditionImmunities;

  const hpFormula = String(system.attributes.hp.formula);
  const statBlock: StatBlock = {
    system: 'dnd5e',
    level,
    size: sizeLabel,
    creatureType,
    ac,
    acNote,
    hp: system.attributes.hp.max,
    hpFormula,
    speed: speeds.join(', '),
    abilities: {
      str: abilities.str ?? 0,
      dex: abilities.dex ?? 0,
      con: abilities.con ?? 0,
      int: abilities.int ?? 0,
      wis: abilities.wis ?? 0,
      cha: abilities.cha ?? 0,
    },
    saves: saves.join(', '),
    skills: skills.join(', '),
    senses: senses.join(', '),
    languages: languages.join(', '),
    traits: passiveTraits,
    actions: [...attacks, ...featActions],
    reactions,
    legendary: [],
    extras,
  };

  const lines: string[] = [
    `${doc.name} — CR ${level}`,
    `${sizeLabel}${traits.length > 0 ? `, ${traits.join(', ')}` : ''}`,
    senses.join(', '),
  ];
  if (languages.length > 0) lines.push(`Languages ${languages.join(', ')}`);
  if (skills.length > 0) lines.push(`Skills ${skills.join(', ')}`);
  if (saves.length > 0) lines.push(`Saves ${saves.join(', ')}`);
  lines.push(
    `AC ${String(ac)}${acNote === '' ? '' : ` (${acNote})`}; HP ${String(system.attributes.hp.max)}${hpFormula === '' ? '' : ` (${hpFormula})`}`,
  );
  if (speeds.length > 0) lines.push(`Speed ${speeds.join(', ')}`);
  lines.push(
    ABILITY_ORDER.map((key) => `${ABILITY_LABELS[key] ?? key} ${String(abilities[key] ?? 0)} (${formatModifier(abilityMod(key))})`).join(', '),
  );
  for (const [key, label] of [
    ['Damage immunities', immunities],
    ['Damage resistances', resistances],
    ['Damage vulnerabilities', vulnerabilities],
    ['Condition immunities', conditionImmunities],
  ] as const) {
    if (label !== '') lines.push(`${key}: ${label}`);
  }
  for (const attack of attacks) {
    // Damage-less attacks (roper Tendril) render without a trailing comma.
    const label = attack.ranged ? 'Ranged' : 'Melee';
    lines.push(attack.text === '' ? `${label} ${attack.name}` : `${label} ${attack.name}, ${attack.text}`);
  }
  for (const trait of passiveTraits) {
    lines.push(trait.text === '' ? trait.name : `${trait.name} ${trait.text}`);
  }
  for (const action of featActions) {
    lines.push(action.text === '' ? action.name : `${action.name} — ${action.text}`);
  }
  for (const reaction of reactions) {
    lines.push(reaction.text === '' ? reaction.name : `${reaction.name} — ${reaction.text}`);
  }

  return {
    name: doc.name,
    statBlock,
    text: lines.join('\n'),
  };
}

// --- Adapter ---------------------------------------------------------------

/** Synchronous parse body — wrapped into a promise by `parseFile`. */
function parseFileSync(fileName: string, bytes: Uint8Array): PackFileParse {
  const text = new TextDecoder('utf-8').decode(bytes);
  const docs = parseDocs(text, fileName);
  const entries: PackEntry[] = [];
  const failures: PackFileParse['failures'] = [];
  let skipped = 0;
  for (const [index, doc] of docs.entries()) {
    if (!isRecord(doc) || doc.type !== 'npc') {
      skipped += 1;
      continue;
    }
    const name = typeof doc.name === 'string' ? doc.name : '';
    try {
      entries.push(mapNpc(dnd5eNpcSchema.parse(doc)));
    } catch (error) {
      failures.push({
        file: fileName,
        name,
        message: `document ${String(index)}: ${errorMessage(error)}`,
      });
    }
  }
  return { entries, skipped, failures };
}

function parseFile(fileName: string, bytes: Uint8Array): Promise<PackFileParse> {
  try {
    return Promise.resolve(parseFileSync(fileName, bytes));
  } catch (error) {
    // Rejections instead of sync throws: the adapter contract is promise-based.
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

export const foundryDnd5eSrdAdapter: PackAdapter = {
  id: FOUNDRY_DND5E_SRD_ADAPTER_ID,
  label: 'D&D 5e (Foundry VTT dnd5e system packs — SRD)',
  system: 'dnd5e',
  license: FOUNDRY_DND5E_SRD_LICENSE,
  extensions: ['.yml', '.yaml'],
  parseFile,
};
