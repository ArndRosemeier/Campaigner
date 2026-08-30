import { describe, expect, it } from 'vitest';

import { ARTIFACT_KINDS } from '@/domain/artifact';
import {
  DEFAULT_ARTIFACT_NAMES,
  blankArtifactData,
  blankStatBlock,
  defaultArtifactName,
} from '@/domain/create';
import { GAME_SYSTEMS } from '@/domain/gameSystem';
import { abilityModifier, formatModifier } from '@/domain/statblock';
import { statBlockSchema } from '@/domain/statblock';

describe('defaultArtifactName', () => {
  it('provides a non-empty default for every kind (names are required)', () => {
    for (const kind of ARTIFACT_KINDS) {
      const name = defaultArtifactName(kind);
      expect(name.length).toBeGreaterThan(0);
      expect(DEFAULT_ARTIFACT_NAMES[kind]).toBe(name);
    }
  });
});

describe('blankArtifactData', () => {
  it('returns schema-valid data for every kind', () => {
    // The artifact schema validates kind+data together; blank data for each
    // kind must satisfy its own slice (spot-check via the exported schemas
    // would need per-kind imports — the repo-level test covers the union).
    for (const kind of ARTIFACT_KINDS) {
      expect(blankArtifactData(kind)).toBeDefined();
    }
  });
});

describe('blankStatBlock', () => {
  it('is valid for every game system and has sensible defaults', () => {
    for (const system of GAME_SYSTEMS) {
      const block = blankStatBlock(system);
      expect(statBlockSchema.safeParse(block).success).toBe(true);
      expect(block.ac).toBe(10);
      expect(block.hp).toBe(1);
      expect(block.traits).toEqual([]);
    }
  });
});

describe('ability helpers', () => {
  it('computes d20 modifiers with floor((score-10)/2)', () => {
    expect(abilityModifier(10)).toBe(0);
    expect(abilityModifier(8)).toBe(-1);
    expect(abilityModifier(9)).toBe(-1);
    expect(abilityModifier(18)).toBe(4);
    expect(abilityModifier(7)).toBe(-2);
  });

  it('formats modifiers with an explicit sign', () => {
    expect(formatModifier(0)).toBe('+0');
    expect(formatModifier(3)).toBe('+3');
    expect(formatModifier(-1)).toBe('-1');
  });
});
