import { describe, expect, it } from 'vitest';

import { z } from 'zod';

import { statBlockSchema } from '@/domain/statblock';
import { encounterDraftSchema } from '@/llm/schemas';
import {
  StrictSchemaError,
  rawSchemaResponseFormat,
  schemaResponseFormat,
  strictJsonSchema,
} from '@/llm/strictSchema';

/**
 * Strict structured outputs (owner decision): the zod → JSON-Schema strict
 * subset conversion. Pins the conversion convention (all-required + nullable
 * optionals, additionalProperties:false everywhere, records dropped,
 * constraint keywords stripped) and the loud failure for recursion.
 */

interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean | Record<string, unknown>;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  enum?: unknown[];
}

function walkNodes(node: unknown, visit: (node: JsonSchemaNode) => void): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  const record = node as JsonSchemaNode;
  visit(record);
  for (const property of Object.values(record.properties ?? {})) walkNodes(property, visit);
  if (record.items !== undefined) walkNodes(record.items, visit);
  for (const member of record.anyOf ?? []) walkNodes(member, visit);
}

function objectNodes(node: unknown): JsonSchemaNode[] {
  const found: JsonSchemaNode[] = [];
  walkNodes(node, (candidate) => {
    if (candidate.type === 'object') found.push(candidate);
  });
  return found;
}

