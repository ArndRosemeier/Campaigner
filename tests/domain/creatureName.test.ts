import { describe, expect, it } from 'vitest';

import {
  creatureNameSimilarity,
  creatureNameTokens,
  normalizeCreatureName,
  sameCreatureName,
} from '@/domain/creatureName';

/**
 * The MESSAGE-ONLY name arithmetic of the cast refusal (docs/17 row 114).
 *
 * Two rules are load-bearing here and both are about NOT widening resolution:
 * `sameCreatureName` is the strict comparison the cast applies, and
 * `creatureNameSimilarity` is the loose one that only ever chooses what a
 * refusal says. The owner's failing module asked for `Zombie-Schläger` and
 * `Zombie-Schlurfer` against a German library; a suggestion that ignored
 * hyphens, umlauts or case would have been as useless as no suggestion at all.
 */
describe('creature name normalization (docs/17 row 114)', () => {
  it('forgives case, surrounding whitespace and hyphen-vs-space', () => {
    expect(normalizeCreatureName('  ZOMBIE  ')).toBe('zombie');
    // A hyphen is punctuation like any other: it collapses to the SAME single
    // space, so "Zombie-Schläger" and "zombie schlager" are one name.
    expect(normalizeCreatureName('Zombie-Schläger')).toBe('zombie schlager');
    expect(normalizeCreatureName('Zombie Schlager')).toBe(normalizeCreatureName('zombie-schlager'));
  });

  it('folds umlauts and other diacritics to their ASCII letters', () => {
    expect(normalizeCreatureName('Schläger')).toBe('schlager');
    expect(normalizeCreatureName('Schläger')).toBe(normalizeCreatureName('Schlager'));
    expect(normalizeCreatureName('Æther Wraith')).toBe('aether wraith');
    expect(normalizeCreatureName('Kâhân')).toBe(normalizeCreatureName('Kahan'));
  });

  it('drops a trailing parenthesized qualifier a library heading may carry', () => {
    expect(normalizeCreatureName('Zombie (variant)')).toBe('zombie');
    expect(normalizeCreatureName('Zombie (Ogre Zombie)')).toBe('zombie');
    // …and does not confuse the qualifier's own words with the name.
    expect(normalizeCreatureName('Zombie (variant)')).not.toBe(normalizeCreatureName('Zombie Ogre'));
  });

  it('keeps punctuation out of the comparison but not the words around it', () => {
    expect(normalizeCreatureName("The Miller's Daughter")).toBe('the miller s daughter');
    expect(normalizeCreatureName('St. Cuthbert')).toBe('st cuthbert');
  });

  it('normalizes an empty or punctuation-only name to nothing', () => {
    expect(normalizeCreatureName('')).toBe('');
    expect(normalizeCreatureName('   ')).toBe('');
    expect(normalizeCreatureName('—')).toBe('');
  });
});

describe('the strict name comparison stays the resolution rule', () => {
  it('matches on trim + case-fold only, never on normalization', () => {
    expect(sameCreatureName('Zombie ', 'zombie')).toBe(true);
    expect(sameCreatureName('ZOMBIE', 'zombie')).toBe(true);
    // The LOOSE reading must never answer the strict question: an umlaut
    // difference, a hyphen difference and a qualifier are all MISSES.
    expect(sameCreatureName('Zombie-Schläger', 'Zombie Schlager')).toBe(false);
    expect(sameCreatureName('Zombie (variant)', 'Zombie')).toBe(false);
    expect(sameCreatureName('Schläger', 'Schlager')).toBe(false);
  });

  it('tokenizes a normalized name, in order', () => {
    expect(creatureNameTokens('Zombie-Schläger der Stufe 1')).toEqual([
      'zombie',
      'schlager',
      'der',
      'stufe',
      '1',
    ]);
    expect(creatureNameTokens('  ')).toEqual([]);
  });
});

describe('creature name similarity is a suggestion score, never a match', () => {
  it('scores an exact name 1 and an unrelated name low', () => {
    expect(creatureNameSimilarity('Zombie', 'zombie')).toBe(1);
    expect(creatureNameSimilarity('Zombie', 'Ancient Red Dragon')).toBeLessThan(0.3);
  });

  it('rates a hyphen/umlaut variant above its base name', () => {
    const near = creatureNameSimilarity('Zombie-Schläger', 'Zombie Schlager');
    const far = creatureNameSimilarity('Zombie-Schläger', 'Ancient Red Dragon');
    expect(near).toBe(1);
    expect(near).toBeGreaterThan(far);
  });

  it('rates a spelling variant of one word close (a typo the refusal should name)', () => {
    expect(creatureNameSimilarity('Zombis', 'Zombie')).toBeGreaterThan(0.6);
    expect(creatureNameSimilarity('Zombie-Schlägerin', 'Zombie-Schläger')).toBeGreaterThan(0.85);
  });

  it('does not let a shared article carry a suggestion', () => {
    // "the" alone must not make two unrelated creatures look close: token
    // overlap over a 2-vs-4 word name is 1/5, and the edit distance is large.
    expect(creatureNameSimilarity('The Miller', "The Ancient Red Dragon")).toBeLessThan(0.4);
  });

  it('scores a padded query the same as its unpadded form (whitespace is not signal)', () => {
    expect(creatureNameSimilarity('  zombie ', 'Zombie')).toBe(
      creatureNameSimilarity('zombie', 'Zombie'),
    );
  });

  it('returns 0 for an empty side, never a division artifact', () => {
    expect(creatureNameSimilarity('', 'Zombie')).toBe(0);
    expect(creatureNameSimilarity('Zombie', '—')).toBe(0);
  });
});
