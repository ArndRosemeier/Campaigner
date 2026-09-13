import type { Content } from 'pdfmake/interfaces';

import type { ArtifactKind } from '@/domain';

/**
 * THE MODULE DOCUMENT'S PAGE MODEL (docs/19 §3–§5, docs/17 row 148).
 *
 * WHAT IT IS. The renderer's own answer to "where does this go on the page",
 * in ONE place: the page geometry (§3), the height arithmetic the model can
 * never do (§2), the two placement tiers and the overflow ladder (§4, §5), and
 * the pagination that turns a flow of blocks into pages carrying a main column
 * and a sidebar.
 *
 * WHY IT EXISTS AT ALL — the owner's report, verbatim: *"PDF is still
 * completely one dimensional flowing, no sidebars and nothing interesting
 * happening at all."* The renderer printed one flat array of content: every
 * planned section broke the page, the artifact's mechanics sat in the same
 * column as its prose, and nothing was ever beside anything. The ratified
 * answer (docs/19) splits the work: the model decides WHAT BELONGS WITH WHAT
 * (the plan), the renderer decides WHERE IT FITS — and "where it fits" is
 * arithmetic over the content, which is exactly what this module owns.
 *
 * THE SPLIT IT ENFORCES. A consumer never decides a placement, never chooses a
 * column and never splits content across pages: it hands this module a list of
 * blocks, each already split into its MAIN content ("the text") and its DETAIL
 * companion (the mechanics), and gets back pages. A second spelling of "which
 * artifact goes where" is the defect this seam exists to prevent (AGENTS
 * rule 4).
 *
 * WHAT IT DOES NOT DO. It does not RENDER: it emits one `columns` node per
 * page and nothing else, so every node inside a page is still built by
 * `lib/modulePdf` from the same builders it always used. It does not measure
 * with pdfmake's layout engine — see `estimateHeight`'s note, which records
 * that deviation from docs/19 §2's word "measuring" rather than hiding it.
 */

// --- §3: the page ------------------------------------------------------------

/** One millimetre in PostScript points (72 pt = 1 inch = 25.4 mm). */
export const MM = 72 / 25.4;

/** A4 portrait, in points. Screen viewers show ONE page, so the document is
 * built page-level — never as paired duplex spreads (docs/19 §3, §10.4). */
export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;

/** §3's geometry: 20 mm margins, main 104 mm, gutter 6 mm, sidebar 60 mm.
 * 104 + 6 + 60 = 170 = 210 − 2×20, so the two columns and the gutter consume
 * the content width exactly. docs/19 §10.5 (and the owner) calls these
 * STARTING POINTS to be tuned against real modules, not fixed truths — they
 * are named here, in one place, so tuning them is one edit. Rounded to a tenth
 * of a point so the numbers a definition prints are readable and their sum is
 * exact. */
const tenths = (points: number): number => Math.round(points * 10) / 10;

export const PAGE_MARGIN = tenths(20 * MM);
export const MAIN_COLUMN_WIDTH = tenths(104 * MM);
export const SIDEBAR_COLUMN_WIDTH = tenths(60 * MM);
export const COLUMN_GUTTER = tenths(6 * MM);

/** The usable box of one page: what a full-width item (an own-page artifact,
 * a map plate) may use, and the height budget both columns share. */
export const PAGE_CONTENT_WIDTH = tenths(PAGE_WIDTH - 2 * PAGE_MARGIN);
export const PAGE_CONTENT_HEIGHT = tenths(PAGE_HEIGHT - 2 * PAGE_MARGIN);

/** §3's detail tier — the type size every companion draws in, one step below
 * the body's 11 pt. Applied to the sidebar COLUMN node, so every stat box,
 * labeled section and table inside it inherits it (pdfmake's style stack). */
export const DETAIL_FONT_SIZE = 9.5;

/** The default type size and leading of the document (`defaultStyle`). */
const BODY_FONT_SIZE = 11;
const DEFAULT_LINE_HEIGHT = 1.35;

/**
 * Roboto's average glyph advance at a mixed-case setting, as a fraction of the
 * font size. Deliberately a little WIDE (measured against the words this
 * document actually prints: prose, stat-block rows, table cells): the
 * estimator may over-state a height and cost a little empty space at the foot
 * of a page, but under-stating it would push a column past the page break and
 * two columns on one page would then drift apart. Over-estimating is the safe
 * direction, and it is the direction this constant is tuned in.
 */
