import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE one 16px coarse-pointer input floor (docs/17 row 262a, docs/18 §2.3).
 *
 * iOS Safari auto-zooms the page when a focused field renders below 16px. The
 * primitives used to bake `md:text-sm` — 14px at EVERY iPad width — while the
 * floor lived at the call sites, so 29 of 61 `<Input>` and 18 of 24 `<Textarea>`
 * tags had never been given it, including `SpawnPicker`'s search field: the
 * only text entry on the battle path, one tap away mid-fight. The enumeration
 * failed twice (batch D's own file list, then `model-widget.tsx`, born after
 * it), so the floor moved into `input.tsx`, `textarea.tsx` and `command.tsx`
 * and the 40 hand-applied copies were folded onto it.
 *
 * WHAT REDS THIS, named so a reader knows. (1) A primitive that loses the
 * floor: on a coarse pointer the field silently falls back to `md:text-sm` and
 * the zoom comes back with nothing in the diff to see. (2) A consumer that
 * re-declares it: the copy matches the primitive today and drifts from it the
 * moment one of the two is touched — exactly the duplication AGENTS rule 4
 * forbids, and exactly how the 47-site version was born.
 *
 * The scan is TAG-AWARE rather than a bare needle count because the six
 * `<SelectTrigger>` sites in `kind-forms.tsx`, `writers-room.tsx` and
 * `stub-popover.tsx` legitimately keep a hand-applied floor: Base UI's Select
 * renders a button plus a custom popup, not a text input, so it never takes
 * focus and never zooms — it is not a consumer of these three primitives, and
 * 26 of the app's 32 triggers carry no floor, so folding these six into
 * `select.tsx` would resize every Select on an iPad. That is a visual decision
 * of its own, not this defect's cure (docs/18 §5).
 *
 * The walk uses Node's recursive `readdirSync` with the tag scan INLINE in the
 * `it` callback rather than a hand-rolled `sourceFiles` helper: the
 * duplicate-body tripwire (docs/17 row 212) baselines every NAMED function body
 * in this tree, so a copied walker here would be a new baselined site for no
 * benefit (`tests/architecture/module-title-seam.test.ts`'s pattern).
 *
 * jsdom CANNOT PROVE THE ZOOM: it has neither a coarse pointer nor a visual
 * viewport, so this is a SOURCE assertion. The rendered half
 * (`tests/features/ipad-inputs.test.tsx`) proves the class reaches the element;
 * the real proof of the behaviour is the owner's iPad.
 */

const SRC_DIR = join(process.cwd(), 'src');

/** The one spelling of the floor — a second spelling is a second rule. */
const COARSE_FLOOR = 'pointer-coarse:text-base';

/** Every text-entry field in the app goes through one of these three. */
const COARSE_FLOOR_PRIMITIVES = [
  'src/components/ui/input.tsx',
  'src/components/ui/textarea.tsx',
  'src/components/ui/command.tsx',
] as const;

/** The primitives' consumers must not re-declare the floor. */
const COARSE_FLOOR_CONSUMERS = ['Input', 'Textarea', 'CommandInput'] as const;

describe('one 16px coarse-pointer floor, owned by the three input primitives (SOURCE SCAN)', () => {
  it('declares the floor exactly once in each of the three primitives', () => {
    for (const primitive of COARSE_FLOOR_PRIMITIVES) {
      const text = readFileSync(join(process.cwd(), primitive), 'utf8');
      expect(text.split(COARSE_FLOOR).length - 1, `${primitive} must carry the coarse floor`).toBe(1);
    }
  });

  it('never re-declares the floor on an <Input>/<Textarea>/<CommandInput> consumer', () => {
    const files = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
      .map((entry) => join(SRC_DIR, entry))
      .sort();

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const name of COARSE_FLOOR_CONSUMERS) {
        const opener = new RegExp(`<${name}\\b`, 'g');
        for (let match = opener.exec(text); match !== null; match = opener.exec(text)) {
          // Walk to the end of the opening tag: the first `>` at brace depth 0,
          // skipping quoted strings so a `placeholder="a > b"` cannot cut the
          // element short and an arrow (`=>`) inside a prop cannot end it early.
          let i = match.index + match[0].length;
          let depth = 0;
          while (i < text.length) {
            const ch = text[i];
            if (ch === '{') depth += 1;
            else if (ch === '}') depth -= 1;
            else if (ch === '"' || ch === "'" || ch === '`') {
              const quote = ch;
              i += 1;
              while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1;
            } else if (ch === '>' && depth === 0) break;
            i += 1;
          }
          const tag = text.slice(match.index, i + 1);
          if (tag.includes(COARSE_FLOOR)) {
            const line = text.slice(0, match.index).split('\n').length;
            offenders.push(`${relative(process.cwd(), file)}:${line} <${name}>`);
          }
        }
      }
    }

    // An EMPTY list is the fold; a non-empty list names every copy that came
    // back, with its line, so the fold cannot be quietly undone.
    expect(offenders).toEqual([]);
  });
});
