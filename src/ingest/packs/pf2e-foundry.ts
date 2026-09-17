import { z } from 'zod';

import type { MobSpellAssignment } from '@/domain/mobSpells';
import { spellTraitsAreCantrip, spellTraitsAreFocus } from '@/domain/spellData';
import { formatModifier, type StatBlock } from '@/domain/statblock';
import { errorMessage } from '@/lib/errors';

import {
  htmlToText,
  isDocumentRecord,
  parseJsonDocs,
  AT_BRACE_LABEL_BLOCK_AND_TABLE,
} from './text';
import { asPackFileParser, type PackAdapter, type PackEntry, type PackFileParse } from './types';

/**
 * `foundry-pf2e` pack adapter (12-BESTIARY-PACKS §5): creature entries from
 * the Foundry VTT PF2e system content packs ([foundryvtt/pf2e](https://github
 * .com/foundryvtt/pf2e) `packs/pf2e/**`). The current default branch (`v14-dev`)
 * ships one JSON file per creature (`type: 'npc'`); older releases ship the
 * same documents as NDJSON `.db` files — both are accepted. Folder documents
 * and non-NPC documents are skipped by design and counted, never silently
 * dropped.
 *
 * Field mapping verified against the live `v14-dev` Monster Core corpus (all
 * 492 documents, 2026-09-05); the fixture tests pin the consumed subset. One
 * structural v14-dev change from the older shape: **perception moved from
 * `system.attributes.perception` to top-level `system.perception`** (the old
 * path no longer exists on any v14-dev NPC). pf2e stores ability *modifiers*;
 * the shared StatBlock expects d20 *scores*, so scores are derived as
 * 10 + 2·mod — the exact inverse of `abilityModifier` — and the raw modifiers
 * are kept in `extras['Ability modifiers']` for fidelity.
 */

export const FOUNDRY_PF2E_ADAPTER_ID = 'foundry-pf2e';

export const FOUNDRY_PF2E_LICENSE =
  'Pathfinder Second Edition content from the Foundry VTT PF2e system packs ' +
  '(Paizo Inc. via the Foundry Gaming LLC partnership; mechanics OGL). ' +
  'User-imported for personal use under Paizo\'s Community Use Policy — not for redistribution.';

const SIZE_LABELS: Readonly<Record<string, string>> = {
  tiny: 'Tiny',
  sm: 'Small',
  med: 'Medium',
  lg: 'Large',
  huge: 'Huge',
  grg: 'Gargantuan',
};

/** Trait candidates for `creatureType`, most specific first. */
const CREATURE_TYPE_TRAITS: readonly string[] = [
  'aberration', 'animal', 'construct', 'dragon', 'fey', 'fiend', 'fungus',
  'humanoid', 'monster', 'ooze', 'plant', 'spirit', 'swarm', 'undead',
];

const SAVE_LABELS: Readonly<Record<string, string>> = {
  fortitude: 'Fort',
  reflex: 'Ref',
  will: 'Will',
};

