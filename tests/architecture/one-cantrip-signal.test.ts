import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE one PF2e cantrip signal (docs/17 row 189, docs/18 §2.1). A cantrip is
 * the source's own `cantrip` TRAIT — a cantrip and a rank-1 spell BOTH store
 * `system.level.value: 1`, so the level is never the signal (docs/17 row 181).
 * The rules lane reads it twice (rank normalization to 0 for list order, and
 * the printed "Cantrip" label) and the bestiary lane reads it to stamp a
 * cantrip with NO cast rank (docs/17 row 184's assignment contract), so the
 * predicate is folded into ONE `domain/spellData.spellTraitsAreCantrip`.
 *
 * The pin is a SOURCE SCAN because the drift it catches is invisible: a second
 * hand-spelled `.includes('cantrip')` answers identically today and diverges
 * the day the signal changes — the exact class AGENTS' centralization rule
 * asks for a pin rather than discipline.
 */

const SRC_DIR = join(process.cwd(), 'src');
const SEAM = 'src/domain/spellData.ts';
const NEEDLE = ".includes('cantrip')";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out.sort();
}

/** Comments are skipped: the seam's own docstring NAMES the shape it replaces. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('one cantrip signal (SOURCE SCAN, docs/17 row 189)', () => {
  it('reads the `cantrip` trait in exactly one place', () => {
    const files = sourceFiles(SRC_DIR);
    // Non-vacuity: the walk must see the whole tree, or it proves nothing.
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain(join(SRC_DIR, 'domain', 'spellData.ts'));

    const offenders: string[] = [];
    let seamHits = 0;
    for (const file of files) {
      const rel = relative(process.cwd(), file);
      const text = stripComments(readFileSync(file, 'utf8'));
      const hits = text.split(NEEDLE).length - 1;
      if (hits === 0) continue;
      if (rel === SEAM) {
        seamHits += hits;
        continue;
      }
      offenders.push(`${rel} (${String(hits)})`);
    }
    expect(offenders).toEqual([]);
    expect(seamHits).toBe(1);
  });

  it('routes both PF2e lanes through the ONE predicate', () => {
    for (const consumer of ['src/ingest/packs/pf2e-rules.ts', 'src/ingest/packs/pf2e-foundry.ts']) {
      const source = readFileSync(join(process.cwd(), consumer), 'utf8');
      expect(source).toContain('spellTraitsAreCantrip(');
      expect(source).toMatch(/from '@\/domain\/spellData'/);
    }
  });
});
