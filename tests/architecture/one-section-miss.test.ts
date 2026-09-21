import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE one pack-adapter SECTION-MISS seam (docs/17 row 294, docs/18 §2).
 *
 * Three adapters read a section out of an UPSTREAM document's own markup with a
 * VALUE pattern, and each used to return an empty value with no signal when the
 * pattern missed — so a document that HAS the section under different markup was
 * indistinguishable from one that legitimately has none (AGENTS rules 1-2).
 * `packages/types.sectionMissFailure` is THE one seam that separates ABSENCE
 * (legitimate, silent) from a MISS (ONE named `PackEntryFailure` on the import
 * report the adapters already feed).
 *
 * This is obligation 2's per-idea pin, and it is the duplicate-body tripwire's
 * complement: the tripwire only sees an IDENTICAL body at two sites, so a
 * paraphrase of the rule or of its sentence would slip past it. The needles
 * below red on the composed sentence anywhere but the seam, whatever the helper
 * is named, and the call-site population is pinned so a FOURTH family cannot
 * quietly grow its own copy.
 */

const PACKS_DIR = 'src/ingest/packs';
const SEAM_FILE = 'types.ts';
const SEAM_NAME = 'sectionMissFailure';

/**
 * The three families docs/17 row 294 names, with how many sections each asks
 * the seam about: the dnd5e "At Higher Levels" sentence, the PF2e rules
 * heightening notes, and the journal adapter's `Section:` footer plus its `pg.`
 * citation footer (two sections, one page).
 */
const CALLERS: readonly (readonly [string, number])[] = [
  ['dnd5e-foundry.ts', 1],
  ['pf2e-rules.ts', 1],
  ['pf2e-journal.ts', 2],
];

/**
 * The seam's composed sentence, in two fragments. Neither may appear anywhere
 * under `src/ingest/packs/**` but the seam file — a second composer of the
 * miss sentence (a copied helper, an inlined string) reds by file, and the
 * fragments are phrasing, not the ledger number, so an ordinary comment naming
 * docs/17 row 294 is not an offender.
 */
const SENTENCE_FRAGMENTS: readonly string[] = [
  "is present in this document's own markup, but the",
  'reader did not match it — that section was not read',
];

describe('the pack-adapter section-miss rule is the ONLY one (SOURCE SCAN)', () => {
  it('defines the ONE seam in types.ts, and proves the needles can see it', () => {
    const files = readdirSync(join(process.cwd(), PACKS_DIR))
      .filter((name) => name.endsWith('.ts'))
      .sort();
    expect(files).toContain(SEAM_FILE);

    const seam = readFileSync(join(process.cwd(), PACKS_DIR, SEAM_FILE), 'utf8');
    expect(seam.match(new RegExp(`export function ${SEAM_NAME}\\(`, 'g')) ?? []).toHaveLength(1);
    // Non-vacuity: the seam really carries BOTH sentence fragments the ban
    // below reds on, so a green scan cannot mean the needles went blind.
    for (const fragment of SENTENCE_FRAGMENTS) expect(seam).toContain(fragment);

    const offenders: string[] = [];
    for (const file of files) {
      if (file === SEAM_FILE) continue;
      const text = readFileSync(join(process.cwd(), PACKS_DIR, file), 'utf8');
      for (const fragment of SENTENCE_FRAGMENTS) {
        if (text.includes(fragment)) offenders.push(`${file}: \`${fragment}\``);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has every declared family call the ONE seam, and no other file that does', () => {
    for (const [file, calls] of CALLERS) {
      const text = readFileSync(join(process.cwd(), PACKS_DIR, file), 'utf8');
      expect(text, `${file} does not import ${SEAM_NAME} from ./types`).toMatch(
        new RegExp(`import \\{[^}]*${SEAM_NAME}[^}]*\\} from '\\./types';`),
      );
      expect(text.match(new RegExp(`${SEAM_NAME}\\(`, 'g')) ?? [], `${file}: seam call count`).toHaveLength(
        calls,
      );
    }
    // Non-vacuity at the population level: exactly the three declared families
    // use the seam, so a FOURTH family (the grep docs/17 row 294 asks for) reds
    // here instead of growing a silent private copy.
    const users = readdirSync(join(process.cwd(), PACKS_DIR))
      .filter((name) => name.endsWith('.ts') && name !== SEAM_FILE)
      .filter((name) => readFileSync(join(process.cwd(), PACKS_DIR, name), 'utf8').includes(SEAM_NAME))
      .sort();
    expect(users).toEqual(CALLERS.map(([file]) => file).sort());
  });

  it('never reports through the console (AGENTS rule 2, docs/17 row 294)', () => {
    const offenders = readdirSync(join(process.cwd(), PACKS_DIR))
      .filter((name) => name.endsWith('.ts'))
      .filter((name) =>
        /console\.(warn|error)\(/.test(readFileSync(join(process.cwd(), PACKS_DIR, name), 'utf8')),
      );
    expect(offenders).toEqual([]);
  });
});
