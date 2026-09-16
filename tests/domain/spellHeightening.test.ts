import { describe, expect, it } from 'vitest';

import type { SpellData } from '@/domain/spellData';
import {
  combineDamageFormula,
  PROSE_ONLY_MARKER,
  spellAtRank,
  UNPARSED_HEIGHTENING_PREFIX,
} from '@/domain/spellHeightening';

/**
 * PF2e heightening — the ONE rule (docs/17 ledger 183). This file is the PURE
 * half: synthetic payloads exercise every arm and every loud failure. The REAL
 * corpus documents (Acid Splash, Fireball, Ignition) go through the same rule
 * end to end in `tests/ingest/packs/pf2e-rules-heightening.test.ts`, so this
 * file never re-implements the payload mapping.
 */

function makeSpell(overrides: Partial<SpellData>): SpellData {
  return {
    system: 'pathfinder2e',
    rank: 3,
    cantrip: false,
    traditions: [],
    traits: [],
    rarity: 'common',
    cast: { time: '', range: '', target: '', duration: '' },
    damage: {},
    area: null,
    heightening: null,
    heighteningEntries: [],
    heighteningUnparsed: [],
    publication: null,
    ...overrides,
  };
}

const formulas = (spell: SpellData, request: Parameters<typeof spellAtRank>[1]): string[] =>
  spellAtRank(spell, request).values.damage.map((entry) => entry.formula);

describe('spellAtRank — fixed heightening (the highest listed rank <= castRank)', () => {
  const fixed = makeSpell({
    rank: 3,
    damage: {
      a: { formula: '6d6', type: 'fire', category: null, materials: [] },
      splash: { formula: '1', type: 'fire', category: 'splash', materials: [] },
    },
    heightening: {
      type: 'fixed',
      levels: {
        4: { damage: { a: { formula: '8d6', type: 'fire', category: null, materials: [] } } },
        6: { damage: { a: { formula: '10d6', type: 'fire', category: null, materials: [] } } },
      },
    },
  });

  it('applies the BASE below the lowest listed rank', () => {
    const result = spellAtRank(fixed, { castRank: 3 });
    expect(result.values.damage.map((entry) => entry.formula)).toEqual(['6d6', '1']);
    expect(result.source).toBe('base');
    expect(result.valuesSource).toBe('base');
    expect(result.structured).toBe(true);
  });

  it('selects the HIGHEST listed rank <= the cast rank, never the lowest', () => {
    expect(formulas(fixed, { castRank: 4 })).toEqual(['8d6']);
    expect(formulas(fixed, { castRank: 5 })).toEqual(['8d6']);
    expect(formulas(fixed, { castRank: 6 })).toEqual(['10d6']);
    expect(formulas(fixed, { castRank: 10 })).toEqual(['10d6']);
    expect(spellAtRank(fixed, { castRank: 5 }).source).toBe('fixed');
  });

  it('treats a layer damage map as a COMPLETE replacement (no base key survives)', () => {
    const result = spellAtRank(fixed, { castRank: 4 });
    expect(result.values.damage.map((entry) => entry.key)).toEqual(['a']);
    expect(result.values.damage.map((entry) => entry.formula)).toEqual(['8d6']);
  });

  it('replaces area, target and duration a layer states, and reports keys it does not apply', () => {
    const layered = makeSpell({
      rank: 2,
      cast: { time: '2', range: '60 feet', target: '1 creature', duration: '1 round' },
      area: { type: 'burst', value: 10 },
      damage: { a: { formula: '1d6', type: 'fire', category: null, materials: [] } },
      heightening: {
        type: 'fixed',
        levels: {
          5: {
            damage: { a: { formula: '3d6', type: 'fire', category: null, materials: [] } },
            area: { type: 'cone', value: 30 },
            target: { value: 'up to 5 creatures' },
            duration: { value: '1 minute' },
            range: { value: '120 feet' },
          },
        },
      },
    });
    const result = spellAtRank(layered, { castRank: 5 });
    expect(result.values.damage.map((entry) => entry.formula)).toEqual(['3d6']);
    expect(result.values.area).toEqual({ type: 'cone', value: 30 });
    expect(result.values.target).toBe('up to 5 creatures');
    expect(result.values.duration).toBe('1 minute');
    // `range` is part of the source layer but not a value this rule carries:
    // it is REPORTED, never silently dropped.
    expect(result.warnings.some((line) => line.includes('range'))).toBe(true);
  });

  it('returns the applicable fixed note verbatim, highest applicable only', () => {
    const noted = makeSpell({
      rank: 2,
      damage: { a: { formula: '1d6', type: 'fire', category: null, materials: [] } },
      heightening: { type: 'fixed', levels: { 4: { damage: { a: { formula: '2d6', type: 'fire', category: null, materials: [] } } } } },
      heighteningEntries: [
        { kind: 'fixed', rank: 4, text: 'The damage increases to 2d6.' },
        { kind: 'fixed', rank: 6, text: 'The damage increases to 3d6.' },
      ],
    });
    expect(spellAtRank(noted, { castRank: 4 }).notes).toEqual(['The damage increases to 2d6.']);
    expect(spellAtRank(noted, { castRank: 6 }).notes).toEqual(['The damage increases to 3d6.']);
  });
});

