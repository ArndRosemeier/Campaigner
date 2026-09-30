import { describe, expect, it } from 'vitest';

import { CODE, filesWith } from '../helpers/sourceCode';

/**
 * THE ONE spelling of the Paizo auto-heightened cantrip RANK (docs/17 row 194,
 * the fold appended to it; docs/18 §2). `clamp(ceil(level / 2), 1, 10)` is ONE
 * rule that a PF2e campaign asks in three places for two different questions:
 * the vocabulary's eligibility cap (`domain/mobSpells.maxCastableRank` — the
 * highest rank a caster of that level may be OFFERED) and the rank a cantrip,
 * or an auto-heightened focus spell, is actually CAST at
 * (`domain/spellHeightening.spellAtRank`). Those answers MUST agree: a cap
 * below the cast rank offers a spell the caster cannot use, a cap above it
 * offers a rank whose numbers are never reached. So the rule lives ONCE as
 * `domain/spellHeightening.pf2eCantripRankFor` and every former site CALLS it.
 *
 * The pin is a SOURCE SCAN because the drift it catches is invisible: a second
 * inline `Math.min(10, Math.max(1, Math.ceil(level / 2)))` answers identically
 * today and diverges the day the rule changes. The needle is the ARITHMETIC,
 * not the function name — after whitespace is collapsed it stops at the
 * `Math.ceil(` call and names the `/2` divisor — so NEITHER renaming
 * `pf2eCantripRankFor` NOR renaming the `level` parameter can hide a copy,
 * while an unrelated ceil clamp without the 1..10 clamp (e.g.
 * `llm/roomBudget.roomBudgetReferenceCreatureLevel`, a half-level reference
 * creature with no rank ceiling) does not match it.
 */

const SEAM = 'src/domain/spellHeightening.ts';
const VOCABULARY = 'src/domain/mobSpells.ts';

/**
 * The Paizo rank arithmetic in either clamp nesting order, the `Math.ceil`
 * argument's variable name BLANKED (`[^)]*`), the `/2` divisor named so an
 * unrelated clamp cannot match. Applied to comment-stripped, whitespace-
 * collapsed source.
 */
const RANK_ARITHMETIC =
  /Math\.(?:min\(10,Math\.max\(1,|max\(1,Math\.min\(10,)Math\.ceil\([^)]*\/2\)\)\)/g;

/** The rank arithmetic a file spells, with comments gone (`CODE`) and whitespace removed. */
function rankArithmeticHits(file: string): number {
  const code = (CODE[file] ?? '').replace(/\s+/g, '');
  return (code.match(RANK_ARITHMETIC) ?? []).length;
}

describe('one Paizo cantrip-rank rule (SOURCE SCAN, docs/17 row 194)', () => {
  it('spells the arithmetic in exactly one file, the heightening seam', () => {
    const files = Object.keys(CODE);
    // Non-vacuity: the walk must see the whole tree, or it proves nothing.
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain(SEAM);

    const offenders = files.filter((file) => file !== SEAM && rankArithmeticHits(file) > 0);
    expect(offenders).toEqual([]);
    // Non-vacuity for the seam: it really carries the ONE spelling, so a scan
    // that matched nothing anywhere cannot pass by accident.
    expect(rankArithmeticHits(SEAM)).toBe(1);
  });

  it('declares the function once and routes all three consumers through it', () => {
    const declarations = filesWith('export function pf2eCantripRankFor(');
    // Exactly ONE definition, at the seam.
    expect(declarations).toEqual([SEAM]);

    // The vocabulary's eligibility cap CALLS the rule — a revert to the inline
    // arithmetic would red both this and the scan above.
    const vocabulary = CODE[VOCABULARY] ?? '';
    expect(vocabulary).toMatch(/return pf2eCantripRankFor\(level\);/);

    // BOTH `spellAtRank` arms that used to spell the arithmetic — the cantrip
    // arm and the auto-heightened focus arm — CALL the same function.
    const seam = CODE[SEAM] ?? '';
    expect(seam.match(/appliedRank = pf2eCantripRankFor\(level\);/g) ?? []).toHaveLength(2);
  });
});
