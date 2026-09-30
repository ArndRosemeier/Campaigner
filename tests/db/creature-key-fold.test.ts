import { describe, expect, it } from 'vitest';

import { contentCreatureKey, foldCreatureKey } from '@/domain';

/**
 * THE PERSISTED CREATURE KEY IS FOLDED (docs/17 row 168).
 *
 * `contentCreatureKey` used to mint `content:${JSON.stringify([
 * name.trim().toLowerCase(), statBlock ?? null])}` — no Unicode canonical
 * folding — and that STRING is an existing identity: a UNIQUE
 * `mobPortraits.creatureKey`, a `creatureImages` composite index, and every
 * battle key. A Mac-authored (NFD) and a precomposed (NFC) spelling of one name
 * therefore minted DIFFERENT keys: two portrait slots for one creature, and
 * "one creature, one look" (docs/11 D6) broken silently.
 *
 * The mint folds now, and `foldCreatureKey` is the SAME seam `lib/exportImport`
 * uses to fold an already-persisted key on the way in. The Dexie v22 upgrade
 * body that re-keyed stored rows was ABOLISHED by the clean cut (docs/17 row
 * 278), so these tests cover the mint and the fold seam itself.
 *
 * The fixtures block first proves composed and decomposed really are different
 * bytes, so no pin here can pass vacuously.
 */

const COMPOSED = 'Wächter'; // precomposed ä (U+00E4)
const DECOMPOSED = 'Wa\u0308chter'; // a + combining diaeresis (U+0308)

const CHUNK = '00000000-0000-4000-8000-0000000000a1';

/** The PRE-FOLD mint (docs/17 row 167: `name.trim().toLowerCase()`, no NFC) —
 * what a row written by the shipped app holds before this slice. */
function legacyContentKey(name: string, statBlock: unknown): string {
  return `content:${JSON.stringify([name.trim().toLowerCase(), statBlock ?? null])}`;
}

describe('the fixtures really are two spellings of one name', () => {
  it('composed and decomposed differ as bytes and agree only under the comparable form', () => {
    expect(COMPOSED).not.toBe(DECOMPOSED);
    expect(DECOMPOSED.normalize('NFC')).toBe(COMPOSED);
    expect(legacyContentKey(COMPOSED, null)).not.toBe(legacyContentKey(DECOMPOSED, null));
    expect(foldCreatureKey(legacyContentKey(DECOMPOSED, null))).toBe(
      contentCreatureKey(COMPOSED, null),
    );
  });
});

describe('foldCreatureKey — the migration/import seam (docs/17 row 168)', () => {
  it('folds a key minted from composed OR decomposed input to itself', () => {
    for (const name of [COMPOSED, DECOMPOSED]) {
      const key = contentCreatureKey(name, { ac: 12 });
      expect(foldCreatureKey(key)).toBe(key);
    }
  });

  it('is idempotent, and folds a legacy decomposed key onto the new mint', () => {
    const legacy = legacyContentKey(DECOMPOSED, { ac: 12 });
    const folded = foldCreatureKey(legacy);
    expect(folded).toBe(contentCreatureKey(DECOMPOSED, { ac: 12 }));
    expect(foldCreatureKey(folded)).toBe(folded);
  });

  it('a content: key minted from an ALREADY-NFC name is byte-identical before and after the fold', () => {
    // This is why the migration is a no-op for typical data: a precomposed
    // name's old key already equals its new key.
    const legacy = legacyContentKey(COMPOSED, null);
    expect(legacy).toBe(contentCreatureKey(COMPOSED, null));
    expect(foldCreatureKey(legacy)).toBe(legacy);
  });

  it('returns chunk:, artifact: and every other key space UNCHANGED', () => {
    for (const key of [`chunk:${CHUNK}`, `artifact:${CHUNK}`, 'other:thing', '']) {
      expect(foldCreatureKey(key)).toBe(key);
    }
  });

  it('throws LOUDLY for a content: key it cannot parse — never silently keeps it', () => {
    expect(() => foldCreatureKey('content:not-json')).toThrow(
      /cannot fold a content: key that is not JSON/,
    );
    expect(() => foldCreatureKey('content:{"a":1}')).toThrow(
      /cannot fold a content: key that is not a \[name, statBlock\] pair/,
    );
    expect(() => foldCreatureKey('content:[1,2]')).toThrow(
      /cannot fold a content: key that is not a \[name, statBlock\] pair/,
    );
  });
});
