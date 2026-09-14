import 'fake-indexeddb/auto';

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { modulePath } from '@/app/routes';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { saveModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type AnyArtifact,
  type Campaign,
  type Id,
} from '@/domain';
import { MarkdownBody } from '@/features/campaign/components/markdown-body';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import { parseMarkdown } from '@/lib/mdToPdfmake';
import { clearDatabase } from '../db/helpers';

/**
 * A markdown table in the APP's one markdown renderer (docs/17 row 158, docs/18
 * §2.3). The module PDF renders tables since row 157 while the app still showed
 * a table as literal `| … |` pipe-mush, because the app's renderer is a
 * different renderer by design. The owner was asked directly and answered:
 * *"Yes — render tables in the app as well."* — so the disagreement between the
 * two surfaces became a defect to fix, not a design choice to preserve.
 *
 * `remark-gfm` is added to THIS pipeline (`WikiMarkdown`) and to no other, so
 * one change reaches all four surfaces that render chips: the module reader,
 * the peek modal, the editor preview and the board cards. One of those is driven
 * here as a REAL surface (the reader page through the app router, and the
 * artifact editor's Preview toggle) rather than only the pure component, because
 * "the pure renderer works" is not the claim the owner made.
 *
 * THE PDF AND THE APP ARE TWO GRAMMARS, and the pins below say where they
 * genuinely disagree instead of faking parity (docs/17 row 158 records each):
 * GFM has no headerless table at all, GFM truncates a row that is WIDER than
 * the header (the PDF widens the table instead), and a bullet-following pipe
 * block is a table in GFM only when the lines are INDENTED into the list item.
 * What the two MUST agree on, and do, is the rule the row-157 arc was really
 * about: **a pipe block never disappears** — every shape that is not a table
 * renders as the literal text it was written as.
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

afterEach(cleanup);

/* ------------------------------------------------------------------------ *
 * The shared renderer, driven directly
 * ------------------------------------------------------------------------ */

const TABLE = '| Item | Value |\n| --- | --- |\n| Silver bell | 40 gp |\n';

function mount(value: string, options: { artifacts?: readonly AnyArtifact[]; sourceOffsets?: boolean } = {}) {
  return render(
    <WikiMarkdown
      value={value}
      artifacts={options.artifacts ?? []}
      {...(options.sourceOffsets === true ? { sourceOffsets: true } : {})}
    />,
  );
}

function tableIn(root: HTMLElement): HTMLTableElement {
  const table = root.querySelector('table');
  if (table === null) throw new Error(`no <table> rendered; text was ${JSON.stringify(root.textContent)}`);
  return table;
}

function headerCells(table: HTMLElement): string[] {
  return Array.from(table.querySelectorAll('thead th')).map((cell) => cell.textContent);
}

function bodyRowCells(table: HTMLElement): string[][] {
  return Array.from(table.querySelectorAll('tbody tr')).map((row) =>
    Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent),
  );
}

function rootOf(container: HTMLElement): HTMLElement {
  const root = container.firstElementChild;
  if (root === null) throw new Error('the renderer rendered nothing');
  return root as HTMLElement;
}

