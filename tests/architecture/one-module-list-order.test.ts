import { describe, expect, it } from 'vitest';

import { CODE, filesWith } from '../helpers/sourceCode';

/**
 * TWO ORDERS, TWO SEAMS, AND NEITHER MAY BE SWAPPED FOR THE OTHER (docs/17 row
 * 297, AGENTS rule 4 / centralization obligation 2).
 *
 * THE OWNER'S REPORT: *"Modules in a campaign right now are sorted by inverse
 * recency (the latest on top), I would like them to be sorted by start level."*
 * The modules page is how he reads the campaign ARC, and `updatedAt` is a fact
 * about his editing session, not about where a module sits in the story.
 *
 * THE SHAPE OF THE CURE, and why it is a SOURCE pin rather than a behaviour
 * one: the repo's read (`moduleRepo.listModulesByCampaign`) is documented
 * "newest first" and its order is load-bearing for SEMANTIC callers — the run
 * engine's module grounding, `moduleGen`, `canvasChat`, `orphanSweep`,
 * `artifactAutoPromote` and the campaign export. The DISPLAY lists all reach the
 * repo through ONE hook, `features/modules/hooks.useModules`, so the arc order is
 * applied THERE and only there. Behaviour pins cannot see the drift this file
 * exists for: the day someone "unifies" the two orders — moving the comparator
 * into the repo, or reinstating a recency sort in the hook — every list still
 * renders, and either the semantic callers silently change what they read or the
 * owner's order silently reverts. Both halves are asserted here, together, so
 * neither can be swapped for the other in silence. The comparator's own four
 * keys and its totality are pinned behaviourally in `tests/domain/module.test.ts`
 * and the rendered arc order on the page in
 * `tests/features/module-ui-toast.test.tsx`.
 *
 * The source list comes from Vite's own `import.meta.glob`, through the ONE
 * test-tree helper (`tests/helpers/sourceCode`) — the hand-rolled walker is a
 * BASELINED multi-site population (docs/17 row 212) and a new copy of it, or of
 * the glob normalization, would be the very defect this file exists to pin.
 */

const DOMAIN = 'src/domain/module.ts';
const HOOKS = 'src/features/modules/hooks.ts';
const REPO = 'src/db/moduleRepo.ts';

describe('ONE arc order for the module list, and the repo keeps its own (SOURCE SCAN, docs/17 row 297)', () => {
  it('DEFINES the comparator once, in the pure domain module', () => {
    // Non-vacuity: the glob must see the whole source tree.
    expect(Object.keys(CODE).length).toBeGreaterThan(300);
    expect(filesWith('export function compareModulesByStartLevel')).toEqual([DOMAIN]);
    // The four keys, IN ORDER, spelled once inside the function body: a
    // reordered or dropped key is a different list and reds here. (The doc
    // comment is stripped by the helper, so only the body matches.)
    const domain = CODE[DOMAIN] ?? '';
    const levelMin = domain.indexOf('a.levelMin - b.levelMin');
    const levelMax = domain.indexOf('a.levelMax - b.levelMax');
    const createdAt = domain.indexOf('a.createdAt - b.createdAt');
    const id = domain.indexOf('a.id.localeCompare(b.id)');
    expect(levelMin, 'the levelMin key exists').toBeGreaterThan(-1);
    expect(levelMax, 'the levelMax key exists').toBeGreaterThan(-1);
    expect(createdAt, 'the createdAt key exists').toBeGreaterThan(-1);
    expect(id, 'the id key exists').toBeGreaterThan(-1);
    expect(levelMin, 'levelMin is the FIRST key').toBeLessThan(levelMax);
    expect(levelMax, 'levelMax precedes createdAt').toBeLessThan(createdAt);
    expect(createdAt, 'createdAt precedes id').toBeLessThan(id);
  });

  it('is CALLED from exactly the ONE display seam — never from the repo or a page', () => {
    // The definition plus ONE reference. The hook hands the comparator to
    // `sort` as a VALUE (no call parens), so the reference scan is the honest
    // one; a second file holding either spelling is a second display order
    // (and, in a page file, the hand-rolled copy this arc forbids).
    expect(filesWith('compareModulesByStartLevel')).toEqual([DOMAIN, HOOKS]);
    expect(filesWith('.sort(compareModulesByStartLevel)')).toEqual([HOOKS]);
    expect(
      CODE[HOOKS]?.match(/\.sort\(compareModulesByStartLevel\)/g)?.length,
      'the hook sorts with it exactly once',
    ).toBe(1);
    // The display seam holds ONE sort and it is the comparator's: a recency
    // sort re-born beside it (the pre-297 behaviour) reds here.
    expect(CODE[HOOKS]?.match(/\.sort\(/g)?.length, 'the hook has one sort').toBe(1);
    expect(CODE[HOOKS]?.includes('updatedAt')).toBe(false);
  });

  it('leaves the repo read NEWEST FIRST — the semantic order is not the display order', () => {
    // The repo's documented contract, still spelled as its own comparator.
    expect(CODE[REPO]?.includes('return rows.map(parseModuleRow).sort((a, b) => b.updatedAt - a.updatedAt);')).toBe(
      true,
    );
    // ...and the arc comparator has NOT leaked into it: the two orders are
    // different questions, and a future reader must not "unify" them.
    expect(CODE[REPO]?.includes('compareModulesByStartLevel')).toBe(false);
  });
});
