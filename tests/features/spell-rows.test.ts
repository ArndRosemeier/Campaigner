import { describe, expect, it } from 'vitest';

import type { RuleChunk, Rulebook, SpellData, SpellTradition } from '@/domain';
import { ruleChunkSchema, spellDataSchema, stampNewEntity } from '@/domain';
import {
  buildSpellRows,
  filterSpellRows,
  spellHeighteningLabel,
  spellRankLabel,
} from '@/features/spells/spell-rows';

/**
 * The spell list's PURE row rules (docs/17 row 182): rank ordering with
 * cantrips first (rank 0, docs/12 §15), the loud per-row data error for a
 * `spell` chunk whose validated payload is missing (never a silent drop), the
 * tradition MULTI-filter, and the heightening labels — which print the entry's
 * own rank/interval and compute no cast rank.
 */

const PACK_ID = '22222222-2222-4222-8222-222222222222';

function spellData(over: Partial<SpellData> = {}): SpellData {
  return spellDataSchema.parse({
    system: 'pathfinder2e',
    rank: 1,
    cantrip: false,
    traditions: ['arcane'],
    traits: [],
    rarity: 'common',
    cast: { time: '', range: '', target: '', duration: '' },
    heightening: null,
    heighteningEntries: [],
    heighteningUnparsed: [],
    publication: null,
    ...over,
  });
}

let seq = 0;
function chunk(
  over: Partial<RuleChunk> & { headingPath: string[] },
): RuleChunk {
  seq += 1;
  return ruleChunkSchema.parse({
    ...stampNewEntity(),
    bookId: PACK_ID,
    pageStart: 1,
    pageEnd: 1,
    chunkType: 'spell',
    text: `spell ${String(seq)}`,
    statBlock: null,
    contentHash: 'a'.repeat(63) + String(seq % 10),
    spellData: spellData(),
    ...over,
  });
}

function packBook(): Rulebook {
  return {
    id: PACK_ID,
    createdAt: 1,
    updatedAt: 1,
    title: 'PF2e Rules',
    system: 'pathfinder2e',
    status: 'ready',
    origin: 'pack',
    filename: 'rules.json',
    pageCount: 0,
    errorMessage: '',
    packMeta: null,
  };
}

