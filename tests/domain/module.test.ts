import { describe, expect, it } from 'vitest';

import {
  compareModulesByStartLevel,
  createModule,
  entityKindFor,
  moduleEntityKindSchema,
  moduleSchema,
  type ModuleArcOrder,
  type ModuleEntityKind,
} from '@/domain';

/**
 * Entity-kind records on the module row (08-MODULE-DESIGNER M4-C, amended by
 * fix-01): the generator declares each entity's kind when it invents the name
 * — the client never guesses. Since fix-01 the records are canonical (one per
 * entity, `absorbed` listing folded variants) and are REPLACED by the
 * normalization pass; the old merge helper is gone. Pure helper behavior +
 * schema defaults.
 */

describe('moduleSchema.entityKinds', () => {
  it('defaults to an empty list when absent', () => {
    const module = createModule({
      campaignId: '00000000-0000-4000-8000-0000000000c1',
      title: 'Test Module',
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'standard',
    });
    expect(module.entityKinds).toEqual([]);
  });

  it('validates recorded kinds against the stub-able enum', () => {
    expect(() => moduleEntityKindSchema.parse({ name: 'Kael', kind: 'plotarc' })).toThrow();
    expect(moduleEntityKindSchema.parse({ name: 'Kael', kind: 'npc' }).kind).toBe('npc');
    expect(moduleEntityKindSchema.parse({ name: 'Bridge Ambush', kind: 'encounter' }).kind).toBe('encounter');
  });

  it('defaults absorbed to an empty list (fix-01)', () => {
    const record = moduleEntityKindSchema.parse({ name: 'Kael', kind: 'npc' });
    expect(record.absorbed).toEqual([]);
  });

  it('ignores the retired conflict-declaration keys on stored rows (no migration)', () => {
    // The conflict-kind vocabulary and the `wants` pair are GONE from the
    // record shape. This schema is deliberately not strict, so a row written
    // before the removal (still carrying `wants` / `conflictKind`) parses on
    // read and the removed keys are dropped: an existing module is never a
    // parse failure and nothing migrates the stored data (docs/17: the owner's
    // testing-phase stance — no migration ceremony for a shape change).
    const legacy = {
      name: 'Ember Trial',
      kind: 'encounter',
      wants: ['seize the bell', 'keep the bell silent'],
      conflictKind: 'combat',
    };
    const record = moduleEntityKindSchema.parse(legacy);
    expect(record).toEqual({ name: 'Ember Trial', kind: 'encounter', absorbed: [] });
    expect(Object.keys(record)).not.toContain('wants');
    expect(Object.keys(record)).not.toContain('conflictKind');

    // The same tolerance at the ROW boundary (the read path parses the whole
    // module, not just the record).
    const module = createModule({
      campaignId: '00000000-0000-4000-8000-0000000000c9',
      title: 'Legacy Module',
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'standard',
    });
    const parsed = moduleSchema.parse({ ...module, entityKinds: [legacy] });
    expect(parsed.entityKinds).toEqual([
      { name: 'Ember Trial', kind: 'encounter', absorbed: [] },
    ]);
  });

  it('rejects records with empty names on a full row', () => {
    const module = createModule({
      campaignId: '00000000-0000-4000-8000-0000000000c1',
      title: 'Test Module',
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'standard',
    });
    expect(() => moduleSchema.parse({ ...module, entityKinds: [{ name: '  ', kind: 'npc' }] })).toThrow();
  });
});

describe('moduleSchema normalization state (fix-01)', () => {
  it('defaults the pass state: not normalized, no error, no proposals', () => {
    const module = createModule({
      campaignId: '00000000-0000-4000-8000-0000000000c1',
      title: 'Test Module',
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'standard',
    });
    expect(module.entityNamesNormalized).toBe(false);
    expect(module.entityNormalizationError).toBe('');
    expect(module.entityRewriteProposals).toBeNull();
  });
});

describe('moduleSchema.includePriorModules', () => {
  const base = {
    campaignId: '00000000-0000-4000-8000-0000000000c1',
    title: 'Test Module',
    concept: '',
    levelMin: 1,
    levelMax: 3,
    sizeDial: 'standard' as const,
  };

  it('defaults to false (opt-in continuity) and honors the explicit flag', () => {
    expect(createModule(base).includePriorModules).toBe(false);
    expect(createModule({ ...base, includePriorModules: true }).includePriorModules).toBe(true);
  });

  it('moduleSchema.parse fills the default for pre-v13 rows', () => {
    const module = createModule(base);
    const parsed = moduleSchema.parse({ ...module, includePriorModules: undefined });
    expect(parsed.includePriorModules).toBe(false);
  });
});

describe('moduleSchema.autoGenerateMobImages', () => {
  const base = {
    campaignId: '00000000-0000-4000-8000-0000000000c1',
    title: 'Test Module',
    concept: '',
    levelMin: 1,
    levelMax: 3,
    sizeDial: 'standard' as const,
  };

  it('defaults to false (opt-in portrait automation) and honors the explicit flag', () => {
    expect(createModule(base).autoGenerateMobImages).toBe(false);
    expect(createModule({ ...base, autoGenerateMobImages: true }).autoGenerateMobImages).toBe(true);
  });

  it('moduleSchema.parse fills the default for rows written before the flag', () => {
    const module = createModule(base);
    const parsed = moduleSchema.parse({ ...module, autoGenerateMobImages: undefined });
    expect(parsed.autoGenerateMobImages).toBe(false);
  });
});

