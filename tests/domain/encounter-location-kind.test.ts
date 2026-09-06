import { describe, expect, it } from 'vitest';

import { encounterDataSchema } from '@/domain';
import {
  encounterLocationKindSchema,
  resolveEncounterPreset,
} from '@/domain/encounterMap/schema';
import { encounterDraftSchema } from '@/llm/schemas';

/**
 * D10 amendment (docs/11): encounters classify their own location kind in
 * the persona's EXISTING draft call, the classification persists additively
 * on the encounter artifact (old rows parse to 'other', no Dexie bump), and
 * the battlemap preset resolves explicit per-run choice > locationKind >
 * Settings fallback. No extra LLM call and no verification pass anywhere.
 */

describe('encounter locationKind (docs/11 D10 amendment)', () => {
  it('bounds the draft classification to the four kinds and defaults to unclassified', () => {
    const base = {
      name: 'X',
      summary: '',
      body: '',
      difficulty: '',
      levelHint: '',
      monsters: [],
      terrain: '',
      tactics: '',
      treasure: '',
    };
    expect(encounterDraftSchema.parse(base).locationKind).toBe('other');
    expect(encounterDraftSchema.parse({ ...base, locationKind: 'DUNGEON' }).locationKind).toBe('dungeon');
    expect(encounterDraftSchema.parse({ ...base, locationKind: 'building' }).locationKind).toBe('building');
    expect(encounterDraftSchema.parse({ ...base, locationKind: 'Wilderness' }).locationKind).toBe('wilderness');
    // Anything outside the bounded enum is a validation failure, never a
    // coerced guess (AGENTS rule 3).
    expect(encounterDraftSchema.safeParse({ ...base, locationKind: 'volcano' }).success).toBe(false);
  });

  it('parses legacy encounter rows without the field to the unclassified default', () => {
    const legacy = {
      difficulty: 'medium',
      levelHint: '3',
      monsters: [],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout: null,
      preset: 'dungeon',
      // no locationKind — a pre-amendment row
    };
    const parsed = encounterDataSchema.parse(legacy);
    expect(parsed.locationKind).toBe('other');
    // The persisted preset is untouched by the additive field.
    expect(parsed.preset).toBe('dungeon');
    expect(encounterLocationKindSchema.options).toEqual(['dungeon', 'building', 'wilderness', 'other']);
  });

  it('resolves the preset: explicit per-run choice beats locationKind beats Settings', () => {
    // Tier 1 — an explicit per-run choice always wins (Auto = null/undefined).
    expect(resolveEncounterPreset('standard', 'dungeon', 'dungeon')).toBe('standard');
    expect(resolveEncounterPreset('dungeon', 'wilderness', 'standard')).toBe('dungeon');
    // Tier 2 — the encounter's own classification.
    expect(resolveEncounterPreset(null, 'dungeon', 'standard')).toBe('dungeon');
    expect(resolveEncounterPreset(undefined, 'building', 'dungeon')).toBe('standard');
    expect(resolveEncounterPreset(null, 'wilderness', 'dungeon')).toBe('standard');
    // Tier 3 — unclassified rows fall back to the campaign preference, and
    // the terminal default is the D10 base tier.
    expect(resolveEncounterPreset(null, 'other', 'dungeon')).toBe('dungeon');
    expect(resolveEncounterPreset(null, undefined, 'standard')).toBe('standard');
    expect(resolveEncounterPreset(null, 'other', null)).toBe('standard');
  });
});
