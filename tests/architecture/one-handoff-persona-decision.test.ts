import { describe, expect, it } from 'vitest';

import { CODE, filesWith } from '../helpers/sourceCode';

/**
 * ONE decision classifies a hand-off request's persona (docs/17 rows 374/376,
 * AGENTS rule 4 / centralization obligation 2).
 *
 * THE MEASURED DEFECT: the decision "is the live persona list loaded yet, and
 * did it yield the persona this hand-off needs?" was written out at EACH caller
 * as a lookup plus a bare `if (persona === undefined) return; // personas not
 * loaded yet`. That single line conflates two worlds — the list has not loaded
 * (wait, KEEP the request) and the list loaded with nothing to claim (a FINAL
 * answer that must raise `toastError` and CLEAR the request) — and the
 * conflation shipped TWICE: the artifact editor's refill hand-off (row 374) and
 * its illustration hand-off (row 376), each silently dropping its request.
 *
 * The cure is ONE pure seam, `features/campaign/handoffPersona
 * .resolveHandoffPersona`, whose result is a DISCRIMINATED union (loading /
 * unclaimed / claimed) rather than the bare `Persona | undefined` each caller
 * re-interpreted. Each caller keeps its OWN store and its OWN message; only the
 * classification is shared.
 *
 * The pin is a SOURCE SCAN because the drift it catches is invisible to
 * behaviour pins: a third hand-off that re-inlines the loading guard reads
 * correctly today and drops its request silently tomorrow. The source list
 * comes from Vite's own `import.meta.glob` through the ONE test-tree helper
 * (`tests/helpers/sourceCode`) — the hand-rolled walker is a BASELINED
 * multi-site population (docs/17 row 212), so a new copy of it here would be
 * the very defect this file exists to pin.
 */

const SEAM = 'src/features/campaign/handoffPersona.ts';
const PANEL = 'src/features/campaign/components/persona-panel.tsx';

describe('one hand-off persona decision (SOURCE SCAN, docs/17 rows 374/376)', () => {
  it('is DEFINED once, in its own seam', () => {
    // Non-vacuity: the glob must see the whole source tree, and the seam must
    // really carry the union it is said to own.
    expect(Object.keys(CODE).length).toBeGreaterThan(300);
    expect(filesWith('export function resolveHandoffPersona(')).toEqual([SEAM]);
    expect(filesWith('export type HandoffPersona =')).toEqual([SEAM]);
    // The `unclaimed`/`claimed` states are DECLARED in exactly one file (the
    // seam); a caller only ever COMPARES against them. (`loading` is NOT a
    // unique needle — an unrelated settings section declares its own loading
    // state — so the seam's three states are asserted on the seam's own body.)
    expect(filesWith("status: 'unclaimed'")).toEqual([SEAM]);
    expect(filesWith("status: 'claimed'")).toEqual([SEAM]);
    const seam = CODE[SEAM] ?? '';
    for (const state of ["'loading'", "'unclaimed'", "'claimed'"]) {
      expect(seam).toContain(state);
    }
  });

  it('is ASKED from EXACTLY the two hand-off effects — never re-spelled at a caller', () => {
    // The seam itself (the definition) and the panel (the two effects). A new
    // file here is a third hand-off that must be declared, not a quiet third
    // mechanism; a new site INSIDE the panel is visible in the count below.
    // `filesWith` returns SORTED paths, so the panel (`components/…`) precedes
    // the seam (`handoffPersona.ts`).
    expect(filesWith('resolveHandoffPersona(')).toEqual([PANEL, SEAM]);
    // TWO asks: the illustration hand-off and the refill hand-off.
    expect(CODE[PANEL]?.match(/resolveHandoffPersona\(/g)?.length).toBe(2);
  });

  it('neither effect re-inlines the loading guard or the raw lookup+return', () => {
    const panel = CODE[PANEL] ?? '';
    // The loading arm's signature (`if (personas === undefined) return`) is
    // spelled ONLY in the seam. The panel's remaining `personas === undefined`
    // is a placeholder's ternary (`… ? 'Loading…' : …`), which has no closing
    // `)` right after `undefined`, so a re-inlined guard reds this by name.
    expect(panel.match(/personas === undefined\)/g) ?? []).toHaveLength(0);
    // The old conflation's lookup is gone from the panel: the illustration's
    // slug lookup now happens inside the seam's `find` callback over `list`.
    expect(panel).not.toContain('personas?.find((persona) => persona.slug ===');
  });
});
