import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE one pair of class strings for a dialog whose BODY is the scroller, and the
 * refusal of the shape that broke it (docs/17 row 343, docs/18 §2.3).
 *
 * WHY IT EXISTS — THE WORKING DIAGNOSIS, THE IN-REPO CONTROL, AND WHAT IS OWED.
 * The owner, verbatim: *"Still can't scroll an I also see no scroll bar"*, with
 * many screens of core mobs, so his content certainly exceeds any cap. The CONTROL
 * is `src/help/HelpDialog.tsx`: a `min-h-0 flex-1 overflow-y-auto` body inside a
 * flex-column `DialogContent` with `overflow-hidden`, under a DEFINITE `h-[80vh]`
 * — the same structure the picker had, except the picker's height was a `max-h`
 * cap. That is the strongest evidence available inside the repo, and it is still an
 * inference: **the tablet check that would confirm the diagnosis is OWED, and this
 * file asserts STRUCTURE only — jsdom computes no layout, cannot see clipping or a
 * scrollbar, and cannot scroll by touch.**
 *
 * WHAT REDS THIS, named so a reader knows.
 * (1) A SECOND SPELLING of the box (`DIALOG_VIEWPORT_BOX`) or of its `@supports`
 *     refinement: one definition, three call sites that IMPORT it. A copy is the
 *     duplication AGENTS rule 4 forbids — three dialogs already carried private
 *     spells of this shape, which is exactly how it drifted.
 * (2) THE ROW-340 SHAPE, outright: a `DialogContent`-bearing file whose class list
 *     carries `overflow-hidden`, `flex-col` AND a viewport `max-h-[…vh]` in the
 *     same list. That is the shape that fails on WebKit under the diagnosis above,
 *     so a FOURTH dialog cannot repeat the mistake by copying it.
 * (3) A CONSUMER THAT TOOK HALF THE SEAM: a dialog may not adopt
 *     `DIALOG_SCROLL_BODY` — the inner scroller — without the definite
 *     `DIALOG_VIEWPORT_BOX` above it, and both must be USED at the `DialogContent`
 *     call rather than merely imported (the arms include exactly that mistake).
 * (4) A SEAM WITH NO CONSUMER, or a consumer that dropped its scroller: the exact
 *     consumer population has to hold, and the body constant has to keep carrying
 *     `min-h-0`, `flex-1` and `overflow-y-auto`, so the pin cannot go vacuous by
 *     deleting the thing it guards.
 * (5) THE CONTROL LOSING ITS BOUND: `HelpDialog` is the one declared non-consumer
 *     (folding it would change its rendered `80vh` box, and it already has the
 *     definite height the seam exists to provide), so its own definite height is
 *     asserted — the exception cannot quietly become an unbounded `max-h` dialog.
 *
 * WHAT THIS CANNOT SEE, stated rather than implied: a dialog that hand-rolls the
 * inner-scroller class list without adopting `DIALOG_SCROLL_BODY` narrows the
 * population this scan keys on. The body idiom is generic Tailwind (panels and
 * pages use it too, which is why it cannot be required to be unique in `src/`),
 * so pin (2) — the broken SHAPE — is the mechanical guard for that case, and the
 * source-level pins here are a tripwire rather than a proof.
 */

const SRC_DIR = join(process.cwd(), 'src');

/** `h-[85vh]` plus the bars-aware refinement — the value, not the seam's name. */
const VIEWPORT_BOX_PLAIN = 'h-[85vh]';
const VIEWPORT_BOX_REFINEMENT = 'supports-[height:100svh]:h-[min(85svh,85dvh)]';
const VIEWPORT_BOX_VALUE = `${VIEWPORT_BOX_PLAIN} ${VIEWPORT_BOX_REFINEMENT}`;

/** The inner scroller's shared part (callers add `gap-3`/`p-4`/`overscroll-contain`). */
const SCROLL_BODY_VALUE = 'min-h-0 flex-1 overflow-y-auto';

/** The seams' ONE names. */
const VIEWPORT_BOX_SEAM = 'DIALOG_VIEWPORT_BOX';
const SCROLL_BODY_SEAM = 'DIALOG_SCROLL_BODY';

/** The ONE file allowed to spell either value out. */
const SEAM_FILE = 'src/components/ui/dialog.tsx';

/** Every dialog that puts a scrolling BODY inside `DialogContent` — the exact population. */
const CONSUMERS = [
  'src/features/modules/peek-modal.tsx',
  'src/features/onboarding/SetupWizardDialog.tsx',
  'src/features/play/battle/SpawnPicker.tsx',
] as const;

/** The declared control: a definite height it already had; folding it would move its box. */
const CONTROL = 'src/help/HelpDialog.tsx';

