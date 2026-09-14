import type { Content, TableCell, TableLayout } from 'pdfmake/interfaces';

import { WIKI_LINK_TOKEN } from '@/lib/wikilinks';

/**
 * Markdown → pdfmake content (07-MILESTONE-3 M3-D): paragraphs, bold/italic,
 * h1–h3, bullet/numbered lists, blockquotes (→ bordered, shaded, italic
 * "read aloud" boxes — the module convention that marks player-facing prose),
 * and **tables** (docs/17 row 157). HTML fragments are IGNORED (documented
 * limit, below); fenced code blocks render as plain monospaced paragraphs.
 * Wiki-links (08 M4-D) `[[Name]]` / `[[Name|display]]` render as bold display
 * text.
 *
 * TABLES, and the rule that shapes everything here: **this module never
 * deletes a line of the text it is given.** A pipe-delimited line is either a
 * real table — a row of cells, with the `| --- |` delimiter row deciding
 * whether the line above it is its header — or it is literal text rendering as
 * the paragraph/bullet/heading/quote it always was. Until row 157 the opposite
 * held: `sanitizeLine` turned ANY line opening and closing with a pipe into the
 * empty string, so a table row vanished at parse time with no problem, no
 * placeholder and no toast — the documented limit this reverses. A CELL is
 * never dropped either (a ragged row is padded with empty cells, and a row
 * wider than the header widens the table), and a pipe block the parser cannot
 * recognise prints as text rather than being silently swallowed, which is why
 * no table failure needs a `ModulePdfProblem` (docs/17 row 157).
 */

export interface InlineRun {
  text: string;
  bold?: boolean;
  italics?: boolean;
  /**
   * Where this run's `[[wiki-link]]` prints, when the caller can answer that
   * (docs/19 §7: *"Every reference in the text is an internal link to the
   * thing it names"*). Render-time only, and absent for every caller that
   * passes no resolver — this module has no idea what a destination is, so the
   * caller owns the answer through `MdRenderOptions.destinationFor`.
   */
  linkToDestination?: string;
}

/**
 * What a caller may know that this renderer cannot: where a wiki-link's name
 * prints in the document being built. ONE hook, because the rule for WHICH row
 * a name resolves to is the reader's own resolver (`lib/wikilinks.resolveWikiLink`)
 * and must stay with the caller that owns the artifact pool — a second
 * resolution rule inside a markdown renderer is exactly the drift docs/18 §2
 * forbids (the chip renderer and the PDF must name the same row).
 */
export interface MdRenderOptions {
  /** The destination a `[[name]]` prints at, or `undefined` when the document
   * has none (an unresolved name, or a row this document does not print): then
   * the run stays bold display text and no link is emitted, because pdfmake
   * throws on a `linkToDestination` no node carries. */
  destinationFor?: (name: string) => string | undefined;
}

export type MdBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; runs: InlineRun[] }
  | { kind: 'paragraph'; runs: InlineRun[] }
  | { kind: 'list'; ordered: boolean; items: InlineRun[][] }
  | { kind: 'quote'; runs: InlineRun[] }
  | { kind: 'fence'; text: string }
  | MdTableBlock;

/**
 * A markdown table (docs/17 row 157), three levels deep because a table really
 * has three: the block holds ROWS, a row holds CELLS, and a cell holds inline
 * RUNS (bold/italic/`code`/wiki-links — the same `InlineRun`s every other kind
 * carries). `header` is the row ABOVE the `| --- |` delimiter row, or `null`
 * when the delimiter row came FIRST — a table written without a header, which
 * renders without one rather than inventing a header from its first data row.
 * `rows` is every OTHER row, in the order the text carries them, one entry per
 * line: a row is never merged, reordered or skipped.
 *
 * The block carries no widths, no bold and no layout: what the markdown SAYS
 * is cells, and how they print is `mdToPdfmakeContent`'s business, so a
 * consumer of the union (a pin, a future text export) reads the text and not
 * a rendering decision.
 */
export interface MdTableBlock {
  kind: 'table';
  header: InlineRun[][] | null;
  rows: InlineRun[][][];
}

/** Parses inline `**bold**`, `*italic*` / `_italic_`, `` `code` ``, and
 * `[[wiki-links]]` (→ bold display text) runs. With `options.destinationFor` a
 * wiki run also carries where its name prints (docs/19 §7). */