describe('moduleSchema.adversarialGeneration (docs/17 row 354, slice 1: the flag only)', () => {
  const base = {
    campaignId: '00000000-0000-4000-8000-0000000000c1',
    title: 'Test Module',
    concept: '',
    levelMin: 1,
    levelMax: 3,
    sizeDial: 'standard' as const,
  };

  it('defaults to false (off by default) and persists BOTH explicit values verbatim', () => {
    expect(createModule(base).adversarialGeneration).toBe(false);
    expect(createModule({ ...base, adversarialGeneration: false }).adversarialGeneration).toBe(
      false,
    );
    expect(createModule({ ...base, adversarialGeneration: true }).adversarialGeneration).toBe(true);
  });

  it('moduleSchema.parse fills the default for rows written before the field', () => {
    // A module row persisted before this slice carries NO `adversarialGeneration`
    // key: `.default(false)` keeps it parsing as today's off-by-default module.
    const module = createModule(base);
    const parsed = moduleSchema.parse({ ...module, adversarialGeneration: undefined });
    expect(parsed.adversarialGeneration).toBe(false);
  });

  it('an untouched (omitted) row and an explicit `false` row are byte-identical', () => {
    // The flag-off guarantee at the ROW boundary: the additive key defaults to
    // false, so the omitted row and the explicit-false row serialize to the same
    // bytes — no other field shifts. (The generation-input half of the guarantee
    // lives in the moduleGen pins, where the model prompt bytes are compared.)
    const module = createModule(base);
    const omitted = moduleSchema.parse({ ...module, adversarialGeneration: undefined });
    const explicitFalse = moduleSchema.parse({ ...module, adversarialGeneration: false });
    expect(JSON.stringify(omitted)).toBe(JSON.stringify(explicitFalse));
  });
});

describe('entityKindFor', () => {
  const records: ModuleEntityKind[] = [
    { name: 'Harbormaster Ilse', kind: 'npc', absorbed: [] },
    { name: 'The Undercroft', kind: 'location', absorbed: [] },
  ];

  it('matches case-insensitively and trims', () => {
    expect(entityKindFor(records, 'harbormaster ilse')).toBe('npc');
    expect(entityKindFor(records, '  THE UNDERCROFT ')).toBe('location');
  });

  it('returns undefined for unknown or blank names', () => {
    expect(entityKindFor(records, 'Nobody')).toBeUndefined();
    expect(entityKindFor(records, '   ')).toBeUndefined();
  });
});

/**
 * THE ARC ORDER of a campaign's module list (docs/17 row 297): `levelMin`
 * ascending, then `levelMax` ascending, then `createdAt` ascending, then `id` —
 * the ONE display order `features/modules/hooks.useModules` applies. The repo's
 * own read keeps "newest first" for its semantic callers; the two orders are
 * different questions (docs/18 §2).
 */
describe('compareModulesByStartLevel (docs/17 row 297)', () => {
  const chapter = (
    id: string,
    levelMin: number,
    levelMax: number,
    createdAt: number,
  ): ModuleArcOrder => ({ id, levelMin, levelMax, createdAt });

  /** The ids `compareModulesByStartLevel` puts the list in. */
  const arcOrder = (list: readonly ModuleArcOrder[]): string[] =>
    [...list].sort(compareModulesByStartLevel).map((module) => module.id);

  it('orders by START LEVEL ascending — level 1 first, whatever the input order', () => {
    const first = chapter('first', 1, 4, 1);
    const third = chapter('third', 3, 3, 1);
    const second = chapter('second', 2, 2, 1);
    expect(arcOrder([first, third, second])).toEqual(['first', 'second', 'third']);
    // The reverse input MUST give the same sequence — this is the "total order"
    // half of the comparator's contract, not a stable-sort accident.
    expect(arcOrder([third, second, first])).toEqual(['first', 'second', 'third']);
  });

  it('breaks a same start level by the NARROWER range first (levelMax ascending)', () => {
    const wide = chapter('wide', 3, 6, 1);
    const narrow = chapter('narrow', 3, 4, 1);
    expect(arcOrder([wide, narrow])).toEqual(['narrow', 'wide']);
    expect(arcOrder([narrow, wide])).toEqual(['narrow', 'wide']);
  });

  it('breaks a same range by createdAt — story order within a level', () => {
    const later = chapter('later', 1, 2, 200);
    const earlier = chapter('earlier', 1, 2, 100);
    expect(arcOrder([later, earlier])).toEqual(['earlier', 'later']);
  });

  it('breaks a FULL tie by id, so the order never depends on the array', () => {
    const b = chapter('b', 1, 2, 100);
    const a = chapter('a', 1, 2, 100);
    expect(arcOrder([b, a])).toEqual(['a', 'b']);
    expect(arcOrder([a, b])).toEqual(['a', 'b']);
  });

  it('is a TOTAL order: every rotation and the reversal sort to ONE sequence', () => {
    // One duplicate pair at (1, 2, 10) so `id` is really exercised, a wider
    // module at the same start level, and gaps between the level groups.
    const list = [
      chapter('c', 1, 2, 5),
      chapter('a', 1, 2, 10),
      chapter('b', 1, 2, 10),
      chapter('d', 1, 3, 1),
      chapter('e', 3, 4, 100),
      chapter('f', 5, 5, 1),
    ];
    const expected = ['c', 'a', 'b', 'd', 'e', 'f'];
    expect(arcOrder(list)).toEqual(expected);
    for (let offset = 0; offset < list.length; offset += 1) {
      const rotated = [...list.slice(offset), ...list.slice(0, offset)];
      expect(arcOrder(rotated), `rotation by ${String(offset)}`).toEqual(expected);
    }
    expect(arcOrder([...list].reverse())).toEqual(expected);
  });
});
