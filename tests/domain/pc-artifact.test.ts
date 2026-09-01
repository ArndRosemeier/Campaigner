import { describe, expect, it } from 'vitest';

import { ARTIFACT_KINDS, artifactSchema } from '@/domain';
import { createArtifact } from '@/domain/create';

/**
 * The `pc` artifact kind (09-MILESTONE-5 M5-A): player characters become
 * artifacts — useful before any battle exists and required by the battle as
 * auto-included fighters. The battle engine REQUIRES the stat block for
 * initiative/HP, so `statBlock: null` is a valid-but-loud state, never a
 * silent placeholder.
 */

describe('pc artifact kind (M5-A)', () => {
  it('is part of the kind enum, listed FIRST so the tree gains a Party group on top', () => {
    expect(ARTIFACT_KINDS[0]).toBe('pc');
  });

  it('creates a valid blank PC with human-owned fields defaulted', () => {
    const pc = createArtifact({
      campaignId: '00000000-0000-4000-8000-0000000000c1',
      kind: 'pc',
      name: 'Serren',
    });
    expect(pc.kind).toBe('pc');
    expect(pc.data).toEqual({
      playerName: '',
      statBlock: null,
      currentHp: 0,
      initiativeOverride: null,
      notes: '',
    });
    // The row validates against the artifact union.
    expect(artifactSchema.parse(pc).kind).toBe('pc');
  });

  it('rejects fractional or negative current HP (whole number, 0..maxHp)', () => {
    const base = createArtifact({
      campaignId: '00000000-0000-4000-8000-0000000000c1',
      kind: 'pc',
      name: 'Serren',
    });
    expect(() => artifactSchema.parse({ ...base, data: { ...base.data, currentHp: 1.5 } })).toThrow();
    expect(() => artifactSchema.parse({ ...base, data: { ...base.data, currentHp: -1 } })).toThrow();
    expect(
      artifactSchema.parse({ ...base, data: { ...base.data, initiativeOverride: 5 } }).kind,
    ).toBe('pc');
  });
});
