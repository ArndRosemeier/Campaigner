import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SpellData } from '@/domain/spellData';
import { PROSE_ONLY_MARKER, spellAtRank, type SpellAtRankRequest } from '@/domain/spellHeightening';
import { foundryPf2eRulesAdapter } from '@/ingest/packs/pf2e-rules';
import { sha256Hex } from '@/lib/hash';

/**
 * PF2e heightening end to end on the REAL corpus (docs/17 ledger 183): the
 * pinned upstream documents are mapped by the ONE pf2e-rules field mapping and
 * the resulting payload is fed to the ONE heightening rule, so the formulas
 * asserted here are the source's own numbers, not a hand-built fixture.
 *
 * Measured from `foundryvtt/pf2e` `v14-dev` (fetched 2026-09-16):
 * - `packs/pf2e/spells/spells/cantrip/acid-splash.json` — OGL cantrip, base
 *   `1d6` + `1` splash, `fixed` layers at 3rd/5th/7th/9th carrying COMPLETE
 *   replacement formulas (`2d6`/`3d6`/`4d6`/`5d6`, splash `1`/`2`/`3`/`4`).
 * - `packs/pf2e/spells/spells/rank-3/fireball.json` — remaster rank 3, base
 *   `6d6`, `heightening: {type:'interval', interval:1, area:0, damage:{'0':'2d6'}}`
 *   (a POSITIVE DELTA per step, keyed by the base damage id).
 * - `packs/pf2e/spells/spells/cantrip/ignition.json` — remaster cantrip, base
 *   `2d4` at `level.value: 1`, `interval 1` delta `1d4` (the cantrip RULES base
 *   rank is 1, not the list rank 0).
 * - `packs/pf2e/spells/spells/rank-1/summon-undead.json` (fetched 2026-09-17,
 *   sha256 `ac16988320dfd9e6ea2157d1f9ea89a9dd1c452b537389d6f1f496a0495757f4`,
 *   1,494 B) — the THIRD heading shape, a bare `<strong>Heightened</strong>`
 *   with NO rank and NO interval, delegating the scaling to the `summon` trait
 *   (`docs/17` row 221). It carries `heightening: null` and `damage: {}`, so
 *   the parsed `note` is prose only and computes NOTHING. Its sibling
 *   `rank-1/summon-animal.json` (`69245404394b1ee414781cadb1c54678dd08d0a357422b39e541115ed60b82a5`,
 *   1,475 B) carries the SAME shape, which is why this is named a FAMILY
 *   rather than a one-off.
 */


const PACK_FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures', 'packs', 'pf2e-rules');
const SPELL_FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures', 'spells');

async function payload(dir: string, name: string, packRelative: string): Promise<SpellData> {
  const bytes = new TextEncoder().encode(readFileSync(join(dir, name), 'utf8'));
  const parsed = await foundryPf2eRulesAdapter.parseFile(packRelative, bytes);
  expect(parsed.failures).toEqual([]);
  const spell = parsed.sections?.[0]?.spell;
  if (spell === undefined) throw new Error(`fixture ${name} produced no spell payload`);
  return spell;
}

const acidSplash = (): Promise<SpellData> =>
  payload(PACK_FIXTURES, 'acid-splash.json', 'spells/spells/cantrip/acid-splash.json');
const fireball = (): Promise<SpellData> =>
  payload(SPELL_FIXTURES, 'fireball.json', 'spells/spells/rank-3/fireball.json');
const ignition = (): Promise<SpellData> => payload(SPELL_FIXTURES, 'ignition.json', 'spells/spells/cantrip/ignition.json');
const summonUndead = (): Promise<SpellData> =>
  payload(SPELL_FIXTURES, 'summon-undead.json', 'spells/spells/rank-1/summon-undead.json');

const SUMMON_UNDEAD_SHA256 = 'ac16988320dfd9e6ea2157d1f9ea89a9dd1c452b537389d6f1f496a0495757f4';

function formulasAt(spell: SpellData, request: SpellAtRankRequest): string[] {
  return spellAtRank(spell, request).values.damage.map((entry) => `${entry.key}=${entry.formula}`);
}

