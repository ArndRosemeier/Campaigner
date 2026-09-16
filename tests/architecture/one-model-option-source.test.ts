import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE ONE account model-id option source (docs/17 row 193, docs/18 §2.3).
 * `features/settings/model-options.listModelIds` is the ONE way a model-choice
 * control turns `/models` into the free-form id list it offers; `ModelInput`'s
 * default browse list and the top-bar `ModelPicker` both go through it. A
 * second copied fetch at the picker would work today and drift the first time
 * the option list changes — exactly the duplication AGENTS rule 4 forbids —
 * and it has no behavioural signature, which is why this is a SOURCE SCAN.
 *
 * Two `listModels` callers are deliberately NOT this seam and are allowlisted
 * BY NAME with their reason: the Settings "Test key" probe (it tests the live
 * endpoint and reports the count, docs/05 §Settings) and
 * `ReasoningEffortSelect` (it needs the full `OpenRouterModel` rows for their
 * reasoning metadata, not ids). Any OTHER file calling `listModels(` reds.
 */

const SRC_DIR = join(process.cwd(), 'src');
const OPTION_SEAM = 'src/features/settings/model-options.ts';
const MODEL_INPUT = 'src/features/settings/model-input.tsx';
const MODEL_PICKER = 'src/features/settings/model-picker.tsx';

/** The allowlisted `listModels(` call sites: the transport definition plus the
 *  two deliberately-different consumers (see the header). */
const LIST_MODELS_ALLOWLIST: Record<string, number> = {
  'src/llm/openrouter.ts': 1,
  'src/features/settings/model-options.ts': 1,
  'src/features/settings/settings-section.tsx': 1,
  'src/features/settings/reasoning-effort-select.tsx': 1,
};

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
 *  names the shape it replaces while explaining it. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function countsOf(needle: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of sourceFiles(SRC_DIR)) {
    const text = stripComments(readFileSync(file, 'utf8'));
    const hits = text.split(needle).length - 1;
    if (hits > 0) counts.set(relative(process.cwd(), file), hits);
  }
  return counts;
}

describe('one account model-id option source (SOURCE SCAN, docs/17 row 193)', () => {
  it('routes every model-option list through listModelIds, and no new /models fetch exists', () => {
    const files = sourceFiles(SRC_DIR);
    // Non-vacuity: the walk must see the whole tree, or it proves nothing.
    expect(files.length).toBeGreaterThan(300);

    const calls = countsOf('listModels(');
    expect([...calls.entries()].sort()).toEqual(
      Object.entries(LIST_MODELS_ALLOWLIST).sort(),
    );

    // Non-vacuity for the seam itself: it is defined once and called.
    expect([...countsOf('export async function listModelIds(').entries()]).toEqual([
      [OPTION_SEAM, 1],
    ]);
    expect([...countsOf('listModelIds(').entries()].sort()).toEqual(
      [
        [MODEL_PICKER, 1],
        [OPTION_SEAM, 1],
      ].sort(),
    );
  });

  it('the two model-choice surfaces read the ONE seam, never listModels directly', () => {
    for (const file of [MODEL_INPUT, MODEL_PICKER]) {
      const text = stripComments(readFileSync(join(process.cwd(), file), 'utf8'));
      expect(text).toContain('listModelIds');
      expect(text).not.toContain('listModels(');
    }
  });
});
