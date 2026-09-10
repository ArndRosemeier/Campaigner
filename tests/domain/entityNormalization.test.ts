import { describe, expect, it } from 'vitest';

import {
  canonicalEntityRecords,
  mergeEntityRewriteProposals,
  mergeNewEntityRecords,
  unclassifiedEntityNames,
  validateNormalizationReply,
  type NormalizationEntry,
} from '@/domain/entityNormalization';
import { MODULE_ENTITY_KIND_CAP } from '@/domain';

/**
 * The normalization verdict post-conditions (fix-01 "reject, never
 * correct"): only exact, case-insensitive string comparisons — no similarity
 * or suffix logic anywhere in the decision path.
 */

const ARTIFACTS = ['Halmund', 'Seggel'];

function entry(name: string, canonical: string, kind: NormalizationEntry['kind'] = 'npc'): NormalizationEntry {
  return { name, canonical, kind };
}

describe('validateNormalizationReply', () => {
  it('accepts a reply where every name maps to itself or a self-mapped variant', () => {
    const violations = validateNormalizationReply(
      ['Halmund', 'Guard Halmund', 'Halmunds'],
      [entry('Halmund', 'Halmund', 'npc'), entry('Guard Halmund', 'Halmund'), entry('Halmunds', 'Halmund')],
      ARTIFACTS,
    );
    expect(violations).toEqual([]);
  });

  it('accepts a mapping onto an existing artifact name', () => {
    const violations = validateNormalizationReply(
      ['the Seggel', 'Other'],
      [entry('the Seggel', 'Seggel', 'location'), entry('Other', 'Other', 'note')],
      ARTIFACTS,
    );
    expect(violations).toEqual([]);
  });

  it('rejects omitted and invented names', () => {
    const violations = validateNormalizationReply(
      ['Halmund', 'Seggel'],
      [entry('Halmund', 'Halmund'), entry('Ghost', 'Ghost')],
      [],
    );
    expect(violations).toHaveLength(2);
    expect(violations.some((v) => v.includes('omitted the listed name "Seggel"'))).toBe(true);
    expect(violations.some((v) => v.includes('invented a name'))).toBe(true);
  });

  it('rejects answering for a name more than once', () => {
    const violations = validateNormalizationReply(
      ['Halmund'],
      [entry('Halmund', 'Halmund'), entry('Halmund', 'Halmund')],
      [],
    );
    expect(violations.some((v) => v.includes('more than once'))).toBe(true);
  });

  it('rejects mapping chains (A → B where B maps elsewhere)', () => {
    const violations = validateNormalizationReply(
      ['Guard Halmund', 'Halmunds'],
      [entry('Guard Halmund', 'Halmunds'), entry('Halmunds', 'Halmund')],
      [],
    );
    expect(violations.some((v) => v.includes('mapping chain'))).toBe(true);
  });

  it('rejects a canonical that is neither listed nor an existing artifact', () => {
    const violations = validateNormalizationReply(
      ['Guard Halmund'],
      [entry('Guard Halmund', 'Halmund The Grey')],
      [],
    );
    expect(violations.some((v) => v.includes('neither a listed name nor an existing artifact'))).toBe(true);
  });

  it('rejects a name that exactly matches an existing artifact mapping away', () => {
    const violations = validateNormalizationReply(
      ['Halmund'],
      [entry('Halmund', 'Guard Halmund')],
      ARTIFACTS,
    );
    expect(violations.some((v) => v.includes('must map to itself'))).toBe(true);
  });
});

describe('canonicalEntityRecords', () => {
  it('replaces variant-keyed records with one record per canonical entity', () => {
    const records = canonicalEntityRecords([
      entry('Guard Halmund', 'Halmund'),
      entry('Halmunds', 'Halmund'),
      entry('Halmund', 'Halmund', 'npc'),
    ]);
    expect(records).toEqual([
      { name: 'Halmund', kind: 'npc', absorbed: ['Guard Halmund', 'Halmunds'], wants: [], conflictKind: null },
    ]);
  });

  it('uses the canonical entrys own kind even when variants disagree', () => {
    const records = canonicalEntityRecords([
      entry('Guard Halmund', 'Halmund', 'faction'),
      entry('Halmund', 'Halmund', 'npc'),
    ]);
    expect(records[0]?.kind).toBe('npc');
  });

  it('falls back to the first variants kind when the canonical is an existing artifact', () => {
    const records = canonicalEntityRecords([
      entry('the Seggel', 'Seggel', 'location'),
      entry('Segele', 'Seggel', 'location'),
    ]);
    expect(records).toEqual([
      { name: 'Seggel', kind: 'location', absorbed: ['the Seggel', 'Segele'], wants: [], conflictKind: null },
    ]);
  });

  it('keeps unrelated canonical entities as separate records', () => {
    const records = canonicalEntityRecords([
      entry('Halmund', 'Halmund', 'npc'),
      entry('Seggel', 'Seggel', 'location'),
    ]);
    expect(records).toEqual([
      { name: 'Halmund', kind: 'npc', absorbed: [], wants: [], conflictKind: null },
      { name: 'Seggel', kind: 'location', absorbed: [], wants: [], conflictKind: null },
    ]);
  });
});

