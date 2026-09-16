import { describe, expect, it } from 'vitest';

import { stampNewEntity } from '@/domain/entity';
import { ruleChunkSchema } from '@/domain/rulebook';
import { spellDataSchema, spellTraditionSchema, type SpellData } from '@/domain/spellData';

/**
 * The structured spell payload (docs/12 §15, the spells arc). Its ONE producer
 * is the pf2e-rules lane's existing spell field mapping — this file pins the
 * payload shape and the additive chunk contract; the adapter's own file pins
 * the mapping from a REAL fixture.
 */

const acidSplash: SpellData = {
  system: 'pathfinder2e',
  rank: 0,
  cantrip: true,
  traditions: ['arcane', 'primal'],
  traits: ['acid', 'attack', 'cantrip', 'concentrate', 'manipulate'],
  rarity: 'common',
  cast: { time: '2', range: '30 feet', target: '1 creature', duration: '' },
  damage: {
    '0': { formula: '1d6', type: 'acid', category: null, materials: [] },
    gcovwqxwitqchoin: { formula: '1', type: 'acid', category: 'splash', materials: [] },
  },
  area: null,
  heightening: { type: 'fixed', levels: { 3: { damage: {} } } },
  heighteningEntries: [
    {
      kind: 'fixed',
      rank: 3,
      text: 'The initial damage increases to 2d6, and the persistent damage increases to 2.',
    },
  ],
  heighteningUnparsed: [],
  publication: { title: 'Pathfinder Core Rulebook', license: 'OGL' },
};

describe('spellDataSchema (docs/12 §15)', () => {
  it('round-trips a full payload', () => {
    expect(spellDataSchema.parse(acidSplash)).toEqual(acidSplash);
  });

  it('validates traditions against the PF2e vocabulary and rejects an unknown one', () => {
    expect(spellTraditionSchema.options).toEqual(['arcane', 'divine', 'occult', 'primal']);
    expect(() => spellDataSchema.parse({ ...acidSplash, traditions: ['elemental'] })).toThrow();
  });

  it('defaults the optional lists and cast facts, and refuses a missing or negative rank', () => {
    expect(spellDataSchema.parse({ system: 'pathfinder2e', rank: 3, cantrip: false, cast: {} })).toEqual({
      system: 'pathfinder2e',
      rank: 3,
      cantrip: false,
      traditions: [],
      traits: [],
      rarity: 'common',
      cast: { time: '', range: '', target: '', duration: '' },
      damage: {},
      area: null,
      heighteningEntries: [],
      heighteningUnparsed: [],
    });
    expect(() => spellDataSchema.parse({ system: 'pathfinder2e', rank: -1, cast: {} })).toThrow();
    expect(() => spellDataSchema.parse({ system: 'pathfinder2e', cast: {} })).toThrow();
    // `cantrip` is the trait signal, required on every spell payload.
    expect(() => spellDataSchema.parse({ system: 'pathfinder2e', rank: 0, cast: {} })).toThrow();
  });

  it('validates the two heightening note shapes and rejects a bad rank/interval', () => {
    expect(
      spellDataSchema.parse({
        system: 'pathfinder2e',
        rank: 2,
        cantrip: false,
        cast: {},
        heighteningEntries: [
          { kind: 'fixed', rank: 3, text: 'Heightened at rank 3.' },
          { kind: 'increment', increment: 1, text: 'Heightened every rank.' },
        ],
      }).heighteningEntries,
    ).toEqual([
      { kind: 'fixed', rank: 3, text: 'Heightened at rank 3.' },
      { kind: 'increment', increment: 1, text: 'Heightened every rank.' },
    ]);
    expect(() =>
      spellDataSchema.parse({
        system: 'pathfinder2e',
        rank: 2,
        cantrip: false,
        cast: {},
        heighteningEntries: [{ kind: 'fixed', rank: 0, text: 'nope' }],
      }),
    ).toThrow();
    expect(() =>
      spellDataSchema.parse({
        system: 'pathfinder2e',
        rank: 2,
        cantrip: false,
        cast: {},
        heighteningEntries: [{ kind: 'increment', increment: -1, text: 'nope' }],
      }),
    ).toThrow();
  });
});

describe('spell chunks in ruleChunkSchema (additive, no migration, no index change)', () => {
  const base = {
    ...stampNewEntity(1),
    bookId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    pageStart: 1,
    pageEnd: 1,
    headingPath: ['Spells — Cantrip', 'Acid Splash'],
    text: 'Acid Splash\nCantrip 1',
    statBlock: null,
    contentHash: 'a'.repeat(64),
  };

  it('parses a pre-arc row without spellData to no payload, and it is NOT a spell', () => {
    // A row written before the arc is `chunkType: 'section'` and genuinely
    // lacks the key — `.nullish()` (never a default) is the honest type, and
    // nothing may count that row as a spell.
    const chunk = ruleChunkSchema.parse({ ...base, chunkType: 'section' });
    expect(chunk.spellData).toBeUndefined();
    expect(chunk.chunkType).not.toBe('spell');
  });

  it('parses a spell chunk carrying a validated payload', () => {
    const chunk = ruleChunkSchema.parse({ ...base, chunkType: 'spell', spellData: acidSplash });
    expect(chunk.chunkType).toBe('spell');
    expect(chunk.spellData).toEqual(acidSplash);
  });

  it('accepts the legacy chunk types unchanged', () => {
    for (const chunkType of ['section', 'statblock', 'table', 'item'] as const) {
      expect(() => ruleChunkSchema.parse({ ...base, chunkType })).not.toThrow();
    }
  });

  it('rejects a malformed payload on a spell chunk instead of storing it', () => {
    expect(() =>
      ruleChunkSchema.parse({ ...base, chunkType: 'spell', spellData: { rank: 1 } }),
    ).toThrow();
  });
});
