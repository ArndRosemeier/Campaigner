import { z } from 'zod';

import { formatModifier, type StatBlock } from '@/domain/statblock';
import { errorMessage } from '@/lib/errors';

import type { PackAdapter, PackEntry, PackFileParse } from './types';

/**
 * `foundry-pf2e` pack adapter (12-BESTIARY-PACKS §5): creature entries from
 * the Foundry VTT PF2e system content packs ([foundryvtt/pf2e](https://github
 * .com/foundryvtt/pf2e) `packs/pf2e/**`). The current default branch ships one
 * JSON file per creature (`type: 'npc'`); older releases ship the same
 * documents as NDJSON `.db` files — both are accepted. Folder documents and
 * non-NPC documents are skipped by design and counted, never silently dropped.
 *
 * Field mapping verified against the repository at spec time; the fixture
 * tests pin the consumed subset. pf2e stores ability *modifiers*; the shared
 * StatBlock expects d20 *scores*, so scores are derived as 10 + 2·mod — the
 * exact inverse of `abilityModifier` — and the raw modifiers are kept in
 * `extras['Ability modifiers']` for fidelity.
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
      perception: z.object({
        mod: z.number(),
        details: z.string().default(''),
        senses: z.array(senseSchema).default([]),
      }),
      speed: z.object({
        value: z.number(),
        otherSpeeds: z
          .array(z.object({ type: z.string(), value: z.number() }))
          .default([]),
      }),
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

type ParsedNpc = z.infer<typeof pf2eNpcSchema>;
type ParsedMelee = z.infer<typeof meleeItemSchema>;
type ParsedAction = z.infer<typeof actionItemSchema>;

// --- Helpers ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whole-file JSON when possible, otherwise newline-delimited JSON (the older
 * `.db` pack format). A line that fails to parse fails the file loudly.
 */
function parseDocs(text: string, fileName: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed === '') throw new Error(`${fileName}: file is empty`);
  try {
    return [JSON.parse(trimmed) as unknown];
  } catch {
    // Fall through to NDJSON — this branch decides nothing, the loop below
    // still fails loudly per line.
  }
  const docs: unknown[] = [];
  for (const [index, line] of trimmed.split('\n').entries()) {
    const candidate = line.trim();
    if (candidate === '') continue;
    try {
      docs.push(JSON.parse(candidate) as unknown);
    } catch (error) {
      throw new Error(`${fileName}: line ${String(index + 1)} is not valid JSON: ${errorMessage(error)}`, { cause: error });
    }
  }
  return docs;
}

/** Strips pf2e description HTML to plain text, resolving @-notation. */
function stripHtml(html: string): string {
  const withoutNotation = html.replace(/@(\w+)\[([^\]]*)\]/g, (_match, _kind: string, inner: string) => {
    const beforePipe = inner.split('|')[0] ?? '';
    return beforePipe.split('.').pop() ?? '';
  });
  return withoutNotation
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
  const description = stripHtml(item.system.description.value);
  if (description !== '') parts.push(description);
  return { name: `${item.name} ${formatModifier(item.system.bonus.value)}`, text: parts.filter((part) => part !== '').join('; ') };
}

function mapAction(item: ParsedAction): { name: string; text: string; actionType: string } {
  const traits = item.system.traits.value;
  const description = stripHtml(item.system.description.value);
  const text = traits.length > 0 ? `(${traits.join(', ')}) ${description}`.trim() : description;
  return { name: item.name, text, actionType: item.system.actionType.value };
}

function mapNpc(doc: ParsedNpc): PackEntry {
  const details = doc.system.details;
  const traitsSection = doc.system.traits;
  const attributes = doc.system.attributes;

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

  const senses: string[] = [`Perception ${formatModifier(attributes.perception.mod)}`];
  if (attributes.perception.details.trim() !== '') {
    senses.push(attributes.perception.details.trim());
  }
  if (attributes.perception.senses.length > 0) {
    senses.push(
      attributes.perception.senses
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
    `${String(attributes.speed.value)} feet`,
    ...attributes.speed.otherSpeeds.map((other) => `${other.type} ${String(other.value)} feet`),
  ];

  const meleeAttacks: { name: string; text: string }[] = [];
  const otherActions: StatBlock['actions'] = [];
  const reactions: StatBlock['reactions'] = [];
  const passiveTraits: StatBlock['traits'] = [];
  for (const item of doc.items) {
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
    // Carried equipment (`weapon`, `armor`, `spell`, `effect`, …) is not part
    // of the stat block (12-BESTIARY-PACKS §9: no spell data in v1).
  }

  const level = details.level.value;
  const extras: Record<string, string> = {
    'Ability modifiers': modifiers.join(', '),
    Traits: traitsSection.value.join(', '),
  };
  if (traitsSection.rarity !== 'common') extras.Rarity = traitsSection.rarity;
  if (attributes.hp.details.trim() !== '') extras['HP details'] = attributes.hp.details.trim();

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

function parseFile(fileName: string, bytes: Uint8Array): Promise<PackFileParse> {
  try {
    return Promise.resolve(parseFileSync(fileName, bytes));
  } catch (error) {
    // Rejections instead of sync throws: the adapter contract is promise-based.
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

export const foundryPf2eAdapter: PackAdapter = {
  id: FOUNDRY_PF2E_ADAPTER_ID,
  label: 'Pathfinder 2e (Foundry VTT PF2e system packs)',
  system: 'pathfinder2e',
  license: FOUNDRY_PF2E_LICENSE,
  extensions: ['.json', '.db'],
  parseFile,
};
