import { describe, expect, it } from 'vitest';

import { encounterDataSchema } from '@/domain';
import {
  encounterMapModeSchema,
  resolveEncounterMapMode,
} from '@/domain/encounterMap/schema';

/**
 * Natural-site mode (docs/11): WHO HOLDS GROUND TRUTH for the rendered map.
 * Dungeons keep the schematic-faithful architectural contract byte-identical;
 * outdoors the encounter's own prose is the truth and the map contract
 * becomes minimal (placement-only schematic, prose-led prompt). The mode
 * derives from the brief's `environment` OR the persisted `locationKind`
 * (union), and the owner's editor override wins over both.
 */

describe('encounter map mode derivation (docs/11 natural-site mode)', () => {
  it('derives natural from the brief environment OR the locationKind (union)', () => {
    // Either outdoor signal alone selects the natural-site contract.
    expect(resolveEncounterMapMode({ override: null, briefEnvironment: 'outdoor', locationKind: 'dungeon' })).toBe('natural');
    expect(resolveEncounterMapMode({ override: null, briefEnvironment: 'dungeon', locationKind: 'wilderness' })).toBe('natural');
    expect(resolveEncounterMapMode({ override: null, briefEnvironment: 'outdoor', locationKind: 'wilderness' })).toBe('natural');
    // Both signals architectural → the dungeon contract.
    expect(resolveEncounterMapMode({ override: null, briefEnvironment: 'dungeon', locationKind: 'dungeon' })).toBe('architectural');
    // Unclassified/indoor classifications never fake outdoors.
    expect(resolveEncounterMapMode({ override: null, briefEnvironment: 'dungeon', locationKind: 'building' })).toBe('architectural');
    expect(resolveEncounterMapMode({ override: null, briefEnvironment: 'dungeon', locationKind: 'other' })).toBe('architectural');
    // Fresh runs carry no target facts — the brief prose alone decides.
    expect(resolveEncounterMapMode({ override: null, briefEnvironment: 'outdoor', locationKind: null })).toBe('natural');
    expect(resolveEncounterMapMode({ override: null, briefEnvironment: 'dungeon', locationKind: null })).toBe('architectural');
    // Pre-derivation rows (no environment on the brief, legacy brief step):
    // the persisted locationKind still decides; with neither, architectural.
    expect(resolveEncounterMapMode({ override: null, briefEnvironment: null, locationKind: 'wilderness' })).toBe('natural');
    expect(resolveEncounterMapMode({ override: null, briefEnvironment: null, locationKind: null })).toBe('architectural');
  });

  it('the owner override beats every derived signal', () => {
    // A forest dungeon (ruin in the woods) forces the architectural contract…
    expect(resolveEncounterMapMode({ override: 'architectural', briefEnvironment: 'outdoor', locationKind: 'wilderness' })).toBe('architectural');
    // …and an open cave forces natural even when classified dungeon.
    expect(resolveEncounterMapMode({ override: 'natural', briefEnvironment: 'dungeon', locationKind: 'dungeon' })).toBe('natural');
  });

  it('the mode enum is the bounded pair and unknown values never parse', () => {
    expect(encounterMapModeSchema.options).toEqual(['architectural', 'natural']);
    expect(encounterMapModeSchema.safeParse('natural').success).toBe(true);
    expect(encounterMapModeSchema.safeParse('sketchy').success).toBe(false);
  });

  it('persists the owner override additively (legacy rows parse to derive)', () => {
    const base = {
      difficulty: 'hard',
      levelHint: '4',
      monsters: [],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    };
    // No mapMode on the row → undefined = derive (Auto in the editor).
    expect(encounterDataSchema.parse(base).mapMode).toBeUndefined();
    // Both forced values round-trip; anything else is a loud parse failure.
    expect(encounterDataSchema.parse({ ...base, mapMode: 'natural' }).mapMode).toBe('natural');
    expect(encounterDataSchema.parse({ ...base, mapMode: 'architectural' }).mapMode).toBe('architectural');
    expect(encounterDataSchema.safeParse({ ...base, mapMode: 'freeform' }).success).toBe(false);
  });
});
