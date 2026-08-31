import { describe, expect, it } from 'vitest';

import { mdToPdfmakeContent, parseInline, parseMarkdown } from '@/lib/mdToPdfmake';

/**
 * Markdown → pdfmake renderer (07-MILESTONE-3 M3-D): headings, inline runs,
 * lists, and read-aloud blockquote boxes; HTML/tables are ignored.
 */

describe('parseInline', () => {
  it('splits bold, italic, and code runs', () => {
    expect(parseInline('plain **bold** and *soft* and `code`')).toEqual([
      { text: 'plain ' },
      { text: 'bold', bold: true },
      { text: ' and ' },
      { text: 'soft', italics: true },
      { text: ' and ' },
      { text: 'code' },
    ]);
  });

  it('returns a single run for plain text', () => {
    expect(parseInline('nothing special')).toEqual([{ text: 'nothing special' }]);
  });
});

describe('parseMarkdown', () => {
  it('parses headings, paragraphs, and lists', () => {
    const blocks = parseMarkdown('# Title\n\nIntro line.\n\n- one\n- two\n\n1. first\n2. second');
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, runs: [{ text: 'Title' }] },
      { kind: 'paragraph', runs: [{ text: 'Intro line.' }] },
      { kind: 'list', ordered: false, items: [[{ text: 'one' }], [{ text: 'two' }]] },
      { kind: 'list', ordered: true, items: [[{ text: 'first' }], [{ text: 'second' }]] },
    ]);
  });

  it('renders blockquotes as read-aloud boxes and fences as code', () => {
    const blocks = parseMarkdown('> The tide waits for no one.\n\n```\ncode line\n```');
    expect(blocks[0]).toEqual({
      kind: 'quote',
      runs: [{ text: 'The tide waits for no one.' }],
    });
    expect(blocks[1]).toEqual({ kind: 'fence', text: 'code line' });
  });

  it('ignores HTML tags (strips markup) and table rows (documented limit)', () => {
    const blocks = parseMarkdown('<div>hidden</div>\n| a | b |\n|---|---|\n\nVisible text.');
    expect(blocks).toEqual([
      { kind: 'paragraph', runs: [{ text: 'hidden' }] },
      { kind: 'paragraph', runs: [{ text: 'Visible text.' }] },
    ]);
  });
});

describe('mdToPdfmakeContent', () => {
  it('maps blockquotes to bordered read-aloud tables', () => {
    const content = mdToPdfmakeContent('> Read aloud, please.');
    const node = content[0] as { table?: { body?: { text: unknown }[][] } };
    expect(node.table).toBeDefined();
    const cell = node.table?.body?.[0]?.[0];
    expect(cell?.text).toEqual([{ text: 'Read aloud, please.', italics: true }]);
  });

  it('maps ordered lists to ol', () => {
    const content = mdToPdfmakeContent('1. alpha\n2. beta');
    expect(content[0]).toHaveProperty('ol');
    expect(content[0]).not.toHaveProperty('ul');
  });
});
