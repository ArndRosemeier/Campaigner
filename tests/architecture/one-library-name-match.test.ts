import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

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
 * The source list is walked ITERATIVELY here on purpose: the shared
 * `sourceFiles`/`stripComments` walkers in the architecture suite are already a
 * baselined multi-site population (docs/17 row 212, 12 and 8 sites), and adding
 * a thirteenth copy of one would be the very defect this file is about.
 */

const ROOT = process.cwd();

/** Every .ts/.tsx file under src, walked with an explicit worklist so this
 * file adds no baselined scan helper body. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const pending: string[] = [join(ROOT, 'src')];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined) break;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(full);
    }
  }
  return found;
}

const SOURCES = sourceFiles();

function repoPath(full: string): string {
  return relative(ROOT, full).split(sep).join('/');
}

/** Comments out, whitespace collapsed: the seam's own docstring NAMES the rule
 * it carries, and several callers' comments quote the comparison they no longer
 * spell. */
function needleCount(file: string, needle: RegExp): number {
  const body = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');
  return (body.match(needle) ?? []).length;
}

/** The exact name match, SPELLED as a filter over a pool. sameCreatureName is
 * the ONLY permitted spelling. */
const NAME_MATCH = /filter\(\s*\(\s*\w+\s*\)\s*=>\s*sameCreatureName\(/g;

const SEAM_PATH = join(ROOT, 'src/domain/libraryCreature.ts');
const SEAM = 'src/domain/libraryCreature.ts';
const POOL_SEAM = 'src/db/creatureRepo.ts';
const LIVE_CALLER = 'src/features/modules/entity-batch.ts';

describe('one library name-match rule (SOURCE SCAN, docs/17 row 248)', () => {
  it('filters the pool by the one comparison in exactly one file, the seam', () => {
    // Non-vacuity: the walk sees the whole source tree, this file included.
    expect(SOURCES.length).toBeGreaterThan(300);
    expect(SOURCES).toContain(SEAM_PATH);

    const offenders = SOURCES.filter(
      (file) => file !== SEAM_PATH && needleCount(file, NAME_MATCH) > 0,
    ).map(repoPath);
    expect(offenders).toEqual([]);
    // Non-vacuity for the seam: it really carries the ONE match, so a scan that
    // matched nothing anywhere cannot pass by accident.
    expect(needleCount(SEAM_PATH, NAME_MATCH)).toBe(1);
  });

  it('builds the citation identity in the seam and nowhere else in the cast lanes', () => {
    expect(needleCount(join(ROOT, SEAM), /contentIdentityFor\(/g)).toBe(1);
    expect(needleCount(join(ROOT, LIVE_CALLER), /contentIdentityFor\(/g)).toBe(0);
  });

  it('routes the live cast through the seam and keeps the pool derivation single-site', () => {
    expect(needleCount(join(ROOT, LIVE_CALLER), /libraryCitationForSlot\(/g)).toBe(1);
    // The seam is TX-CALLABLE: it takes the pool and its lookups as arguments
    // and reaches for no `db` singleton, which is what would let a Dexie
    // transaction call it.
    expect(readFileSync(join(ROOT, SEAM), 'utf8')).not.toContain("from '@/db");
    // The POOL is derived in one place too: the repo DELEGATES to the pure
    // derivation instead of filtering and sorting a second time.
    expect(needleCount(join(ROOT, POOL_SEAM), /libraryCreaturePool\(/g)).toBe(1);
    expect(readFileSync(join(ROOT, POOL_SEAM), 'utf8')).not.toContain('creatures.sort(');
    // The migration that ran inside the upgrade transaction — and spelled no
    // name match of its own — was deleted by the clean cut (docs/17 row 278),
    // so the tx-caller arm of this pin has no subject left.
  });
});
