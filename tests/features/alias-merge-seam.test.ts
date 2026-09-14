import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The alias-merge seam's SOURCE SCAN (docs/17 rows 121 + 123, docs/18 §2.1,
 * docs/08 §The one way to add an alias).
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
 *    so silently reverting one of the seven sites to the old shape fails even
 *    though every behavioural pin stays green.
 *
 * The SEVENTH copy (`campaign-tree.tsx`'s rename-keep-alias path) was a
 * documented SUBSET-shaped carve-out here while it was unfolded; row 122 folded
 * it, and the carve-out is DELETED rather than kept — an allowlist entry that
 * exists only because something was not folded must not outlive the fold, or it
 * silently licenses the shape it was excusing. Folding it could not turn this
 * pin red, and the fold does not: the campaign-tree file is in `FOLDED` now, so
 * both halves of the scan are strict about it (reverting the fold REDs the
 * offender pin AND the route pin).
 *
 * THE THIRD SHAPE: A HAND-ROLLED NAME COMPARISON (docs/17 row 166). The two
 * shapes above are the ALIAS-POOL spellings; this one is the same idea one tier
 * out — `creature.name.trim().toLowerCase() === wanted.toLowerCase()` and its
 * relatives, a NAME equality spelled by hand instead of through
 * `sameCreatureName`/`sameAliasName`. The app had TWENTY-TWO of them across
 * eleven files, and the one that mattered was the bestiary cast's: a
 * hand-rolled `toLowerCase` comparison does NOT fold Unicode canonical
 * composition, so a Mac-authored DECOMPOSED creature name missed a precomposed
 * library name and the cast refused a creature the library holds. Row 166
 * folded every one of them and this pin now runs over all of `src/`, so a
 * twenty-third is born red with its path named. The shape is deliberately
 * NAME-ANCHORED (it requires a name-ish operand) rather than
 * "any `===` near a `toLowerCase`", because the loose version also matches
 * comparisons that are NOT names at all — a book title (docs/17 row 161's
 * disambiguator), a tag, a keyboard key — and an allowlist of those would
 * license the shape everywhere.
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
   * A NAME equality spelled by hand instead of through the comparable form
   * (docs/17 row 166): a `.toLowerCase()` on a name read, directly beside a
   * `===`/`!==`, with a name-ish operand on the other side. Both directions are
   * covered — `creature.name.trim().toLowerCase() === wanted` and
   * `wanted.toLowerCase() === creature.name` — because the two spellings of one
   * defect are equally invisible to behaviour on ASCII input.
   *
   * WHAT IT CANNOT SEE, stated rather than implied: a comparison of two
   * ALREADY-BUILT hand-rolled keys (`const a = x.trim().toLowerCase()` …
   * `a === b`), which carries no `toLowerCase` on the comparison line. That
   * shape exists in this repo and is tracked as its own class (docs/18 §2.1,
   * the key-index note); `entityNormalization.ts` and
   * `moduleGen.applyNormalizationVerdict` were folded on it by hand for exactly
   * that reason, and their `comparableName(` COUNTS in `FOLDED` are what hold
   * them.
   */
  const NAME_OPERAND = '(?:\\.name\\b|\\.creature\\b|\\.canonical\\b|\\bname\\b|\\bName\\b|citingName|canonicalName)';
  const HAND_ROLLED_NAME_COMPARISON = new RegExp(
    `${NAME_OPERAND}[^\\n]{0,80}?\\.toLowerCase\\(\\)\\s*[!=]==` +
      `|\\.toLowerCase\\(\\)\\s*[!=]==[^\\n]{0,80}?${NAME_OPERAND}`,
  );

  /**
   * The ONLY files allowed to carry those shapes, each for a reason stated in
   * `domain/artifactAlias`'s header or in docs/18 §2.1 (path → why):
   *
   * `lib/wikilinks.ts` USED to be listed here as the RESOLVER — "it answers a
   * link against the pool, which is a different question from 'may this name
   * join the pool'". docs/17 row 162 folded it: the QUESTION is different, the
   * COMPARISON is not, and its THIRTEEN hand-rolled `toLowerCase` comparisons
   * are `sameAliasName`/`comparableName` calls now (it is in `FOLDED`
   * below, counted). The carve-out is DELETED rather than left in place, for the
   * same reason row 122 deleted the `campaign-tree.tsx` one — an allowlist entry
   * that exists only because something was not folded must not outlive the fold,
   * or it silently licenses the shape it was excusing.
   */
  const BOUNDARIES: Record<string, string> = {
    'features/campaign/components/alias-editor.tsx':
      'the FORM — it REJECTS a keystroke a person just typed (UI feedback, no row write), rather than merging a name the app decided to add',
    'db/mobPortraitCache.ts':
      'NOT a deliberate boundary — a SURVIVOR row 166 reports instead of licensing. `isCanonicalCitation` asks "is this citing name the library\'s canonical name?" with a hand-rolled comparison, and it is the portrait path docs/17 row 165 owns (another writer\'s in-flight slice): folding it here would race that landing. It is named, counted and LEFT, so the next reader meets it as a known site rather than as a ninth discovery — and folding it DELETES this entry (the row-122/row-162 move), never keeps it',
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
        ['sameAliasName(', 3],
        ['comparableName(', 1],
      ],
    },
    'llm/moduleGen.ts': { needles: [['addArtifactAliases(', 1], ['sameAliasName(', 2], ['comparableName(', 4]] },
    'features/modules/stub-popover.tsx': { needles: [['addArtifactAliases(', 1], ['sameAliasName(', 3]] },
    'features/modules/ModuleReaderPage.tsx': { needles: [['addArtifactAliases(', 1]] },
    'features/modules/entity-batch.ts': {
      needles: [
        ['mergeAliasNames(', 1],
        ['sameAliasName(', 1],
        // docs/17 row 166: the bestiary lookup. This file's creature-name
        // comparison was the LAST hand-rolled one in `src/`, and the count is
        // what reds a revert — reverting it to
        // `creature.name.trim().toLowerCase() === wanted.toLowerCase()` leaves
        // every behavioural pin green except the two composition pins, and this
        // count reds too.
        ['sameCreatureName(', 1],
      ],
    },
    'features/campaign/components/campaign-tree.tsx': {
      needles: [
        ['mergeAliasNames(', 1],
        ['sameAliasName(', 1],
      ],
    },
    // Folded by docs/17 row 162. The counts are the point: THIRTEEN hand-rolled
    // comparisons lived here, and reverting any one of them to
    // `…trim().toLowerCase() === …` must fail this pin even though behaviour
    // stays green (the two spellings agree on every ASCII input).
    'lib/wikilinks.ts': {
      needles: [
        ['sameAliasName(', 4],
        ['comparableName(', 9],
      ],
    },
    // Folded by docs/17 row 166 — every hand-rolled NAME comparison in `src/`
    // except the two files in `BOUNDARIES` above. Each count is a REVERT pin:
    // the replaced spelling and the seam call agree on every ASCII input, so no
    // behavioural pin can see one of these go back.
    'db/creatureRepo.ts': { needles: [['sameAliasName(', 1]] },
    'features/modules/entity-panel.tsx': { needles: [['sameAliasName(', 2]] },
    'domain/wikiGraph.ts': { needles: [['sameAliasName(', 1]] },
    'domain/module.ts': { needles: [['sameAliasName(', 3], ['comparableName(', 2]] },
    // Folded WHOLE, keys included: this module's every key is a name, and a
    // partial fold here neutralizes itself (a comparable-form equality answered
    // through a lowercased map key simply misses). The 23 is that whole file.
    'domain/entityNormalization.ts': { needles: [['comparableName(', 23]] },
    'llm/roomBudget.ts': { needles: [['sameAliasName(', 1]] },
    'llm/canvasChat.ts': { needles: [['sameAliasName(', 1]] },
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

  /**
   * The file's CODE, with comment lines dropped. Required for the name shape,
   * which the seam's own doc comments legitimately NAME: `domain/artifactAlias`
   * and `domain/creatureName` both quote `…trim().toLowerCase() === …` while
   * explaining why it is forbidden. Row 162 was caught by exactly this (a
   * locale pin that read comments and red on the seam's own explanation), so
   * the rule is written down once here rather than rediscovered.
   */
  const codeLines = (text: string): string =>
    text
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
      })
      .join('\n');

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
        HAND_ROLLED_COMPARISON.test(text) ||
        HAND_ROLLED_APPEND.test(text) ||
        HAND_ROLLED_NAME_COMPARISON.test(codeLines(text));
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

  it('declares every hand-rolled NAME comparison in src/ — the population, not a sample', () => {
    // NON-VACUITY for the shape above, which is the one thing a regex-based
    // scan can get wrong silently: assert that it still SEES the two declared
    // sites. A shape that matched nothing would leave the offenders pin above
    // trivially green forever.
    const seen = srcFiles().filter((file) =>
      HAND_ROLLED_NAME_COMPARISON.test(codeLines(source(file))),
    );
    expect(seen.sort()).toEqual(Object.keys(BOUNDARIES).sort());
    expect(seen).toContain('db/mobPortraitCache.ts');
    // …and the shape must still recognise the ORIGINAL spelling of the defect it
    // was written for, or it has drifted into matching something else.
    expect(
      HAND_ROLLED_NAME_COMPARISON.test(
        'const sameName = pool.filter(\n  (creature) => creature.name.trim().toLowerCase() === wanted.toLowerCase(),\n);',
      ),
    ).toBe(true);
  });

  for (const [file, { needles }] of Object.entries(FOLDED)) {
    it(`routes the alias write in ${file} through the seam`, () => {
      const text = source(file);
      for (const [needle, count] of needles) {
        const found = text.split(needle).length - 1;
        expect(found, `${file}: ${needle} call sites`).toBe(count);
      }
      // The folded file must not have kept the shape it replaced: the seam call
      // is the ONLY alias-pool comparison left in it, and — since docs/17 row
      // 166 — the only name comparison too. A hand-rolled name comparison
      // reappearing in a FOLDED file reds HERE as well as in the offenders pin,
      // which is what makes the brief's "a future hand-rolled comparison in that
      // file goes red" hold even for the files whose counts are untouched.
      expect(HAND_ROLLED_COMPARISON.test(text), `${file}: hand-rolled comparison`).toBe(false);
      expect(HAND_ROLLED_APPEND.test(text), `${file}: hand-appended pool`).toBe(false);
      expect(
        HAND_ROLLED_NAME_COMPARISON.test(codeLines(text)),
        `${file}: hand-rolled name comparison`,
      ).toBe(false);
    });
  }

  it('keeps the seam itself free of the hand-rolled shapes it exists to replace', () => {
    const text = source('domain/artifactAlias.ts');
    expect(text).toContain('export function sameAliasName');
    expect(text).toContain('export function mergeAliasNames');
    expect(HAND_ROLLED_COMPARISON.test(text)).toBe(false);
    expect(HAND_ROLLED_APPEND.test(text)).toBe(false);
    expect(HAND_ROLLED_NAME_COMPARISON.test(codeLines(text))).toBe(false);
    // The ONE creature tier is the same primitive, not a second comparison.
    expect(source('domain/creatureName.ts')).toContain(
      'return comparableName(left) === comparableName(right);',
    );
    // The write path's half of the seam names the rule it applies.
    expect(source('db/artifactRepo.ts')).toContain('mergeAliasNames(current.aliases, names, current.name)');
  });
});
