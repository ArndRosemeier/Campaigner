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
 * Field mapping verified against the repository at spec time; the fixture
 * tests (real trimmed `ape.yml`/`wolf.yml`/`kobold.yml`/`goblin.yml` subsets)
 * pin the consumed subset. The consumed sub-fields, all fixture-pinned:
 *
 * - `system.abilities.<abil>.value` → StatBlock scores **directly** (dnd5e
 *   stores scores, the exact inverse information of the pf2e adapter);
 *   `<abil>.proficient` (0/1) → rendered save strings.
 * - `system.attributes.ac.flat` → `ac`. A document without a flat AC (armor
 *   creatures store `flat: null, calc: 'default'`, e.g. Goblin) fails loudly
 *   as a per-entry failure: deriving AC from armor items would be Foundry
 *   system automation (§9) and could silently diverge from the printed block,
 *   and `statBlock` must be exact, never best-effort (§1).
 * - `system.attributes.hp.max` + `.formula` → `hp` + `hpFormula`.
 * - `system.details.cr` (number, `0.125/0.25/0.5` allowed; string accepted) →
 *   `level` in the printed convention (`"1/2"`) + numeric `levelSort`.
 * - `system.traits.size`, `system.details.type.value` (+ `.subtype` tag),
 *   `system.attributes.movement` (per-type feet values), `senses` (per-sense
 *   feet + `special`), `system.traits.languages.value`/`.custom`,
 *   `system.skills.<id>.{value, ability}` (proficiency level → rendered
 *   "Stealth +6"-style strings), `di`/`dr`/`dv`/`ci` → extras.
 * - `items[]` `feat` bucketed by activity activation: no activities/passive →
 *   `traits`, `reaction` → `reactions`, else → `actions`; `items[]` `weapon`
 *   → one rendered attack line from the first attack activity.
 *
 * The source stores no computed totals, so save/skill/attack modifiers are
 * rendered with the standard printed-convention derivation from the pinned
 * sub-fields: ability modifier = `abilityModifier(score)` (the shared
 * StatBlock inverse), proficiency bonus = `floor(CR / 4) + 2`, weapon ability
 * = stored `attack.ability`, else finesse melee → better of Str/Dex, ranged →
 * Dex (a ranged natural weapon such as the ape's Rock therefore renders
 * DEX-based, exactly as the dnd5e system computes the stored data — which can
 * differ from the printed book's STR-based listing for thrown rocks; the data,
 * not the book layout, is authoritative for an exact mapping). No other roll
 * math is performed (§9: no Foundry system code) — attack
 * activities' extra damage parts (e.g. `@mod` versatile variants), spell
 * items, equipment and carried weapons without an attack activity are not
 * represented in v1 (documented scope cut, not a failure path).
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
          burrow: z.number().default(0),
          climb: z.number().default(0),
          fly: z.number().default(0),
          swim: z.number().default(0),
          walk: z.number().default(0),
          units: z.string().default('ft'),
          hover: z.boolean().default(false),
        })
        .default({
          burrow: 0, climb: 0, fly: 0, swim: 0, walk: 0, units: 'ft', hover: false,
        }),
      senses: z
        .object({
          darkvision: z.number().default(0),
          blindsight: z.number().default(0),
          tremorsense: z.number().default(0),
          truesight: z.number().default(0),
          units: z.string().default('ft'),
          special: z.string().default(''),
        })
        .default({
          darkvision: 0, blindsight: 0, tremorsense: 0, truesight: 0, units: 'ft', special: '',
        }),
    }),
    details: z.object({
      cr: z.union([z.number(), z.string()]),
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
      type: z.object({ value: z.string().default('') }).default({ value: '' }),
    })
    .default({ ability: '', bonus: '', type: { value: '' } }),
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
          })
          .nullish()
          .default(null),
      })
      .default({ base: null }),
    activities: z.record(z.string(), attackActivitySchema).default({}),
  }),
});

type ParsedNpc = z.infer<typeof dnd5eNpcSchema>;
type ParsedFeat = z.infer<typeof featItemSchema>;
type ParsedWeapon = z.infer<typeof weaponItemSchema>;

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