/** Every source file, walked inline (a named helper would join the duplication baseline). */
function sourceFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .map((entry) => relative(process.cwd(), join(SRC_DIR, entry)))
    .sort();
}

/** The JSX expression starting at a `{`, so a COMMENT mentioning a seam cannot satisfy a pin. */
function jsxExpressionAt(text: string, braceIndex: number): string | null {
  if (text[braceIndex] !== '{') return null;
  let depth = 0;
  for (let index = braceIndex; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(braceIndex, index + 1);
    }
  }
  return null;
}

function read(file: string): string {
  return readFileSync(join(process.cwd(), file), 'utf8');
}

describe('one definite-height dialog box for an inner-scroller body (SOURCE SCAN)', () => {
  it('spells the definite height in exactly ONE file — the seam, not a call site', () => {
    const values = sourceFiles().filter((file) => read(file).includes(VIEWPORT_BOX_VALUE));
    expect(values).toEqual([SEAM_FILE]);

    const refinements = sourceFiles().filter((file) => read(file).includes(VIEWPORT_BOX_REFINEMENT));
    expect(refinements).toEqual([SEAM_FILE]);

    // The body seam's value may appear as a SUBSTRING of longer class lists in
    // non-dialog scrollers (declared in the doc above), but it must be declared
    // once: the seam file owns the three tokens.
    const seamText = read(SEAM_FILE);
    for (const token of SCROLL_BODY_VALUE.split(' ')) {
      expect(seamText.includes(token), `${SEAM_FILE} must declare ${token}`).toBe(true);
    }
  });

  it('refuses the row-340 shape — a dialog box with `overflow-hidden`, `flex-col` and a viewport `max-h`', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = read(file);
      if (!text.includes('<DialogContent')) continue;
      for (const literal of text.matchAll(/"[^"\n]*"|`[^`\n]*`/g)) {
        const value = literal[0];
        const isViewportMaxHeight = value.includes('max-h-[') && value.includes('vh]');
        if (value.includes('overflow-hidden') && value.includes('flex-col') && isViewportMaxHeight) {
          offenders.push(`${file}: ${value.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('carries BOTH seams at every dialog whose body is the scroller, and nowhere else', () => {
    const heightConsumers = sourceFiles()
      .filter((file) => file !== SEAM_FILE)
      .filter((file) => read(file).includes(VIEWPORT_BOX_SEAM));
    expect(heightConsumers).toEqual([...CONSUMERS].sort());

    const bodyConsumers = sourceFiles()
      .filter((file) => file !== SEAM_FILE)
      .filter((file) => read(file).includes(SCROLL_BODY_SEAM));
    expect(bodyConsumers).toEqual([...CONSUMERS].sort());
  });

  it('USES both seams in a className expression — half a seam is the WebKit trap with a nicer name', () => {
    for (const consumer of CONSUMERS) {
      const text = read(consumer);
      const content = text.indexOf('<DialogContent');
      expect(content, `${consumer} must render DialogContent`).toBeGreaterThan(-1);
      // The DialogContent's OWN className expression — read through a brace
      // matcher, because a comment mentioning the seam (which these files carry)
      // must not be able to satisfy the pin, and the seam may sit on its own line
      // inside `cn(...)`.
      const dialogBrace = text.indexOf('className={', content) + 'className='.length;
      const dialogClass = jsxExpressionAt(text, dialogBrace);
      expect(
        dialogClass?.includes(VIEWPORT_BOX_SEAM),
        `${consumer}'s DialogContent className must USE ${VIEWPORT_BOX_SEAM}`,
      ).toBe(true);
      // …and some className expression in the file must carry the body seam.
      const bodyClass = [...text.matchAll(/className=\{/g)]
        .map((match) => jsxExpressionAt(text, match.index + 'className='.length))
        .find((expression) => expression?.includes(SCROLL_BODY_SEAM) === true);
      expect(bodyClass, `${consumer}'s body className must USE ${SCROLL_BODY_SEAM}`).toBeTruthy();
    }
  });

  it('leaves the CONTROL bounded by its own definite height and out of the consumer inventory', () => {
    const text = read(CONTROL);
    expect(text.includes('<DialogContent'), `${CONTROL} must still render DialogContent`).toBe(true);
    // It keeps a definite height of its own (the control this row reasons from)…
    expect(text.includes('h-[80vh]'), `${CONTROL} must keep its definite height`).toBe(true);
    // …and it is deliberately NOT a consumer: folding it would move its box from
    // 80vh to 85vh, which is a rendered change in a fix-forward.
    expect(text.includes(VIEWPORT_BOX_SEAM)).toBe(false);
    expect(CONSUMERS.includes(CONTROL as (typeof CONSUMERS)[number])).toBe(false);
  });
});