const ABILITY_ORDER: readonly string[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

const ABILITY_LABELS: Readonly<Record<string, string>> = {
  str: 'Str', dex: 'Dex', con: 'Con', int: 'Int', wis: 'Wis', cha: 'Cha',
};

// --- Source schemas (consumed subset of the Foundry document; unknown keys
// are ignored — the document is never re-serialized). ------------------------

const senseSchema = z.object({
  type: z.string(),
  acuity: z.string().optional(),
  range: z.number().optional(),
});

const pf2eNpcSchema = z.object({
  name: z.string().min(1),
  type: z.literal('npc'),
  items: z.array(z.unknown()).default([]),
  system: z.object({
    details: z.object({
      level: z.object({ value: z.number() }),
      languages: z.object({ value: z.array(z.string()) }).optional(),
      // Per-entry source publication (hygiene rider, docs/12 §15) — carried
      // into the stat block's extras verbatim instead of being dropped.
      publication: z
        .object({
          title: z.string().default(''),
          license: z.string().default(''),
        })
        .nullish(),
    }),
    traits: z.object({
      value: z.array(z.string()).default([]),
      rarity: z.string().default('common'),
      size: z.object({ value: z.string() }).default({ value: 'med' }),
    }),
    abilities: z.record(z.string(), z.object({ mod: z.number() })),
    attributes: z.object({
      ac: z.object({ value: z.number(), details: z.string().default('') }),
      hp: z.object({ max: z.number(), details: z.string().default('') }),
      speed: z.object({
        // `null` = no land speed (fly-only creatures, e.g. the Banshee).
        value: z.number().nullable(),
        otherSpeeds: z
          .array(z.object({ type: z.string(), value: z.number() }))
          .default([]),
      }),
    }),
    // v14-dev moved perception out of `attributes` to the system top level
    // (verified across the whole live Monster Core corpus — the old
    // `system.attributes.perception` path no longer exists on any NPC).
    perception: z.object({
      mod: z.number(),
      details: z.string().default(''),
      senses: z.array(senseSchema).default([]),
    }),
    saves: z.record(
      z.string(),
      z.object({ value: z.number(), saveDetail: z.string().default('') }),
    ),
    skills: z.record(z.string(), z.object({ base: z.number() })).default({}),
  }),
});

const meleeItemSchema = z.object({
  name: z.string().min(1),
  type: z.literal('melee'),
  system: z.object({
    bonus: z.object({ value: z.number() }).default({ value: 0 }),
    damageRolls: z
      .record(z.string(), z.object({ damage: z.string(), damageType: z.string() }))
      .default({}),
    attackEffects: z.object({ value: z.array(z.string()) }).default({ value: [] }),
    traits: z.object({ value: z.array(z.string()) }).default({ value: [] }),
    description: z.object({ value: z.string() }).default({ value: '' }),
  }),
});

const actionItemSchema = z.object({
  name: z.string().min(1),
  type: z.literal('action'),
  system: z.object({
    actionType: z.object({ value: z.string() }).default({ value: 'action' }),
    description: z.object({ value: z.string() }).default({ value: '' }),
    traits: z.object({ value: z.array(z.string()) }).default({ value: [] }),
  }),
});

/**
 * One of the creature's OWN embedded `spell` items (docs/17 row 189). Only the
 * fields a mob-spell assignment needs are consumed: the name and the rank the
 * source CASTS the entry at. That rank is
 * `system.location.heightenedLevel ?? system.level.value`, which IS the
 * upstream Foundry PF2e system's own `SpellPF2e.rank` getter (`foundryvtt/pf2e`
 * @ `v14-dev`, `src/module/item/spell/document.ts`:
 * `Math.clamp(this.system.location.heightenedLevel || this.baseRank, 1, 10)`,
 * `baseRank = system.level.value`) for a RANKED entry — the same file row 183
 * pinned its heightening arithmetic from. A cantrip is one of that getter's two
 * auto-heightened kinds (the other is a FOCUS spell, docs/17 row 191): it
 * auto-derives `ceil(actor.level / 2)` and IGNORES `heightenedLevel` entirely,
 * so a cantrip is stamped with NO cast rank and its (absent or present)
 * `heightenedLevel` is irrelevant — the rank is
 * `domain/spellHeightening.spellAtRank`'s to derive from the caster's level
 * (docs/17 rows 183/184). MEASURED on the real corpus, Ghost Mage's "Dispel
 * Magic" has `level.value: 2` but `heightenedLevel: 3` and its printed stat
 * block lists it at 3rd (Bone Prophet's "Harm" is 1 → 4), so `level.value`
 * alone would print the wrong rank. `type: 'spell'` is REQUIRED: a
 * `weapon`/`consumable` that merely EMBEDS a `spell` object is carried
 * equipment, not the creature's own casting, and a `spellcastingEntry` is the
 * container those items hang from — neither is a spell and neither is stamped.
 * A `spell` item with no level or no traits is a malformed document: `parse`
 * fails the creature LOUDLY rather than dropping it as if it were equipment.
 *
 * KNOWN GAP — CLOSED BY docs/17 ROW 191: the upstream getter ALSO
 * auto-heightens a FOCUS spell the same way
 * (`isAutoHeightened = isCantrip || isFocusSpell`), and a focus item may state
 * neither `heightenedLevel` nor `autoHeightenLevel` (Lawbringer Warpriest,
 * level 5, "Athletic Rush": level 1, no rank stated; upstream rank 3). A focus
 * item is now stamped with NO cast rank (upstream IGNORES `heightenedLevel` for
 * it, and the rank is `domain/spellHeightening.spellAtRank`'s to derive), and
 * the source's fixed `autoHeightenLevel` — item first, else the casting entry's
 * — is carried on the assignment because the rules-pack `SpellData` the rule
 * reads never holds it. The `focus` TRAIT is the signal
 * (`domain/spellData.spellTraitsAreFocus`); upstream's tradition-less-cantrip
 * arm of `isFocusSpell` adds nothing, because a cantrip is auto-heightened
 * whatever its traditions.
 */
const spellItemSchema = z.object({
  name: z.string().min(1),
  type: z.literal('spell'),
  system: z.object({
    level: z.object({ value: z.number().int().positive() }),
    traits: z.object({ value: z.array(z.string()) }),
    // The rank a spontaneous/innate entry is heightened to; a prepared entry or
    // an unheightened spell carries none, and the item's own level is the
    // fallback — exactly `SpellPF2e.rank`'s `heightenedLevel || baseRank`. A
    // cantrip or a FOCUS spell IGNORES this field upstream (its rank is the
    // auto-derived one). `autoHeightenLevel` is the item half of the one fixed
    // auto rank upstream reads for either; `value` is the id of the
    // `spellcastingEntry` this item hangs from, whose own `autoHeightenLevel` is
    // the second half.
    location: z
      .object({
        heightenedLevel: z.number().int().positive().nullish(),
        autoHeightenLevel: z.number().int().positive().nullish(),
        value: z.string().nullish(),
      })
      .nullish(),
  }),
});

/**
 * The container a creature's `spell` items hang from (docs/17 row 191). It
 * contributes NOTHING to the stat block itself, but upstream's `rank` getter
 * reads its `system.autoHeightenLevel.value` as the SECOND source of a focus
 * spell's fixed auto rank (after the item's own). `_id` may be absent on a
 * hand-built document (the entry is then unreferencable and simply carries no
 * rank); a malformed `autoHeightenLevel` FAILS the creature loudly rather than
 * silently falling back to the caster-level derivation.
 */
const spellcastingEntrySchema = z.object({
  _id: z.string().min(1).nullish(),
  type: z.literal('spellcastingEntry'),
  system: z
    .object({
      autoHeightenLevel: z
        .object({ value: z.number().int().positive().nullish() })
        .nullish(),
    })
    .nullish(),
});

type ParsedNpc = z.infer<typeof pf2eNpcSchema>;
type ParsedMelee = z.infer<typeof meleeItemSchema>;
type ParsedAction = z.infer<typeof actionItemSchema>;
type ParsedSpell = z.infer<typeof spellItemSchema>;
type ParsedSpellcastingEntry = z.infer<typeof spellcastingEntrySchema>;

// --- Helpers ---------------------------------------------------------------

function titleCase(slug: string): string {
  return slug
    .split(/[\s-]+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function skillLabel(slug: string): string {
  const lorePrefix = 'lore-';
  if (slug.startsWith(lorePrefix)) {
    return `Lore (${slug.slice(lorePrefix.length).replaceAll('-', ' ')})`;
  }
  return titleCase(slug);
}

// --- Mapping ---------------------------------------------------------------

function mapMelee(item: ParsedMelee): { name: string; text: string } {
  const damages = Object.values(item.system.damageRolls).map(
    (roll) => `${roll.damage} ${roll.damageType}`,
  );
  const parts: string[] = [damages.join(' plus ')];
  if (item.system.traits.value.length > 0) {
    parts.push(`(${item.system.traits.value.join(', ')})`);
  }
  if (item.system.attackEffects.value.length > 0) {
    parts.push(item.system.attackEffects.value.join(', '));
  }
  const description = htmlToText(item.system.description.value, AT_BRACE_LABEL_BLOCK_AND_TABLE);
  if (description !== '') parts.push(description);
  return { name: `${item.name} ${formatModifier(item.system.bonus.value)}`, text: parts.filter((part) => part !== '').join('; ') };
}

function mapAction(item: ParsedAction): { name: string; text: string; actionType: string } {
  const traits = item.system.traits.value;
  const description = htmlToText(item.system.description.value, AT_BRACE_LABEL_BLOCK_AND_TABLE);
  const text = traits.length > 0 ? `(${traits.join(', ')}) ${description}`.trim() : description;
  return { name: item.name, text, actionType: item.system.actionType.value };
}

/**
 * The fixed auto-heightened rank a creature's `spellcastingEntry` container
 * states, keyed by entry `_id`, from the ONE pre-pass over `doc.items`. The
 * importer resolves upstream's `location.autoHeightenLevel ||
 * spellcasting?.system?.autoHeightenLevel.value || null` order HERE — two
 * source fields, so reading them is the importer's job, not a derivation — and
 * carries the resolved value on the focus item's assignment.
 */
function entryAutoHeightenLevels(items: readonly unknown[]): Map<string, number> {
  const levels = new Map<string, number>();
  for (const item of items) {
    if (!isDocumentRecord(item) || item.type !== 'spellcastingEntry') continue;
    const entry: ParsedSpellcastingEntry = spellcastingEntrySchema.parse(item);
    const id = entry._id ?? null;
    const value = entry.system?.autoHeightenLevel?.value ?? null;
    if (id !== null && value !== null) levels.set(id, value);
  }
  return levels;
}

/**
 * One of the creature's OWN `spell` items as a mob-spell assignment (docs/17
 * rows 189/191): the source's own name VERBATIM and the rank the source itself
 * casts the entry at — `system.location.heightenedLevel` when the entry is
 * heightened, else the item's own `system.level.value`, i.e. the upstream
 * Foundry PF2e `SpellPF2e.rank` expression (`src/module/item/spell/document.ts`
 * @ `v14-dev`: `Math.clamp(heightenedLevel || baseRank, 1, 10)`).
 *
 * A CANTRIP carries NO cast rank (docs/17 row 189): upstream IGNORES
 * `heightenedLevel` for one and auto-derives `ceil(actor.level / 2)`.
 *
 * A FOCUS spell is upstream's OTHER auto-heightened kind (docs/17 row 191):
 * `isAutoHeightened = isCantrip || isFocusSpell`, so its `heightenedLevel` is
 * IGNORED too and the importer claims no rank. Instead it carries the source's
 * fixed auto rank when one is stated — the item's own
 * `location.autoHeightenLevel`, else its entry's (`entryLevels`) — because
 * upstream prefers that fixed value over `ceil(actor.level / 2)` and only the
 * CREATURE document holds it; `domain/spellHeightening.spellAtRank` applies it
 * (and derives the ceil rank when the source states none).
 *
 * Nothing here normalizes, defaults or invents a name or a rank: an unresolved
 * name is the render/export boundary's loud business, not the importer's.
 */
function mapSpell(
  item: ParsedSpell,
  entryLevels: ReadonlyMap<string, number>,
): MobSpellAssignment {
  const traits = item.system.traits.value;
  if (spellTraitsAreCantrip(traits)) return { name: item.name };
  if (spellTraitsAreFocus(traits)) {
    const entryLevel = entryLevels.get(item.system.location?.value ?? '') ?? null;
    const autoHeightenLevel = item.system.location?.autoHeightenLevel ?? entryLevel;
    return autoHeightenLevel === null
      ? { name: item.name }
      : { name: item.name, autoHeightenLevel };
  }
  const castRank = item.system.location?.heightenedLevel ?? item.system.level.value;
  return { name: item.name, castRank };
}

function mapNpc(doc: ParsedNpc): PackEntry {
  const details = doc.system.details;
  const traitsSection = doc.system.traits;
  const attributes = doc.system.attributes;
  const perception = doc.system.perception;

  const sizeLabel = SIZE_LABELS[traitsSection.size.value];
  if (sizeLabel === undefined) {
    throw new Error(`unknown size "${traitsSection.size.value}"`);
  }
  const creatureType =
    traitsSection.value.find((trait) => CREATURE_TYPE_TRAITS.includes(trait)) ?? '';

  const abilities: Record<string, number> = {};
  const modifiers: string[] = [];
  for (const key of ABILITY_ORDER) {
    const ability = doc.system.abilities[key];
    if (ability === undefined) throw new Error(`missing ${key} modifier`);
    abilities[key] = 10 + 2 * ability.mod;
    modifiers.push(`${ABILITY_LABELS[key]} ${formatModifier(ability.mod)}`);
  }

  const saves = Object.entries(doc.system.saves).map(([key, save]) => {
    const label = SAVE_LABELS[key] ?? titleCase(key);
    const detail = save.saveDetail.trim();
    return `${label} ${formatModifier(save.value)}${detail === '' ? '' : ` (${detail})`}`;
  });

  const skills = Object.entries(doc.system.skills).map(
    ([slug, skill]) => `${skillLabel(slug)} ${formatModifier(skill.base)}`,
  );

  const senses: string[] = [`Perception ${formatModifier(perception.mod)}`];
  if (perception.details.trim() !== '') {
    senses.push(perception.details.trim());
  }
  if (perception.senses.length > 0) {
    senses.push(
      perception.senses
        .map((sense) => {
          const acuity = sense.acuity ?? '';
          const range = sense.range === undefined ? '' : ` ${String(sense.range)} feet`;
          return `${acuity === '' ? '' : `${acuity} `}${sense.type}${range}`;
        })
        .join(', '),
    );
  }

  const languages = (details.languages?.value ?? []).map((language) => titleCase(language));

  const speeds = [
    // A null land speed (fly-only creature) simply has no base-speed entry.
    ...(attributes.speed.value === null ? [] : [`${String(attributes.speed.value)} feet`]),
    ...attributes.speed.otherSpeeds.map((other) => `${other.type} ${String(other.value)} feet`),
  ];

  const meleeAttacks: { name: string; text: string }[] = [];
  const otherActions: StatBlock['actions'] = [];
  const reactions: StatBlock['reactions'] = [];
  const passiveTraits: StatBlock['traits'] = [];
  // The creature's OWN embedded `spell` items, in the SOURCE's own item order
  // (deterministic, and the honest default: the document's order is the only
  // ordering the source states). A `spellcastingEntry` is the container those
  // items hang from and contributes no row of its own — only a focus item's
  // fixed auto rank, read below (docs/17 row 191); a `spell` object embedded in
  // a `weapon`/`consumable` is carried equipment, not the creature's casting.
  const spells: MobSpellAssignment[] = [];
  // docs/17 row 191: a focus item's fixed auto rank may live on the
  // `spellcastingEntry` it hangs from, which can sit anywhere in `items`, so the
  // container values are read in ONE pre-pass before the walk.
  const spellcastingEntries = entryAutoHeightenLevels(doc.items);
  for (const item of doc.items) {
    if (isDocumentRecord(item) && item.type === 'spell') {
      spells.push(mapSpell(spellItemSchema.parse(item), spellcastingEntries));
      continue;
    }
    const melee = meleeItemSchema.safeParse(item);
    if (melee.success) {
      meleeAttacks.push(mapMelee(melee.data));
      continue;
    }
    const action = actionItemSchema.safeParse(item);
    if (action.success) {
      const mapped = mapAction(action.data);
      if (mapped.actionType === 'reaction') {
        reactions.push({ name: mapped.name, text: mapped.text });
      } else if (mapped.actionType === 'passive') {
        passiveTraits.push({ name: mapped.name, text: mapped.text });
      } else {
        // 'action', 'free', and anything new: a real (non-passive) action.
        otherActions.push({ name: mapped.name, text: mapped.text });
      }
      continue;
    }
    // Carried equipment (`weapon`, `armor`, `effect`, …) is not part of the
    // stat block. The creature's own `spell` items ARE (docs/17 row 189).
  }

  const level = details.level.value;
  const extras: Record<string, string> = {
    'Ability modifiers': modifiers.join(', '),
    Traits: traitsSection.value.join(', '),
  };
  if (traitsSection.rarity !== 'common') extras.Rarity = traitsSection.rarity;
  if (attributes.hp.details.trim() !== '') extras['HP details'] = attributes.hp.details.trim();
  // Per-entry source publication (hygiene rider, docs/12 §15): the corpus
  // carries it at system.details.publication ({license, remaster, title}, full
  // coverage on sampled documents) — preserved as the stat block's Source
  // extra (rendered by the stat-block UI), never silently dropped.
  const publication = details.publication;
  const pubTitle = publication?.title.trim() ?? '';
  const pubLicense = publication?.license.trim() ?? '';
  if (pubTitle !== '' || pubLicense !== '') {
    extras.Source = pubTitle === '' ? pubLicense : `${pubTitle}${pubLicense === '' ? '' : ` (${pubLicense})`}`;
  }

  const statBlock: StatBlock = {
    system: 'pathfinder2e',
    level: String(level),
    size: sizeLabel,
    creatureType,
    ac: attributes.ac.value,
    acNote: attributes.ac.details.trim(),
    hp: attributes.hp.max,
    hpFormula: '',
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
    senses: senses.join('; '),
    languages: languages.join(', '),
    traits: passiveTraits,
    actions: [...meleeAttacks, ...otherActions],
    reactions,
    legendary: [],
    extras,
    // A creature whose OWN document carries no `spell` items OMITS the key, so
    // "no field" (legacy / no spells) stays distinguishable from "authored,
    // empty" — row 184's `.nullish()` contract, exactly as a legacy stat block
    // renders today (no chip section, no error).
    ...(spells.length === 0 ? {} : { spells }),
  };

  const lines: string[] = [
    `${doc.name} — Creature ${String(level)}`,
    `${sizeLabel}${traitsSection.value.length > 0 ? `, ${traitsSection.value.join(', ')}` : ''}`,
    senses.join('; '),
  ];
  if (languages.length > 0) lines.push(`Languages ${languages.join(', ')}`);
  if (skills.length > 0) lines.push(`Skills ${skills.join(', ')}`);
  const acNote = attributes.ac.details.trim();
  const hpDetail = attributes.hp.details.trim();
  lines.push(
    `AC ${String(attributes.ac.value)}${acNote === '' ? '' : ` (${acNote})`}; HP ${String(attributes.hp.max)}${hpDetail === '' ? '' : ` (${hpDetail})`}`,
  );
  if (saves.length > 0) lines.push(`Saves ${saves.join(', ')}`);
  lines.push(`Speed ${speeds.join(', ')}`);
  lines.push(modifiers.join(', '));
  for (const attack of meleeAttacks) {
    lines.push(`Melee ${attack.name}, ${attack.text}`);
  }
  for (const trait of passiveTraits) {
    lines.push(trait.text === '' ? trait.name : `${trait.name} ${trait.text}`);
  }
  for (const action of otherActions) {
    lines.push(action.text === '' ? action.name : `${action.name} — ${action.text}`);
  }

  return {
    name: doc.name,
    statBlock,
    text: lines.join('\n'),
  };
}

// --- Adapter ---------------------------------------------------------------

/** Synchronous parse body — wrapped into the promise contract by `asPackFileParser`. */
function parseFileSync(fileName: string, bytes: Uint8Array): PackFileParse {
  const text = new TextDecoder('utf-8').decode(bytes);
  const docs = parseJsonDocs(text, fileName);
  const entries: PackEntry[] = [];
  const failures: PackFileParse['failures'] = [];
  let skipped = 0;
  for (const [index, doc] of docs.entries()) {
    if (!isDocumentRecord(doc) || doc.type !== 'npc') {
      skipped += 1;
      continue;
    }
    const name = typeof doc.name === 'string' ? doc.name : '';
    try {
      entries.push(mapNpc(pf2eNpcSchema.parse(doc)));
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

const parseFile = asPackFileParser(parseFileSync);

export const foundryPf2eAdapter: PackAdapter = {
  id: FOUNDRY_PF2E_ADAPTER_ID,
  label: 'Pathfinder 2e (Foundry VTT PF2e system packs)',
  system: 'pathfinder2e',
  license: FOUNDRY_PF2E_LICENSE,
  extensions: ['.json', '.db'],
  parseFile,
};
