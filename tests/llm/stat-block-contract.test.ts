import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { COPIED_SPELL_ENTRY_KEY, statBlockSchema } from '@/domain/statblock';
import {
  STORED_ASSIGNMENT_KEYS,
  foreignAssignmentKeys,
  mobSpellAssignmentSchemaFor,
  spellEntryShape,
  spellEntryShapeKeys,
  statBlockResponseFormat,
  statBlockSchemaFor,
} from '@/llm/statBlockContract';
import { strictJsonSchema } from '@/llm/strictSchema';
/**
 * THE system-aware stat-block request contract (docs/17 row 205).
 *
 * The owner's real Pathfinder 2e run produced eight loud errors, one per
 * spell: *"the mob «Nirklex» assigns a spell it cannot use: the spell
 * «Regenerate» is pathfinder2e; a dnd5e caster/character level cannot apply to
 * it"*. The root cause was in OUR contract, not the model: the 5e lane (row
 * 194) added `casterLevel`/`characterLevel` to the ONE STORED assignment
 * schema, and `strictSchema` turns every key of a zod schema into a required,
 * nullable property — so a PF2e request's response format DEMANDED the other
 * system's fields, and the prose shape the model read (`{ name, castRank }`)
 * disagreed with the schema that constrained it.
 *
 * These pins are DIFFERENTIAL: the same builder is asked for both systems and
 * the emitted JSON Schemas are compared field-for-field, so the two can never
 * collapse into one shape (an identical pair is the tell, never the result).
 */

const ENGINE = join(process.cwd(), 'src', 'llm', 'runEngine.ts');
const CONTRACT = join(process.cwd(), 'src', 'llm', 'statBlockContract.ts');

/** A minimal block satisfying every required stat-block field — the fixture
 *  every compatibility arm parses, so an arm cannot drift by its own shape. */
const BASE_BLOCK = {
  system: 'pathfinder2e' as const,
  level: '5',
  size: 'Small',
  creatureType: 'goblinoid',
  ac: 20,
  acNote: '',
  hp: 60,
  hpFormula: '',
  speed: '25 feet',
  abilities: { str: 14, dex: 16, con: 14, int: 16, wis: 12, cha: 10 },
  saves: '',
  skills: '',
  senses: '',
  languages: 'Goblin',
  traits: [],
  actions: [],
  reactions: [],
  legendary: [],
  extras: {},
};

interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean | Record<string, unknown>;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
}

/** The ONE `spells` property node of an emitted stat-block schema. */
function spellsNode(system: 'pathfinder2e' | 'dnd5e', spellCorpus: boolean): JsonSchemaNode {
  const { schema } = strictJsonSchema('stat-block', statBlockSchemaFor(system, spellCorpus));
  const spells = (schema as JsonSchemaNode).properties?.spells;
  if (spells === undefined) throw new Error('the stat-block schema carries no spells property');
  // `z.array(...).nullish()` emits an `anyOf: [array, null]`.
  const array = spells.type === 'array' ? spells : spells.anyOf?.find((node) => node.type === 'array');
  if (array?.items === undefined) throw new Error('the spells property is not an array');
  return array.items;
}

function keysOf(node: JsonSchemaNode): string[] {
  return Object.keys(node.properties ?? {});
}

/** The assignment key set a WHOLE stat-block schema emits for one `spells`
 *  entry — the same walk `spellsNode` does, over an already-converted schema. */
function assignmentKeysOf(schema: Record<string, unknown>): string[] {
  const spells = (schema as JsonSchemaNode).properties?.spells;
  if (spells === undefined) throw new Error('the stat-block schema carries no spells property');
  const array = spells.type === 'array' ? spells : spells.anyOf?.find((node) => node.type === 'array');
  if (array?.items === undefined) throw new Error('the spells property is not an array');
  return keysOf(array.items);
}

