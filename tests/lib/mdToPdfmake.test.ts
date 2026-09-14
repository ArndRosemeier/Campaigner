import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { mdToPdfmakeContent, parseInline, parseMarkdown } from '@/lib/mdToPdfmake';

/** The BODY of the FIRST node's table — what pdfmake would actually lay out. */
function tableBody(content: readonly unknown[]): unknown[] {
  const node = content[0] as { table?: { body?: unknown[] } } | undefined;
  return node?.table?.body ?? [];
}

/**
 * Markdown → pdfmake renderer (07-MILESTONE-3 M3-D): headings, inline runs,
 * lists, read-aloud blockquote boxes, and — since docs/17 row 157 — TABLES.
 * HTML is still ignored (that limit stands; the table limit was REVERSED).
 *
 * The reversal is pinned in BOTH directions: the pin that used to assert a
 * table row was deleted now asserts it PRINTS (the same input, the opposite
 * claim), and every awkward case the row-157 brief names has its own pin
 * below, because "which shape wins" is a decision here, not an accident.
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

  // THE REVERSED PIN (docs/17 row 157). BEFORE this slice the name was
  // `it('ignores HTML tags (strips markup) and table rows (documented limit)')`
  // and its second half asserted the table lines produced NO block at all — the
  // deliberate limit docs/07 §"the module's own vocabulary" declared. The HTML
  // half is unchanged; the table half now asserts the opposite, on the same
  // input, because a row that vanishes is the defect this slice exists to end.
  it('strips HTML tags, and renders a table row instead of deleting it (the row-157 reversal)', () => {
    const blocks = parseMarkdown('<div>hidden</div>\n| a | b |\n|---|---|\n| c | d |\n\nVisible text.');
    expect(blocks).toEqual([
      { kind: 'paragraph', runs: [{ text: 'hidden' }] },
      {
        kind: 'table',
        header: [[{ text: 'a' }], [{ text: 'b' }]],
        rows: [[[{ text: 'c' }], [{ text: 'd' }]]],
      },
      { kind: 'paragraph', runs: [{ text: 'Visible text.' }] },
    ]);
    // NON-VACUITY, spelled out: the CELL TEXT is in the parsed document. The
    // old pin passed while this expectation was false; a parser that dropped
    // the row (or the whole table) can no longer pass this test.
    expect(JSON.stringify(blocks)).toContain('"c"');
    expect(JSON.stringify(blocks)).toContain('"d"');
  });

  it('reads the header row, the delimiter row and the body rows in the text’s own order', () => {
    const blocks = parseMarkdown('| Item | Value |\n| --- | --- |\n| Silver bell | 40 gp |\n| Rope | 2 gp |');
    expect(blocks).toEqual([
      {
        kind: 'table',
        header: [[{ text: 'Item' }], [{ text: 'Value' }]],
        rows: [
          [[{ text: 'Silver bell' }], [{ text: '40 gp' }]],
          [[{ text: 'Rope' }], [{ text: '2 gp' }]],
        ],
      },
    ]);
  });

  it('renders a delimiter-FIRST table without a header, never inventing one from its first row', () => {
    const blocks = parseMarkdown('| --- | --- |\n| Silver bell | 40 gp |');
    expect(blocks).toEqual([
      { kind: 'table', header: null, rows: [[[{ text: 'Silver bell' }], [{ text: '40 gp' }]]] },
    ]);
  });

  it('pads a ragged row with empty cells instead of dropping it', () => {
    // Fewer cells than the header: the row keeps its one cell and gains an
    // empty one — a refusal would lose "40 gp" from the document, which is the
    // failure mode this slice exists to end.
    const blocks = parseMarkdown('| Item | Value |\n| --- | --- |\n| Silver bell |');
    expect(blocks).toEqual([
      {
        kind: 'table',
        header: [[{ text: 'Item' }], [{ text: 'Value' }]],
        rows: [[[{ text: 'Silver bell' }]]],
      },
    ]);
    const body = tableBody(mdToPdfmakeContent('| Item | Value |\n| --- | --- |\n| Silver bell |'));
    expect(body).toEqual([
      [{ text: [{ text: 'Item' }], bold: true, fillColor: '#f6efe2' }, { text: [{ text: 'Value' }], bold: true, fillColor: '#f6efe2' }],
      [{ text: [{ text: 'Silver bell' }] }, { text: '' }],
    ]);
  });

  it('widens the table for a row carrying MORE cells than the header, keeping every cell', () => {
    const content = mdToPdfmakeContent('| a | b |\n| --- | --- |\n| c | d | e |');
    const node = content[0] as { table?: { widths?: unknown[] } };
    // Three columns, because the widest ROW has three — a renderer that sized
    // the table from the header would silently drop `e`.
    expect(node.table?.widths).toEqual(['*', '*', '*']);
    expect(tableBody(content)).toEqual([
      [
        { text: [{ text: 'a' }], bold: true, fillColor: '#f6efe2' },
        { text: [{ text: 'b' }], bold: true, fillColor: '#f6efe2' },
        { text: '' },
      ],
      [{ text: [{ text: 'c' }] }, { text: [{ text: 'd' }] }, { text: [{ text: 'e' }] }],
    ]);
  });

  it('keeps an escaped pipe inside one cell', () => {
    const blocks = parseMarkdown('| Roll | Result |\n| --- | --- |\n| 1 \\| 2 | Either |');
    expect(blocks).toEqual([
      {
        kind: 'table',
        header: [[{ text: 'Roll' }], [{ text: 'Result' }]],
        rows: [[[{ text: '1 | 2' }], [{ text: 'Either' }]]],
      },
    ]);
  });

  it('prints a pipe line with NO delimiter row as literal text, never deletes it', () => {
    // The old code emptied this line (and so made it a paragraph break). The
    // deliberate change: a pipe block that is not a table is TEXT.
    expect(parseMarkdown('The cult keeps its hoard here.\n\n| Item | Value |\n\nThe bell is cursed.')).toEqual([
      { kind: 'paragraph', runs: [{ text: 'The cult keeps its hoard here.' }] },
      { kind: 'paragraph', runs: [{ text: '| Item | Value |' }] },
      { kind: 'paragraph', runs: [{ text: 'The bell is cursed.' }] },
    ]);
  });

  it('prints a LONE delimiter row as literal text too (a headerless table with no rows is not a table)', () => {
    expect(parseMarkdown('| --- | --- |')).toEqual([
      { kind: 'paragraph', runs: [{ text: '| --- | --- |' }] },
    ]);
  });

  it('reads a table as the FIRST block and as the LAST block', () => {
    const first = parseMarkdown('| a | b |\n| --- | --- |\n| c | d |');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: 'table' });
    const last = parseMarkdown('Intro.\n\n| a | b |\n| --- | --- |\n| c | d |');
    expect(last).toEqual([
      { kind: 'paragraph', runs: [{ text: 'Intro.' }] },
      {
        kind: 'table',
        header: [[{ text: 'a' }], [{ text: 'b' }]],
        rows: [[[{ text: 'c' }], [{ text: 'd' }]]],
      },
    ]);
  });

  it('renders a table written under a bullet as its own table, and the bullet keeps its own text', () => {
    const blocks = parseMarkdown(
      '- The hoard:\n  | Item | Value |\n  | --- | --- |\n  | Silver bell | 40 gp |',
    );
    expect(blocks).toEqual([
      { kind: 'list', ordered: false, items: [[{ text: 'The hoard:' }]] },
      {
        kind: 'table',
        header: [[{ text: 'Item' }], [{ text: 'Value' }]],
        rows: [[[{ text: 'Silver bell' }], [{ text: '40 gp' }]]],
      },
    ]);
  });

  it('prints a bullet whose whole text is a pipe line, instead of the empty bullet it used to be', () => {
    // The empty-bullet defect verbatim: `flushList` sanitized the item the same
    // way, so this bullet printed a marker with nothing after it.
    const blocks = parseMarkdown('- | a | b |');
    expect(blocks).toEqual([{ kind: 'list', ordered: false, items: [[{ text: '| a | b |' }]] }]);
    expect(mdToPdfmakeContent('- | a | b |')).toEqual([
      { ul: [{ text: [{ text: '| a | b |' }] }], margin: [0, 2, 0, 2] },
    ]);
  });

  it('keeps the pipes of a heading written with them, instead of emptying the heading', () => {
    // Was an EMPTY heading (the same `sanitizeLine` deletion, on the heading
    // path): a heading is a heading — markdown has no table inside one — so its
    // text is what it says.
    expect(parseMarkdown('## | a | b |')).toEqual([
      { kind: 'heading', level: 2, runs: [{ text: '| a | b |' }] },
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

  it('maps a table to a REAL pdfmake table: a header row marked for repetition, equal widths, every cell', () => {
    const content = mdToPdfmakeContent('| Item | Value |\n| --- | --- |\n| Silver bell | 40 gp |');
    expect(content).toHaveLength(1);
    const node = content[0] as {
      table?: { headerRows?: number; widths?: unknown[]; body?: unknown[] };
      layout?: unknown;
    };
    // `headerRows: 1` is what makes pdfmake REPEAT the header when the table
    // crosses a page break — a table that crossed a page without it would print
    // its column labels once and leave the rest of the rows unlabelled.
    expect(node.table?.headerRows).toBe(1);
    expect(node.table?.widths).toEqual(['*', '*']);
    expect(node.table?.body).toHaveLength(2);
    // The header cells are bold AND shaded at RENDER time — the parsed block
    // carries no styling, so a consumer of the union reads text, not a
    // rendering decision.
    expect(tableBody(content)).toEqual([
      [
        { text: [{ text: 'Item' }], bold: true, fillColor: '#f6efe2' },
        { text: [{ text: 'Value' }], bold: true, fillColor: '#f6efe2' },
      ],
      [{ text: [{ text: 'Silver bell' }] }, { text: [{ text: '40 gp' }] }],
    ]);
    // The layout is an OBJECT of functions, not one of pdfmake's layout NAMES:
    // lib/pdfPageModel's height estimator measures a table by CALLING the
    // layout's paddings, so a named layout would measure as padding-free.
    const layout = node.layout as Record<string, unknown>;
    expect(layout.paddingTop).toBeTypeOf('function');
    expect(layout.paddingBottom).toBeTypeOf('function');
  });

  it('never lets a malformed pipe block disappear: it lands in the definition as text', () => {
    // A malformed table cannot be a table, and it must not be a deletion
    // either — this is the rule-1 pin of docs/17 row 157. Every one of these is
    // a shape the old renderer swallowed whole.
    for (const malformed of ['| a | b', '| a | b |', '| --- |', 'a | b | c']) {
      const content = mdToPdfmakeContent(malformed);
      expect(content).toHaveLength(1);
      expect(JSON.stringify(content)).toContain(malformed);
    }
    // …and the same input the defect report used: prose, a pipe block with no
    // delimiter row, prose. Nothing between the two prose lines may vanish.
    const content = mdToPdfmakeContent(
      'The cult keeps its hoard here.\n\n| Item | Value |\n\nThe bell is cursed.',
    );
    expect(content.map((node) => (node as { text?: unknown }).text)).toEqual([
      [{ text: 'The cult keeps its hoard here.' }],
      [{ text: '| Item | Value |' }],
      [{ text: 'The bell is cursed.' }],
    ]);
  });
});

// --- The "exactly one" half: the SOURCE (AGENTS §Centralization) --------------

const SRC = 'src';

function srcFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), dir)).sort()) {
    const path = `${dir}/${entry}`;
    if (statSync(join(process.cwd(), path)).isDirectory()) out.push(...srcFiles(path));
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/** Source lines holding an ESCAPED PIPE in code — the spelling a pipe GRAMMAR
 * needs (comment lines are skipped: a doc comment naming `\|` is prose, not a
 * pattern). */
function escapedPipeLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.includes('\\|'))
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    });
}

/**
 * Where a pipe grammar may be SPELLED. TWO sites, and the pair is the point:
 * `wikilinks.ts` carries the wiki-token grammar's own `\|` alternation, and
 * `mdToPdfmake.ts` carries `PIPE_ROW` — the ONE markdown-table row grammar
 * (docs/17 row 157). A THIRD site is a second table parser being born, which is
 * exactly what docs/18 §2's NOT-Z column forbids, and this is the pin that goes
 * red when it appears (AGENTS §Centralization 2: never centralize by prose
 * alone).
 */
const DECLARED_ESCAPED_PIPE_SITES: Readonly<Record<string, number>> = {
  'src/lib/wikilinks.ts': 1,
  'src/lib/mdToPdfmake.ts': 1,
};

/**
 * Every PRODUCTION caller of the seam, by file. The markdown→pdfmake renderer
 * has exactly three doors in the module book — `artifactProse` (every artifact
 * body), `premiseContent`, `partTextContent` — and they all live in
 * `modulePdf.ts`. A markdown table rendered anywhere else would be a second
 * renderer, not a caller: `mdToPdfmakeContent(` appearing in a new file, or a
 * fourth time, reds this.
 */
const DECLARED_CONTENT_CALLERS: Readonly<Record<string, number>> = {
  'src/lib/modulePdf.ts': 3,
};