/** Printed challenge rating: `0.5` → `"1/2"`, `2` → `"2"`. */
function levelFromCr(cr: number | string): { level: string; sort: number } {
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

function mapWeapon(
  item: ParsedWeapon,
  abilities: Readonly<Record<string, number>>,
  pb: number,
): { name: string; text: string; ranged: boolean } {
  const attack = Object.values(item.system.activities).find((activity) => activity.type === 'attack');
  if (attack === undefined) {
    throw new Error(`weapon "${item.name}" has no attack activity`);
  }
  const base = item.system.damage.base;
  const noBaseDamage = `weapon "${item.name}" has no base damage`;
  if (base === null) throw new Error(noBaseDamage);
  if (base.number === null || base.denomination === null) throw new Error(noBaseDamage);

  const typeValue = item.system.type.value;
  const ranged = attack.attack.type.value === 'ranged' || typeValue.endsWith('R');
  const strMod = abilityModifier(abilities.str ?? 0);
  const dexMod = abilityModifier(abilities.dex ?? 0);
  let abilityKey = attack.attack.ability;
  if (abilityKey === '') {
    if (ranged) abilityKey = 'dex';
    else if (item.system.properties.includes('fin')) abilityKey = dexMod >= strMod ? 'dex' : 'str';
    else abilityKey = 'str';
  }
  const abilityScore = abilities[abilityKey];
  if (abilityScore === undefined) {
    throw new Error(`weapon "${item.name}" attacks with unknown ability "${abilityKey}"`);
  }
  const abilityMod = abilityModifier(abilityScore);
  // `proficient: 0` means explicitly unproficient; monsters inherit
  // proficiency with their own attacks (`proficient: null`/`1`).
  const prof = item.system.proficient === 0 ? 0 : pb;
  const toHit = abilityMod + prof + numericBonus(attack.attack.bonus, 'attack bonus');

  const damageBonus = abilityMod + numericBonus(base.bonus, 'damage bonus');
  const damage = `${String(base.number)}d${String(base.denomination)}${damageBonus === 0 ? '' : formatModifier(damageBonus)}`;
  const properties = item.system.properties
    .map((property) => PROPERTY_LABELS[property])
    .filter((label) => label !== undefined);
  const notes = [...properties];
  if (ranged && item.system.range.value !== null && item.system.range.value > 0) {
    const long = item.system.range.long === null ? '' : `/${String(item.system.range.long)}`;
    notes.push(`range ${String(item.system.range.value)}${long} ft.`);
  }
  const parts = [damage, base.types.join(' ')];
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
  const pb = proficiencyBonus(cr);

  const ac = system.attributes.ac.flat;
  if (ac === null || ac === undefined) {
    throw new Error(
      `no flat Armor Class stored (ac.calc "${system.attributes.ac.calc}") — ` +
        'the adapter maps only exact, stored AC values',
    );
  }

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

  if (system.attributes.senses.units !== 'ft') {
    throw new Error(`unsupported sense units "${system.attributes.senses.units}"`);
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
      const range = system.attributes.senses[key];
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

  if (system.attributes.movement.units !== 'ft') {
    throw new Error(`unsupported movement units "${system.attributes.movement.units}"`);
  }
  const movement = system.attributes.movement;
  const speeds: string[] = [];
  if (movement.walk > 0) speeds.push(`${String(movement.walk)} feet`);
  for (const [key, label] of [['burrow', 'burrow'], ['climb', 'climb'], ['fly', 'fly'], ['swim', 'swim']] as const) {
    const value = movement[key];
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
      attacks.push(mapWeapon(weapon.data, abilities, pb));
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
    acNote: '',
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
    `AC ${String(ac)}; HP ${String(system.attributes.hp.max)}${hpFormula === '' ? '' : ` (${hpFormula})`}`,
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
    lines.push(`${attack.ranged ? 'Ranged' : 'Melee'} ${attack.name}, ${attack.text}`);
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