const GLYPH_WIDTH_RATIO = 0.52;

// --- the heights the renderer can verify -------------------------------------

/** One named style, as much of it as the estimator needs. */
export interface MeasureStyle {
  // `| undefined` is written out because this repo compiles with
  // `exactOptionalPropertyTypes`, and the dictionary handed in is pdfmake's own
  // `Style` — whose fields are optional-and-possibly-undefined.
  fontSize?: number | undefined;
  lineHeight?: number | undefined;
  characterSpacing?: number | undefined;
  bold?: boolean | undefined;
}

/** What a measurement needs beyond the node: how wide it may be, what type it
 * inherits, and the document's named styles. */
export interface MeasureContext {
  /** The width the node is laid out in, in points. */
  width: number;
  /** The inherited font size, in points. */
  fontSize: number;
  /** The inherited leading multiplier. */
  lineHeight: number;
  /** The document's `styles` dictionary, for a node that names one. */
  styles: Readonly<Record<string, MeasureStyle>>;
}

/** One entry of a `margin` array, read as VERTICAL space: top + bottom. */
function verticalMargin(node: Record<string, unknown>): number {
  const margin = node.margin;
  if (typeof margin === 'number') return margin * 2;
  if (!Array.isArray(margin)) return 0;
  const [top, , bottom] = margin as number[];
  if (margin.length >= 3) return (top ?? 0) + (bottom ?? 0);
  return (top ?? 0) * 2;
}

/** Every leaf string of a `text` value, joined — the characters that have to
 * fit in the column. A nested run array is concatenated, never treated as
 * separate lines. */
function runText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(runText).join('');
  if (typeof value === 'object' && value !== null) {
    return runText((value as Record<string, unknown>).text ?? '');
  }
  return '';
}

/** The points one block of text occupies in a column of `width`. */
function textHeight(value: unknown, ctx: MeasureContext): number {
  const text = runText(value);
  if (text.trim() === '') return 0;
  // A blank line still occupies a line, so every line counts.
  const perLine = Math.max(1, Math.floor(ctx.width / (ctx.fontSize * GLYPH_WIDTH_RATIO)));
  let lines = 0;
  for (const line of text.split('\n')) {
    lines += Math.max(1, Math.ceil(line.length / perLine));
  }
  return lines * ctx.fontSize * ctx.lineHeight;
}

/** The named style a node names, as overrides. */
function styleOf(node: Record<string, unknown>, ctx: MeasureContext): MeasureStyle {
  const named = node.style;
  if (typeof named !== 'string') return {};
  return ctx.styles[named] ?? {};
}

/** The context a node's children are measured in. */
function childContext(node: Record<string, unknown>, ctx: MeasureContext): MeasureContext {
  const style = styleOf(node, ctx);
  return {
    ...ctx,
    fontSize: typeof node.fontSize === 'number' ? node.fontSize : (style.fontSize ?? ctx.fontSize),
    lineHeight:
      typeof node.lineHeight === 'number' ? node.lineHeight : (style.lineHeight ?? ctx.lineHeight),
  };
}

/** One cell of a table body, measured at the width its column gets. */
function cellHeight(cell: unknown, width: number, ctx: MeasureContext): number {
  return estimateHeight(cell, { ...ctx, width });
}

/** The height of a `table` node's body, padding included. Every column is
 * given an EQUAL share of the width: real `auto` columns are narrower, so this
 * over-states — the conservative direction named at `GLYPH_WIDTH_RATIO`. */
function tableHeight(
  table: { widths?: unknown; body?: unknown },
  width: number,
  ctx: MeasureContext,
  node: Record<string, unknown>,
): number {
  const body = table.body;
  if (!Array.isArray(body)) return 0;
  const columns = Math.max(1, table.widths === undefined ? 1 : (table.widths as unknown[]).length);
  const cellWidth = width / columns;
  const layout = (node.layout ?? {}) as Record<string, unknown>;
  const padding = (key: string): number => {
    const value = layout[key];
    return typeof value === 'function' ? (value as () => number)() : 0;
  };
  const rowPadding = padding('paddingTop') + padding('paddingBottom');
  let total = 0;
  for (const row of body) {
    if (!Array.isArray(row)) continue;
    let tallest = 0;
    for (const cell of row) {
      // A `colSpan` cell owns the whole row, so it is measured at full width.
      const span =
        typeof cell === 'object' && cell !== null
          ? Number((cell as Record<string, unknown>).colSpan ?? 1)
          : 1;
      tallest = Math.max(tallest, cellHeight(cell, cellWidth * (span > 1 ? span : 1), ctx));
    }
    total += tallest + rowPadding + 1;
  }
  return total;
}

