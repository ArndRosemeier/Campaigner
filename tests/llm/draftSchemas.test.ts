import { describe, expect, it } from 'vitest';

import {
  encounterDraftSchema,
  encounterGeneratorBriefSchema,
  eventDraftSchema,
  factionDraftSchema,
  locationDraftSchema,
  npcDraftSchema,
  pcDraftSchema,
  plotArcDraftSchema,
  noteDraftSchema,
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

  it('parses event drafts with the location contract (code-identical shape)', () => {
    const draft = eventDraftSchema.parse({
      ...BASE,
      locationType: 'feast',
      inhabitants: 'Villagers',
      pointsOfInterest: ['High table'],
      hooks: ['A toast goes wrong.'],
    });
    expect(draft.locationType).toBe('feast');
    expect(draft.pointsOfInterest).toEqual([{ name: 'High table', description: '' }]);
    expect(draft.hooks).toEqual(['A toast goes wrong.']);
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

  it('accepts sourceName roster citations in both encounter contracts (12-BESTIARY-PACKS §7)', () => {
    const draft = encounterDraftSchema.parse({
      ...BASE,
      difficulty: 'medium',
      levelHint: '3',
      monsters: [{ name: 'Goblin Boss', count: 2, notes: '', sourceName: 'Goblin Boss' }],
      terrain: 't',
      tactics: 'x',
      treasure: 'y',
    });
    expect(draft.monsters[0]?.sourceName).toBe('Goblin Boss');
    expect(draft.monsters[0]?.sourceChunkIndex).toBeUndefined();

    const brief = encounterGeneratorBriefSchema.parse({
      name: 'Goblin Gate',
      summary: 'S',
      body: 'B',
      difficulty: 'medium',
      levelHint: '3',
      terrain: 't',
      tactics: 'x',
      treasure: 'y',
      theme: 'gate',
      monsters: [{ name: 'Goblin Boss', count: 2, notes: '', sourceName: 'goblin boss' }],
      // A complex carries a targetLevel on EVERY room (docs/11 D12
      // amendment — the fill-grade arc made it required for complexes).
      rooms: [
        { name: 'Entry', monsterIndexes: [], targetLevel: 3 },
        { name: 'Yard', monsterIndexes: [0], targetLevel: 3 },
      ],
      entryRoomIndex: 0,
    });
    expect(brief.monsters[0]?.sourceName).toBe('goblin boss');
    expect(brief.monsters[0]?.sourceChunkIndex).toBeUndefined();
  });
});

/**
 * Minimum-content contract (owner-ratified empty-text rejection): an empty
 * body never ships as a generation result; neither do empty summary/name
 * where they carry the artifact's substance. A violation is a NAMED zod
 * issue so the existing one-repair turn can name it (04 §draft step).
 */
describe('draft schema minimum content', () => {
  const VALID = {
    npc: {
      ...BASE,
      appearance: 'a',
      personality: 'p',
      needsStatBlock: false,
    },
    pc: { ...BASE, concept: 'c', notes: 'n', needsStatBlock: false },
    location: { ...BASE, locationType: 't', inhabitants: 'i', pointsOfInterest: [], hooks: [] },
    event: { ...BASE, locationType: 't', inhabitants: 'i', pointsOfInterest: [], hooks: [] },
    faction: { ...BASE, goals: 'g', methods: 'm', resources: 'r', ranks: [] },
    note: { ...BASE },
    plotarc: { ...BASE, arcType: 'a', premise: 'p', stakes: 's', beats: [], hooks: [], climax: 'c' },
  } as const;

  it('rejects an empty or whitespace-only body for every draft kind', () => {
    for (const [kind, schema] of [
      ['npc', npcDraftSchema],
      ['pc', pcDraftSchema],
      ['location', locationDraftSchema],
      ['event', eventDraftSchema],
      ['faction', factionDraftSchema],
      ['note', noteDraftSchema],
      ['plotarc', plotArcDraftSchema],
    ] as const) {
      for (const body of ['', '   \n\t ']) {
        const parsed = schema.safeParse({ ...VALID[kind], body });
        expect(parsed.success, `${kind} body ${JSON.stringify(body)}`).toBe(false);
        if (!parsed.success) {
          const messages = parsed.error.issues.map((issue) => issue.message).join('; ');
          expect(messages).toMatch(/body is empty/);
        }
      }
    }
  });

  it('rejects an empty summary and a whitespace-only name (substance fields)', () => {
    const emptySummary = npcDraftSchema.safeParse({ ...VALID.npc, summary: '' });
    expect(emptySummary.success).toBe(false);
    const blankName = npcDraftSchema.safeParse({ ...VALID.npc, name: '   ' });
    expect(blankName.success).toBe(false);
    if (!emptySummary.success) {
      expect(emptySummary.error.issues.map((issue) => issue.message).join('; ')).toMatch(
        /summary is empty/,
      );
    }
  });

  it('accepts a short-but-real draft (one non-whitespace char is the floor)', () => {
    const parsed = noteDraftSchema.parse({ name: 'X', summary: 'S', body: 'B' });
    expect(parsed.body).toBe('B');
  });

  it('rejects an empty body/summary on the encounter brief too', () => {
    const base = {
      name: 'Goblin Gate',
      summary: 'S',
      body: 'B',
      difficulty: 'medium',
      levelHint: '3',
      terrain: 't',
      tactics: 'x',
      treasure: 'y',
      theme: 'gate',
      monsters: [{ name: 'Goblin Boss', count: 2, notes: '', sourceName: 'Goblin Boss' }],
      rooms: [{ name: 'Entry', monsterIndexes: [0] }],
      entryRoomIndex: 0,
    };
    expect(encounterGeneratorBriefSchema.safeParse({ ...base, body: '' }).success).toBe(false);
    expect(encounterGeneratorBriefSchema.safeParse({ ...base, summary: '  ' }).success).toBe(
      false,
    );
    expect(encounterGeneratorBriefSchema.safeParse(base).success).toBe(true);
  });
});

/**
 * D12 amendment (fill-grade arc): a DUNGEON COMPLEX requires every room to
 * carry an explicit targetLevel — the party level that room alone should
 * challenge. A missing field is a named schema issue that rides the brief's
 * EXISTING one-repair turn, then rejects loudly; a digit-free levelHint can
 * no longer leave complex rooms silently 'unverified'. Single arenas stay
 * optional.
 */
describe('encounter brief targetLevel requirement for complexes (docs/11 D12 amendment)', () => {
  const complexBase = {
    name: 'Goblin Gate',
    summary: 'S',
    body: 'B',
    difficulty: 'medium',
    levelHint: 'mid', // digit-free: the stamp fallback cannot save the rooms
    terrain: 't',
    tactics: 'x',
    treasure: 'y',
    theme: 'gate',
    monsters: [{ name: 'Goblin Boss', count: 2, notes: '' }],
    entryRoomIndex: 0,
  };

  it('rejects a complex whose rooms miss a targetLevel (named issue, repairable)', () => {
    const result = encounterGeneratorBriefSchema.safeParse({
      ...complexBase,
      rooms: [
        { name: 'Entry', monsterIndexes: [0], targetLevel: 3 },
        { name: 'Yard', monsterIndexes: [] },
        { name: 'Shrine', monsterIndexes: [], targetLevel: 2 },
        { name: 'Crypt', monsterIndexes: [] },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain(
        'rooms.1.targetLevel',
      );
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        'a dungeon complex requires every room to carry a targetLevel (the party level this room alone should challenge)',
      );
    }
  });

  it('accepts a complex whose every room carries a targetLevel', () => {
    const result = encounterGeneratorBriefSchema.safeParse({
      ...complexBase,
      rooms: [
        { name: 'Entry', monsterIndexes: [0], targetLevel: 3 },
        { name: 'Yard', monsterIndexes: [], targetLevel: 2 },
        { name: 'Shrine', monsterIndexes: [], targetLevel: 2 },
        { name: 'Crypt', monsterIndexes: [], targetLevel: 4 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('keeps targetLevel optional for a single arena', () => {
    const result = encounterGeneratorBriefSchema.safeParse({
      ...complexBase,
      rooms: [{ name: 'Entry', monsterIndexes: [0] }],
    });
    expect(result.success).toBe(true);
  });
});