describe('the request contract is per system (docs/17 row 205)', () => {
  it('a PF2e request asks for castRank/autoHeightenLevel and NOT the dnd5e keys', () => {
    const keys = keysOf(spellsNode('pathfinder2e', true));
    expect(keys).toContain('name');
    expect(keys).toContain('castRank');
    expect(keys).toContain('autoHeightenLevel');
    expect(keys).not.toContain('casterLevel');
    expect(keys).not.toContain('characterLevel');
  });

  it('the dnd5e request is the MIRROR — and the two emitted schemas DIFFER', () => {
    const pf2e = spellsNode('pathfinder2e', true);
    const dnd5e = spellsNode('dnd5e', true);
    expect(keysOf(dnd5e)).toEqual(['name', 'castRank', 'casterLevel', 'characterLevel']);
    expect(keysOf(dnd5e)).not.toContain('autoHeightenLevel');
    // The differential's own guard: two identical arms would prove nothing.
    expect(JSON.stringify(pf2e)).not.toEqual(JSON.stringify(dnd5e));
  });

  it('the assignment builder itself is per-system', () => {
    const pf2e = strictJsonSchema('assignment', mobSpellAssignmentSchemaFor('pathfinder2e'));
    const dnd5e = strictJsonSchema('assignment', mobSpellAssignmentSchemaFor('dnd5e'));
    const keys = (schema: unknown): string[] => {
      const properties =
        typeof schema === 'object' && schema !== null
          ? (schema as { properties?: Record<string, unknown> }).properties
          : undefined;
      return Object.keys(properties ?? {});
    };
    expect(keys(pf2e.schema)).toEqual(['name', 'castRank', 'autoHeightenLevel']);
    expect(keys(dnd5e.schema)).toEqual(['name', 'castRank', 'casterLevel', 'characterLevel']);
  });

  it('every emitted optional assignment property is still required-nullable', () => {
    for (const system of ['pathfinder2e', 'dnd5e'] as const) {
      const node = spellsNode(system, true);
      expect(node.required).toEqual(keysOf(node));
      // `name` is a required plain string; every OTHER key is a nullish field
      // that strict mode must let the model spell as `null`.
      for (const key of keysOf(node)) {
        if (key === 'name') continue;
        expect(JSON.stringify(node.properties?.[key])).toContain('null');
      }
    }
  });

  it('a system with NO corpus keeps the PRE-ARC stored superset; storage adds only the copy payload', () => {
    for (const system of ['pathfinder2e', 'dnd5e'] as const) {
      // The request arm is still the pre-arc assignment builder, key for key.
      const request = strictJsonSchema('stat-block', statBlockSchemaFor(system, false));
      const requestKeys = assignmentKeysOf(request.schema);
      expect(requestKeys).toEqual([...STORED_ASSIGNMENT_KEYS]);
      // Storage adds EXACTLY the copy-only key (docs/17 row 255c): the library
      // entry a copied assignment carries. The app writes it, never the model,
      // so the request does not ask for it — and the difference is asserted by
      // name below, so a stray key on either side still reds.
      expect(COPIED_SPELL_ENTRY_KEY).toBe('spellData');
      // A model's reply to the request arm still parses as STORAGE — the
      // property the two schemas exist to guarantee, and the reason a
      // structural difference is allowed at all.
      const reply = {
        ...BASE_BLOCK,
        spells: [{ name: 'Regenerate', castRank: 4, casterLevel: 9, characterLevel: 9 }],
      };
      const parsed = statBlockSchema.parse(statBlockSchemaFor(system, false).parse(reply));
      expect(parsed.spells?.[0]?.name).toBe('Regenerate');
      // The copy key is ABSENT on such a row (not defaulted to a placeholder).
      expect(parsed.spells?.[0]?.spellData).toBeUndefined();
    }
    // …and the name stays the pre-arc `statblock` for those systems.
    expect(statBlockResponseFormat('pathfinder2e', false).name).toBe('statblock');
    expect(statBlockResponseFormat('pathfinder2e', true).name).toBe('statblock-pathfinder2e');
    expect(statBlockResponseFormat('dnd5e', true).name).toBe('statblock-dnd5e');
  });

  it('does not emit a $ref (a reused instance would be refused loudly)', () => {
    const { schema } = strictJsonSchema('stat-block', statBlockSchemaFor('dnd5e', true));
    expect(JSON.stringify(schema)).not.toContain('$ref');
  });
});

describe('the prose shape is the SAME statement as the contract', () => {
  it('names exactly the request schema keys, per system', () => {
    for (const system of ['pathfinder2e', 'dnd5e'] as const) {
      const prose = spellEntryShape(system);
      expect(spellEntryShapeKeys(system)).toEqual(keysOf(spellsNode(system, true)));
      for (const key of spellEntryShapeKeys(system)) {
        expect(prose).toContain(`"${key}"`);
      }
      // The needle the architecture scan uses is the JSON-quoted spelling.
      expect(prose).toContain('"castRank"');
    }
    // The prose differs between systems too: a dnd5e model is told about the
    // caster/character level, a PF2e one about the focus rank.
    expect(spellEntryShape('pathfinder2e')).toContain('"autoHeightenLevel"');
    expect(spellEntryShape('pathfinder2e')).not.toContain('"casterLevel"');
    expect(spellEntryShape('dnd5e')).toContain('"casterLevel"');
    expect(spellEntryShape('dnd5e')).toContain('"characterLevel"');
    expect(spellEntryShape('dnd5e')).not.toContain('"autoHeightenLevel"');
  });

  it('names the foreign keys it must ignore, in both directions', () => {
    expect(foreignAssignmentKeys('pathfinder2e')).toEqual(['casterLevel', 'characterLevel']);
    expect(foreignAssignmentKeys('dnd5e')).toEqual(['autoHeightenLevel']);
    // The stored superset carries every one of them (the compatibility pin).
    expect([...STORED_ASSIGNMENT_KEYS]).toEqual([
      'name',
      'castRank',
      'autoHeightenLevel',
      'casterLevel',
      'characterLevel',
    ]);
  });
});

