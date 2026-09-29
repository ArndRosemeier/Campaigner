import {
  SOURCE_FROM_ATTRIBUTE,
  resolveSourceOffset,
} from '@/features/campaign/components/wiki-markdown';

/**
 * Click-to-edit position handoff (docs/17 row 399, docs/23): the ONE place that
 * turns a spot in the rendered preview into a whole-document SOURCE offset and
 * back. It adds no mapping of its own — the caret rides
 * `wiki-markdown.resolveSourceOffset` (the same `resolvePoint` behind "Refine
 * selection"), and the scroll anchor reads the `data-md-from` run spans the
 * preview already renders. Pure DOM helpers; the document string is never read
 * or written here.
 *
 * DEGRADATION (never the document start): an exact map wins; a point the
 * mapper refuses (separator caption chrome, a chip's inside, a table cell, code,
 * the nothing-written placeholder) falls to the first mappable run of the
 * clicked block, then of the clicked section, then the section's own text start.
 */

/** The attribute a part root carries: its text's offset in the whole document. */
export const PART_FROM_ATTRIBUTE = 'data-canvas-part-from';
export const PART_ROOT_SELECTOR = '[data-canvas-part-source]';

export interface EditHandoff {
  /** Whole-document offset the caret lands on. */
  caret: number;
  /** Whole-document offset of the text that sat at the top of the pane. */
  scrollPos: number;
  /** Pixels between the pane top and that text's top (>= 0). */
  scrollOffsetPx: number;
  /** Set when a mapped selection carries over as the editor selection. */
  selectionTo?: number;
}

function partFrom(root: Element): number {
  return Number(root.getAttribute(PART_FROM_ATTRIBUTE) ?? '0');
}

function runsOf(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`[${SOURCE_FROM_ATTRIBUTE}]`)];
}

function absFrom(run: HTMLElement, root: Element): number {
  return partFrom(root) + Number(run.getAttribute(SOURCE_FROM_ATTRIBUTE));
}

/** The text at the top of the preview pane, as a whole-document offset. */
export function previewScrollAnchor(
  scroller: HTMLElement,
): { pos: number; offsetPx: number } | null {
  const top = scroller.getBoundingClientRect().top;
  let last: { pos: number; offsetPx: number } | null = null;
  for (const root of scroller.querySelectorAll(PART_ROOT_SELECTOR)) {
    for (const run of runsOf(root)) {
      const rect = run.getBoundingClientRect();
      const pos = absFrom(run, root);
      if (rect.bottom > top + 1) return { pos, offsetPx: Math.max(0, rect.top - top) };
      last = { pos, offsetPx: 0 };
    }
  }
  return last;
}

/** Scrolls the preview so the run holding whole-document offset `pos` is at the top. */
export function scrollPreviewToPos(scroller: HTMLElement, pos: number): void {
  let target: HTMLElement | null = null;
  for (const root of scroller.querySelectorAll(PART_ROOT_SELECTOR)) {
    for (const run of runsOf(root)) {
      if (absFrom(run, root) <= pos) target = run;
    }
  }
  if (target === null) return;
  const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTop += delta;
}

/**
 * The caret for a click at `point` (the collapsed browser selection the click
 * placed), inside `root` (the clicked part), or null when the click is not in a
 * part at all.
 */
export function caretForClick(
  partRoot: Element,
  partText: string,
  point: { node: Node; offset: number },
): number {
  const base = partFrom(partRoot);
  const exact = resolveSourceOffset(partText, point);
  if (exact.ok) return base + exact.offset;
  // Nearest mappable: the first run of the clicked block, then of the section.
  const el =
    point.node.nodeType === Node.TEXT_NODE ? point.node.parentElement : (point.node as Element);
  const block = el?.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, pre') ?? null;
  const inBlock =
    block !== null && partRoot.contains(block)
      ? block.querySelector(`[${SOURCE_FROM_ATTRIBUTE}]`)
      : null;
  const run = inBlock ?? partRoot.querySelector(`[${SOURCE_FROM_ATTRIBUTE}]`);
  if (run !== null) return base + Number(run.getAttribute(SOURCE_FROM_ATTRIBUTE));
  return base;
}
