import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CODE } from '../helpers/sourceCode';

/**
 * THE ONE library name-matching rule (docs/17 row 248's remaining slice,
 * AGENTS §Centralization obligation 4).
 *
 * "Which library creature does this NAME mean?" is ONE algorithm: an exact
 * name comparison (`domain/creatureName.sameCreatureName`), a book
 * disambiguation when the name is ambiguous, and a citation built through the
 * ONE identity constructor (`domain/encounterResolve.contentIdentityFor`). It
 * has to answer from TWO places that cannot share a call stack — the live cast
 * (`features/modules/entity-batch.libraryCitationForEntity`) and, when a caller
 * has one, inside a Dexie transaction before the upgraded `db` instance is
 * usable — and the whole point of `domain/libraryCreature` is that they share
 * the ALGORITHM rather than each carrying a copy of it.
 *
 * The pin is a SOURCE SCAN, because the drift it catches is invisible: a second
 * copy of the name match answers identically today and diverges the day the
 * exactness rule or the disambiguation changes (the real history: a hand-rolled
 * `name.trim().toLowerCase() === wanted.toLowerCase()` in this very function
 * missed a decomposed umlaut — docs/17 row 166). The needles are the MATCH and
 * the IDENTITY CONSTRUCTION, not the function's own name, so a rename cannot
 * hide a copy.
 *
 * The source view is the shared `CODE` (`tests/helpers/sourceCode.ts`, docs/17
 * row 427): comments out, whitespace collapsed, keyed by `/`-separated repo path.
 */

const SOURCES = Object.keys(CODE);

/** Comments out, whitespace collapsed (`CODE`): the seam's own docstring NAMES
 * the rule it carries, and several callers' comments quote the comparison they
 * no longer spell. A file that is not in the tree is an error, never a zero. */
function needleCount(file: string, needle: RegExp): number {
  const body = CODE[file];
  if (body === undefined) throw new Error(`${file} is not a src/ source file`);
  return (body.match(needle) ?? []).length;
}

/** The exact name match, SPELLED as a filter over a pool. sameCreatureName is
 * the ONLY permitted spelling. */
const NAME_MATCH = /filter\(\s*\(\s*\w+\s*\)\s*=>\s*sameCreatureName\(/g;

const SEAM = 'src/domain/libraryCreature.ts';
const POOL_SEAM = 'src/db/creatureRepo.ts';
const LIVE_CALLER = 'src/features/modules/entity-batch.ts';

describe('one library name-match rule (SOURCE SCAN, docs/17 row 248)', () => {
  it('filters the pool by the one comparison in exactly one file, the seam', () => {
    // Non-vacuity: the walk sees the whole source tree, this file included.
    expect(SOURCES.length).toBeGreaterThan(300);
    expect(SOURCES).toContain(SEAM);

    const offenders = SOURCES.filter(
      (file) => file !== SEAM && needleCount(file, NAME_MATCH) > 0,
    );
    expect(offenders).toEqual([]);
    // Non-vacuity for the seam: it really carries the ONE match, so a scan that
    // matched nothing anywhere cannot pass by accident.
    expect(needleCount(SEAM, NAME_MATCH)).toBe(1);
  });

  it('builds the citation identity in the seam and nowhere else in the cast lanes', () => {
    expect(needleCount(SEAM, /contentIdentityFor\(/g)).toBe(1);
    expect(needleCount(LIVE_CALLER, /contentIdentityFor\(/g)).toBe(0);
  });

  it('routes the live cast through the seam and keeps the pool derivation single-site', () => {
    expect(needleCount(LIVE_CALLER, /libraryCitationForSlot\(/g)).toBe(1);
    // The seam is TX-CALLABLE: it takes the pool and its lookups as arguments
    // and reaches for no `db` singleton, which is what would let a Dexie
    // transaction call it.
    expect(readFileSync(SEAM, 'utf8')).not.toContain("from '@/db");
    // The POOL is derived in one place too: the repo DELEGATES to the pure
    // derivation instead of filtering and sorting a second time.
    expect(needleCount(POOL_SEAM, /libraryCreaturePool\(/g)).toBe(1);
    expect(readFileSync(POOL_SEAM, 'utf8')).not.toContain('creatures.sort(');
    // The migration that ran inside the upgrade transaction — and spelled no
    // name match of its own — was deleted by the clean cut (docs/17 row 278),
    // so the tx-caller arm of this pin has no subject left.
  });

  it('reads a candidate level through the ONE reader, INJECTED into the seam (docs/17 row 302)', () => {
    const ROSTER = 'src/llm/encounterRoster.ts';
    const filesWith = (needle: RegExp): string[] =>
      SOURCES.filter((file) => needleCount(file, needle) > 0).sort();
    // THE READER — "what level does this library creature's own stat block
    // state?" — is DEFINED once, beside the ONE grammar it composes
    // (`mobLevelText` + `parseLevelSort`), and nowhere else: a second reader is
    // how the level grammar goes plural.
    expect(filesWith(/export function libraryCreatureLevelSort\(/)).toEqual([ROSTER]);
    // ...and it is reached from exactly ONE place — the live cast wrapper, which
    // hands it to the seam as an INJECTED dependency. The injection is the
    // design: `domain/libraryCreature` may not import `llm/**` (the seam must
    // stay a tx-callable leaf, pinned above), and the level is still read
    // through the ONE grammar because the only reader handed in is this one.
    expect(filesWith(/libraryCreatureLevelSort/g)).toEqual([LIVE_CALLER, ROSTER].sort());
    // THE SEAM OWNS NO LEVEL GRAMMAR: it reads the STRUCTURED `statBlock.level`
    // field and asks the injected reader to order it, so `parseLevelSort` — and
    // every other spelling of the grammar — has no home in the resolution.
    expect(needleCount(SEAM, /parseLevelSort\(/g)).toBe(0);
    // The handoff is the argument itself, so a caller that supplied a level
    // WITHOUT the reader is the loud error the seam's own pin covers.
    expect(needleCount(LIVE_CALLER, /levelSortOf: libraryCreatureLevelSort/g)).toBe(1);
  });
});
