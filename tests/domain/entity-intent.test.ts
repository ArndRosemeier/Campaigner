import { describe, expect, it } from 'vitest';

import { z } from 'zod';

import {
  ENTITY_INTENT_MAX_LENGTH,
  canonicalEntityRecords,
  entityIntentFor,
  moduleEntityKindSchema,
  withEntityBestiarySlots,
  type ModuleEntityKind,
} from '@/domain';
import { parseSpineEntities } from '@/llm/moduleGen';

/**
 * The entity INTENT record field (08-MODULE-DESIGNER §M4-C "Entity intent",
 * docs/17 row 141): the author's steering note that lives on the entity RECORD.
 *
 * These pins judge the FIELD's own contract — what "no intent" means, the loud
 * cap, what a spine reply may answer, and the one thing that would silently kill
 * the feature: the name-normalization substitution REPLACING
 * `module.entityKinds` a moment after the planner recorded the note. The brief's
 * own bytes live in `tests/features/entity-intent-brief.test.tsx`.
 */

const SENTINEL = 'The market is a front for the smugglers; play the bustle as fear.';

function record(overrides: Partial<ModuleEntityKind> = {}): ModuleEntityKind {
  return { name: 'The Salt Market', kind: 'location', absorbed: [], ...overrides };
}

describe('moduleEntityKindSchema.intent — additive, optional, one spelling of absence', () => {
  it('a record written before the field parses with NO intent key at all', () => {
    const parsed = moduleEntityKindSchema.parse({ name: 'Kael', kind: 'npc', absorbed: [] });
    expect(parsed).toEqual({ name: 'Kael', kind: 'npc', absorbed: [] });
  });

  it('the model’s own null, an empty string and a whitespace-only note all read as no intent', () => {
    for (const value of [null, '', '   ']) {
      const parsed = moduleEntityKindSchema.parse({
        name: 'Kael',
        kind: 'npc',
        absorbed: [],
        intent: value,
      });
      expect(parsed.intent).toBeUndefined();
    }
  });

  it('a present note is kept, trimmed', () => {
    const parsed = moduleEntityKindSchema.parse({
      name: 'The Salt Market',
      kind: 'location',
      absorbed: [],
      intent: `  ${SENTINEL}  `,
    });
    expect(parsed.intent).toBe(SENTINEL);
  });

  it('the cap is enforced by the schema, not by a truncation', () => {
    const atCap = 'x'.repeat(ENTITY_INTENT_MAX_LENGTH);
    expect(
      moduleEntityKindSchema.parse({ name: 'Kael', kind: 'npc', absorbed: [], intent: atCap }).intent,
    ).toBe(atCap);

    const pastCap = 'y'.repeat(ENTITY_INTENT_MAX_LENGTH + 1);
    let thrown: unknown;
    try {
      moduleEntityKindSchema.parse({ name: 'Kael', kind: 'npc', absorbed: [], intent: pastCap });
    } catch (error) {
      thrown = error;
    }
    // LOUD (AGENTS rules 1/3): a validation failure, with the field and the
    // limit in the reason — never a silently shortened note.
    expect(thrown).toBeInstanceOf(z.ZodError);
    const issues = (thrown as z.ZodError).issues;
    expect(issues.some((issue) => issue.path.join('.') === 'intent')).toBe(true);
    const message = issues.map((issue) => issue.message).join(' | ');
    expect(message).toContain('intent');
    expect(message).toContain(String(ENTITY_INTENT_MAX_LENGTH));
  });
});