describe('validateNormalizationReply — incremental vocabulary', () => {
  it('accepts a new variant mapping onto a RECORDED canonical (no artifact, not listed)', () => {
    const violations = validateNormalizationReply(
      ['Harbormaster Ilse'],
      [entry('Harbormaster Ilse', 'Ilse')],
      [],
      { canonicalNames: ['Ilse', 'Halmund'] },
    );
    expect(violations).toEqual([]);
  });

  it('still rejects a canonical that is nowhere: recorded names widen the vocabulary, nothing else', () => {
    const violations = validateNormalizationReply(
      ['Harbormaster Ilse'],
      [entry('Harbormaster Ilse', 'Ilse the Grey')],
      [],
      { canonicalNames: ['Ilse'] },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('a recorded entity name');
  });
});

describe('unclassifiedEntityNames', () => {
  const records = [
    { name: 'Halmund', kind: 'npc' as const, absorbed: ['Halmunds'], wants: [], conflictKind: null },
  ];

  it('names the text names that have no record — exact, case-insensitive, in order', () => {
    expect(
      unclassifiedEntityNames({
        entityKinds: records,
        names: ['Halmund', 'The Tide Bell', 'Kael', 'the tide bell'],
        resolvedNames: [],
      }),
    ).toEqual(['The Tide Bell', 'Kael']);
  });

  it('skips names that already resolve to an artifact (nothing to create)', () => {
    expect(
      unclassifiedEntityNames({
        entityKinds: [],
        names: ['Mira', 'Kael'],
        resolvedNames: ['Mira'],
      }),
    ).toEqual(['Kael']);
  });

  it('skips names a pending consent proposal already answered for', () => {
    expect(
      unclassifiedEntityNames({
        entityKinds: [],
        names: ['Guard Halmund', 'Kael'],
        resolvedNames: [],
        proposals: [{ planIndex: 0, replacements: [{ from: 'guard halmund', to: 'Halmund' }] }],
      }),
    ).toEqual(['Kael']);
  });

  it('treats a recorded name as accounted for even when the text used another spelling', () => {
    // 'Halmunds' is an ABSORBED variant, not a record: the record gate keys
    // buckets by record names only, so the absorbed spelling is still
    // un-batchable and still offered for classification.
    expect(
      unclassifiedEntityNames({
        entityKinds: records,
        names: ['Halmunds'],
        resolvedNames: [],
      }),
    ).toEqual(['Halmunds']);
  });
});

describe('mergeNewEntityRecords', () => {
  const existing = [
    { name: 'Halmund', kind: 'npc' as const, absorbed: [], wants: [], conflictKind: null },
  ];

  it('appends only new canonicals and leaves existing records byte-identical', () => {
    const added = {
      name: 'Kael',
      kind: 'npc' as const,
      absorbed: [],
      wants: [],
      conflictKind: null,
    };
    const merged = mergeNewEntityRecords(existing, [added]);
    expect(merged).toEqual([...existing, added]);
    expect(merged[0]).toBe(existing[0]);
  });

  it('never duplicates a canonical the module already records (case-insensitively)', () => {
    const merged = mergeNewEntityRecords(existing, [
      { name: 'halmund', kind: 'faction', absorbed: [], wants: [], conflictKind: null },
      { name: 'Kael', kind: 'npc', absorbed: [], wants: [], conflictKind: null },
      { name: '  ', kind: 'note', absorbed: [], wants: [], conflictKind: null },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(existing[0]);
    expect(merged[1]?.name).toBe('Kael');
  });

  it('throws loudly past the row cap instead of dropping a record', () => {
    const full = Array.from({ length: MODULE_ENTITY_KIND_CAP }, (_value, index) => ({
      name: `Entity ${String(index)}`,
      kind: 'npc' as const,
      absorbed: [],
      wants: [],
      conflictKind: null,
    }));
    expect(() =>
      mergeNewEntityRecords(full, [
        { name: 'One Too Many', kind: 'npc', absorbed: [], wants: [], conflictKind: null },
      ]),
    ).toThrow(/past the 400-record cap/);
  });
});

describe('mergeEntityRewriteProposals', () => {
  it('returns null when neither side has anything pending', () => {
    expect(mergeEntityRewriteProposals(null, [])).toBeNull();
    expect(mergeEntityRewriteProposals([], [])).toBeNull();
  });

  it('preserves an unanswered review and unions the new rewrites, deduped', () => {
    const merged = mergeEntityRewriteProposals(
      [{ planIndex: 1, replacements: [{ from: 'Halmunds', to: 'Halmund' }] }],
      [
        { planIndex: 1, replacements: [{ from: 'halmunds', to: 'Halmund' }] },
        { planIndex: -1, replacements: [{ from: 'Guard Ilse', to: 'Ilse' }] },
      ],
    );
    expect(merged).toEqual([
      { planIndex: -1, replacements: [{ from: 'Guard Ilse', to: 'Ilse' }] },
      { planIndex: 1, replacements: [{ from: 'Halmunds', to: 'Halmund' }] },
    ]);
  });
});
