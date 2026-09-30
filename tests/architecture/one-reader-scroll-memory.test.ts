import { describe, expect, it } from 'vitest';

import { CODE, filesWith } from '../helpers/sourceCode';

/**
 * ONE reader position MEMORY, and ONE `#part-<n>` GRAMMAR (docs/17 row 305,
 * AGENTS rule 4 / centralization obligation 2).
 *
 * TWO POPULATIONS, both pinned as SOURCE rather than only as behaviour —
 * behaviour cannot see the drift either one exists to prevent: copies agree on
 * every fixture until the day one of them is edited.
 *
 * 1. THE MEMORY. Nothing in `src/` remembered a scroll position before this
 *    row (`scrollTop` / `sessionStorage` / `scrollRestoration` were zero hits),
 *    so `features/modules/readerScroll` is a NEW single-site seam and this arm
 *    declares its population: one definition, one caller (the reader). A second
 *    store for the same idea — the "third shape" the brief forbids — reds here
 *    BY FILE.
 *
 * 2. THE GRAMMAR. `canvasScope.resolveCanvasScrollTarget` exists for the
 *    reader's own `#part-<n>` hash (its doc calls the hash the reader's, and
 *    `CanvasPage` reads it through that resolver), yet `ModuleReaderPage`
 *    spelled the pattern AGAIN inline — `/^#part-(\d+)$/.exec(location.hash)`.
 *    Two spellings of one navigation grammar, so a change to one would silently
 *    change where a quick-find deep link lands on the other surface. Both
 *    surfaces now ask the ONE exported resolver.
 */

const MEMORY = 'src/features/modules/readerScroll.ts';
const READER = 'src/features/modules/ModuleReaderPage.tsx';

/** The pattern as the file's own bytes spell it (comments stripped). */
const GRAMMAR = '^#part-(\\d+)$';
const GRAMMAR_SEAM = 'src/features/modules/canvas/canvasScope.ts';
const CANVAS_PAGE = 'src/features/modules/canvas/CanvasPage.tsx';
const RESOLVER_CALLERS = [READER, CANVAS_PAGE, GRAMMAR_SEAM];

describe('ONE reader position memory, not two (SOURCE SCAN, docs/17 row 305)', () => {
  it('the memory is defined once and the reader is its only caller', () => {
    // Non-vacuity: the glob must see the whole source tree.
    expect(Object.keys(CODE).length).toBeGreaterThan(300);
    expect(filesWith('rememberReaderScroll(')).toEqual([READER, MEMORY]);
    expect(filesWith('recallReaderScroll(')).toEqual([READER, MEMORY]);
    // The reset exists for test isolation only: nothing in `src/` calls it.
    expect(filesWith('resetReaderScroll(')).toEqual([MEMORY]);
    // The reader captures into and restores from THAT memory, not a local copy.
    expect(CODE[READER]?.includes('container.scrollTop = recallReaderScroll(')).toBe(true);
    expect(CODE[READER]?.includes('rememberReaderScroll(moduleId, container.scrollTop)')).toBe(true);
  });
});

describe('ONE #part-<n> grammar, not two (SOURCE SCAN, docs/17 row 305)', () => {
  it('the part-hash pattern exists in exactly ONE src/ file', () => {
    expect(Object.keys(CODE).length).toBeGreaterThan(300);
    // A re-spelled inline copy at the reader reds here NAMING both files.
    expect(filesWith(GRAMMAR)).toEqual([GRAMMAR_SEAM]);
    expect(CODE[GRAMMAR_SEAM]?.includes(GRAMMAR)).toBe(true);
    expect(CODE[READER]?.includes(GRAMMAR)).toBe(false);
  });

  it('both surfaces ask the exported resolver, and its caller set is declared', () => {
    expect(filesWith('resolveCanvasScrollTarget(')).toEqual(RESOLVER_CALLERS);
    expect(CODE[READER]?.includes('resolveCanvasScrollTarget(')).toBe(true);
    expect(CODE[CANVAS_PAGE]?.includes('resolveCanvasScrollTarget(')).toBe(true);
  });
});