describe('the markdown table grammar and its renderer live in ONE place (SOURCE SCAN)', () => {
  it('no second pipe-row grammar exists outside the declared sites', () => {
    const files = srcFiles();
    // Non-vacuity: the walk must see the whole `src/` tree, and the seam must
    // really carry the idiom this pin is about.
    expect(files.length).toBeGreaterThan(200);
    const seam = readFileSync(join(process.cwd(), 'src/lib/mdToPdfmake.ts'), 'utf8');
    expect(escapedPipeLines(seam)).toHaveLength(1);
    expect(seam).toContain('const PIPE_ROW = /^\\s*\\|.*\\|\\s*$/;');

    const found: Record<string, number> = {};
    for (const file of files) {
      const lines = escapedPipeLines(readFileSync(join(process.cwd(), file), 'utf8'));
      if (lines.length > 0) found[file] = lines.length;
    }
    expect(found).toEqual(DECLARED_ESCAPED_PIPE_SITES);
    // Rot check: a declared site that no longer holds its line is a stale
    // carve-out licensing the shape it excused.
    for (const site of Object.keys(DECLARED_ESCAPED_PIPE_SITES)) {
      expect(found[site], `${site} no longer holds an escaped pipe`).toBeDefined();
    }
  });

  it('the markdown→pdfmake renderer is reached through its declared callers and no others', () => {
    const files = srcFiles();
    const found: Record<string, number> = {};
    for (const file of files) {
      if (file === 'src/lib/mdToPdfmake.ts') continue; // the definition itself
      const count = readFileSync(join(process.cwd(), file), 'utf8')
        .split('mdToPdfmakeContent(')
        .length - 1;
      if (count > 0) found[file] = count;
    }
    expect(found).toEqual(DECLARED_CONTENT_CALLERS);
  });
});
