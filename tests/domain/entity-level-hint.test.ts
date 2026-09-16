import { describe, expect, it } from 'vitest';

import { z } from 'zod';

import {
  ENTITY_LEVEL_HINT_MAX,
  ENTITY_LEVEL_HINT_MIN,
  bestiarySlotForEntity,
  canonicalEntityRecords,
  entityIntentFor,
  entityKindFor,
  entityLevelHintFor,
  moduleEntityKindSchema,
  unmatchedEntityLevelHints,
  withEntityBestiarySlots,
  type ModuleEntityKind,
} from '@/domain';
import { parseSpineEntities } from '@/llm/moduleGen';

/**
 * The entity LEVEL-HINT record field (owner request, docs/17 row 197): the
 * structured level the module author fixes for an entity, carried on the entity
 * RECORD beside `intent` (row 141) and `bestiary` (row 107).
 *
 * These pins judge the FIELD's own contract — what "no level" means, the LOUD
 * malformed case, what a spine reply may answer, that name normalization CARRIES
 * the hint instead of deleting it, and that the lookup is the module's ONE
 * name-comparison seam. The brief's own bytes live in
 * `tests/features/entity-level-hint-batch.test.ts` and
 * `tests/features/persona-request.test.ts`; the stat-block precedence lives in
 * `tests/llm/runEngine.test.ts`.
 */

function record(overrides: Partial<ModuleEntityKind> = {}): ModuleEntityKind {
  return { name: 'Kael', kind: 'npc', absorbed: [], ...overrides };
}