describe('a markdown table renders as a real table (docs/17 row 158)', () => {
  it('renders a real <table> with the header row and the body rows in the text’s own order', () => {
    const { container } = mount(TABLE);
    const root = rootOf(container);
    const table = tableIn(root);

    // The header is the delimiter's row above it, in a real <thead>; the body
    // is a real <tbody>. Order is the text's own — never alphabetical, never
    // re-flowed.
    expect(headerCells(table)).toEqual(['Item', 'Value']);
    expect(bodyRowCells(table)).toEqual([['Silver bell', '40 gp']]);
    expect(table.querySelectorAll('thead')).toHaveLength(1);
    expect(table.querySelectorAll('tbody')).toHaveLength(1);
  });

  it('the OLD mush cannot pass: no table pin is satisfiable by the literal pipes', () => {
    // The defect this slice ends rendered the block as paragraph text whose
    // content WAS the markup. Three shapes, each asserted to be a REAL table
    // AND to carry no pipe and no delimiter row in its rendered text, so a
    // renderer that only "prints the row nicely" cannot pass.
    const shapes = [
      TABLE,
      '| a | b | c |\n| --- | --- | --- |\n| d |\n| e | f | g |\n',
      '| a | b |\n| :-- | --: |\n| c | d |\n',
    ];
    for (const value of shapes) {
      const { container } = mount(value);
      const root = rootOf(container);
      expect(tableIn(root), value).toBeInstanceOf(HTMLTableElement);
      const text = root.textContent;
      expect(text, value).not.toContain('|');
      expect(text, value).not.toContain('---');
    }
  });

  it('maps the delimiter row’s column ALIGNMENT onto the cells (GFM’s own extra)', () => {
    const { container } = mount('| a | b |\n| :-- | --: |\n| c | d |\n');
    const table = tableIn(rootOf(container));
    const header = Array.from(table.querySelectorAll('thead th'));
    // GFM carries `:---`/`---:` as an inline text-align on the cell; the table
    // element's own `text-left` class must NOT be what decides it.
    expect(header.map((cell) => cell.getAttribute('style'))).toEqual([
      'text-align: left;',
      'text-align: right;',
    ]);
  });

  it('keeps an escaped pipe inside ONE cell, instead of splitting the row on it', () => {
    const { container } = mount('| a | b |\n| --- | --- |\n| x \\| y | z |\n');
    const table = tableIn(rootOf(container));
    expect(bodyRowCells(table)).toEqual([['x | y', 'z']]);
  });

  it('pads a short row to the header’s width, and DROPS a cell beyond it — GFM’s rule, the PDF’s divergence recorded', () => {
    // The PDF renderer (row 157) WIDENS the table for a row carrying more
    // cells than the header, so no cell can be dropped. GFM truncates instead.
    // This is a real, deliberate divergence: faking parity would mean
    // hand-rolling a table grammar, which is exactly what the app must not do
    // (docs/18 §2.3). Both halves are pinned so the divergence cannot drift
    // unnoticed, and the short row's padding — the half that DOES agree — is
    // pinned beside it.
    const { container } = mount('| a | b | c |\n| --- | --- | --- |\n| d |\n| e | f | g | h |\n');
    const root = rootOf(container);
    const table = tableIn(root);
    expect(bodyRowCells(table)).toEqual([
      ['d', '', ''],
      ['e', 'f', 'g'],
    ]);
    // GFM's truncation, asserted rather than glossed: `h` is NOT in the table.
    expect(table.textContent).not.toContain('h');
  });

  it('wraps the table in its own horizontal-overflow container, and the table is its CHILD', () => {
    const { container } = mount('| a very wide first column | a very wide second column | third |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n');
    const root = rootOf(container);
    const wrapper = root.querySelector('[data-testid="markdown-table-scroll"]');
    expect(wrapper).not.toBeNull();
    // The wrapper is what scrolls; without `overflow-x-auto` a wide table blows
    // the reader's column out, which is worse than the mush it replaced.
    expect(wrapper?.className).toContain('overflow-x-auto');
    expect(wrapper?.firstElementChild?.tagName).toBe('TABLE');
    // …and it is a WRAPPER, never a sibling the table escaped from.
    expect(wrapper?.querySelectorAll('table')).toHaveLength(1);
    expect(root.querySelectorAll('[data-testid="markdown-table-scroll"]')).toHaveLength(1);
    expect(tableIn(root).parentElement).toBe(wrapper);
  });
});

describe('the shapes GFM does NOT read as a table stay literal text (the never-delete rule)', () => {
  it('prints a pipe line with NO delimiter row as the text it is, never deletes it', () => {
    for (const value of ['| a | b |\n| c | d |\n', 'a | b | c\n']) {
      const { container } = mount(value);
      const root = rootOf(container);
      expect(root.querySelector('table'), value).toBeNull();
      const text = root.textContent;
      // The literal text survives character for character (`a | b | c` is prose
      // that merely CONTAINS pipes).
      expect(text, value).toContain(value.trim().split('\n')[0] ?? '');
      expect(text.length, value).toBeGreaterThan(0);
    }
  });

  it('prints a LONE delimiter row as literal text too (GFM has no headerless table at all)', () => {
    // The PDF renders a delimiter-FIRST pipe block HEADERLESS (row 157). GFM
    // does not recognise a table without a header row, so the app shows the
    // block as text. Divergence, recorded — and crucially NOT a deletion.
    const { container } = mount('| --- | --- |\n| c | d |\n');
    const root = rootOf(container);
    expect(root.querySelector('table')).toBeNull();
    expect(root.textContent).toContain('| --- | --- |');
    expect(root.textContent).toContain('| c | d |');
  });
});