describe('strictJsonSchema', () => {
  it('converts the encounter draft contract: every object forbids extra keys and requires every key', () => {
    const { name, schema } = strictJsonSchema('encounter-draft', encounterDraftSchema);
    expect(name).toBe('encounter-draft');
    expect(schema.type).toBe('object');
    const objects = objectNodes(schema);
    expect(objects.length).toBeGreaterThan(2);
    for (const objectNode of objects) {
      expect(objectNode.additionalProperties).toBe(false);
      expect(objectNode.required).toEqual(Object.keys(objectNode.properties ?? {}));
    }
    // Top-level keys survive conversion (preprocess fields emit their output shape).
    expect(Object.keys((schema as JsonSchemaNode).properties ?? {})).toEqual([
      'name',
      'summary',
      'suggestedTags',
      'body',
      'difficulty',
      'levelHint',
      'monsters',
      'terrain',
      'tactics',
      'treasure',
      // The scene-assertion declaration (docs/11 assertion rule, row 89): the
      // preprocess field emits its OUTPUT shape (the array), like the other
      // tolerant fields above.
      'substitutions',
      'locationKind',
    ]);
  });

  it('emits the draft tolerance preprocessor fields as their canonical shapes', () => {
    const { schema } = strictJsonSchema('encounter-draft', encounterDraftSchema);
    const properties = (schema as JsonSchemaNode).properties ?? {};
    expect(properties.suggestedTags).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(properties.locationKind).toMatchObject({
      type: 'string',
      enum: ['dungeon', 'building', 'wilderness', 'other'],
    });
    const monster = properties.monsters?.items;
    expect(monster?.properties?.count).toMatchObject({ type: 'integer' });
  });

  it('strips constraint keywords the strict decoders reject (the zod parse still enforces them)', () => {
    const { schema } = strictJsonSchema('encounter-draft', encounterDraftSchema);
    walkNodes(schema, (node) => {
      for (const keyword of [
        'minLength',
        'maxLength',
        'minimum',
        'maximum',
        'exclusiveMinimum',
        'exclusiveMaximum',
        'minItems',
        'maxItems',
        'format',
        'pattern',
        'default',
        '$schema',
      ]) {
        expect(node).not.toHaveProperty(keyword);
      }
    });
  });

  it('emits formerly-optional fields as required + nullable (null parses back to absent)', () => {
    const { schema } = strictJsonSchema('encounter-draft', encounterDraftSchema);
    const monster = (schema as JsonSchemaNode).properties?.monsters?.items;
    expect(monster?.required).toContain('sourceChunkIndex');
    expect(monster?.required).toContain('sourceName');
    expect(monster?.required).toContain('statBlock');
    expect(monster?.properties?.sourceChunkIndex?.type).toEqual(['integer', 'null']);
    const statBlockProperty = monster?.properties?.statBlock;
    expect(Array.isArray(statBlockProperty?.type)).toBe(true);
    expect(statBlockProperty?.type).toContain('object');
    expect(statBlockProperty?.type).toContain('null');
  });

  it('drops the free-form record (StatBlock extras) from the emitted schema', () => {
    const { schema } = strictJsonSchema('statblock', statBlockSchema);
    const properties = (schema as JsonSchemaNode).properties ?? {};
    expect(properties.extras).toBeUndefined();
    expect(properties.abilities).toBeDefined();
    expect(properties.traits?.items?.properties?.name).toMatchObject({ type: 'string' });
    walkNodes(schema, (node) => {
      expect(node).not.toHaveProperty('propertyNames');
    });
    // The runtime schema is unchanged: extras still parses (hand edits, pack imports).
    expect(statBlockSchema.parse({ ...VALID_STATBLOCK_MINIMAL, extras: { CR: '1' } }).extras).toEqual({ CR: '1' });
    // And a strict-decoded reply without extras parses to the default.
    expect(statBlockSchema.parse(VALID_STATBLOCK_MINIMAL).extras).toEqual({});
  });

  it('keeps the parsed draft type shape for null stat sources (absentable convention)', () => {
    const parsed = encounterDraftSchema.parse({
      name: 'Ambush at the ford',
      summary: 's',
      suggestedTags: 'goblins',
      body: 'b',
      difficulty: 'easy',
      levelHint: '1',
      monsters: [
        { name: 'Goblin', count: '2', notes: '', treasure: '', sourceChunkIndex: null, sourceName: null, statBlock: null },
      ],
      terrain: 't',
      tactics: 'x',
      treasure: '',
      locationKind: 'Dungeon',
    });
    expect(parsed.suggestedTags).toEqual(['goblins']);
    expect(parsed.locationKind).toBe('dungeon');
    expect(parsed.monsters[0]?.count).toBe(2);
    expect(parsed.monsters[0]?.sourceChunkIndex).toBeUndefined();
    expect(parsed.monsters[0]?.sourceName).toBeUndefined();
    expect(parsed.monsters[0]?.statBlock).toBeUndefined();
  });

  it('throws loudly on recursive schemas (strict decoders cannot express $ref cycles)', () => {
    interface Category {
      name: string;
      children: Category[];
    }
    const categorySchema: z.ZodType<Category> = z.lazy(() =>
      z.object({ name: z.string(), children: z.array(categorySchema) }),
    );
    expect(() => strictJsonSchema('recursive', categorySchema)).toThrow(StrictSchemaError);
  });

  it('throws loudly on a free-form record at the root and on non-object roots', () => {
    expect(() => strictJsonSchema('record-root', z.record(z.string(), z.string()))).toThrow(
      StrictSchemaError,
    );
    expect(() => strictJsonSchema('string-root', z.string())).toThrow(StrictSchemaError);
  });

  it('sanitizes schema names to the OpenRouter/OpenAI charset', () => {
    const { name } = strictJsonSchema('encounter draft (v2)', encounterDraftSchema);
    expect(name).toBe('encounter-draft--v2-');
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('builds the ChatOptions.responseFormat payload', () => {
    const format = schemaResponseFormat('encounter-draft', encounterDraftSchema);
    expect(format.kind).toBe('schema');
    expect(format.name).toBe('encounter-draft');
    expect(format.jsonSchema.type).toBe('object');
    const raw = rawSchemaResponseFormat('pre-converted', { type: 'object', properties: {} });
    expect(raw).toEqual({ kind: 'schema', name: 'pre-converted', jsonSchema: { type: 'object', properties: {} } });
  });
});

interface StatblockFixture {
  system: string;
  level: string;
  size: string;
  creatureType: string;
  ac: number;
  hp: number;
  speed: string;
  abilities: { str: number; dex: number; con: number; int: number; wis: number; cha: number };
  saves: string;
  skills: string;
  senses: string;
  languages: string;
}

const VALID_STATBLOCK_MINIMAL: StatblockFixture = {
  system: 'dnd5e',
  level: '3',
  size: 'Small',
  creatureType: 'humanoid (goblinoid)',
  ac: 14,
  hp: 22,
  speed: '30 ft.',
  abilities: { str: 8, dex: 16, con: 13, int: 14, wis: 10, cha: 12 },
  saves: '',
  skills: '',
  senses: '',
  languages: 'Common, Goblin',
};
