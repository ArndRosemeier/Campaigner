import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE one model-prose renderer (docs/17 row 217, docs/18 §2.3).
 *
 * The owner's report — *"in the description i see [[<name>]] occurrances which
 * are supposed to be links, but are not. They are not rendered as links and not
 * clickable."* — was not a missing feature: `WikiMarkdown` already renders a
 * resolvable `[[Name]]` as a kind-coloured clickable chip and an unresolvable
 * one as the dashed muted chip carrying the byte-exact token in its tooltip.
 * The defect was that whole surfaces BYPASSED that renderer and printed the
 * model's raw bytes in a bare `<p>`. The fix is therefore mechanical: every
 * model-authored prose field goes through the ONE chain.
 *
 * The drift this scan catches is invisible — a surface can print a plausible
 * `[[Name]]` today and diverge from the reader the first time chip behaviour
 * changes, and a second `react-markdown` import would silently become a second
 * markdown dialect (no wiki chips, no GFM tables, no shared tooltip). Two
 * mechanisms for one idea is exactly what AGENTS rule 4 forbids.
 *
 * WHAT THIS PIN REDS ON, named so a reader knows:
 * (1) `react-markdown` imported anywhere but `wiki-markdown.tsx` — the
 *     non-vacuity arm is the source line itself, so a second import (or the
 *     `revision-dialog` regression this slice removed) fails by file. The scan
 *     is TEXTUAL and sees neither a dynamic `await import('react-markdown')`
 *     nor a re-export that hides the specifier (labelled, not fixed).
 * (2) `remarkWikiLinks` imported anywhere but `wiki-markdown.tsx` — the token
 *     plugin runs inside react-markdown by contract; a second importer is a
 *     second token walker, and this arc forbids a string→React token renderer
 *     (docs/17 row 217 item 4).
 * (3) The declared MODEL_PROSE_SURFACES population: each file must exist, must
 *     render at least the declared number of `<WikiMarkdown` blocks, and carry
 *     a reason. A migrated field that reverts to a bare `<p>{modelText}</p>`
 *     drops one and reds here; a NEW model-prose surface is added deliberately
 *     (this map is the record of which surfaces the seam owns).
 *
 * WHAT IT CANNOT SEE: a per-FIELD reversion when the same file still renders
 * another field through the seam (the count catches only a whole-file drop);
 * that is what the surface's own behaviour pins are for, and this scan is the
 * tripwire, not the proof. It sees `src/` only — a test tree may import
 * `react-markdown` for its own differential without this pin caring.
 *
 * The walk uses Node's recursive `readdirSync` with the counting INLINE in the
 * `it` callbacks rather than a hand-rolled `sourceFiles` helper: the
 * duplicate-body tripwire (docs/17 row 212) baselines every named function body
 * in this tree, so a copied helper would be a new baselined site for no benefit
 * (`tests/architecture/module-title-seam.test.ts`'s pattern).
 */

const SRC_DIR = join(process.cwd(), 'src');
const ONE_RENDERER = 'src/features/campaign/components/wiki-markdown.tsx';

/**
 * Every surface that renders MODEL-AUTHORED prose, with the number of
 * `<WikiMarkdown` blocks it owns and the fields those blocks carry. A surface
 * added or a field moved is an edit HERE, in the same commit — the row-213
 * "declared population" shape.
 */
const MODEL_PROSE_SURFACES: Readonly<Record<string, { count: number; fields: string }>> = {
  'src/features/play/artifact-cards.tsx': {
    count: 5,
    fields: 'npc summary/appearance/personality, encounter summary, CollapsibleRow summary',
  },
  'src/features/modules/peek-modal.tsx': {
    count: 2,
    fields: 'non-npc summary, and the pre-existing artifact body',
  },
  'src/features/campaign/components/monster-source.tsx': {
    count: 1,
    fields: 'a roster entry`s model-authored notes',
  },
  'src/features/play/battle/BattleSurface.tsx': {
    count: 3,
    fields: 'layout room key, room keyTreasure, the frozen token treasure',
  },
  'src/features/campaign/components/campaign-tree.tsx': {
    count: 1,
    fields: 'the row summary tooltip',
  },
  'src/features/campaign/components/revision-dialog.tsx': {
    count: 2,
    fields: 'the snapshot summary and body (its direct react-markdown import is GONE)',
  },
};

describe('one model-prose renderer (SOURCE SCAN)', () => {
  it('imports react-markdown from exactly the one renderer, and proves it can see one', () => {
    const files = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
      .map((entry) => join(SRC_DIR, entry));

    const directImporters: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (/from ['"]react-markdown['"]/.test(text) || /require\(['"]react-markdown['"]\)/.test(text)) {
        directImporters.push(relative(process.cwd(), file));
      }
    }

    // Non-vacuity: the ONE renderer really does carry the import, so a scan
    // that matched nothing could not pass this assertion by accident.
    expect(directImporters).toContain(ONE_RENDERER);
    expect(directImporters.sort()).toEqual([ONE_RENDERER]);
  });

  it('runs the wiki token plugin only inside the one renderer', () => {
    const files = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
      .map((entry) => join(SRC_DIR, entry));

    const pluginImporters: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (/import \{[^}]*\bremarkWikiLinks\b[^}]*\} from '@\/lib\/remark-wikilinks'/.test(text)) {
        pluginImporters.push(relative(process.cwd(), file));
      }
    }

    expect(pluginImporters.sort()).toEqual([ONE_RENDERER]);
  });

  it('declares every model-prose surface, and each still renders through the seam', () => {
    const declared = Object.keys(MODEL_PROSE_SURFACES).sort();
    // The population is work, not a formality: every declared surface exists
    // (a moved file reds instead of silently vanishing from the scan) and each
    // still calls the ONE renderer at least the declared number of times.
    const observed: Record<string, number> = {};
    for (const file of declared) {
      const text = readFileSync(join(process.cwd(), file), 'utf8');
      const occurrences = text.split('<WikiMarkdown').length - 1;
      observed[file] = occurrences;
      // Rot check per site: the reason string is non-empty and the file still
      // imports the seam (a stale declaration must not outlive its migration).
      expect(MODEL_PROSE_SURFACES[file]?.fields ?? '').not.toBe('');
      expect(text).toContain('wiki-markdown');
    }
    const expected: Record<string, number> = {};
    for (const file of declared) expected[file] = MODEL_PROSE_SURFACES[file]?.count ?? -1;
    expect(observed).toEqual(expected);
    // Non-vacuity: the declared counts are real work, not a list of zeros.
    expect(Object.values(observed).reduce((sum, value) => sum + value, 0)).toBeGreaterThanOrEqual(14);
  });
});