describe('a table and a wiki-link chip in the same block (the highest-risk interaction of this change)', () => {
  let campaignId: Id;

  beforeEach(async () => {
    await clearDatabase();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    campaignId = campaign.id;
  });

  it('renders a resolved chip INSIDE a table cell — header cell and body cell — with its byte-exact token', async () => {
    const gate = await createArtifact({
      campaignId,
      kind: 'location',
      name: 'Ash Gate',
      summary: '',
      body: '',
    });
    // THE AUTHORING RULE INSIDE A CELL, which is GFM's own and not this
    // renderer's invention: a `|` in cell content separates cells, so a padded
    // token (`[[Name|display]]`) must escape it — `[[ Ash Gate \|the gate]]`.
    // The module PDF's `splitRow` has NO token exemption either (it splits on
    // any unescaped pipe), so both renderers agree here; the unescaped shape is
    // pinned below for what it really does.
    const { container } = mount('| [[Ash Gate]] | Value |\n| --- | --- |\n| [[ Ash Gate \\|the gate]] | 40 gp |\n', {
      artifacts: [gate],
    });
    const table = tableIn(rootOf(container));
    const chips = within(table).getAllByTestId('wiki-chip');
    expect(chips).toHaveLength(2);
    // The header cell holds the first chip, the body cell the second: the chip
    // is a real child of the cell, not a sibling and not a dropped label.
    const headerChip = table.querySelector('thead th [data-testid="wiki-chip"]');
    const bodyChip = table.querySelector('tbody td [data-testid="wiki-chip"]');
    expect(headerChip?.getAttribute('data-wiki-name')).toBe('Ash Gate');
    expect(bodyChip?.getAttribute('data-wiki-name')).toBe('Ash Gate');
    expect(bodyChip?.getAttribute('data-wiki-artifact-id')).toBe(gate.id);
    // The carrier holds the token as the WIKI GRAMMAR sees it (the parser
    // resolved `\|` to `|` before `remarkWikiLinks` ran — the inner spacing the
    // author wrote is what matters and it survives). docs/17 row 158 records
    // that consequence for the canvas source map, which refuses a selection
    // there by name rather than mapping it to the wrong bytes.
    expect(bodyChip?.getAttribute('data-wiki-raw')).toBe('[[ Ash Gate |the gate]]');
    expect(bodyChip?.getAttribute('title')).toBe('[[ Ash Gate |the gate]] — Location Ash Gate');
    // The cell's own text is the chip's DISPLAY, and the row keeps its other
    // cell: a chip inside a cell neither eats the row nor is eaten by it.
    expect(bodyRowCells(table)).toEqual([['the gate', '40 gp']]);
  });

  it('an UNESCAPED pipe in a padded token splits it across cells — and GFM then drops the row’s tail cell (pinned, not glossed)', () => {
    // The hazard the rule above exists for, pinned as it really behaves. GFM
    // splits the token at its own pipe, making the body row WIDER than the
    // two-column header, and GFM truncates a too-wide row: `40 gp` is gone.
    // The PDF renderer breaks the same token (its `splitRow` splits on any
    // unescaped pipe) but WIDENS the table instead, so it keeps `40 gp` — one
    // more of the two grammars' recorded differences.
    const { container } = mount('| a | b |\n| --- | --- |\n| [[ Ash Gate |the gate]] | 40 gp |\n');
    const table = tableIn(rootOf(container));
    expect(bodyRowCells(table)).toEqual([['[[ Ash Gate', 'the gate]]']]);
    expect(table.textContent).not.toContain('40 gp');
    // …and the same markdown through the PDF seam really splits it the same way
    // (the agreement that makes the escaping rule a RULE and not a quirk).
    const blocks = parseMarkdown('| a | b |\n| --- | --- |\n| [[ Ash Gate |the gate]] | 40 gp |\n');
    const pdfTable = blocks.find((block) => block.kind === 'table');
    expect(pdfTable?.kind === 'table' ? pdfTable.rows[0]?.length : null).toBe(3);
  });

  it('renders an UNRESOLVED chip inside a cell as a chip too, never as its raw token', () => {
    const { container } = mount('| a | b |\n| --- | --- |\n| [[Nobody]] | z |\n');
    const root = rootOf(container);
    const chip = within(tableIn(root)).getByTestId('wiki-chip-unresolved');
    expect(chip.getAttribute('data-wiki-name')).toBe('Nobody');
    expect(chip.getAttribute('data-wiki-raw')).toBe('[[Nobody]]');
    expect(chip.textContent).toBe('Nobody');
    expect(root.textContent).not.toContain('[[');
  });
});

