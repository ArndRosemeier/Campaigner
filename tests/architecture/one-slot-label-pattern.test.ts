import { describe, expect, it } from 'vitest';

import { CODE, filesWith } from '../helpers/sourceCode';

/**
 * ONE SLOT-LABEL GRAMMAR, NOT TWO (docs/17 row 295, AGENTS rule 4 /
 * centralization obligation 2) — and, since docs/17 row 300, ONE REGEX-LITERAL
 * ESCAPE for the whole app.
 *
 * THE DUPLICATION THIS PINS, as it stood: `db/battleSeed.spawnRosterInstance`
 * built `new RegExp('^' + escaped + '(?: \\d+)?$')` inline while
 * `features/play/battle/spawn-picker-logic.slotPatternFor` re-implemented the
 * same escaping and the same anchored, optionally-numbered grammar — its own
 * doc comment admitting it "mirrors `spawnRosterInstance`". The pair decides
 * how MANY on-board tokens exist for a name, so a drift between the copies
 * would change the board silently (the next spawn would reuse or skip a label
 * number).
 *
 * Both callers now ask `domain/battle/board.matchesSlotLabel(label, name)`,
 * which owns the escaping AND the grammar in one place. This is a SOURCE pin
 * rather than only a behaviour one because behaviour cannot see the drift this
 * file exists for: two copies agree on every fixture until the day one of them
 * is edited, and then the board counts differently with every test still green
 * on today's inputs.
 *
 * ROW 300 EXTENDED THIS FILE rather than adding a seventh scan, exactly as the
 * row-295 record promised: the metacharacter escape CLASS that used to be
 * asserted INSIDE the slot seam is now a FILE POPULATION of its own, because it
 * MOVED — `domain/escapeRegExp` carries it for all six sites that used to spell
 * it (`board`, `llm/language`, `llm/promptScaffolding`, `llm/campaignGrounding`,
 * `llm/roomBudget`, `features/rules/search-browser`). The slot seam therefore
 * asserts the OPPOSITE of what it used to: it must NOT hold the class any more,
 * and must import the seam instead.
 *
 * The source list comes from the ONE test-tree helper
 * (`tests/helpers/sourceCode`, docs/17 rows 212/284) — a hand-rolled walker
 * would be a baselined multi-site population.
 */

const SEAM = 'src/domain/battle/board.ts';
const SEED = 'src/db/battleSeed.ts';
const PICKER = 'src/features/play/battle/spawn-picker-logic.ts';

/**
 * The grammar both copies spelled: an OPTIONAL single-space numeric suffix,
 * anchored at the end (the `^` is built from the name at the other end).
 * Whitespace-collapsed by the helper, so this is the file's own bytes.
 */
const GRAMMAR = '(?: \\\\d+)?$';

/**
 * The escape seam (docs/17 row 300) and the SIX sites it now carries, in the
 * helper's own sorted order — a caller added or removed reds by name.
 */
const ESCAPE_SEAM = 'src/domain/escapeRegExp.ts';
const ESCAPE_SITES = [
  'src/domain/battle/board.ts',
  'src/features/rules/search-browser.tsx',
  'src/llm/campaignGrounding.ts',
  'src/llm/language.ts',
  'src/llm/promptScaffolding.ts',
  'src/llm/roomBudget.ts',
];

/**
 * The metacharacter escape CLASS as the seam spells it, the `.replace(` call
 * shape INCLUDED: the needle matches the DEFINING expression and never a doc
 * comment naming it (the helper strips comments) nor a caller that merely uses
 * the exported name. It is the EXACT bytes the six sites spelled, so a seventh
 * copy is byte-equal to the seam's own line and reds here.
 */
const ESCAPE_CLASS = 'replace(/[.*+?^${}()|[\\]\\\\]/g';

/** How every one of the six callers asks the seam. */
const ESCAPE_IMPORT = "from '@/domain/escapeRegExp'";

describe('ONE slot-label grammar, not two (SOURCE SCAN, docs/17 row 295)', () => {
  it('the anchored, optionally-numbered grammar exists in exactly ONE file', () => {
    // Non-vacuity: the glob must see the whole source tree.
    expect(Object.keys(CODE).length).toBeGreaterThan(300);
    // A reinvention at ONE call site reds here NAMING both it and the seam.
    expect(filesWith(GRAMMAR)).toEqual([SEAM]);
    // The escaping the seam uses is the ONE app-wide escape, IMPORTED — the
    // seam no longer spells the class itself (docs/17 row 300).
    expect(CODE[SEAM]?.includes(ESCAPE_CLASS)).toBe(false);
    expect(CODE[SEAM]?.includes('escapeRegExp(')).toBe(true);
  });

  it('both callers ask the seam, and neither builds a pattern of its own', () => {
    // The definition plus exactly the two callers — a THIRD caller reds by name
    // (`filesWith` is sorted, so the order is the seam file's own path order).
    expect(filesWith('matchesSlotLabel(')).toEqual([SEED, SEAM, PICKER]);
    expect(CODE[SEAM]?.match(/matchesSlotLabel\(/g)?.length, 'defined once').toBe(1);
    expect(CODE[SEED]?.match(/matchesSlotLabel\(/g)?.length, 'seeding asks once').toBe(1);
    expect(CODE[PICKER]?.match(/matchesSlotLabel\(/g)?.length, 'the picker asks once').toBe(1);
    // The pre-fold shape is GONE from both callers: no caller-side RegExp
    // construction, so a "second copy" cannot be born beside the seam.
    expect(CODE[SEED]?.includes('new RegExp(')).toBe(false);
    expect(CODE[PICKER]?.includes('new RegExp(')).toBe(false);
  });
});

describe('ONE RegExp-literal escape, not seven (SOURCE SCAN, docs/17 row 300)', () => {
  it('the escape class lives in exactly ONE src/ file — a seventh spelling reds NAMING it', () => {
    // Non-vacuity: the walk sees the whole app, and the population this pin
    // declares is the six sites the fold measured, not an empty list.
    expect(Object.keys(CODE).length).toBeGreaterThan(300);
    expect(ESCAPE_SITES).toHaveLength(6);
    // A copy ANYWHERE under `src/**` — a new file, a re-spelled call site, a
    // helper reborn beside the seam — makes this list longer and the failure
    // NAMES the offending path beside the seam's own.
    expect(filesWith(ESCAPE_CLASS)).toEqual([ESCAPE_SEAM]);
  });

  it('all six declared sites IMPORT the seam and none spells the class itself', () => {
    expect(filesWith(ESCAPE_IMPORT)).toEqual(ESCAPE_SITES);
    for (const site of ESCAPE_SITES) {
      expect(CODE[site]?.includes('escapeRegExp('), `${site} asks the seam`).toBe(true);
      expect(
        CODE[site]?.includes(ESCAPE_CLASS),
        `${site} still spells the escape class instead of asking ${ESCAPE_SEAM}`,
      ).toBe(false);
    }
    // The seam defines it once, and only once, in its own body.
    expect(CODE[ESCAPE_SEAM]?.match(/escapeRegExp\(/g)?.length, 'defined once').toBe(1);
    expect(CODE[ESCAPE_SEAM]?.includes(ESCAPE_CLASS), 'the class is IN the seam').toBe(true);
  });
});