describe('the spine reply may spell absence as null (the strict subset cannot omit a key)', () => {
  const PLAN = [{ title: 'One', levelBand: '1', synopsis: '', levelUpTrigger: '' }];
  function reply(entities: unknown[]): string {
    return JSON.stringify({ premise: 'P', themes: [], partPlan: PLAN, entities });
  }

  it('a reply with no intent key and a reply with "intent": null both read as no intent', () => {
    expect(parseSpineEntities(reply([{ name: 'Kael', kind: 'npc' }]))[0]?.intent).toBeUndefined();
    expect(parseSpineEntities(reply([{ name: 'Kael', kind: 'npc', intent: null }]))[0]?.intent).toBeUndefined();
  });

  it('a present intent round-trips through the spine parse', () => {
    const parsed = parseSpineEntities(reply([{ name: 'The Salt Market', kind: 'location', intent: SENTINEL }]));
    expect(parsed[0]?.intent).toBe(SENTINEL);
  });

  it('an over-long intent in a reply fails the spine parse LOUDLY, by field and limit', () => {
    const long = 'z'.repeat(ENTITY_INTENT_MAX_LENGTH + 5);
    let thrown: unknown;
    try {
      parseSpineEntities(reply([{ name: 'Kael', kind: 'npc', intent: long }]));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(z.ZodError);
    const issues = (thrown as z.ZodError).issues;
    expect(issues.some((issue) => issue.path.join('.') === 'entities.0.intent')).toBe(true);
    expect(issues.map((issue) => issue.message).join(' ')).toContain(String(ENTITY_INTENT_MAX_LENGTH));
  });
});

describe('entityIntentFor — the ONE read of the note', () => {
  it('finds the note by name, case-insensitively, and returns null for everything else', () => {
    const records = [record({ intent: SENTINEL }), record({ name: 'Kael', kind: 'npc' })];
    expect(entityIntentFor(records, 'the salt market')).toBe(SENTINEL);
    expect(entityIntentFor(records, '  THE SALT MARKET  ')).toBe(SENTINEL);
    expect(entityIntentFor(records, 'Kael')).toBeNull();
    expect(entityIntentFor(records, 'Nobody')).toBeNull();
    expect(entityIntentFor(records, '')).toBeNull();
  });

  it('an empty or whitespace-only note on a hand-built record reads as NO intent', () => {
    expect(entityIntentFor([record({ intent: '' })], 'The Salt Market')).toBeNull();
    expect(entityIntentFor([record({ intent: '   ' })], 'The Salt Market')).toBeNull();
  });
});

describe('the note survives the name-normalization substitution', () => {
  /** The canonical records a normalization pass produces (name + kind only). */
  function canonical(...names: string[]): ModuleEntityKind[] {
    return canonicalEntityRecords(
      names.map((name) => ({ name, canonical: name, kind: 'location' as const })),
    );
  }

  it('a canonical record carries the source record’s intent — the pass would otherwise delete it', () => {
    const source: ModuleEntityKind[] = [
      { name: 'Salt Market', kind: 'location', absorbed: ['The Market'], intent: SENTINEL },
    ];
    const carried = withEntityBestiarySlots(canonical('Salt Market'), source);
    expect(carried[0]?.intent).toBe(SENTINEL);
  });

  it('a source variant the pass ABSORBED still hands its note to the canonical it resolves to', () => {
    const source: ModuleEntityKind[] = [{ name: 'Salt Market', kind: 'location', absorbed: [], intent: SENTINEL }];
    const absorbed = withEntityBestiarySlots(
      [
        {
          name: 'The Salt Market',
          kind: 'location',
          absorbed: ['Salt Market'],
        },
      ],
      source,
    );
    expect(absorbed[0]?.intent).toBe(SENTINEL);
  });

  it('a source with NO note leaves the canonical record untouched, by identity', () => {
    const records = canonical('Salt Market');
    const carried = withEntityBestiarySlots(records, [
      { name: 'Salt Market', kind: 'location', absorbed: [] },
    ]);
    expect(carried[0]).toBe(records[0]);
    expect(carried[0]?.intent).toBeUndefined();
  });

  it('two source records answering one canonical with DIFFERENT notes is refused loudly, never picked', () => {
    // The normalizer folded the two variants onto one canonical, and the two
    // source records note different things about it: picking one would silently
    // re-steer the entity (AGENTS rule 1).
    const source: ModuleEntityKind[] = [
      { name: 'Salt Market', kind: 'location', absorbed: [], intent: 'A market.' },
      { name: 'The Salt Market', kind: 'location', absorbed: [], intent: 'A tomb.' },
    ];
    const canonical: ModuleEntityKind[] = [
      { name: 'The Salt Market', kind: 'location', absorbed: ['Salt Market'] },
    ];
    expect(() => withEntityBestiarySlots(canonical, source)).toThrow(
      /entity intent: «The Salt Market» was given two different author's notes/,
    );
  });

  it('the SAME note on two variants is one note, not a conflict', () => {
    const source: ModuleEntityKind[] = [
      { name: 'Salt Market', kind: 'location', absorbed: [], intent: SENTINEL },
      { name: 'The Salt Market', kind: 'location', absorbed: [], intent: ` ${SENTINEL} ` },
    ];
    const canonical: ModuleEntityKind[] = [
      { name: 'The Salt Market', kind: 'location', absorbed: ['Salt Market'] },
    ];
    expect(withEntityBestiarySlots(canonical, source)[0]?.intent).toBe(SENTINEL);
  });

  it('the bestiary carry is untouched: a slot still rides and two slots still refuse', () => {
    const source: ModuleEntityKind[] = [
      {
        name: 'Aunt Agatha',
        kind: 'npc',
        absorbed: [],
        bestiary: { creature: 'Zombie' },
        intent: SENTINEL,
      },
    ];
    const carried = withEntityBestiarySlots(canonical('Aunt Agatha'), source)[0];
    expect(carried?.bestiary).toEqual({ creature: 'Zombie' });
    expect(carried?.intent).toBe(SENTINEL);
  });
});