describe('spellAtRank — cantrip auto-heightening (the module owns the rank)', () => {
  const cantrip = makeSpell({
    rank: 0,
    cantrip: true,
    damage: { a: { formula: '1d6', type: 'acid', category: null, materials: [] } },
    heightening: {
      type: 'fixed',
      levels: {
        3: { damage: { a: { formula: '2d6', type: 'acid', category: null, materials: [] } } },
        5: { damage: { a: { formula: '3d6', type: 'acid', category: null, materials: [] } } },
      },
    },
  });

  it('derives max(1, ceil(level / 2)) for levels 1..20', () => {
    const expected = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10];
    const ranks = Array.from({ length: 20 }, (_, index) =>
      spellAtRank(cantrip, { casterLevel: index + 1 }).appliedRank,
    );
    expect(ranks).toEqual(expected);
  });

  it('applies the fixed layer the auto rank selects', () => {
    // Caster level 5 → rank 3 (the first listed layer), level 10 → rank 5.
    const level5 = spellAtRank(cantrip, { casterLevel: 5 });
    expect(level5.appliedRank).toBe(3);
    expect(level5.source).toBe('cantrip-auto');
    expect(level5.valuesSource).toBe('fixed');
    expect(level5.cantripAuto).toBe(true);
    expect(level5.values.damage.map((entry) => entry.formula)).toEqual(['2d6']);
    expect(spellAtRank(cantrip, { casterLevel: 10 }).values.damage.map((entry) => entry.formula)).toEqual(['3d6']);
  });

  it('uses the BASE below the lowest layer, still flagged cantrip-auto', () => {
    const result = spellAtRank(cantrip, { casterLevel: 2 });
    expect(result.appliedRank).toBe(1);
    expect(result.source).toBe('cantrip-auto');
    expect(result.valuesSource).toBe('base');
    expect(result.values.damage.map((entry) => entry.formula)).toEqual(['1d6']);
  });

  it('IGNORES a caller castRank and says so loudly', () => {
    const result = spellAtRank(cantrip, { casterLevel: 5, castRank: 9 });
    expect(result.appliedRank).toBe(3);
    expect(result.warnings.some((line) => line.includes('castRank 9 ignored'))).toBe(true);
  });

  it('refuses a cantrip with no caster level instead of guessing a rank', () => {
    expect(() => spellAtRank(cantrip, {})).toThrow(/casterLevel/);
    expect(() => spellAtRank(cantrip, { casterLevel: 0 })).toThrow(/casterLevel/);
  });
});

