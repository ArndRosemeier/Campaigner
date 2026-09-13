import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The alias-merge seam's SOURCE SCAN (docs/17 row 121, docs/18 §2.1, docs/08
 * §The one way to add an alias).
 *
 * WHY A SCAN AND NOT A BEHAVIOURAL PIN. Folding six hand-rolled copies onto one
 * rule is byte-identical BY CONSTRUCTION on five of the six sites and on every
 * sanctioned path — measured yesterday on the sibling fold (docs/08, ledger
 * row 119): reverting a fold left 77 behavioural pins GREEN. Behaviour can
 * therefore never see a half-done or later-reverted fold; only the source can.
 *
 * WHAT IT ASSERTS, in two halves:
 * 1. the two hand-rolled SHAPES (a pool comparison re-stated beside the seam,
 *    and a hand-appended alias pool) exist in exactly the documented boundary
 *    files — a new caller that rolls its own trips here with its path named;
 * 2. every FOLDED file still routes its alias writes through the seam, counted,
 *    so silently reverting one of the six sites to the old shape fails even
 *    though every behavioural pin stays green.
 */
describe('the alias merge is ONE seam (SOURCE SCAN)', () => {
  /**
   * A pool comparison re-stated outside the seam: `aliases.some(...)`/
   * `aliases.filter(...)` whose body folds case somewhere in the following 200
   * characters. Bounded window rather than one line, because the copies this
   * slice folded were themselves formatted across lines (entity-batch's was).
   */
  const HAND_ROLLED_COMPARISON =
    /\.aliases\.(?:some|filter)\([\s\S]{0,200}?\.toLowerCase\(\)\s*[!=]==|\.aliases\.filter\([\s\S]{0,200}?\.toLowerCase\(\)/;
  /** A hand-appended pool: `[...aliases, x]` / `[...artifact.aliases, x]`. */
  const HAND_ROLLED_APPEND = /\[\s*\.\.\.(?:[A-Za-z_$][\w$]*\.)?aliases\s*,/;

  /**
   * The ONLY files allowed to carry those shapes, each for a reason stated in
   * `domain/artifactAlias`'s header or in docs/18 §2.1 (path → why):
   */
  const BOUNDARIES: Record<string, string> = {
    'lib/wikilinks.ts':
      'the RESOLVER — it answers a link against the pool (name first, then aliases, then scope tiers), which is a different question from "may this name join the pool"',
    'features/campaign/components/alias-editor.tsx':
      'the FORM — it REJECTS a keystroke a person just typed (UI feedback, no row write), rather than merging a name the app decided to add',
    'features/campaign/components/campaign-tree.tsx':
      'a SEVENTH copy the audit did not count (untrimmed rename-keep-alias, `:314-317`). NOT folded here on purpose — folding it is a THIRD behaviour change and the brief said to report rather than smuggle; it is named in docs/18 §5 and the landing report as the next slice',
  };

  /**
   * Every folded site, with the number of seam calls it must contain. A COUNT,
   * not `>= 1`: reverting ONE of the three `runEngine` sites (they sat 15 lines
   * apart with different shapes) must fail here.
   */
  const FOLDED: Record<string, { readonly needles: readonly [string, number][] }> = {
    'llm/runEngine.ts': {
      needles: [
        ['mergeAliasNames(', 4],
        ['sameAliasName(', 2],
      ],
    },
    'llm/moduleGen.ts': { needles: [['addArtifactAliases(', 1]] },
    'features/modules/stub-popover.tsx': { needles: [['addArtifactAliases(', 1]] },
    'features/modules/ModuleReaderPage.tsx': { needles: [['addArtifactAliases(', 1]] },
    'features/modules/entity-batch.ts': {
      needles: [
        ['mergeAliasNames(', 1],
        ['sameAliasName(', 1],
      ],
    },
  };

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

  it('leaves the hand-rolled shapes in exactly the documented boundaries (and nowhere else)', () => {
    const files = srcFiles();
    // Non-vacuity: the walk must actually see the app, or this pin proves
    // nothing about it.
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('llm/runEngine.ts');

    const offenders: string[] = [];
    const seenBoundaries = new Set<string>();
    for (const file of files) {
      const text = source(file);
      const handRolled =
        HAND_ROLLED_COMPARISON.test(text) || HAND_ROLLED_APPEND.test(text);
      if (!handRolled) continue;
      if (file in BOUNDARIES) {
        seenBoundaries.add(file);
        continue;
      }
      offenders.push(file);
    }
    expect(offenders, 'hand-rolled alias merge outside the seam').toEqual([]);
    // …and each boundary still exists as a copy, so this allowlist cannot rot
    // into a list of files that no longer need it.
    expect([...seenBoundaries].sort()).toEqual(Object.keys(BOUNDARIES).sort());
  });

  for (const [file, { needles }] of Object.entries(FOLDED)) {
    it(`routes the alias write in ${file} through the seam`, () => {
      const text = source(file);
      for (const [needle, count] of needles) {
        const found = text.split(needle).length - 1;
        expect(found, `${file}: ${needle} call sites`).toBe(count);
      }
      // The folded file must not have kept the shape it replaced: the seam call
      // is the ONLY alias-pool comparison left in it.
      expect(HAND_ROLLED_COMPARISON.test(text), `${file}: hand-rolled comparison`).toBe(false);
      expect(HAND_ROLLED_APPEND.test(text), `${file}: hand-appended pool`).toBe(false);
    });
  }

  it('keeps the seam itself free of the hand-rolled shapes it exists to replace', () => {
    const text = source('domain/artifactAlias.ts');
    expect(text).toContain('export function sameAliasName');
    expect(text).toContain('export function mergeAliasNames');
    expect(HAND_ROLLED_COMPARISON.test(text)).toBe(false);
    expect(HAND_ROLLED_APPEND.test(text)).toBe(false);
    // The write path's half of the seam names the rule it applies.
    expect(source('db/artifactRepo.ts')).toContain('mergeAliasNames(current.aliases, names, current.name)');
  });
});