describe('a table under a bullet', () => {
  it('reads an INDENTED table under a bullet as a real table INSIDE the list item', () => {
    const { container } = mount('- item\n  | a | b |\n  | --- | --- |\n  | c | d |\n');
    const root = rootOf(container);
    const bundle = root.querySelector('li');
    expect(bundle).not.toBeNull();
    const table = tableIn(bundle as HTMLElement);
    expect(headerCells(table)).toEqual(['a', 'b']);
    expect(bodyRowCells(table)).toEqual([['c', 'd']]);
    // The bullet keeps its own text: the table did not swallow it. (GFM emits
    // the text and the table as siblings inside the `<li>` — no `<p>` wrapper
    // once a table follows, which is why this asserts text, not a paragraph.)
    expect((bundle?.textContent ?? '').startsWith('item')).toBe(true);
  });

  it('reads an UNINDENTED pipe block under a bullet as the bullet’s own text (GFM’s lazy continuation — the PDF flushes a table here)', () => {
    // The PDF's line-based parser closes the list and prints a real table after
    // it. GFM treats the unindented lines as a lazy CONTINUATION of the list
    // item's paragraph, so they are text. Recorded divergence, and the text is
    // still there — nothing vanishes either way.
    const { container } = mount('- item\n| a | b |\n| --- | --- |\n| c | d |\n');
    const root = rootOf(container);
    expect(root.querySelector('table')).toBeNull();
    const text = root.querySelector('li')?.textContent;
    expect(text).toContain('item');
    expect(text).toContain('| a | b |');
    expect(text).toContain('| --- | --- |');
  });
});

describe('the canvas preview’s opt-in source map still works in a table cell', () => {
  it('renders the same real table with the same cell text, with the cell runs wrapped', () => {
    // `sourceOffsets` wraps every mdast text node in a span carrying its source
    // byte range, and the wrapper runs BEFORE `remarkWikiLinks`. A table cell's
    // text is an mdast text node, so the map must survive GFM's own nodes —
    // this is the pin that fails if the source-span plugin stops reaching cells.
    const plain = mount(TABLE);
    const plainText = rootOf(plain.container).textContent;
    plain.unmount();

    const { container } = mount(TABLE, { sourceOffsets: true });
    const root = rootOf(container);
    const table = tableIn(root);
    expect(headerCells(table)).toEqual(['Item', 'Value']);
    expect(bodyRowCells(table)).toEqual([['Silver bell', '40 gp']]);
    expect(root.textContent).toBe(plainText);
    const runs = table.querySelectorAll('[data-md-from]');
    expect(Array.from(runs).map((run) => run.textContent)).toEqual([
      'Item',
      'Value',
      'Silver bell',
      '40 gp',
    ]);
  });
});

/* ------------------------------------------------------------------------ *
 * The REAL surfaces: the reader page, and the artifact editor's preview
 * ------------------------------------------------------------------------ */

const MODULE_TITLE = 'The Drowned Vault';