describe('spellAtRank — focus auto-heightening (docs/17 row 191)', () => {
  const focusSpell = makeSpell({
    rank: 1,
    cantrip: false,
    traits: ['cleric', 'focus', 'manipulate'],
  });

  it('derives clamp(ceil(casterLevel / 2), 1, 10) when the source states no fixed rank', () => {
    // THE DIFFERENTIAL: the SAME focus spell at two caster levels moves the
    // rank, so no caller-side constant could have supplied it.
    const level5 = spellAtRank(focusSpell, { casterLevel: 5 });
    expect(level5.appliedRank).toBe(3);
    expect(level5.focusAuto).toBe(true);
    expect(level5.cantripAuto).toBe(false);
    expect(level5.source).toBe('focus-auto');
    const level9 = spellAtRank(focusSpell, { casterLevel: 9 });
    expect(level9.appliedRank).toBe(5);
    expect(level9.source).toBe('focus-auto');
  });

  it('prefers the source fixed autoHeightenLevel over the ceil rule', () => {
    // The importer resolved upstream's item-then-entry order; the rule applies
    // the value but still names the focus rule as the provenance.
    const result = spellAtRank(focusSpell, { casterLevel: 9, autoHeightenLevel: 7 });
    expect(result.appliedRank).toBe(7);
    expect(result.focusAuto).toBe(true);
    expect(result.source).toBe('focus-auto');
  });

  it('lets an EXPLICIT cast rank win over every derived one', () => {
    // The caller's assignment is authoritative: neither the fixed rank nor the
    // caster level is used, and no auto provenance is claimed.
    const result = spellAtRank(focusSpell, {
      castRank: 4,
      casterLevel: 9,
      autoHeightenLevel: 7,
    });
    expect(result.appliedRank).toBe(4);
    expect(result.focusAuto).toBe(false);
    expect(result.source).toBe('base');
  });

  it('refuses a focus spell with neither a fixed rank nor a usable caster level', () => {
    expect(() => spellAtRank(focusSpell, {})).toThrow(/casterLevel/);
    expect(() => spellAtRank(focusSpell, { casterLevel: 0 })).toThrow(/casterLevel/);
    expect(() => spellAtRank(focusSpell, { casterLevel: 5, autoHeightenLevel: 0 })).toThrow(
      /autoHeightenLevel/,
    );
  });

  it('keeps the CANTRIP arm unchanged for a spell carrying both traits (docs/17 rows 183/191)', () => {
    // A cantrip+focus document rides the cantrip arm byte for byte — the focus
    // trait must not reroute it, and its provenance stays `cantrip-auto`.
    const both = makeSpell({ rank: 0, cantrip: true, traits: ['cantrip', 'focus'] });
    const result = spellAtRank(both, { casterLevel: 5 });
    expect(result.source).toBe('cantrip-auto');
    expect(result.cantripAuto).toBe(true);
    expect(result.focusAuto).toBe(false);
    expect(result.appliedRank).toBe(3);
  });
});