export function parseInline(text: string, options: MdRenderOptions = {}): InlineRun[] {
  const runs: InlineRun[] = [];
  const pattern = /(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(`[^`]+`)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index > last) pushWithWiki(text.slice(last, index), runs, options);
    const token = match[0];
    if (token.startsWith('**')) {
      runs.push({ text: token.slice(2, -2), bold: true });
    } else if (token.startsWith('`')) {
      runs.push({ text: token.slice(1, -1) });
    } else {
      runs.push({ text: token.slice(1, -1), italics: true });
    }
    last = index + token.length;
  }
  if (last < text.length) pushWithWiki(text.slice(last), runs, options);
  return runs.length === 0 ? [{ text: '' }] : runs;
}

/** Appends a text slice, turning any `[[wiki-link]]` into a bold run — linked
 * to the destination the caller's resolver names, when it names one. Loops
 * with `exec` on ONE string, so it reads the shared NON-global
 * `lib/wikilinks.WIKI_LINK_TOKEN`: a global pattern would carry `lastIndex`
 * between calls and silently skip every second link (docs/17 row 145). */
function pushWithWiki(text: string, runs: InlineRun[], options: MdRenderOptions): void {
  let rest = text;
  for (;;) {
    const match = WIKI_LINK_TOKEN.exec(rest);
    if (match?.index === undefined) break;
    if (match.index > 0) runs.push({ text: rest.slice(0, match.index) });
    const name = (match[1] ?? '').trim();
    const display = (match[2] ?? '').trim();
    const destination = options.destinationFor?.(name);
    runs.push({
      text: display === '' ? name : display,
      bold: true,
      ...(destination === undefined ? {} : { linkToDestination: destination }),
    });
    rest = rest.slice(match.index + match[0].length);
  }
  if (rest !== '') runs.push({ text: rest });
}

/**
 * Strips HTML tags — the ONE remaining renderer limit on markup (07-MILESTONE-3
 * M3-D; tables left this list in docs/17 row 157). It deliberately does NOT
 * touch pipes: a line's table-ness is decided at the BLOCK level by
 * `readTable`, never by deleting a line here, because deleting a line here is
 * exactly how a table row used to disappear without a trace (the row-157
 * defect). Anything this function empties prints as an empty block only when
 * the text really was empty.
 */
function sanitizeLine(line: string): string {
  return line.replaceAll(/<[^>]*>/g, '');
}

/** A line written as a pipe-delimited ROW: it opens AND closes with `|`, the
 * shape this module has always recognised. A line that merely CONTAINS a pipe
 * (`a | b`) is prose and always was. */
const PIPE_ROW = /^\s*\|.*\|\s*$/;

/** One delimiter-row cell: `---`, `:---`, `---:` or `:---:`. */
const DELIMITER_CELL = /^:?-+:?$/;

/** Whether a row is the `| --- |` DELIMITER row that makes the line above it a
 * header. Every cell has to be a delimiter, so a data row that happens to hold
 * a dash is never mistaken for one. */
function isDelimiterRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => DELIMITER_CELL.test(cell));
}

/**
 * One pipe row as CELLS. The outer pipes are the row's frame and are not
 * content; `\|` inside a cell is an ESCAPED pipe — it belongs to the cell's
 * text and must not split the row (so `| a \| b | c |` is TWO cells, `a | b`
 * and `c`, not three). A backslash that escapes anything else stays literal.
 */
