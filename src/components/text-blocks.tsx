import type { JSX } from 'react';

import { blockText, textBlocks } from '@/lib/textBlocks';
import { cn } from '@/lib/utils';

/**
 * The app's block renderer for STRUCTURED PLAIN TEXT (docs/17 row 146,
 * docs/18 §2.3) — a thin presenter over the ONE rule,
 * `lib/textBlocks.textBlocks`, which owns what a block is. It carries no
 * splitting logic of its own: a second paragraph rule here is exactly the
 * drift the seam removes, and `tests/lib/text-blocks.test.tsx` fails on one.
 *
 * WHAT IT DRAWS, and why in `<span>`s rather than `<p>`s:
 *
 * - ONE ELEMENT PER BLOCK, so a blank line in the source reads as a paragraph
 *   break (`mt-1 block` on every block after the first);
 * - `whitespace-pre-line`, so a SINGLE newline inside a block stays a line
 *   break — the collapsed-to-a-space behaviour that produced the owner's
 *   *"walls of text, no formatting at all"* is gone;
 * - NOTHING for whitespace-only text, so an empty field still prints nothing
 *   (the pre-existing rule of every caller) instead of an empty line.
 *
 * `<span>` (not `<p>`) because the callers are stat-block FIELDS: a trait's
 * body sits after its bold name inside an `<li>`, and a `<p>` there would both
 * break the "Name. text" line and be invalid inside anything inline. A block is
 * a LINE-GROUP here, which is what the text means.
 */
export function TextBlocks({ text }: { text: string }): JSX.Element | null {
  const blocks = textBlocks(text);
  if (blocks.length === 0) return null;
  return (
    <>
      {blocks.map((block, index) => (
        <span
          key={index}
          data-testid="text-block"
          className={cn('whitespace-pre-line', index > 0 && 'mt-1 block')}
        >
          {blockText(block)}
        </span>
      ))}
    </>
  );
}
