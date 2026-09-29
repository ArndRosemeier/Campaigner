import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE one module-TITLE creation seam (docs/17 row 213, docs/18 §2).
 *
 * The owner's report: a new module was always called "New Module" because the
 * creation dialog had no Name field and sent a hard-coded literal, while the
 * domain already declared the placeholder that nothing called. The drift this
 * scan catches is invisible — a call site may re-inline `title: 'New Module'`
 * (or hand-roll the blank→placeholder rule), work today, and diverge from the
 * draft's saved value the first time the rule changes. Two mechanisms for one
 * idea is exactly what AGENTS rule 4 forbids, so the pin reds on BOTH a
 * re-inlined literal and a second resolver.
 *
 * SOURCE_FILES uses Node's own recursive `readdirSync` rather than a
 * hand-rolled `sourceFiles` walker ON PURPOSE: the duplicate-body tripwire
 * (docs/17 row 212) baselines every named helper body in the test tree, so a
 * copied walker here would be a new baselined site for no benefit, and the
 * per-file counting is inlined into the two anonymous `it` callbacks.
 */

const SRC_DIR = join(process.cwd(), 'src');

/** Every `src/**` TypeScript file, recursively, as absolute paths. */
const SOURCE_FILES: readonly string[] = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
  .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
  .map((entry) => join(SRC_DIR, entry))
  .sort();

describe('one module-title seam (SOURCE SCAN, docs/17 row 402)', () => {
  it("the 'New Module' placeholder is gone: the empty document is titled with the campaign name", () => {
    // MIGRATED (row 402): `defaultModuleTitle()` and its literal are DELETED; the ONE
    // creation input takes `campaign.name`, and `updateCampaign` is the ONE rename seam.
    for (const file of SOURCE_FILES) {
      const text = readFileSync(file, 'utf8');
      expect(text.includes('defaultModuleTitle'), relative(process.cwd(), file)).toBe(false);
      expect(text.includes("title: 'New Module'"), relative(process.cwd(), file)).toBe(false);
      expect(text.includes('resolveModuleTitle' + '('), relative(process.cwd(), file)).toBe(false);
    }
    const gen = readFileSync(join(process.cwd(), 'src/llm/moduleGen.ts'), 'utf8');
    expect(gen).toContain('title: campaign.name,');
    const repo = readFileSync(join(process.cwd(), 'src/db/campaignRepo.ts'), 'utf8');
    expect(repo).toContain('module.title === current.name');
  });
});