function splitRow(line: string): string[] {
  const inner = line.trim().slice(1, -1);
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] ?? '';
    if (char === '\\' && inner[index + 1] === '|') {
      cell += '|';
      index += 1;
      continue;
    }
    if (char === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/** One parsed table and the index of its LAST row line. */
interface ReadTable {
  block: MdTableBlock;
  lastIndex: number;
}

/**
 * Reads a markdown table starting at `start`, or answers `null` when those
 * lines are not a table at all.
 *
 * A table is a pipe row followed by a `| --- |` DELIMITER row (that header row
 * renders as the table's header), OR a delimiter row FIRST (a table written
 * without a header) — and nothing else. A pipe block with no delimiter row is
 * NOT a table: it is literal text, which is the deliberate reversal of the old
 * behaviour, where any pipe line was deleted on sight. A LONE delimiter row
 * with no cell-bearing row under it is not a table either (there is no content
 * to render and a headerless empty table would be a node that prints nothing);
 * it prints as the text it is written as.
 */
function readTable(lines: readonly string[], start: number, options: MdRenderOptions): ReadTable | null {
  const first = lines[start];
  if (first === undefined || !PIPE_ROW.test(first)) return null;
  const firstCells = splitRow(first);
  const second = lines[start + 1];
  const secondCells =
    second !== undefined && PIPE_ROW.test(second) ? splitRow(second) : null;

  const firstIsDelimiter = isDelimiterRow(firstCells);
  const secondIsDelimiter = secondCells !== null && isDelimiterRow(secondCells);
  if (!firstIsDelimiter && !secondIsDelimiter) return null;

  const headerCells = firstIsDelimiter ? null : firstCells;
  const rows: string[][] = [];
  let index = firstIsDelimiter ? start + 1 : start + 2;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || !PIPE_ROW.test(line)) break;
    rows.push(splitRow(line));
  }
  if (headerCells === null && rows.length === 0) return null;

  const cellsToRuns = (cells: readonly string[]): InlineRun[][] =>
    cells.map((cell) => parseInline(sanitizeLine(cell), options));
  return {
    block: {
      kind: 'table',
      header: headerCells === null ? null : cellsToRuns(headerCells),
      rows: rows.map(cellsToRuns),
    },
    lastIndex: index - 1,
  };
}

export function parseMarkdown(markdown: string, options: MdRenderOptions = {}): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = markdown.split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  function flushParagraph(): void {
    const text = sanitizeLine(paragraph.join(' ')).trim();
    paragraph = [];
    if (text !== '') blocks.push({ kind: 'paragraph', runs: parseInline(text, options) });
  }

  function flushList(): void {
    if (list !== null && list.items.length > 0) {
      blocks.push({
        kind: 'list',
        ordered: list.ordered,
        items: list.items.map((item) => parseInline(sanitizeLine(item).trim(), options)),
      });
    }
    list = null;
  }

  let fence: string[] | null = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const raw = lines[lineIndex] ?? '';
    if (/^\s*```/.test(raw)) {
      if (fence === null) {
        flushParagraph();
        flushList();
        fence = [];
      } else {
        blocks.push({ kind: 'fence', text: fence.join('\n') });
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      fence.push(raw);
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(raw);
    if (heading !== null) {
      flushParagraph();
      flushList();
      const level = (heading[1] ?? '').length as 1 | 2 | 3;
      blocks.push({
        kind: 'heading',
        level,
        runs: parseInline(sanitizeLine(heading[2] ?? ''), options),
      });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(raw);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(raw);
    if (bullet !== null || ordered !== null) {
      flushParagraph();
      const orderedList = ordered !== null;
      if (list !== null && list.ordered !== orderedList) flushList();
      list ??= { ordered: orderedList, items: [] };
      list.items.push(bullet?.[1] ?? ordered?.[1] ?? '');
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(raw);
    if (quote !== null) {
      flushParagraph();
      flushList();
      blocks.push({ kind: 'quote', runs: parseInline(sanitizeLine(quote[1] ?? ''), options) });
      continue;
    }

    // A TABLE is a block of its own (docs/17 row 157). It is asked for AFTER
    // the heading/bullet/quote shapes, so `## | a | b |` stays a heading whose
    // text carries pipes and `- | a | b |` stays a bullet with that text —
    // deliberate decisions, both of them reversed, because the old code
    // emptied both. An open list is FLUSHED rather than swallowed: a table
    // written under a bullet is not list content in this line-based model, so
    // it prints as a real table immediately after the list, and the bullet
    // keeps its own text instead of becoming the empty bullet it used to be.
    const table = readTable(lines, lineIndex, options);
    if (table !== null) {
      flushParagraph();
      flushList();
      blocks.push(table.block);
      lineIndex = table.lastIndex;
      continue;
    }

    if (sanitizeLine(raw).trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    paragraph.push(raw);
  }
  flushParagraph();
  flushList();
  if (fence?.length) {
    blocks.push({ kind: 'fence', text: fence.join('\n') });
  }
  return blocks;
}