describe('heightening on the real corpus (the Paizo rule, source numbers only)', () => {
  it('Acid Splash (fixed): the exact replacement formulas at 3rd/4th/5th/7th/9th/10th', async () => {
    const spell = await acidSplash();
    // Caster level 1 → rank 1: below the lowest listed layer (3rd) → BASE.
    expect(spellAtRank(spell, { casterLevel: 1 }).appliedRank).toBe(1);
    expect(formulasAt(spell, { casterLevel: 1 })).toEqual(['0=1d6', 'gcovwqxwitqchoin=1']);
    // Level 5 → rank 3; level 7 → rank 4 picks the 3rd-level layer (highest ≤ 4).
    expect(formulasAt(spell, { casterLevel: 5 })).toEqual(['0=2d6', 'gcovwqxwitqchoin=1']);
    expect(formulasAt(spell, { casterLevel: 7 })).toEqual(['0=2d6', 'gcovwqxwitqchoin=1']);
    // Level 9 → rank 5; level 13 → rank 7; level 17 → rank 9; level 20 → rank 10 (capped at the 9th layer).
    expect(formulasAt(spell, { casterLevel: 9 })).toEqual(['0=3d6', 'gcovwqxwitqchoin=2']);
    expect(formulasAt(spell, { casterLevel: 13 })).toEqual(['0=4d6', 'gcovwqxwitqchoin=3']);
    expect(formulasAt(spell, { casterLevel: 17 })).toEqual(['0=5d6', 'gcovwqxwitqchoin=4']);
    expect(formulasAt(spell, { casterLevel: 20 })).toEqual(['0=5d6', 'gcovwqxwitqchoin=4']);
    // The note shown is the layer's own prose, verbatim.
    expect(spellAtRank(spell, { casterLevel: 5 }).notes).toEqual([
      'The initial damage increases to 2d6, and the persistent damage increases to 2.',
    ]);
  });

  it('Fireball (interval): the pinned base formula plus the pinned delta per step', async () => {
    const spell = await fireball();
    expect(spell.rank).toBe(3);
    expect(spell.damage).toEqual({
      '0': { formula: '6d6', type: 'fire', category: null, materials: [] },
    });
    expect(spell.heightening).toEqual({
      type: 'interval',
      interval: 1,
      area: 0,
      damage: { '0': '2d6' },
    });
    expect(formulasAt(spell, { castRank: 3 })).toEqual(['0=6d6']);
    expect(formulasAt(spell, { castRank: 4 })).toEqual(['0=8d6']);
    expect(formulasAt(spell, { castRank: 5 })).toEqual(['0=10d6']);
    const atBase = spellAtRank(spell, { castRank: 3 });
    expect(atBase.appliedSteps).toBe(0);
    expect(atBase.source).toBe('base');
    const two = spellAtRank(spell, { castRank: 5 });
    expect(two.appliedSteps).toBe(2);
    expect(two.source).toBe('interval');
    // `area: 0` means the 20-foot burst is unchanged at every rank.
    expect(two.values.area).toEqual({ type: 'burst', value: 20 });
    expect(two.notes).toEqual(['The damage increases by 2d6.']);
  });

  it('Ignition (cantrip interval): auto-heightens from the cantrip RULES base rank 1', async () => {
    const spell = await ignition();
    expect(spell.rank).toBe(0);
    expect(spell.cantrip).toBe(true);
    expect(spell.damage).toEqual({
      cQDyW0QpjJ38MlSi: { formula: '2d4', type: 'fire', category: null, materials: [] },
    });
    // Caster level 1 → rank 1 → 2d4; level 5 → rank 3 → 2 steps → 4d4;
    // level 9 → rank 5 → 4 steps → 6d4.
    expect(formulasAt(spell, { casterLevel: 1 })).toEqual(['cQDyW0QpjJ38MlSi=2d4']);
    expect(formulasAt(spell, { casterLevel: 5 })).toEqual(['cQDyW0QpjJ38MlSi=4d4']);
    expect(formulasAt(spell, { casterLevel: 9 })).toEqual(['cQDyW0QpjJ38MlSi=6d4']);
    const rank5 = spellAtRank(spell, { casterLevel: 9 });
    expect(rank5.appliedRank).toBe(5);
    expect(rank5.appliedSteps).toBe(4);
    expect(rank5.source).toBe('cantrip-auto');
    expect(rank5.valuesSource).toBe('interval');
  });
});

describe('the bare Heightened shape — a NOTES-ONLY entry that computes nothing (docs/17 row 221)', () => {
  it('Summon Undead: the REAL upstream bytes are the pinned fixture', async () => {
    const fixture = readFileSync(join(SPELL_FIXTURES, 'summon-undead.json'), 'utf8');
    // The fixture is the fetched document byte-for-byte (never synthesised):
    // a drift REDS by name here.
    expect(await sha256Hex(fixture)).toBe(SUMMON_UNDEAD_SHA256);
  });

  it('parses the bare heading as ONE readable note and leaves the fallback EMPTY', async () => {
    const spell = await summonUndead();
    // The source carries NO structured heightening and no base damage — the
    // scaling lives in the `summon` trait's own journal page.
    expect(spell.heightening).toBeNull();
    expect(spell.damage).toEqual({});
    expect(spell.heighteningEntries).toEqual([
      { kind: 'note', text: 'As listed in the summon trait.' },
    ]);
    // Pin 1: NO unparsed entry, and the GM-readable text carries neither the
    // raw `<strong>`/`<p>` markup nor the Foundry `@UUID[…]` notation.
    expect(spell.heighteningUnparsed).toEqual([]);
    const text = spell.heighteningEntries[0]?.text ?? '';
    expect(text).not.toContain('<');
    expect(text).not.toContain('@UUID[');
    expect(text).toBe('As listed in the summon trait.');
  });

  it('computes NO numbers from the note at any cast rank (the loud cannot-compute path)', async () => {
    const spell = await summonUndead();
    for (const castRank of [1, 2, 5]) {
      const result = spellAtRank(spell, { castRank });
      // A note names no rank and no interval, so no number and no step is
      // derived from it — the source's sentence is printed behind the marker.
      expect(result.values.damage).toEqual([]);
      expect(result.appliedSteps).toBeNull();
      expect(result.stepRemainder).toBeNull();
      expect(result.valuesSource).toBe('base');
      expect(result.structured).toBe(false);
      expect(result.source).toBe('prose-only');
      expect(result.notes).toEqual(['As listed in the summon trait.']);
      expect(result.warnings).toContain(PROSE_ONLY_MARKER);
    }
  });
});
