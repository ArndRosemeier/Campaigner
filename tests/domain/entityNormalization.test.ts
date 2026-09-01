import { describe, expect, it } from 'vitest';

import {
  canonicalEntityRecords,
  validateNormalizationReply,
  type NormalizationEntry,
} from '@/domain/entityNormalization';

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
      { name: 'Halmund', kind: 'npc', absorbed: ['Guard Halmund', 'Halmunds'] },
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
      { name: 'Seggel', kind: 'location', absorbed: ['the Seggel', 'Segele'] },
    ]);
  });

  it('keeps unrelated canonical entities as separate records', () => {
    const records = canonicalEntityRecords([
      entry('Halmund', 'Halmund', 'npc'),
      entry('Seggel', 'Seggel', 'location'),
    ]);
    expect(records).toEqual([
      { name: 'Halmund', kind: 'npc', absorbed: [] },
      { name: 'Seggel', kind: 'location', absorbed: [] },
    ]);
  });
});