/** The module's own rule colour, the one the read-aloud box already draws in. */
const TABLE_RULE = '#9a7b4f';

/** The header row's shading — the read-aloud fill, so a header reads as a
 * header without being a second visual language. */
const TABLE_HEADER_FILL = '#f6efe2';

/**
 * A markdown table's pdfmake LAYOUT. Written as an object of functions rather
 * than one of pdfmake's built-in layout NAMES on purpose: the page model's
 * height estimator measures a table by CALLING these (lib/pdfPageModel
 * `tableHeight` reads `paddingTop`/`paddingBottom` off the node's layout), and
 * a named layout string tells it nothing — the estimator would then measure a
 * table as padding-free and under-state its height, which is the unsafe
 * direction for a fit rule (docs/19 §3).
 */
const TABLE_LAYOUT: TableLayout = {
  hLineWidth: () => 0.5,
  vLineWidth: () => 0.5,
  hLineColor: () => TABLE_RULE,
  vLineColor: () => TABLE_RULE,
  paddingLeft: () => 6,
  paddingRight: () => 6,
  paddingTop: () => 3,
  paddingBottom: () => 3,
};

/** Renders parsed blocks as pdfmake content; blockquotes become read-aloud boxes.
 * `options.destinationFor` is the ONE hook through which a wiki-link's name
 * becomes an INTERNAL LINK to where it prints (docs/19 §7, docs/17 row 151);
 * without it every run is what it always was. */
export function mdToPdfmakeContent(markdown: string, options: MdRenderOptions = {}): Content[] {
  return parseMarkdown(markdown, options).map((block): Content => {
    switch (block.kind) {
      case 'heading': {
        const style = block.level === 1 ? 'h1' : block.level === 2 ? 'h2' : 'h3';
        return { text: block.runs, style };
      }
      case 'paragraph':
        return { text: block.runs };
      case 'fence':
        return { text: block.text, style: 'code' };
      // A table becomes a REAL pdfmake table (docs/17 row 157). Nothing is
      // dropped on the way: the column count is the WIDEST row's (so a row
      // carrying more cells than the header widens the table rather than
      // losing its tail), and EVERY row — header included — is padded to that
      // width with explicit empty cells, so pdfmake is never left to guess
      // what a short row meant.
      case 'table': {
        const columns = Math.max(
          block.header?.length ?? 0,
          ...block.rows.map((row) => row.length),
          1,
        );
        const rowCells = (cells: readonly InlineRun[][], header: boolean): TableCell[] => {
          const out: TableCell[] = cells.map((runs) =>
            header
              ? { text: runs, bold: true, fillColor: TABLE_HEADER_FILL }
              : { text: runs },
          );
          while (out.length < columns) out.push({ text: '' });
          return out;
        };
        const body: TableCell[][] = [];
        if (block.header !== null) body.push(rowCells(block.header, true));
        for (const row of block.rows) body.push(rowCells(row, false));
        return {
          table: {
            // `headerRows` is what makes pdfmake REPEAT the header when a table
            // crosses a page break; without it a long table would print its
            // header once and leave the rest unlabelled.
            ...(block.header === null ? {} : { headerRows: 1 }),
            widths: Array.from({ length: columns }, (): '*' => '*'),
            body,
          },
          layout: TABLE_LAYOUT,
          margin: [0, 4, 0, 4],
        };
      }
      case 'list': {
        const items: Content[] = block.items.map((runs) => ({ text: runs }));
        return block.ordered ? { ol: items, margin: [0, 2, 0, 2] } : { ul: items, margin: [0, 2, 0, 2] };
      }
      case 'quote':
        return {
          table: {
            widths: ['*'],
            body: [
              [
                {
                  text: block.runs.map((run) => ({ ...run, italics: true })),
                  style: 'readAloud',
                },
              ],
            ],
          },
          layout: {
            hLineWidth: () => 1,
            vLineWidth: () => 1,
            hLineColor: () => '#9a7b4f',
            vLineColor: () => '#9a7b4f',
            paddingLeft: () => 8,
            paddingRight: () => 8,
            paddingTop: () => 6,
            paddingBottom: () => 6,
          },
          margin: [0, 4, 0, 4],
        };
    }
  });
}
