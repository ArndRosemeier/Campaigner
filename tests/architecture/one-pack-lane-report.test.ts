import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE one per-lane pack report (docs/17 row 204).
 *
 * The manual-import toast, the summary dialog, the fetch toast and the book
 * card all state the SAME four lanes in the SAME wording. `sectionsImported`
 * MIXES the spell lane in, so a surface that re-spelled the arithmetic could
 * state a different spell count than the toast the owner just read — the exact
 * drift the centralization rule forbids. This SOURCE SCAN pins the call-site
 * population of the ONE formatter; the behavioural pins (docs/08 row 204)
 * assert the rendered strings agree across the surfaces.
 *
 * The scan is deliberately textual, the row-182 precedent: the shape it
 * forbids has no behavioural signature when a second copy is correct.
 */

const SRC_DIR = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out.sort();
}

/** Comments are skipped: the scan is about CODE, and the seam's own docstring
 *  names the wording it owns while explaining it. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('one per-lane pack report (SOURCE SCAN, docs/17 row 204)', () => {
  it('routes every report surface through the ONE formatter', () => {
    const files = sourceFiles(SRC_DIR);
    // Non-vacuity: the walk must see the whole tree, or it proves nothing.
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain(join(SRC_DIR, 'features', 'rules', 'pack-lanes.ts'));

    const callSites: Record<string, number> = {};
    for (const file of files) {
      const rel = relative(process.cwd(), file);
      const hits = stripComments(readFileSync(file, 'utf8')).split('formatPackLanes(').length - 1;
      if (hits > 0) callSites[rel] = hits;
    }
    // The declaration plus the report surfaces: the manual-import toast and
    // the summary dialog (`pack-import-dialog`), the fetch toast and the
    // per-recipe import-state line (`bestiary-fetch-section`, which gained its
    // second call in docs/17 row 210) and the book-card stats line
    // (`RulesPage`). A new surface that formats its own lane line, or a dropped
    // call, reds.
    expect(callSites).toEqual({
      'src/features/rules/pack-lanes.ts': 1,
      'src/features/rules/pack-import-dialog.tsx': 2,
      'src/features/settings/bestiary-fetch-section.tsx': 2,
      'src/features/rules/RulesPage.tsx': 1,
    });
  });
});
