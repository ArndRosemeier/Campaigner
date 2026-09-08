import { describe, expect, it } from 'vitest';

import {
  createModule,
  entityKindFor,
  moduleEntityKindSchema,
  moduleSchema,
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

  it('defaults conflict declarations empty so pre-slice rows parse (no migration)', () => {
    const record = moduleEntityKindSchema.parse({ name: 'Ember Trial', kind: 'encounter' });
    expect(record.wants).toEqual([]);
    expect(record.conflictKind).toBeNull();
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

describe('entityKindFor', () => {
  const records: ModuleEntityKind[] = [
    { name: 'Harbormaster Ilse', kind: 'npc', absorbed: [], wants: [], conflictKind: null },
    { name: 'The Undercroft', kind: 'location', absorbed: [], wants: [], conflictKind: null },
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
