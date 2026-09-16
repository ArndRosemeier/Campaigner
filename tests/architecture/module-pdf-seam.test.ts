import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE one module-PDF export control (docs/17 rows 108/139/185, docs/18 §2).
 *
 * `features/modules/module-pdf-button.tsx` is the ONE control that plans and
 * prints the module book: one press, one model call, the audience an explicit
 * option of the ONE builder, the same two documents everywhere. It mounts from
 * THREE module surfaces — the canvas header, the campaign tree's module-group
 * header and (row 185) the module reader header — and every mount is the SAME
 * component, never a per-surface copy.
 *
 * The pin is a SOURCE SCAN because a copied menu renders identically: a second
 * `DropdownMenuItem` spelling "GM document …" in a second file is invisible to
 * every behavioural test today and drifts the moment one label, one audience
 * or one filename changes. The needles are the two audience LABELS in full
 * (with their em dash, which is also what separates them from `lib/modulePdf`'s
 * own prose "the GM document"): re-spelling a menu anywhere else reds by file
 * and count. The second half holds the MOUNT population, so a fourth copy of
 * `<ModulePdfButton …>` — or a reader that defines its own menu instead of
 * importing the shared component — reds by file.
 */

const SRC_DIR = join(process.cwd(), 'src');
const BUTTON = 'src/features/modules/module-pdf-button.tsx';
const READER = 'src/features/modules/ModuleReaderPage.tsx';

/** The two audiences, exactly as the ONE control declares them. */
const GM_LABEL = 'GM document — premise, part plan, parts, artifacts, maps, gallery, treasure';
const PLAYER_LABEL = 'Player document — the same book without the planning or the secrets';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out.sort();
}

function countsOf(needle: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of sourceFiles(SRC_DIR)) {
    const hits = readFileSync(file, 'utf8').split(needle).length - 1;
    if (hits > 0) counts.set(relative(process.cwd(), file), hits);
  }
  return counts;
}

describe('one module-PDF control, three surfaces (SOURCE SCAN)', () => {
  it('declares each audience label exactly once, in module-pdf-button.tsx', () => {
    for (const label of [GM_LABEL, PLAYER_LABEL]) {
      const counts = countsOf(label);
      expect([...counts.keys()]).toEqual([BUTTON]);
      expect(counts.get(BUTTON)).toBe(1);
    }
  });

  it('mounts the ONE control from the three module surfaces, the reader through the shared import', () => {
    const mountSites = sourceFiles(SRC_DIR)
      .filter((file) => readFileSync(file, 'utf8').includes('<ModulePdfButton'))
      .map((file) => relative(process.cwd(), file));
    expect(mountSites).toEqual([
      'src/features/campaign/components/campaign-tree.tsx',
      'src/features/modules/ModuleReaderPage.tsx',
      'src/features/modules/canvas/CanvasPage.tsx',
    ]);
    // The reader MOUNTS the shared component, it does not define a menu of its
    // own (the label scan above is the half that catches a copied menu).
    const reader = readFileSync(join(process.cwd(), READER), 'utf8');
    expect(reader).toMatch(
      /import \{ ModulePdfButton \} from '@\/features\/modules\/module-pdf-button'/,
    );
  });
});