describe('spellAtRank — interval heightening (a delta per whole step)', () => {
  const fireballish = makeSpell({
    rank: 3,
    damage: { '0': { formula: '6d6', type: 'fire', category: null, materials: [] } },
    area: { type: 'burst', value: 20 },
    heightening: { type: 'interval', interval: 1, area: 0, damage: { '0': '2d6' } },
    heighteningEntries: [{ kind: 'increment', increment: 1, text: 'The damage increases by 2d6.' }],
  });

  it('applies the base at the base rank, then one delta per step', () => {
    const base = spellAtRank(fireballish, { castRank: 3 });
    expect(base.values.damage.map((entry) => entry.formula)).toEqual(['6d6']);
    expect(base.appliedSteps).toBe(0);
    expect(base.source).toBe('base');
    expect(base.valuesSource).toBe('base');
    // A `+1` note applies only once the spell is actually heightened.
    expect(base.notes).toEqual([]);

    const one = spellAtRank(fireballish, { castRank: 4 });
    expect(one.values.damage.map((entry) => entry.formula)).toEqual(['8d6']);
    expect(one.appliedSteps).toBe(1);
    expect(one.source).toBe('interval');
    expect(one.valuesSource).toBe('interval');
    expect(one.notes).toEqual(['The damage increases by 2d6.']);

    const two = spellAtRank(fireballish, { castRank: 5 });
    expect(two.values.damage.map((entry) => entry.formula)).toEqual(['10d6']);
    expect(two.appliedSteps).toBe(2);
  });

  it('floors a (+2) interval and REPORTS the leftover rank instead of rounding it up', () => {
    const slow = makeSpell({
      rank: 3,
      damage: { '0': { formula: '2d6', type: 'fire', category: null, materials: [] } },
      heightening: { type: 'interval', interval: 2, area: 0, damage: { '0': '1d6' } },
    });
    const oddTwo = spellAtRank(slow, { castRank: 5 });
    expect(oddTwo.appliedSteps).toBe(1);
    expect(oddTwo.stepRemainder).toBe(0);
    expect(oddTwo.values.damage.map((entry) => entry.formula)).toEqual(['3d6']);
    // The floor is the Paizo/Foundry rule: a (+2) spell 1 rank up gains NOTHING.
    const oddOne = spellAtRank(slow, { castRank: 4 });
    expect(oddOne.appliedSteps).toBe(0);
    expect(oddOne.stepRemainder).toBe(1);
    expect(oddOne.values.damage.map((entry) => entry.formula)).toEqual(['2d6']);
    expect(oddOne.warnings.some((line) => line.includes('leftover'))).toBe(true);
    expect(spellAtRank(slow, { castRank: 7 }).values.damage.map((entry) => entry.formula)).toEqual(['4d6']);
  });

  it('adds the interval area increase to the base area', () => {
    const areaSpell = makeSpell({
      rank: 2,
      area: { type: 'burst', value: 20 },
      heightening: { type: 'interval', interval: 1, area: 5, damage: {} },
    });
    const result = spellAtRank(areaSpell, { castRank: 4 });
    expect(result.values.area).toEqual({ type: 'burst', value: 30 });
    expect(result.valuesSource).toBe('interval');
  });

  it('warns instead of inventing an area when the interval states one but the base has none', () => {
    const areaSpell = makeSpell({
      rank: 2,
      heightening: { type: 'interval', interval: 1, area: 5, damage: {} },
    });
    const result = spellAtRank(areaSpell, { castRank: 3 });
    expect(result.values.area).toBeNull();
    expect(result.warnings.some((line) => line.includes('no base area'))).toBe(true);
  });

  it('refuses to heighten from nothing when the payload has no base damage', () => {
    const corrupt = makeSpell({
      rank: 3,
      damage: {},
      heightening: { type: 'interval', interval: 1, area: 0, damage: { '0': '2d6' } },
    });
    expect(() => spellAtRank(corrupt, { castRank: 4 })).toThrow(/refusing to heighten from nothing/);
  });

  it('warns about a delta key no base damage entry uses while still applying the matches', () => {
    const stray = makeSpell({
      rank: 3,
      damage: {
        '0': { formula: '6d6', type: 'fire', category: null, materials: [] },
        extra: { formula: '1d4', type: 'fire', category: null, materials: [] },
      },
      heightening: { type: 'interval', interval: 1, area: 0, damage: { '0': '2d6', ghost: '2d6' } },
    });
    const result = spellAtRank(stray, { castRank: 4 });
    expect(result.values.damage.map((entry) => `${entry.key}=${entry.formula}`)).toEqual(['0=8d6', 'extra=1d4']);
    expect(result.warnings.some((line) => line.includes('"ghost"'))).toBe(true);
  });

  it('uses the cantrip RULES base rank (1), never the list rank (0)', () => {
    // Ignition's shape: base 2d4 at rank 1, +1d4 per rank. Caster level 5 → rank
    // 3 → TWO steps (3 - 1), giving 4d4. Using `spell.rank` (0) would give the
    // wrong 5d4 — the bug this pin exists for.
    const ignitionish = makeSpell({
      rank: 0,
      cantrip: true,
      damage: { a: { formula: '2d4', type: 'fire', category: null, materials: [] } },
      heightening: { type: 'interval', interval: 1, area: 0, damage: { a: '1d4' } },
    });
    const rank3 = spellAtRank(ignitionish, { casterLevel: 5 });
    expect(rank3.appliedRank).toBe(3);
    expect(rank3.appliedSteps).toBe(2);
    expect(rank3.values.damage.map((entry) => entry.formula)).toEqual(['4d4']);
    expect(spellAtRank(ignitionish, { casterLevel: 1 }).values.damage.map((entry) => entry.formula)).toEqual(['2d4']);
  });
});