describe('the STORED schema still parses every past row (compatibility)', () => {
  const base = BASE_BLOCK;

  it('parses a row carrying ANY of the assignment keys, including the other system’s', () => {
    const parsed = statBlockSchema.parse({
      ...base,
      // The owner's real row: a PF2e spell carrying the dnd5e keys.
      spells: [
        { name: 'Regenerate', castRank: 4, casterLevel: 9, characterLevel: 9 },
        { name: 'Ignition', autoHeightenLevel: 3 },
      ],
    });
    expect(parsed.spells).toHaveLength(2);
    expect(parsed.spells?.[0]?.casterLevel).toBe(9);
    expect(parsed.spells?.[1]?.autoHeightenLevel).toBe(3);
  });

  it('a legacy row with no spells key still parses (and stays distinguishable)', () => {
    const legacy = statBlockSchema.parse(base);
    expect(legacy.spells).toBeUndefined();
    const empty = statBlockSchema.parse({ ...base, spells: null });
    expect(empty.spells).toBeNull();
  });

  it('the request variants are STRUCTURAL SUBSETS: a reply they admit still parses as storage', () => {
    const reply = {
      ...base,
      spells: [
        { name: 'Regenerate', castRank: 4, casterLevel: 9, characterLevel: 9 },
      ],
    };
    for (const system of ['pathfinder2e', 'dnd5e'] as const) {
      const request = statBlockSchemaFor(system, true).parse(reply);
      expect(statBlockSchema.safeParse(request).success).toBe(true);
    }
  });
});

describe('every spell-bearing lane goes through the ONE builder (SOURCE SCAN)', () => {
  const engine = readFileSync(ENGINE, 'utf8');
  const contract = readFileSync(CONTRACT, 'utf8');

  it('the request schema is built in exactly one file', () => {
    // Non-vacuity: the file must actually declare the builder.
    expect(contract).toContain('export function statBlockSchemaFor(');
    expect(contract).toContain('export function spellEntryShape(');
    // The engine builds NO stat-block/spell contract of its own.
    expect(engine).not.toMatch(/schemaResponseFormat\(\s*'statblock'/);
    expect(engine).not.toContain('"spells": [');
  });

  it('names the spell-bearing call sites and routes them through the builder', () => {
    // The lanes: the encounter draft contract, the NPC stat-block step and the
    // Cartographer brief. Each is a population pin, so a FOURTH hand-built
    // variant reds by count.
    expect(engine.match(/statBlockResponseFormat\(/g) ?? []).toHaveLength(1);
    expect(engine.match(/encounterDraftSchemaFor\(/g) ?? []).toHaveLength(1);
    expect(engine.match(/encounterGeneratorBriefSchemaFor\(/g) ?? []).toHaveLength(1);
    // The spell-bearing schemas are never handed to `schemaResponseFormat`
    // directly again, and the engine never names the stored schemas as a
    // REQUEST contract.
    expect(engine).not.toMatch(/schemaResponseFormat\([^)]*statBlockSchema\b/);
    expect(engine).not.toMatch(/schemaResponseFormat\([^)]*encounterGeneratorBriefSchema\b/);
    expect(engine).not.toMatch(/schemaResponseFormat\([^)]*encounterDraftSchema\b/);
  });

  it('the no-corpus request is the STORED schema’s own builders, not a second shape', () => {
    // The builder's falsy-corpus arm and the stored schema share their nodes.
    expect(contract).toContain('storedMobSpellAssignmentSchema()');
    expect(contract).toContain('statBlockBaseFields()');
    expect(contract.match(/storedMobSpellAssignmentSchema\(\)/g) ?? []).toHaveLength(1);
  });

  it('the builder module declares the assignment shape in exactly ONE place', () => {
    // ONE assignment shape with two system branches, plus the stat-block
    // builder's two corpus branches. A hand-built `z.object` beside them — the
    // "just for this lane" variant — reds by count.
    expect(contract.match(/z\.object\(/g) ?? []).toHaveLength(4);
    expect(contract.match(/export function statBlockSchemaFor\(/g) ?? []).toHaveLength(1);
    expect(contract.match(/export function statBlockResponseFormat\(/g) ?? []).toHaveLength(1);
    expect(contract.match(/mobSpellAssignmentSchemaFor\(system\)/g) ?? []).toHaveLength(1);
    // The two arms (corpus / no-corpus) are the ONLY places the shared field
    // set is composed.
    expect(contract.match(/\.\.\.statBlockBaseFields\(\)/g) ?? []).toHaveLength(2);
  });
});
