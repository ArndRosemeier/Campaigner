import { describe, expect, it } from 'vitest';

import { mergeAliasNames, sameAliasName } from '@/domain/artifactAlias';

/**
 * The ONE alias comparison and the ONE alias merge rule (docs/17 row 121,
 * docs/18 §2.1). This file is the RULE TABLE: everything every folded call site
 * relies on, stated once, with the two decisions the fold had to make explicit —
 * the comparison trims (which is the drift that was live) and the stored
 * spelling does NOT (which is what keeps five of the six folds byte-identical).
 */
describe('sameAliasName — the ONE alias comparison', () => {
  it('forgives surrounding whitespace and case on BOTH sides', () => {
    expect(sameAliasName('Kael ', 'Kael')).toBe(true);
    expect(sameAliasName('Kael', ' kael ')).toBe(true);
    expect(sameAliasName('KAEL', 'kael')).toBe(true);
  });

  it('forgives nothing else — an interior difference is a different name', () => {
    expect(sameAliasName('Kael Ash', 'Kaelash')).toBe(false);
    expect(sameAliasName('Kael-the-Bold', 'Kael the Bold')).toBe(false);
    // No diacritic folding either: `domain/creatureName` owns that reading for
    // the creature SUGGESTION tier, and resolution itself is strict.
    expect(sameAliasName('Kâhân', 'Kahan')).toBe(false);
  });
});

describe('mergeAliasNames — the ONE alias merge rule', () => {
  it('adds a genuinely new name, keeping the caller\u2019s spelling verbatim', () => {
    expect(mergeAliasNames(['The Alchemist'], ['Kael'], 'Grix')).toEqual(['The Alchemist', 'Kael']);
    // Deliberate: the comparison trims, the ROW does not — the name is stored
    // exactly as the caller passed it (docs/17 row 121). Three of the six
    // folded sites hand this function a row's own name, and re-trimming it
    // there would change bytes for no resolution gain.
    expect(mergeAliasNames([], [' Kael '], 'Grix')).toEqual([' Kael ']);
  });

  it('never stores a duplicate — against the pool or within one batch', () => {
    expect(mergeAliasNames(['The Alchemist'], ['the alchemist'], 'Grix')).toEqual(['The Alchemist']);
    // Within the batch: the second spelling is answered by the first, which the
    // per-site `filter` versions did not check (they compared against the POOL
    // only, so one verdict listing a variant twice wrote two aliases).
    expect(mergeAliasNames([], ['Kael', 'kael', ' KAEL '], 'Grix')).toEqual(['Kael']);
    expect(mergeAliasNames(['Old'], ['New', 'OLD', 'Newer', 'new'], 'Zed')).toEqual([
      'Old',
      'New',
      'Newer',
    ]);
  });

  it('never treats the artifact\u2019s OWN name as an alias (same comparison)', () => {
    // `alias-editor.tsx` states the reason at the form: `resolveWikiLink`
    // matches the name before it looks at aliases, so such an alias could never
    // resolve. This is the check `moduleGen`'s copy of the rule lacked.
    expect(mergeAliasNames([], ['Kael'], 'Kael')).toEqual([]);
    expect(mergeAliasNames([], ['  kael '], 'KAEL')).toEqual([]);
    expect(mergeAliasNames(['The Alchemist'], ['Kael'], 'Kael')).toEqual(['The Alchemist']);
  });

  it('returns the SAME list (same reference) when nothing is added, so callers skip the write', () => {
    const existing = ['The Alchemist'];
    expect(mergeAliasNames(existing, ['the alchemist'], 'Grix')).toBe(existing);
    expect(mergeAliasNames(existing, ['Grix'], 'Grix')).toBe(existing);
    expect(mergeAliasNames(existing, [], 'Grix')).toBe(existing);
    // …and it copies when it DOES add, so a caller's snapshot is never mutated
    // behind its back (the sites patch a row from a list they already hold).
    const added = mergeAliasNames(existing, ['Kael'], 'Grix');
    expect(added).not.toBe(existing);
    expect(existing).toEqual(['The Alchemist']);
  });
});

/**
 * The live divergence the audit measured (docs/17 row 121, item 1): an existing
 * alias spelled `"Kael "` made the reader append a duplicate `"Kael"` because
 * `ModuleReaderPage.linkExisting` compared UNTRIMMED, while
 * `entity-batch.alignEntityName` compared trimmed and skipped it. Both now ask
 * this function, so the two surfaces cannot disagree.
 */
describe('the "Kael " divergence is closed — the reader and the merge AGREE', () => {
  it('a stored "Kael " already answers the name "Kael"', () => {
    const stored = ['Kael '];
    expect(mergeAliasNames(stored, ['Kael'], 'Someone Else')).toBe(stored);
    // The reader's own write path holds the same rule (the UI pin drives the
    // real click; this is the rule it must match).
    expect(sameAliasName(stored[0] ?? '', 'Kael')).toBe(true);
  });
});
