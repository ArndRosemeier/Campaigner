import { describe, expect, it } from 'vitest';

import { CODE, filesWith } from '../helpers/sourceCode';

/**
 * THE ONE BOOK-REMOVAL SEAM (docs/17 row 369, AGENTS §Centralization
 * obligation 2).
 *
 * The row-369 fix makes the removal the Rules page already had REACHABLE from a
 * failed PACK import — and the temptation it must not give in to is a second
 * destructive path "just for the failure card". A hand-rolled delete is
 * correct where it is written and invisible afterwards: `deleteRulebook` is ONE
 * transaction over the chunks, the retained PDF bytes and the book row, with no
 * refcount, no in-use check and no status gate, which is exactly why it already
 * reclaims a PARTIAL pack. A second spelling could delete the row while
 * orphaning 500 chunks, and no behavioural pin would notice unless it happened
 * to build that exact state.
 *
 * This pin declares the population instead of trusting discipline:
 * `db.rulebooks.delete(` and `deleteChunksByBook(` exist in exactly ONE place
 * each, and `deleteRulebook(` is DECLARED in the repo module and CALLED from
 * exactly the one confirm dialog every destructive affordance opens (the card's
 * trash icon, the menu's `Delete`, and the failed pack's `Remove failed import…`
 * — all three are `setMenuAction('delete')`).
 *
 * A NEW call site reds naming the file; the source list comes from
 * `tests/helpers/sourceCode` (the ONE glob/needle seam), so this pin adds no
 * ninth copy of the walker.
 */
describe('one book-removal seam (SOURCE SCAN, docs/17 row 369)', () => {
  it('keeps the book row, its chunk cascade and the retained bytes in ONE transaction', () => {
    // Non-vacuity: the glob sees the whole source tree.
    expect(Object.keys(CODE).length).toBeGreaterThan(300);

    // The ROW delete and the CHUNK cascade each have exactly one home, and it
    // is `deleteRulebook`'s transaction.
    expect(filesWith('db.rulebooks.delete(')).toEqual(['src/db/rulebookRepo.ts']);
    expect(filesWith('deleteChunksByBook(')).toEqual([
      'src/db/chunkRepo.ts',
      'src/db/rulebookRepo.ts',
    ]);
  });

  it('routes every destructive affordance through the ONE deleteRulebook call site', () => {
    // DECLARATION (the repo) + CALL (the shared confirm dialog). A removal
    // implemented inside `RulesPage` — or a second dialog — reds here by name,
    // which is the arm the behavioural pins cannot see when the hand-rolled
    // delete happens to be complete.
    expect(filesWith('deleteRulebook(')).toEqual([
      'src/db/rulebookRepo.ts',
      'src/features/rules/book-dialogs.tsx',
    ]);

    // The failed pack's `Remove failed import…` therefore cannot be a second
    // destructive control: the card page names no delete seam of its own.
    const rulesPage = CODE['src/features/rules/RulesPage.tsx'] ?? '';
    expect(rulesPage).toContain('remove-book-');
    expect(rulesPage).not.toContain('rulebooks.delete(');
    expect(rulesPage).not.toContain('deleteChunksByBook(');
  });
});
