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
      // The battle card reads a copied cast row's own block and discloses it
      // with the same composer (docs/17 row 255b).
      'db/creatureRepo.ts',
      'domain/encounterResolve.ts',
      // The legacy-read seam composes the ONE label for a MIGRATED cast row
      // (docs/17 row 248c): that disclosure moved here with the `npc-ref` arm
      // when the live resolver lost its legacy branch. It is the same composer,
      // called from the module that owns the pointer read — not a second
      // implementation, which the holder list is what guards against.
      'domain/mobCopyLegacy.ts',
      // The ONE renderer CALLS it too (docs/17 row 255b) for the copy a cast
      // row now owns: its label is the stamped `sourceLine` plus the row's own
      // name, composed by the same seam rather than re-worded in the component.
      'features/campaign/components/borrowed-stats.tsx',
    ]);
    // The COMPOSER is what must stay one (the holder list above pins every
    // caller, this pins the single definition).
    expect(files.filter((file) => source(file).includes('export function derivedStatOrigin('))).toEqual([
      'domain/encounterResolve.ts',
    ]);
    // …its own definition plus ONE call inside the rule file: the live
    // derived-stats rule (`resolveDerivedNpcStats`). The migrated-cast-row call
    // moved to the seam with the arm (docs/17 row 248c), so this count moved
    // 3→2 for the same reason the holder list grew: the ONE composer has one
    // more module calling it, never a second implementation.
    expect(occurrences(source('domain/encounterResolve.ts'), LABEL_CALL)).toBe(2);
  });

  it('scan: the repo-wired read DELEGATES to the domain rule, and every surface MOUNTS the ONE renderer', () => {
    const creatureRepo = source('db/creatureRepo.ts');
    // The wrapper supplies the library lookups and nothing else: exactly ONE
    // call of the domain rule, spelled as the delegation, with no second copy
    // of the label beside it.
    expect(occurrences(creatureRepo, DERIVED_DELEGATION), 'creatureRepo: domain-rule calls').toBe(1);
    expect(creatureRepo).toContain('return derivedNpcStats(npcName, citation, creatureLookups());');
    // The repo no longer composes the sentence itself: the ONE place it needs
    // the label — a copied cast row's battle card (docs/17 row 255b) — CALLS the
    // domain composer, whose single definition the test above pins.
    expect(creatureRepo).toContain('derivedStatOrigin(artifact.name, sourceLine)');

    // The derivation has exactly FOUR holders in `src/`: the domain rule
    // itself, the repo-wired read top code calls, the ONE component that draws
    // it, and — since docs/17 row 248c — the legacy-read seam that resolves a
    // stored `creatureRef` for a row the v24 migration could not convert. A
    // FIFTH file asking the derivation directly is a second rendering of the
    // same numbers — the duplication this pin exists to make visible.
    const holders = srcFiles().filter((file) => source(file).includes(DERIVED_READ));
    expect(holders, 'files reading the derived stats').toEqual([
      'db/creatureRepo.ts',
      'domain/encounterResolve.ts',
      'domain/mobCopyLegacy.ts',
      'features/campaign/components/borrowed-stats.tsx',
    ]);

    // Both surfaces MOUNT that component, handing it the row's own COPY and the
    // legacy pointer (docs/17 row 255b) — the renderer decides which one the row
    // actually carries.
    const editor = source('features/campaign/components/kind-forms.tsx');
    expect(editor).toContain('<BorrowedStatBlock');
    expect(editor).toContain('npcName={artifactName}');
    expect(editor).toContain('copy={{ statBlock: data.statBlock, sourceLine: data.sourceLine }}');
    expect(editor).toContain('citation={data.creatureRef}');
    const card = source('features/play/artifact-cards.tsx');
    expect(card).toContain('<BorrowedStatBlock');
    expect(card).toContain('npcName={npc.name}');
    expect(card).toContain('copy={{ statBlock: data.statBlock, sourceLine: data.sourceLine }}');
    expect(card).toContain('citation={data.creatureRef}');
    const renderers = srcFiles().filter((file) => source(file).includes(BORROWED_RENDERER));
    expect(renderers, 'files naming the borrowed-stats renderer').toEqual([
      'features/campaign/components/borrowed-stats.tsx',
      'features/campaign/components/kind-forms.tsx',
      'features/play/artifact-cards.tsx',
    ]);
  });
});