/**
 * The points a node occupies in a column of `ctx.width`.
 *
 * DEVIATION, RECORDED (docs/19 §2 says the renderer's work is "arithmetic it
 * can verify by measuring"). This is arithmetic over the DEFINITION, not a
 * measurement by pdfmake's layout engine: the document builder is synchronous
 * and definition-only (the pins of this repo assert definitions, never rendered
 * pages), and pdfmake exposes no way to measure a definition without rendering
 * it. So the estimator is deliberately CONSERVATIVE — margins counted, tables
 * summed row by row at an equal-column width, images at their `fit` maximum —
 * and a page may therefore end a little early rather than overflow. The
 * alternative (a two-pass render that feeds real heights back into the
 * definition) would make the builder async and its output non-deterministic
 * under the byte-determinism pins, which is a worse trade for this document.
 *
 * An unknown node contributes 0: this estimator decides PAGE BREAKS, so a node
 * it does not understand may cost a page its tightest fit — but it can never
 * drop content, because pagination never removes anything from the flow.
 */
export function estimateHeight(node: unknown, ctx: MeasureContext): number {
  if (node === null || node === undefined) return 0;
  if (typeof node === 'string') return textHeight(node, ctx);
  if (typeof node === 'number') return 0;
  if (Array.isArray(node)) {
    return node.reduce<number>((sum, child) => sum + estimateHeight(child, ctx), 0);
  }
  if (typeof node !== 'object') return 0;
  const record = node as Record<string, unknown>;
  const outer = verticalMargin(record);
  const inner = childContext(record, ctx);
  let body: number;
  if (record.text !== undefined) {
    body = textHeight(record.text, inner);
  } else if (Array.isArray(record.stack)) {
    body = record.stack.reduce((sum: number, child: unknown) => sum + estimateHeight(child, inner), 0);
  } else if (Array.isArray(record.columns)) {
    // pdfmake has no float: a row of columns is as tall as its tallest column,
    // and `width: '55%'`/`'*'` share the width. Equal shares here too.
    const columns = record.columns as { width?: unknown }[];
    const share = inner.width / Math.max(1, columns.length);
    body = columns.reduce(
      (tallest: number, column: unknown) => Math.max(tallest, estimateHeight(column, { ...inner, width: share })),
      0,
    );
  } else if (record.table !== undefined) {
    body = tableHeight(record.table as { widths?: unknown; body?: unknown }, inner.width, inner, record);
  } else if (record.image !== undefined) {
    // An image prints at its `fit` box at most; a wide source is shorter, and
    // this over-states in the safe direction.
    const fit = record.fit;
    body = Array.isArray(fit) ? ((fit as number[])[1] ?? 0) : 0;
  } else if (record.toc !== undefined) {
    // The table of contents is its own page's business, never a flow item.
    body = PAGE_CONTENT_HEIGHT;
  } else {
    body = 0;
  }
  return outer + body;
}

// --- §4/§5: the placement rule ----------------------------------------------

/**
 * Where a block's DETAIL companion is printed. Three outcomes, one per rung of
 * docs/19 §5's ladder, plus the two the spec's §4 names as oversized by KIND.
 */
export type DetailPlacement =
  | { kind: 'beside' }
  | { kind: 'beside-continued' }
  | { kind: 'adjacent'; reason: 'oversized-kind' | 'overflows-the-sidebar' };

/** The context a placement is decided from. */
export interface PlacementInput {
  /** The artifact's kind, or `null` for a section with no row behind it. */
  kind: ArtifactKind | null;
  /** Whether the block prints an IMAGE (an artifact cover, an encounter map, a
   * plan-anchored picture). An image needs the page, so it is a full-width
   * item by construction and can never be a sidebar companion. */
  hasImage: boolean;
  /** The companion's estimated height, in points. */
  height: number;
}

/** One sidebar page's worth of companion content, with a little slack kept
 * back so a conservative estimate still fits. */
export const SIDEBAR_PAGE_BUDGET = PAGE_CONTENT_HEIGHT * 0.95;

/**
 * §4's oversized kinds, verbatim from the spec: *"an oversized thing (an
 * encounter, an event, a location with maps) gets its OWN page(s)"*. This is
 * the ONE closed set — a new artifact kind must be decided here rather than
 * inheriting a default, and the companion `hasImage` clause is what turns the
 * spec's "a location with maps" into a testable condition.
 */