/** The reader surfaces the module's own text: a table in part 0 must reach it. */
async function seedReaderModule(partMarkdown: string): Promise<{ campaign: Campaign; moduleId: Id }> {
  await seedBuiltInPersonas();
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  await createArtifact({
    campaignId: campaign.id,
    kind: 'location',
    name: 'Old Tower',
    summary: 'A crumbling watchtower above the ford.',
  });
  const draft = createModule({
    campaignId: campaign.id,
    title: MODULE_TITLE,
    concept: 'A flooded vault beneath a watchtower.',
    levelMin: 1,
    levelMax: 3,
    tone: '',
    sizeDial: 'standard',
  });
  const saved = await saveModule({
    ...draft,
    status: 'ready',
    errorMessage: '',
    spine: moduleSpineSchema.parse({
      premise: 'The party is hired to recover a drowned relic from the [[Old Tower]].',
      themes: ['bargains', 'rising water'],
      partPlan: [
        {
          title: 'The Gate Bargain',
          levelBand: '1',
          synopsis: 'The party negotiates entry with the tower keeper.',
          levelUpTrigger: 'The gate opens.',
        },
      ],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: partMarkdown,
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
  return { campaign, moduleId: saved.id };
}

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

describe('the reader page renders the table (the surface the owner sees)', () => {
  beforeEach(clearDatabase);

  it('renders a real table with an overflow wrapper in a part’s body, and no pipe-mush anywhere in the section', async () => {
    const partMarkdown =
      'The cult keeps its hoard here.\n\n' +
      '| Item | Value |\n| --- | --- |\n| Silver bell | 40 gp |\n\n' +
      'The bell is cursed. It was found at the [[Old Tower]].';
    const { campaign, moduleId } = await seedReaderModule(partMarkdown);
    renderAppAt(modulePath(campaign.id, moduleId));

    await screen.findByTestId('module-reader', {}, { timeout: 10_000 });
    const section = await waitFor(() => {
      const found = document.getElementById('part-0');
      if (found === null) throw new Error('part-0 not mounted yet');
      return found;
    });

    const body = within(section).getByTestId('part-body');
    const table = tableIn(body);
    expect(headerCells(table)).toEqual(['Item', 'Value']);
    expect(bodyRowCells(table)).toEqual([['Silver bell', '40 gp']]);
    expect(body.querySelector('[data-testid="markdown-table-scroll"]')).not.toBeNull();
    // The prose AROUND the table is intact, and the chip beside it still chips
    // (resolved — the module seeds an `Old Tower` location).
    expect(body.textContent).toContain('The cult keeps its hoard here.');
    expect(body.textContent).toContain('The bell is cursed.');
    const chip = body.querySelector('[data-testid="wiki-chip"]');
    expect(chip?.getAttribute('data-wiki-name')).toBe('Old Tower');
    // Non-vacuity: the section's own rendered text carries no markup at all.
    expect(body.textContent).not.toContain('|');
  });
});

describe('the artifact editor’s Preview toggle renders the table', () => {
  it('renders a real table (with the wrapper) only once Preview is on', async () => {
    const user = userEvent.setup();
    const { container } = render(<MarkdownBody value={TABLE} onChange={vi.fn()} />);
    // Edit mode is a plain textarea: the markup is the TEXT there, which is
    // what an editor is for.
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('textarea')?.value).toBe(TABLE);

    await user.click(screen.getByRole('button', { name: 'Preview' }));

    const root = rootOf(container);
    const table = tableIn(root);
    expect(headerCells(table)).toEqual(['Item', 'Value']);
    expect(bodyRowCells(table)).toEqual([['Silver bell', '40 gp']]);
    expect(root.querySelector('[data-testid="markdown-table-scroll"]')).not.toBeNull();
  });
});

/* ------------------------------------------------------------------------ *
 * EXACTLY ONE app-side table renderer (AGENTS §Centralization 2)
 * ------------------------------------------------------------------------ */

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

/**
 * Where a `<table>` ELEMENT may be written in `src/`. `wiki-markdown.tsx` is
 * the app's markdown table renderer (docs/17 row 158); `LabeledDungeonView.tsx`
 * is the lab's own synthetic preview grid, which renders no markdown at all and
 * is deliberately left alone. A third site is a second app-side table renderer
 * being born — the NOT-Z column of docs/18 §2.3's app-renderer row.
 */
const DECLARED_TABLE_SITES: Readonly<Record<string, number>> = {
  'src/features/campaign/components/wiki-markdown.tsx': 1,
  'src/features/lab/LabeledDungeonView.tsx': 1,
};

describe('the app’s table grammar lives in ONE place (SOURCE SCAN)', () => {
  it('`remark-gfm` is wired into exactly ONE src file — the shared renderer', () => {
    const files = srcFiles();
    // Non-vacuity: the walk must see the whole `src/` tree, and the seam must
    // really import AND use the plugin this pin is about.
    expect(files.length).toBeGreaterThan(200);
    const seam = readFileSync(join(process.cwd(), 'src/features/campaign/components/wiki-markdown.tsx'), 'utf8');
    expect(seam).toContain("import remarkGfm from 'remark-gfm';");
    expect(seam).toContain('[remarkGfm, remarkWikiLinks]');

    const found: Record<string, number> = {};
    for (const file of files) {
      const count = readFileSync(join(process.cwd(), file), 'utf8').split("from 'remark-gfm'").length - 1;
      if (count > 0) found[file] = count;
    }
    // A second pipeline (a per-surface renderer, a second markdown component)
    // importing the plugin reds this — the chips' ONE renderer is the point
    // (AGENTS §Centralization 2, docs/18 §2.3's NOT-Z column).
    expect(found).toEqual({ 'src/features/campaign/components/wiki-markdown.tsx': 1 });
  });

  it('no src file renders a table element outside the declared sites', () => {
    const files = srcFiles();
    expect(files.length).toBeGreaterThan(200);

    const found: Record<string, number> = {};
    for (const file of files) {
      const count = tableElementLines(readFileSync(join(process.cwd(), file), 'utf8')).length;
      if (count > 0) found[file] = count;
    }
    expect(found).toEqual(DECLARED_TABLE_SITES);
    // Rot check: a declared site that no longer holds its table is a stale
    // carve-out licensing the shape it excused.
    for (const site of Object.keys(DECLARED_TABLE_SITES)) {
      expect(found[site], `${site} no longer renders a table`).toBeDefined();
    }
  });
});

/** Source lines rendering a `<table>` ELEMENT (comment lines are skipped: a doc
 * comment NAMING `<table>` is prose — `src/ingest/packs/text.ts` says no such
 * markup exists — not a renderer). */
function tableElementLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.includes('<table'))
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    });
}