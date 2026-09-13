import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A cited row's BORROWED numbers are derived by ONE rule and drawn by ONE
 * component (docs/17 row 134, docs/18 §2/§4).
 *
 * WHY A SOURCE SCAN HERE, AND NOT ONLY BEHAVIOURAL PINS. Folding two spellings
 * of one rule into one seam is byte-identical BY CONSTRUCTION: before this
 * slice `db/creatureRepo.resolveDerivedNpcStats` and
 * `domain/encounterResolve.resolveMonsterEntry`'s `npc-ref` arm each composed
 * the same `derivedStatOrigin(npcName, creatureOrigin)` label, so no
 * behavioural pin could tell the folded tree from the unfolded one — the same
 * measurement this repo has now recorded on its sibling folds (docs/08). The
 * scan is what holds the ROUTING: the label is composed in exactly one file,
 * the domain rule has exactly one caller outside it, and the rendering exists
 * in exactly one component that every surface MOUNTS rather than
 * re-implements.
 *
 * THE SCAN IS TEXTUAL, and its limits are stated rather than implied: it
 * cannot see a copy that a template literal or a concatenation splits, and it
 * cannot see a second derivation reached through a FUNCTION CALL in another
 * module that does not name the seam. What it does see is the shape every
 * previous drift on this repo actually took (a re-inlined expression, a second
 * component asking the derivation directly).
 */

/** The label composer, as a CALL — a doc mention without parentheses is not a composition. */
const LABEL_CALL = 'derivedStatOrigin(';
/** The repo-wired read of the ONE rule, as a CALL. */
const DERIVED_READ = 'resolveDerivedNpcStats(';
/** The domain rule's local alias inside the repo wrapper, as a CALL. */
const DERIVED_DELEGATION = 'derivedNpcStats(';
/** The ONE component that draws borrowed numbers. */
const BORROWED_RENDERER = 'BorrowedStatBlock';

function srcFiles(): string[] {
  const root = join(process.cwd(), 'src');
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      found.push(full.slice(root.length + 1).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return found.sort();
}

const source = (file: string): string => readFileSync(join(process.cwd(), 'src', file), 'utf8');
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

describe('a cited row’s borrowed numbers are ONE rule and ONE render (SOURCE SCAN)', () => {
  it('scan: the derived-stats label is composed in the domain rule ALONE', () => {
    const files = srcFiles();
    // Non-vacuity: the walk must actually see the app, and the needle must
    // actually match the holder, or this pin proves nothing about either.
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('domain/encounterResolve.ts');
    expect(files).toContain('db/creatureRepo.ts');

    const holders = files.filter((file) => source(file).includes(LABEL_CALL));
    expect(holders, 'files composing the derived-stats label').toEqual([
      'domain/encounterResolve.ts',
    ]);
    // …its own definition plus exactly ONE call, inside the one rule.
    expect(occurrences(source('domain/encounterResolve.ts'), LABEL_CALL)).toBe(2);
  });

  it('scan: the repo-wired read DELEGATES to the domain rule, and every surface MOUNTS the ONE renderer', () => {
    const creatureRepo = source('db/creatureRepo.ts');
    // The wrapper supplies the library lookups and nothing else: exactly ONE
    // call of the domain rule, spelled as the delegation, with no second copy
    // of the label beside it.
    expect(occurrences(creatureRepo, DERIVED_DELEGATION), 'creatureRepo: domain-rule calls').toBe(1);
    expect(creatureRepo).toContain('return derivedNpcStats(npcName, citation, creatureLookups());');
    expect(creatureRepo.includes(LABEL_CALL), 'creatureRepo composes the label itself').toBe(false);

    // The derivation has exactly THREE holders in `src/`: the domain rule
    // itself, the repo-wired read top code calls, and the ONE component that
    // draws it. A FOURTH file asking the derivation directly is a second
    // rendering of the same numbers — the duplication this pin exists to make
    // visible.
    const holders = srcFiles().filter((file) => source(file).includes(DERIVED_READ));
    expect(holders, 'files reading the derived stats').toEqual([
      'db/creatureRepo.ts',
      'domain/encounterResolve.ts',
      'features/campaign/components/borrowed-stats.tsx',
    ]);

    // Both surfaces MOUNT that component, with the row's own citation.
    expect(source('features/campaign/components/kind-forms.tsx')).toContain(
      '<BorrowedStatBlock npcName={artifactName} citation={data.creatureRef} />',
    );
    expect(source('features/play/artifact-cards.tsx')).toContain(
      '<BorrowedStatBlock npcName={npc.name} citation={data.creatureRef} />',
    );
    const renderers = srcFiles().filter((file) => source(file).includes(BORROWED_RENDERER));
    expect(renderers, 'files naming the borrowed-stats renderer').toEqual([
      'features/campaign/components/borrowed-stats.tsx',
      'features/campaign/components/kind-forms.tsx',
      'features/play/artifact-cards.tsx',
    ]);
  });
});
