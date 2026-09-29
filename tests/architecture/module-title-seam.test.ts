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

/** Every `src/**` TypeScript file, recursively, as absolute paths. */
const SOURCE_FILES: readonly string[] = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
  .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
  .map((entry) => join(SRC_DIR, entry))
  .sort();

describe('one module-title creation seam (SOURCE SCAN)', () => {
  it('the placeholder title is defined once and only the empty-document default assigns it', () => {
    // MIGRATED (docs/17 row 395): the creation dialog and its typed Name field
    // are DELETED, so the blank->placeholder resolver (`resolveModuleTitle`) has
    // no caller and is deleted with them. Creation asks nothing: the ONE default
    // input (`emptyDocumentInput`) takes the placeholder straight from the domain.
    const definitions = new Map<string, number>();
    const literals = new Map<string, number>();
    const resolverMentions = new Map<string, number>();
    for (const file of SOURCE_FILES) {
      const text = readFileSync(file, 'utf8');
      const path = relative(process.cwd(), file);
      const defined = text.split('export function defaultModuleTitle(').length - 1;
      if (defined > 0) definitions.set(path, defined);
      const literal = text.split("title: 'New Module'").length - 1;
      if (literal > 0) literals.set(path, literal);
      const resolver = text.split('resolveModuleTitle' + '(').length - 1;
      if (resolver > 0) resolverMentions.set(path, resolver);
    }
    expect([...definitions.entries()]).toEqual([[MODULE_DOMAIN, 1]]);
    expect([...literals.entries()]).toEqual([]);
    expect([...resolverMentions.entries()]).toEqual([]);
    const gen = readFileSync(join(process.cwd(), 'src/llm/moduleGen.ts'), 'utf8');
    expect(gen).toContain('title: defaultModuleTitle(),');
  });
});
