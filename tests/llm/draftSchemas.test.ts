import { describe, expect, it } from 'vitest';

import {
  encounterDraftSchema,
  factionDraftSchema,
  locationDraftSchema,
  plotArcDraftSchema,
} from '@/llm/schemas';

/**
 * Draft JSON contracts tolerate the common model variations (bare strings
 * for object lists, numeric strings, single-string tags) so a good draft is
 * not thrown away over formatting.
 */

const BASE = { name: 'X', summary: 'S', body: 'B' };

describe('draft schema coercions', () => {
  it('accepts bare strings for pointsOfInterest and object entries for hooks', () => {
    const draft = locationDraftSchema.parse({
      ...BASE,
      suggestedTags: 'harbour',
      locationType: 'district',
      inhabitants: 'Fishers',
      pointsOfInterest: ['Bell tower', { name: 'Market', description: 'Stalls.' }],
      hooks: [{ title: 'Missing diver' }, 'A light at midnight.'],
    });
    expect(draft.suggestedTags).toEqual(['harbour']);
    expect(draft.pointsOfInterest).toEqual([
      { name: 'Bell tower', description: '' },
      { name: 'Market', description: 'Stalls.' },
    ]);
    expect(draft.hooks).toEqual(['Missing diver', 'A light at midnight.']);
  });

  it('accepts bare strings for faction ranks and plot-arc beats', () => {
    const faction = factionDraftSchema.parse({
      ...BASE,
      goals: 'g',
      methods: 'm',
      resources: 'r',
      ranks: ['Harbourmaster', { title: 'Tide-priest', description: 'Speaks.' }],
    });
    expect(faction.ranks).toEqual([
      { title: 'Harbourmaster', description: '' },
      { title: 'Tide-priest', description: 'Speaks.' },
    ]);

    const arc = plotArcDraftSchema.parse({
      ...BASE,
      arcType: 'mystery',
      premise: 'p',
      stakes: 's',
      beats: ['First ring', { title: 'The flood', description: 'Docks go under.' }],
      hooks: [],
      climax: 'c',
    });
    expect(arc.beats).toEqual([
      { title: 'First ring', description: '' },
      { title: 'The flood', description: 'Docks go under.' },
    ]);
  });

  it('accepts numeric-string monster counts', () => {
    const encounter = encounterDraftSchema.parse({
      ...BASE,
      difficulty: 'medium',
      levelHint: '3',
      monsters: [{ name: 'Cultist', count: '4', notes: 'netters' }],
      terrain: 't',
      tactics: 'x',
      treasure: 'y',
    });
    expect(encounter.monsters[0]?.count).toBe(4);
  });
});
