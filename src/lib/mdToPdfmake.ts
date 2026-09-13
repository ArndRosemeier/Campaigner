import type { Content } from 'pdfmake/interfaces';

import { WIKI_LINK_TOKEN } from '@/lib/wikilinks';

/**
 * Markdown → pdfmake content (07-MILESTONE-3 M3-D): paragraphs, bold/italic,
 * h1–h3, bullet/numbered lists, and blockquotes (→ bordered, shaded, italic
 * "read aloud" boxes — the module convention that marks player-facing prose).
 * HTML fragments and tables are IGNORED (documented limit); fenced code
 * blocks render as plain monospaced paragraphs. Wiki-links (08 M4-D)
 * `[[Name]]` / `[[Name|display]]` render as bold display text.
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
  | { kind: 'fence'; text: string };

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

/** Strips HTML tags and table rows (documented renderer limit). */
function sanitizeLine(line: string): string {
  if (/^\s*\|.*\|\s*$/.test(line)) return '';
  return line.replaceAll(/<[^>]*>/g, '');
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
  for (const raw of lines) {
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
