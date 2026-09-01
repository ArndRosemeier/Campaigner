import { describe, expect, it } from 'vitest';

import {
  createModule,
  entityKindFor,
  mergeEntityKinds,
  moduleEntityKindSchema,
  moduleSchema,
  type ModuleEntityKind,
} from '@/domain';

/**
 * Entity-kind records on the module row (08-MODULE-DESIGNER M4-C): the
 * generator declares each entity's kind when it invents the name — the
 * client never guesses. Pure helper behavior + schema defaults.
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
    expect(() =>
      moduleEntityKindSchema.parse({ name: 'Kael', kind: 'encounter' }),
    ).toThrow();
    expect(moduleEntityKindSchema.parse({ name: 'Kael', kind: 'npc' }).kind).toBe('npc');
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
    expect(() =>
      moduleSchema.parse({ ...module, entityKinds: [{ name: '  ', kind: 'npc' }] }),
    ).toThrow();
  });
});

describe('entityKindFor', () => {
  const records = [
    { name: 'Harbormaster Ilse', kind: 'npc' },
    { name: 'The Undercroft', kind: 'location' },
  ] as const;

  it('matches case-insensitively and trims', () => {
    expect(entityKindFor(records, 'harbormaster ilse')).toBe('npc');
    expect(entityKindFor(records, '  THE UNDERCROFT ')).toBe('location');
  });

  it('returns undefined for unknown or blank names', () => {
    expect(entityKindFor(records, 'Nobody')).toBeUndefined();
    expect(entityKindFor(records, '   ')).toBeUndefined();
  });
});

describe('mergeEntityKinds', () => {
  it('adds new names and keeps existing ones', () => {
    const merged = mergeEntityKinds([{ name: 'Kael', kind: 'npc' }], [
      { name: 'The Undercroft', kind: 'location' },
    ]);
    expect(merged).toEqual([
      { name: 'Kael', kind: 'npc' },
      { name: 'The Undercroft', kind: 'location' },
    ]);
  });

  it('dedupes case-insensitively, keeping the first recorded spelling', () => {
    const merged = mergeEntityKinds([{ name: 'Kael', kind: 'npc' }], [
      { name: 'KAEL', kind: 'faction' },
    ]);
    expect(merged).toEqual([{ name: 'Kael', kind: 'npc' }]);
  });

  it('skips blank additions and does not mutate its inputs', () => {
    const existing: ModuleEntityKind[] = [{ name: 'Kael', kind: 'npc' }];
    const additions: ModuleEntityKind[] = [{ name: '   ', kind: 'location' }];
    const merged = mergeEntityKinds(existing, additions);
    expect(merged).toEqual([{ name: 'Kael', kind: 'npc' }]);
    expect(existing).toEqual([{ name: 'Kael', kind: 'npc' }]);
    expect(additions).toEqual([{ name: '   ', kind: 'location' }]);
  });
});
