import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { namesUnder } from '../helpers/sourceCode';

/**
 * THE one pack-adapter promise seam (docs/17 row 214, docs/18 §2).
 *
 * `PackAdapter.parseFile` is promise-based, but each adapter's real parsing is
 * its own synchronous `parseFileSync`, so all seven hand-wrote the same
 * resolve/reject wrapper. The duplicate-body tripwire (docs/17 row 172)
 * baselined those seven copies as group `4849c733c9136aa8`; row 214 folds them
 * into `types.asPackFileParser`.
 *
 * This scan is obligation 2's per-idea pin, and it is the tripwire's complement
 * rather than its duplicate: the tripwire only sees a wrapper that comes back
 * VERBATIM at TWO sites (a rename included), so a SINGLE adapter re-spelling
 * the wrapper — or a paraphrase of it — would slip past. These needles red on
 * the wrapper's two load-bearing lines in any pack file but the seam, whatever
 * the function is named.
 *
 * It reads the directory through the ONE tree walk (`repoFiles`, docs/17 row
 * 427) rather than a walker of its own.
 */

const PACKS_DIR = 'src/ingest/packs';
const SEAM_FILE = 'types.ts';
/** The pack directory's `.ts` files, by name (the ONE tree walk, docs/17 row 427). */
const PACK_FILES = namesUnder(PACKS_DIR, ['.ts']);
const SEAM_NAME = 'asPackFileParser';

/**
 * The seven adapters that wrap their own `parseFileSync` — the seven sites the
 * tripwire group held before the fold (docs/17 row 214).
 */
const ADAPTERS: readonly string[] = [
  'dnd5e-equipment.ts',
  'dnd5e-foundry.ts',
  'pf2e-conditions.ts',
  'pf2e-equipment.ts',
  'pf2e-foundry.ts',
  'pf2e-journal.ts',
  'pf2e-rules.ts',
];

/**
 * The wrapper's two load-bearing lines, plus the retired declaration spelling.
 * `Promise.resolve(parseFileSync` is the resolve arm; the `instanceof Error`
 * ternary is the rejection arm — a copy of EITHER reds, so a re-spelled wrapper
 * cannot hide behind a rename.
 */
const WRAPPER_SHAPES: readonly string[] = [
  'Promise.resolve(parseFileSync',
  'instanceof Error ? error : new Error(String(error))',
  'function parseFile(',
];

describe('the pack-adapter promise wrapper is the ONLY one (SOURCE SCAN)', () => {
  it('defines the ONE seam in types.ts, and proves the needles can see it', () => {
    const files = PACK_FILES
      .sort();
    // Non-vacuity: the walk must see the whole directory (7 adapters + the
    // seam + text.ts + registry.ts), or this proves nothing about it.
    expect(files).toHaveLength(10);
    expect(files).toContain(SEAM_FILE);

    const seam = readFileSync(join(process.cwd(), PACKS_DIR, SEAM_FILE), 'utf8');
    expect(seam.match(new RegExp(`export function ${SEAM_NAME}\\(`, 'g')) ?? []).toHaveLength(1);
    // Non-vacuity for the ban below: the seam really carries BOTH arms the
    // needles red on — the resolve of the sync result and the non-Error rewrap.
    expect(seam).toContain('Promise.resolve(parseFileSync(fileName, bytes))');
    expect(seam).toContain('instanceof Error ? error : new Error(String(error))');

    const offenders: string[] = [];
    for (const file of files) {
      if (file === SEAM_FILE) continue;
      const text = readFileSync(join(process.cwd(), PACKS_DIR, file), 'utf8');
      for (const shape of WRAPPER_SHAPES) {
        if (text.includes(shape)) offenders.push(`${file}: \`${shape}\``);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has every adapter call the ONE seam, and no other file that does', () => {
    expect(ADAPTERS).toHaveLength(7);
    for (const file of ADAPTERS) {
      const text = readFileSync(join(process.cwd(), PACKS_DIR, file), 'utf8');
      expect(text, `${file} does not import ${SEAM_NAME} from ./types`).toMatch(
        new RegExp(`import \\{[^}]*${SEAM_NAME}[^}]*\\} from '\\./types';`),
      );
      const calls = text.match(new RegExp(`${SEAM_NAME}\\(parseFileSync\\)`, 'g')) ?? [];
      expect(calls.length, `${file}: seam call count`).toBe(1);
    }
    // Non-vacuity at the population level: exactly those seven files use the
    // seam, so an EIGHTH user — a new adapter that re-spelled the wrapper, or a
    // non-adapter file reaching for it — reds here rather than being missed.
    const users = PACK_FILES
      .filter((name) => name !== SEAM_FILE)
      .filter((name) =>
        readFileSync(join(process.cwd(), PACKS_DIR, name), 'utf8').includes(SEAM_NAME),
      )
      .sort();
    expect(users).toEqual([...ADAPTERS].sort());
  });
});