describe('moduleEntityKindSchema.levelHint — additive, optional, one spelling of absence', () => {
  it('a record written before the field parses with NO levelHint key at all', () => {
    const parsed = moduleEntityKindSchema.parse({ name: 'Kael', kind: 'npc', absorbed: [] });
    expect(parsed).toEqual({ name: 'Kael', kind: 'npc', absorbed: [] });
  });

  it('the model’s own null and an empty string both read as no level', () => {
    for (const value of [null, '']) {
      const parsed = moduleEntityKindSchema.parse({
        name: 'Kael',
        kind: 'npc',
        absorbed: [],
        levelHint: value,
      });
      expect(parsed.levelHint).toBeUndefined();
    }
  });

  it('a present level is kept, including a numeric string (meaning-preserving coercion)', () => {
    expect(
      moduleEntityKindSchema.parse({ name: 'Kael', kind: 'npc', absorbed: [], levelHint: 7 }).levelHint,
    ).toBe(7);
    expect(
      moduleEntityKindSchema.parse({ name: 'Kael', kind: 'npc', absorbed: [], levelHint: ' 7 ' }).levelHint,
    ).toBe(7);
  });

  it('the range is enforced by the schema, not by a clamp — and the reason names the field', () => {
    expect(
      moduleEntityKindSchema.parse({
        name: 'Kael',
        kind: 'npc',
        absorbed: [],
        levelHint: ENTITY_LEVEL_HINT_MIN,
      }).levelHint,
    ).toBe(ENTITY_LEVEL_HINT_MIN);
    expect(
      moduleEntityKindSchema.parse({
        name: 'Kael',
        kind: 'npc',
        absorbed: [],
        levelHint: ENTITY_LEVEL_HINT_MAX,
      }).levelHint,
    ).toBe(ENTITY_LEVEL_HINT_MAX);

    // Malformed in four different ways — all LOUD, none silently clamped or
    // dropped (AGENTS rules 1/3).
    for (const bad of [0, ENTITY_LEVEL_HINT_MAX + 1, 3.5, 'seven', true, {}]) {
      let thrown: unknown;
      try {
        moduleEntityKindSchema.parse({ name: 'Kael', kind: 'npc', absorbed: [], levelHint: bad });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(z.ZodError);
      const issues = (thrown as z.ZodError).issues;
      expect(issues.some((issue) => issue.path.join('.') === 'levelHint')).toBe(true);
    }
  });
});

describe('the spine reply may spell absence as null (the strict subset cannot omit a key)', () => {
  const PLAN = [{ title: 'One', levelBand: '1', synopsis: '', levelUpTrigger: '' }];
  function reply(entities: unknown[]): string {
    return JSON.stringify({ premise: 'P', themes: [], partPlan: PLAN, entities });
  }

  it('a reply with no levelHint key and a reply with "levelHint": null both read as no level', () => {
    expect(parseSpineEntities(reply([{ name: 'Kael', kind: 'npc' }]))[0]?.levelHint).toBeUndefined();
    expect(
      parseSpineEntities(reply([{ name: 'Kael', kind: 'npc', levelHint: null }]))[0]?.levelHint,
    ).toBeUndefined();
  });

  it('a present level round-trips through the spine parse', () => {
    const parsed = parseSpineEntities(reply([{ name: 'Kael', kind: 'npc', levelHint: 7 }]));
    expect(parsed[0]?.levelHint).toBe(7);
  });

  it('a MALFORMED level in a reply fails the spine parse LOUDLY, by field (never a partial apply)', () => {
    let thrown: unknown;
    try {
      parseSpineEntities(reply([{ name: 'Kael', kind: 'npc', levelHint: 99 }]));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(z.ZodError);
    const issues = (thrown as z.ZodError).issues;
    expect(issues.some((issue) => issue.path.join('.') === 'entities.0.levelHint')).toBe(true);
  });
});

describe('name normalization CARRIES the hint onto the canonical record, never deletes it', () => {
  it('a variant-keyed hint reaches the canonical record it was written for', () => {
    const source = [record({ name: 'Kael the Grey', levelHint: 7 })];
    const canonical = canonicalEntityRecords([{ name: 'Kael the Grey', canonical: 'Kael', kind: 'npc' }]);
    const carried = withEntityBestiarySlots(canonical, source);
    expect(carried[0]?.name).toBe('Kael');
    expect(carried[0]?.levelHint).toBe(7);
  });

  it('no hint on the source leaves the record WITHOUT the key (byte-identical shape)', () => {
    const canonical = canonicalEntityRecords([{ name: 'Kael', canonical: 'Kael', kind: 'npc' }]);
    const carried = withEntityBestiarySlots(canonical, [record()]);
    expect(carried[0]).toEqual({ name: 'Kael', kind: 'npc', absorbed: [] });
  });

  it('two source records answering ONE canonical with DIFFERENT levels is LOUD, never a pick', () => {
    // The normalizer folded two variants onto one canonical and their records
    // state different levels: picking one would silently generate the entity at
    // a level the other contradicts (AGENTS rule 1). The canonical's own name
    // and its `absorbed` variant each resolve to a different source record.
    const source: ModuleEntityKind[] = [
      { name: 'Kael', kind: 'npc', absorbed: [], levelHint: 3 },
      { name: 'Kael the Grey', kind: 'npc', absorbed: [], levelHint: 7 },
    ];
    const canonical: ModuleEntityKind[] = [
      { name: 'Kael', kind: 'npc', absorbed: ['Kael the Grey'] },
    ];
    expect(() => withEntityBestiarySlots(canonical, source)).toThrow(
      /entity level hint: «Kael» was given two different levels \(7 and 3\)/,
    );
  });

  it('two source records agreeing on one level carry it once', () => {
    const source: ModuleEntityKind[] = [
      { name: 'Kael', kind: 'npc', absorbed: [], levelHint: 7 },
      { name: 'Kael the Grey', kind: 'npc', absorbed: [], levelHint: 7 },
    ];
    const canonical: ModuleEntityKind[] = [
      { name: 'Kael', kind: 'npc', absorbed: ['Kael the Grey'] },
    ];
    const carried = withEntityBestiarySlots(canonical, source);
    expect(carried[0]?.levelHint).toBe(7);
  });
});

describe('entityLevelHintFor — the ONE read of the level', () => {
  it('finds the level by name, case- and composition-insensitively, and null for everything else', () => {
    const records = [record({ levelHint: 7 }), record({ name: 'Bram', kind: 'npc' })];
    expect(entityLevelHintFor(records, 'Kael')).toBe(7);
    expect(entityLevelHintFor(records, '  kael  ')).toBe(7);
    // A decomposed spelling of the same name resolves to the same record
    // (`sameAliasName`'s canonical composition, docs/17 row 166/167).
    expect(entityLevelHintFor([record({ name: 'Müller', kind: 'npc', levelHint: 4 })], 'Mu\u0308ller')).toBe(4);
    expect(entityLevelHintFor(records, 'Bram')).toBeNull();
    expect(entityLevelHintFor(records, 'Nobody')).toBeNull();
    expect(entityLevelHintFor(records, '   ')).toBeNull();
  });

  it('a record whose levelHint is a numeric string still reads as a number after parse', () => {
    const records = [moduleEntityKindSchema.parse({ name: 'Kael', kind: 'npc', levelHint: '7' })];
    expect(entityLevelHintFor(records, 'Kael')).toBe(7);
  });
});

describe('unmatchedEntityLevelHints — the one derivation of a hint that can never be consumed', () => {
  it('names a hint whose name the module text never mentions', () => {
    const records = [record({ name: 'Kael', levelHint: 7 }), record({ name: 'Bram' })];
    expect(unmatchedEntityLevelHints(['[[Bram]]'], records).map((entry) => entry.name)).toEqual(['Kael']);
  });

  it('a mention in ANY spelling that the kind lookup accepts counts as matched', () => {
    const records = [record({ name: 'Müller', levelHint: 4 })];
    expect(unmatchedEntityLevelHints(['Mu\u0308ller'], records)).toEqual([]);
    expect(unmatchedEntityLevelHints(['  müller '], records)).toEqual([]);
  });

  it('a record with NO hint is never reported (nothing was dropped)', () => {
    expect(unmatchedEntityLevelHints([], [record({ name: 'Kael' })])).toEqual([]);
  });
});

/**
 * PIN 7 — the matching is the module's ONE name-comparison seam (docs/18 §2,
 * AGENTS rule 4). Every per-entity record lookup must select the SAME record for
 * the same name spellings; if one of them grows a second spelling (a hand-rolled
 * `trim().toLowerCase()`, a substring match), the differential breaks.
 */
describe('every per-entity record lookup agrees: ONE name-comparison seam', () => {
  const records: ModuleEntityKind[] = [
    { name: 'Müller', kind: 'npc', absorbed: [], levelHint: 7, intent: 'a ferryman' },
    { name: 'Kael', kind: 'npc', absorbed: [], bestiary: { creature: 'Zombie' } },
  ];
  // The expected outcome of EVERY spelling is known A PRIORI (never re-derived
  // through the seam being tested), so a second spelling in any single reader
  // makes exactly that reader disagree with the rest.
  const onMuller = ['Müller', 'müller', '  MÜLLER  ', 'Mu\u0308ller'];
  const onKael = ['Kael', 'kael'];
  const onNothing = ['Nobody', ''];

  it('the four readers answer for exactly the same name set, on every spelling', () => {
    for (const name of onMuller) {
      expect(entityKindFor(records, name)).toBe('npc');
      expect(entityLevelHintFor(records, name)).toBe(7);
      expect(entityIntentFor(records, name)).toBe('a ferryman');
      expect(bestiarySlotForEntity(records, name)).toBeNull();
    }
    for (const name of onKael) {
      expect(entityKindFor(records, name)).toBe('npc');
      expect(entityLevelHintFor(records, name)).toBeNull();
      expect(entityIntentFor(records, name)).toBeNull();
      expect(bestiarySlotForEntity(records, name)).toEqual({ creature: 'Zombie' });
    }
    for (const name of onNothing) {
      expect(entityKindFor(records, name)).toBeUndefined();
      expect(entityLevelHintFor(records, name)).toBeNull();
      expect(entityIntentFor(records, name)).toBeNull();
      expect(bestiarySlotForEntity(records, name)).toBeNull();
    }
  });

  it('the unmatched derivation asks the SAME comparison the hint reader asks', () => {
    // Mentioning the hinted name in ANY spelling it answers to makes it matched.
    for (const name of onMuller) {
      expect(unmatchedEntityLevelHints([name], records).map((entry) => entry.name)).not.toContain(
        'Müller',
      );
    }
    // A mention of the OTHER record leaves the hinted one unmatched — the loud
    // case, and the proof the comparison is per-name and not global.
    for (const name of onKael) {
      expect(unmatchedEntityLevelHints([name], records).map((entry) => entry.name)).toEqual([
        'Müller',
      ]);
    }
    // With NO mention at all, the hinted record is unmatched.
    expect(unmatchedEntityLevelHints([], records).map((entry) => entry.name)).toEqual(['Müller']);
  });
});
