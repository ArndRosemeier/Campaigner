import type { Content } from 'pdfmake/interfaces';

/**
 * Markdown → pdfmake content (07-MILESTONE-3 M3-D): paragraphs, bold/italic,
 * h1–h3, bullet/numbered lists, and blockquotes (→ bordered, shaded, italic
 * "read aloud" boxes — the module convention that marks player-facing prose).
 * HTML fragments and tables are IGNORED (documented limit); fenced code
 * blocks render as plain monospaced paragraphs.
 */

export interface InlineRun {
  text: string;
  bold?: boolean;
  italics?: boolean;
}

export type MdBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; runs: InlineRun[] }
  | { kind: 'paragraph'; runs: InlineRun[] }
  | { kind: 'list'; ordered: boolean; items: InlineRun[][] }
  | { kind: 'quote'; runs: InlineRun[] }
  | { kind: 'fence'; text: string };

/** Parses inline `**bold**`, `*italic*` / `_italic_`, and `` `code` `` runs. */
export function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const pattern = /(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(`[^`]+`)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index > last) runs.push({ text: text.slice(last, index) });
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
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length === 0 ? [{ text: '' }] : runs;
}

/** Strips HTML tags and table rows (documented renderer limit). */
function sanitizeLine(line: string): string {
  if (/^\s*\|.*\|\s*$/.test(line)) return '';
  return line.replaceAll(/<[^>]*>/g, '');
}

export function parseMarkdown(markdown: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = markdown.split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  function flushParagraph(): void {
    const text = sanitizeLine(paragraph.join(' ')).trim();
    paragraph = [];
    if (text !== '') blocks.push({ kind: 'paragraph', runs: parseInline(text) });
  }

  function flushList(): void {
    if (list !== null && list.items.length > 0) {
      blocks.push({
        kind: 'list',
        ordered: list.ordered,
        items: list.items.map((item) => parseInline(sanitizeLine(item).trim())),
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
      blocks.push({ kind: 'heading', level, runs: parseInline(sanitizeLine(heading[2] ?? '')) });
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
      blocks.push({ kind: 'quote', runs: parseInline(sanitizeLine(quote[1] ?? '')) });
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

/** Renders parsed blocks as pdfmake content; blockquotes become read-aloud boxes. */
export function mdToPdfmakeContent(markdown: string): Content[] {
  return parseMarkdown(markdown).map((block): Content => {
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