describe('buildSpellRows', () => {
  it('orders by rank with cantrips first (rank 0), then by name', () => {
    const rows = buildSpellRows([packBook()], [
      chunk({ headingPath: ['Spells — Rank 3', 'Zeta'], spellData: spellData({ rank: 3 }) }),
      chunk({ headingPath: ['Spells — Cantrip', 'Ignition'], spellData: spellData({ rank: 0, cantrip: true }) }),
      chunk({ headingPath: ['Spells — Rank 1', 'Beta'], spellData: spellData({ rank: 1 }) }),
      chunk({ headingPath: ['Spells — Rank 1', 'Alpha'], spellData: spellData({ rank: 1 }) }),
      chunk({ headingPath: ['Spells — Rank 10', 'Omega'], spellData: spellData({ rank: 10 }) }),
    ]);
    expect(rows.map((row) => (row.kind === 'entry' ? row.name : row.message))).toEqual([
      'Ignition', // cantrip = rank 0
      'Alpha', // rank 1, name tiebreak
      'Beta',
      'Zeta', // rank 3
      'Omega', // rank 10
    ]);
    expect(rows[0]).toMatchObject({ kind: 'entry', rankLabel: 'Cantrip', cantrip: true });
    expect(rows[1]).toMatchObject({ kind: 'entry', rankLabel: 'Rank 1', cantrip: false });
  });

  it('carries the spell payload and the book title as its origin', () => {
    const rows = buildSpellRows([packBook()], [
      chunk({
        headingPath: ['Spells — Rank 2', 'Blur'],
        spellData: spellData({ rank: 2, traditions: ['arcane', 'occult'] }),
      }),
    ]);
    expect(rows[0]).toMatchObject({
      kind: 'entry',
      name: 'Blur',
      origin: 'PF2e Rules',
      // The row's OWN axis and its values (row 194): a PF2e payload's axis is
      // its traditions, and `filterValues` is what the ONE filter compares.
      filterAxis: 'tradition',
      filterValues: ['arcane', 'occult'],
    });
    if (rows[0]?.kind !== 'entry') throw new Error('expected an entry');
    expect(rows[0].data.rank).toBe(2);
  });

  it('marks a spell chunk with no validated payload as a loud data error, never dropping it', () => {
    const rows = buildSpellRows([packBook()], [
      chunk({ headingPath: ['Spells — Rank 1', 'Broken'], spellData: null }),
      chunk({ headingPath: ['Spells — Rank 1', 'Fine'], spellData: spellData({ rank: 1 }) }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: 'data-error',
      message: /has no validated spell payload — re-import the rules pack/,
    });
    expect(rows[1]).toMatchObject({ kind: 'entry', name: 'Fine' });
  });

  it('marks a spell chunk without a name in its heading as a data error', () => {
    const rows = buildSpellRows([packBook()], [chunk({ headingPath: ['Spells — Rank 1', '   '] })]);
    expect(rows[0]).toMatchObject({
      kind: 'data-error',
      message: /has no spell name in its heading/,
    });
  });

  it('ignores non-spell chunks entirely', () => {
    const rows = buildSpellRows([packBook()], [
      chunk({ headingPath: ['Spells — Rank 1', 'Real'], chunkType: 'spell' }),
      chunk({ headingPath: ['Feats', 'Cat Fall'], chunkType: 'section', spellData: null }),
    ]);
    expect(rows.map((row) => (row.kind === 'entry' ? row.name : row.message))).toEqual(['Real']);
  });
});

describe('filterSpellRows', () => {
  const rows = buildSpellRows([packBook()], [
    chunk({ headingPath: ['Spells — Rank 1', 'Arcane Only'], spellData: spellData({ traditions: ['arcane'] }) }),
    chunk({ headingPath: ['Spells — Rank 1', 'Primal Only'], spellData: spellData({ traditions: ['primal'] }) }),
    chunk({
      headingPath: ['Spells — Rank 1', 'Both'],
      spellData: spellData({ traditions: ['arcane', 'primal'] }),
    }),
    chunk({ headingPath: ['Spells — Rank 1', 'Traditionless'], spellData: spellData({ traditions: [] }) }),
    chunk({ headingPath: ['Spells — Rank 1', 'Corrupt'], spellData: null }),
  ]);

  function names(selection: readonly SpellTradition[]): string[] {
    return filterSpellRows(rows, selection).map((row) =>
      row.kind === 'entry' ? row.name : 'DATA-ERROR',
    );
  }

  it('an empty selection is no filter — every row stays', () => {
    expect(names([])).toEqual([
      'DATA-ERROR', // errors always visible, pinned first
      'Arcane Only',
      'Both',
      'Primal Only',
      'Traditionless',
    ]);
  });

  it('a non-empty selection keeps entries carrying ANY of the chosen traditions', () => {
    expect(names(['primal'])).toEqual(['DATA-ERROR', 'Both', 'Primal Only']);
    expect(names(['arcane', 'primal'])).toEqual([
      'DATA-ERROR',
      'Arcane Only',
      'Both',
      'Primal Only',
    ]);
    // A spell of no tradition is kept by no selection — honest, not a fallback.
    expect(names(['divine'])).toEqual(['DATA-ERROR']);
  });

  it('a second filter replaces the first (narrowing, not accumulating)', () => {
    expect(names(['arcane'])).toEqual(['DATA-ERROR', 'Arcane Only', 'Both']);
    expect(names(['occult'])).toEqual(['DATA-ERROR']);
  });
});

describe('spell labels', () => {
  it('spellRankLabel prints Cantrip or Rank N', () => {
    expect(spellRankLabel(0, true)).toBe('Cantrip');
    expect(spellRankLabel(4, false)).toBe('Rank 4');
  });

  it('spellHeighteningLabel prints the entry own rank/interval, computing nothing', () => {
    expect(spellHeighteningLabel({ kind: 'fixed', rank: 3, text: 'x' })).toBe('Heightened (3rd)');
    expect(spellHeighteningLabel({ kind: 'fixed', rank: 11, text: 'x' })).toBe('Heightened (11th)');
    expect(spellHeighteningLabel({ kind: 'fixed', rank: 22, text: 'x' })).toBe('Heightened (22nd)');
    expect(spellHeighteningLabel({ kind: 'increment', increment: 1, text: 'x' })).toBe(
      'Heightened (+1)',
    );
  });
});