const OWN_PAGE_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>(['encounter', 'event']);

/**
 * docs/19 §4 and §5 as ONE decision: which tier the companion gets.
 *
 * - §4's oversized kinds (and a location carrying maps/art) go STRAIGHT to
 *   their own page — the spec's reason is the thing's own nature, not a
 *   measurement, and a short encounter still belongs on its own page.
 * - everything else walks §5's deterministic ladder: it fits the sidebar
 *   (`beside`), it needs two (`beside-continued`, the second chunk marked
 *   "(continued)" on the NEXT page), or it is promoted to its own page(s).
 *
 * Nothing here can CLIP: the three arms are "all of it here", "all of it over
 * two pages" and "all of it on a page of its own", and no arm shortens the
 * content (§5's verbatim rule, docs/19 §9).
 */
export function detailPlacement(input: PlacementInput): DetailPlacement {
  if (input.hasImage) return { kind: 'adjacent', reason: 'oversized-kind' };
  if (input.kind !== null && OWN_PAGE_KINDS.has(input.kind)) {
    return { kind: 'adjacent', reason: 'oversized-kind' };
  }
  if (input.height <= SIDEBAR_PAGE_BUDGET) return { kind: 'beside' };
  if (input.height <= SIDEBAR_PAGE_BUDGET * 2) return { kind: 'beside-continued' };
  return { kind: 'adjacent', reason: 'overflows-the-sidebar' };
}

// --- pagination --------------------------------------------------------------

/** One block of the document's flow: the text, and the companion it brings. */
export interface PageBlock {
  /** The block's MAIN content — the module's text in the main column. */
  main: Content[];
  /** The block's DETAIL companion — the artifact's mechanics. Empty for a
   * block that brings none (a part's prose, a read-aloud section). */
  detail: Content[];
  /** The placement of `detail`, decided by `detailPlacement`. */
  placement: DetailPlacement;
  /** The artifact this block details, for the sidebar's "(continued)" label
   * and for the pointer left where an own-page artifact is referred to. */
  name: string | null;
  /** Whether this block STARTS a page (docs/19 §3: "a chapter start"). A
   * chapter heading does; an ordinary section flows. */
  breakBefore?: boolean;
}

/** One page of the document: a main column and a sidebar, side by side. */
export interface DocumentPage {
  main: Content[];
  sidebar: Content[];
}

/** The sentence a companion that ran out of sidebar prints where it stopped. */
export function continuedNote(name: string | null, where: 'here' | 'next'): string {
  const subject = name === null ? 'The details' : `The details of “${name}”`;
  return where === 'here'
    ? `${subject} continue in the sidebar of the next page.`
    : `${subject}, continued.`;
}

/** The pointer left in the sidebar where an own-page artifact is referred to
 * (docs/19 §5 step 3: *"marked in the sidebar where the space ran out"*). */
export function ownPageNote(name: string): string {
  return `“${name}” has its own page, following this one.`;
}

/** A sidebar/own-page marker run, in the document's kicker tier (§3: 8 pt). */
function marker(text: string): Content {
  return { text: text.toUpperCase(), style: 'kicker', margin: [0, 0, 0, 4] };
}

/**
 * Turns the flow into pages.
 *
 * The contract every page keeps: a block's main content and its companion
 * START on the same page (docs/19 §4: the companion sits *"on a page where
 * its referring text runs"*), and neither column is handed more than its
 * budget. So the page closes BEFORE a block that would overrun either column —
 * which may leave a page a little short, and never splits a companion from the
 * text it belongs to.
 *
 * The three §5 outcomes are pages:
 * - `beside` — the companion in this page's sidebar;
 * - `beside-continued` — the first chunk here with a marker, the page CLOSED
 *   right after it, and the second chunk at the head of the next page's
 *   sidebar, so "the NEXT page's sidebar" is a fact rather than a hope;
 * - `adjacent` — a pointer in the sidebar where the text runs, then the
 *   block's main AND detail together on a full-width page of its own.
 */