describe('spellAtRank — prose-only heightening (displayed, never computed)', () => {
  const proseOnly = makeSpell({
    rank: 3,
    damage: { a: { formula: '2d6', type: 'fire', category: null, materials: [] } },
    heightening: null,
    heighteningEntries: [
      { kind: 'fixed', rank: 5, text: 'The damage increases to 4d6 and the duration becomes 1 minute.' },
    ],
  });

  it('returns the applicable entry VERBATIM with the loud marker and no computed numbers', () => {
    const result = spellAtRank(proseOnly, { castRank: 5 });
    expect(result.source).toBe('prose-only');
    expect(result.structured).toBe(false);
    expect(result.valuesSource).toBe('base');
    expect(result.notes).toEqual(['The damage increases to 4d6 and the duration becomes 1 minute.']);
    expect(result.values.damage.map((entry) => entry.formula)).toEqual(['2d6']);
    expect(result.warnings).toContain(PROSE_ONLY_MARKER);
  });

  it('falls back to `base` when no note is applicable at the cast rank', () => {
    const result = spellAtRank(proseOnly, { castRank: 4 });
    expect(result.source).toBe('base');
    expect(result.notes).toEqual([]);
    expect(result.warnings).not.toContain(PROSE_ONLY_MARKER);
  });

  it('returns an applicable increment note verbatim', () => {
    const increment = makeSpell({
      rank: 2,
      heightening: null,
      heighteningEntries: [{ kind: 'increment', increment: 2, text: 'The damage increases by 1d6.' }],
    });
    const result = spellAtRank(increment, { castRank: 4 });
    expect(result.source).toBe('prose-only');
    expect(result.notes).toEqual(['The damage increases by 1d6.']);
  });

  it('surfaces heighteningUnparsed loudly and still returns base values', () => {
    const unparsed = makeSpell({
      rank: 3,
      damage: { a: { formula: '2d6', type: 'fire', category: null, materials: [] } },
      heightening: null,
      heighteningUnparsed: ['<strong>Heightened (special)</strong> Ask your GM.'],
    });
    const result = spellAtRank(unparsed, { castRank: 5 });
    expect(result.source).toBe('base');
    expect(result.unparsed).toEqual(['<strong>Heightened (special)</strong> Ask your GM.']);
    expect(result.warnings).toContain(
      `${UNPARSED_HEIGHTENING_PREFIX}<strong>Heightened (special)</strong> Ask your GM.`,
    );
  });
});

describe('spellAtRank — loud refusals (no silent fallback)', () => {
  it('throws on a spell row with no payload', () => {
    expect(() => spellAtRank(null, { castRank: 3 })).toThrow(/no spellData payload/);
    expect(() => spellAtRank(undefined, { castRank: 3 })).toThrow(/no spellData payload/);
  });

  it('throws when the cast rank is below the spell own rank', () => {
    const spell = makeSpell({ rank: 3 });
    expect(() => spellAtRank(spell, { castRank: 2 })).toThrow(/cannot be cast at rank 2/);
  });

  it('throws on a non-integer cast rank or an absent one', () => {
    const spell = makeSpell({ rank: 3 });
    expect(() => spellAtRank(spell, { castRank: 3.5 })).toThrow(/integer castRank/);
    expect(() => spellAtRank(spell, {})).toThrow(/integer castRank/);
  });

  it('throws on a corrupt interval or an unknown type', () => {
    expect(() =>
      spellAtRank(makeSpell({ heightening: { type: 'interval', interval: 0 } }), { castRank: 4 }),
    ).toThrow(/malformed interval heightening/);
    expect(() =>
      spellAtRank(makeSpell({ heightening: { type: 'graded', levels: {} } }), { castRank: 4 }),
    ).toThrow(/unsupported heightening type "graded"/);
    expect(() => spellAtRank(makeSpell({ heightening: { levels: {} } }), { castRank: 4 })).toThrow(/no "type"/);
  });
});

describe('combineDamageFormula — symbolic, deterministic, never evaluated', () => {
  it('adds same-die dice counts', () => {
    expect(combineDamageFormula('6d6', '2d6', 2)).toEqual('10d6');
    expect(combineDamageFormula('2d6', '-1d6', 1)).toEqual('1d6');
  });

  it('keeps different dice and flat bonuses separate', () => {
    expect(combineDamageFormula('1d6', '1d4 + 4', 1)).toEqual('1d6 + 1d4 + 4');
    expect(combineDamageFormula('1d6 + 2', '1d6', 1)).toEqual('2d6 + 2');
  });

  it('orders dice by FIRST APPEARANCE (base first, then the delta), flat total last', () => {
    expect(combineDamageFormula('1d8 + 1d4', '1d6', 1)).toEqual('1d8 + 1d4 + 1d6');
    expect(combineDamageFormula('1d4', '1d8', 1)).toEqual('1d4 + 1d8');
  });

  it('leaves the base untouched for zero steps', () => {
    expect(combineDamageFormula('6d6', '2d6', 0)).toEqual('6d6');
  });

  it('refuses a formula it cannot read instead of guessing', () => {
    expect(() => combineDamageFormula('@item.level', '1d6', 1)).toThrow(/cannot read the formula term/);
    expect(() => combineDamageFormula('1d6', '2d6', -1)).toThrow(/non-negative integer/);
  });
});
