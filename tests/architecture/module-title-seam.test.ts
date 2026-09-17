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
const MODULE_DOMAIN = 'src/domain/module.ts';
const NEW_MODULE_DIALOG = 'src/features/modules/new-module-dialog.tsx';

/** Every `src/**` TypeScript file, recursively, as absolute paths. */
const SOURCE_FILES: readonly string[] = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
  .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
  .map((entry) => join(SRC_DIR, entry))
  .sort();

describe('one module-title creation seam (SOURCE SCAN)', () => {
  it('defines the ONE resolver, and the dialog calls it from both writers', () => {
    // "The typed name becomes a module title" is written down once.
    const definitions = new Map<string, number>();
    const calls = new Map<string, number>();
    for (const file of SOURCE_FILES) {
      const text = readFileSync(file, 'utf8');
      const path = relative(process.cwd(), file);
      const defined = text.split('export function resolveModuleTitle(').length - 1;
      if (defined > 0) definitions.set(path, defined);
      const called = text.split('resolveModuleTitle(').length - 1;
      if (called > 0) calls.set(path, called);
    }
    expect([...definitions.entries()]).toEqual([[MODULE_DOMAIN, 1]]);
    // The dialog calls it from EXACTLY the two places that turn the field into
    // a title: the persisted draft's saved value, and the `NewModule` input
    // `createModuleAndRun` receives. A third caller would mean a new mechanism;
    // a dropped one means the two values can disagree.
    expect([...calls.entries()]).toEqual([
      [MODULE_DOMAIN, 1],
      [NEW_MODULE_DIALOG, 2],
    ]);
  });

  it('never re-inlines the placeholder as a title literal in the dialog', () => {
    // THE pin that reds if the fold is quietly undone: the dialog may mention
    // "New Module" in its title/toast copy, but it must not ASSIGN it as a
    // module title. The placeholder comes from the domain seam.
    const dialog = readFileSync(join(process.cwd(), NEW_MODULE_DIALOG), 'utf8');
    expect(dialog).not.toContain("title: 'New Module'");
    expect(dialog).not.toContain('title: "New Module"');
    expect(dialog).toContain('defaultModuleTitle()');
  });
});
