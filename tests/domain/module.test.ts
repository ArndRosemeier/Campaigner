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
    expect(() => moduleEntityKindSchema.parse({ name: 'Kael', kind: 'encounter' })).toThrow();
    expect(moduleEntityKindSchema.parse({ name: 'Kael', kind: 'npc' }).kind).toBe('npc');
  });

  it('defaults absorbed to an empty list (fix-01)', () => {
    const record = moduleEntityKindSchema.parse({ name: 'Kael', kind: 'npc' });
    expect(record.absorbed).toEqual([]);
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