export function paginateDocument(
  blocks: readonly PageBlock[],
  ctx: { styles: Readonly<Record<string, MeasureStyle>> },
): DocumentPage[] {
  const pages: DocumentPage[] = [];
  let main: Content[] = [];
  let sidebar: Content[] = [];
  let mainHeight = 0;
  let sidebarHeight = 0;
  /** The companion chunk that must head the NEXT page's sidebar. */
  let carry: Content[] | null = null;

  const heightOf = (nodes: readonly Content[], width: number): number =>
    estimateHeight(nodes, {
      ...ctx,
      width,
      fontSize: BODY_FONT_SIZE,
      lineHeight: DEFAULT_LINE_HEIGHT,
    });

  /** Opens a page: empty columns, then the continuation the previous page
   * owed this one, so "(continued) on the NEXT page's sidebar" is a fact. */
  const openPage = (): void => {
    main = [];
    sidebar = [];
    mainHeight = 0;
    sidebarHeight = 0;
    if (carry !== null) {
      sidebar.push(...carry);
      sidebarHeight += heightOf(carry, SIDEBAR_COLUMN_WIDTH);
      carry = null;
    }
  };
  const flush = (): void => {
    if (main.length === 0 && sidebar.length === 0) return;
    pages.push({ main, sidebar });
    openPage();
  };
  /** Ends the current page, and gives a pending continuation its own page
   * first, so whatever asked for a break really does start one. */
  const breakPage = (): void => {
    flush();
    if (main.length === 0 && sidebar.length > 0) flush();
  };

  openPage();
  for (const block of blocks) {
    // §3: a break happens "where content or the plan demands one … a chapter
    // start" — a page-model decision, never a node's.
    if (block.breakBefore === true) breakPage();
    if (block.placement.kind === 'adjacent') {
      if (block.name !== null) {
        // §5 step 3, and the one pointer every own-page artifact leaves: the
        // reader is told, where the text runs, that the detail follows.
        sidebar.push(marker(ownPageNote(block.name)));
      }
      breakPage();
      // An own page: heading, prose and the companion at FULL width, because
      // the page is the thing's own (docs/19 §4).
      pages.push({ main: [...block.main, ...block.detail], sidebar: [] });
      continue;
    }
    const blockMain = heightOf(block.main, MAIN_COLUMN_WIDTH);
    const blockDetail = heightOf(block.detail, SIDEBAR_COLUMN_WIDTH);
    if (
      (main.length > 0 || sidebar.length > 0) &&
      (mainHeight + blockMain > PAGE_CONTENT_HEIGHT * 0.95 ||
        sidebarHeight + blockDetail > SIDEBAR_PAGE_BUDGET)
    ) {
      flush();
    }
    main.push(...block.main);
    mainHeight += blockMain;
    if (block.placement.kind === 'beside') {
      sidebar.push(...block.detail);
      sidebarHeight += blockDetail;
      continue;
    }
    // §5 step 2: split the companion where the sidebar runs out, mark BOTH
    // halves, and close the page so the continuation really is the next one's.
    const [head, tail] = splitContent(block.detail, ctx, SIDEBAR_PAGE_BUDGET - sidebarHeight);
    sidebar.push(...head, marker(continuedNote(block.name, 'here')));
    // The carry is armed BEFORE the page closes, because closing the page is
    // what OPENS the next one — and the next page's sidebar is where §5 puts
    // the continuation.
    carry = [marker(continuedNote(block.name, 'next')), ...tail];
    flush();
  }
  // The last page is pushed whatever it holds: a companion whose continuation
  // has no block after it still gets its page, because a page the document owes
  // its content is never dropped for want of a following block (docs/19 §9).
  flush();
  if (main.length > 0 || sidebar.length > 0) pages.push({ main, sidebar });
  return pages;
}

/**
 * The companion split into "what fits in `budget` points" and the rest. It is
 * a SPLIT, never a TRUNCATION: the two halves together are the whole list, in
 * order, byte for byte — the only content the paginator is allowed to touch,
 * and it only ever moves it to the next page.
 */
function splitContent(
  nodes: readonly Content[],
  ctx: { styles: Readonly<Record<string, MeasureStyle>> },
  budget: number,
): [Content[], Content[]] {
  const heights = nodes.map((node) =>
    estimateHeight(node, {
      ...ctx,
      width: SIDEBAR_COLUMN_WIDTH,
      fontSize: BODY_FONT_SIZE,
      lineHeight: DEFAULT_LINE_HEIGHT,
    }),
  );
  let used = 0;
  let split = 0;
  for (const height of heights) {
    if (used + height > budget && split > 0) break;
    used += height;
    split += 1;
  }
  if (split >= nodes.length) return [[...nodes], []];
  return [nodes.slice(0, split), nodes.slice(split)];
}
