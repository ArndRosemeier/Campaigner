import { describe, expect, it } from 'vitest';

import { CODE, filesWith } from '../helpers/sourceCode';

/**
 * ONE SLOT-LABEL GRAMMAR, NOT TWO (docs/17 row 295, AGENTS rule 4 /
 * centralization obligation 2).
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
 * The metacharacter escape CLASS. It is NOT unique to this rule in `src/`
 * (four other seams escape their own patterns), so it is asserted INSIDE the
 * seam rather than by file population — the grammar needle is the one that
 * goes red when the pattern is rebuilt at a second site.
 */
const ESCAPE_CLASS = 'replace(/[.*+?^${}()|[\\]\\\\]/g';

describe('ONE slot-label grammar, not two (SOURCE SCAN, docs/17 row 295)', () => {
  it('the anchored, optionally-numbered grammar exists in exactly ONE file', () => {
    // Non-vacuity: the glob must see the whole source tree.
    expect(Object.keys(CODE).length).toBeGreaterThan(300);
    // A reinvention at ONE call site reds here NAMING both it and the seam.
    expect(filesWith(GRAMMAR)).toEqual([SEAM]);
    // ...and the escaping lives WITH the grammar, in the seam's own body.
    expect(CODE[SEAM]?.includes(ESCAPE_CLASS)).toBe(true);
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
