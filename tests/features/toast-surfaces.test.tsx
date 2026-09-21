/**
 * MERGED same-background cluster (docs/17 row 177, extending row 176's pilot):
 * five `tests/features` render-surface files that share ONE background —
 * fake-indexeddb + `clearDatabase()` and the SAME identical `vi.mock` target set
 * (`@/lib/toast` only) — now run in ONE file, so the
 * import/transform/jsdom-environment/setup cost is paid once instead of five
 * times.
 *
 * Merged from (one `describe` per original file, so each stays findable; test
 * names and every `expect` assertion site is byte-identical):
 *   - tests/features/wiki-chip-tooltip.test.tsx (10)
 *   - tests/features/wiki-markdown-tables.test.tsx (18)
 *   - tests/features/module-style-bar.test.tsx (5)
 *   - tests/features/prompt-styles-section.test.tsx (6)
 *   - tests/features/spawn-picker.test.tsx (13)
 *
 * `spawn-picker` is placed LAST on purpose: its `beforeEach` mutates
 * `HTMLElement.prototype.offsetWidth/offsetHeight` by direct assignment (for
 * virtual-core's layout-less measurement) with no restore, so every describe
 * that does not want that stub runs BEFORE it (sweep rule 4).
 */

import 'fake-indexeddb/auto';
import { render, screen, cleanup, waitFor, within, fireEvent, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { createArtifact, getAnyArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  libraryCreatureKey,
  monsterEntrySchema,
  newId,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
} from '@/domain';
import type { AnyArtifact, Id, Campaign, PromptStyle, MonsterEntry, StatBlock } from '@/domain';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import { clearDatabase } from '../db/helpers';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { createAppRouter } from '@/app/router';
import { modulePath } from '@/app/routes';
import { saveModule, getModule, patchModule, createModule as saveModule__2 } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { MarkdownBody } from '@/features/campaign/components/markdown-body';
import { parseMarkdown } from '@/lib/mdToPdfmake';
import { db } from '@/db/db';
import {
  duplicatePromptStyle,
  savePromptStyle,
  readPromptStyleCatalog,
} from '@/db/promptStyleRepo';
import { ModuleStyleBar } from '@/features/modules/canvas/module-style-bar';
import { builtinPromptStyle, modulePromptStyleOf } from '@/llm/promptStyles';
import { toastError, toastSuccess } from '@/lib/toast';
import { flushAsyncUpdates, actDrained } from '../helpers/flush';
import { getSettings, updateSettings } from '@/db/settingsRepo';
import { PromptStylesSection } from '@/features/settings/prompt-styles-section';
import { listBattlesByModule, saveBattleBoard } from '@/db/battleRepo';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import { putChunks } from '@/db/chunkRepo';
import { buildFighterStatsLookup } from '@/db/fighterStats';
import { createRulebook, updateRulebook } from '@/db/rulebookRepo';
import { fallbackSpawnPoint } from '@/domain/battle/board';
import { sha256Hex } from '@/lib/hash';
import { SpawnPicker } from '@/features/play/battle/SpawnPicker';
import {
  buildMobPickEntry,
  countLabelSlots,
  nextFreeSpawnPoint,
  parseLevelOrLast,
  spawnPickedEntry,
} from '@/features/play/battle/spawn-picker-logic';
import { parseLevelSort } from '@/llm/encounterRoster';

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastErrorPersistent: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

/**
 * Cross-describe mock isolation for the merge: each original owned its own mock
 * instance, so its own teardown sufficed. A merged file shares ONE instance per
 * mocked module (the point of the merge), so a leftover `mockImplementation` or
 * call history from an earlier describe would answer a later test's `...Once`
 * queue overflow and change its call counts. Reset before every test; each
 * describe's own hooks then install what it needs.
 */
beforeEach(() => {
  vi.resetAllMocks();
});

describe('wiki-chip-tooltip.test.tsx', () => {
  /**
   * The chip's hover tooltip (docs/17 row 100, docs/05 §The chip): EVERY
   * wiki-link chip shows the token it was WRITTEN from — byte-exact, inner
   * spacing included — ahead of whatever the chip already said.
   *
   * The owner's report, verbatim: *"i would like to have a hover tooltip over
   * all Wikilinks where the raw text of the link is displayed. Some things are
   * just not visible in the rendered version, like encounter parameters."*
   *
   * The token is not recoverable after the FACT: `remarkWikiLinks` rewrites a
   * text run into a synthetic link node whose only child is the DISPLAY text, so
   * the source bytes have to be carried at that moment. They ride the node's
   * `data.hProperties` (verified against react-markdown 10.1.0 +
   * mdast-util-to-hast 13.2.1 in this arc) and arrive as `data-wiki-raw`.
   *
   * The pins below are deliberately written so that a RECONSTRUCTION from
   * name+display cannot pass any of them (see the non-vacuity block at the
   * bottom, which asserts the two plausible reconstructions are NOT what the
   * chip carries).
   */

  /** The owner's own shape: the display text hides the target AND the token. */
  const PADDED_TOKEN = '[[ Ash Gate |the gate]]';
  const PLAIN_TOKEN = '[[Ash Gate]]';
  const MISSING_TOKEN = '[[Kael]]';

  let campaignId: Id;

  async function seedArtifact(
    name: string,
    kind: 'npc' | 'location' = 'npc',
  ): Promise<AnyArtifact> {
    return createArtifact({
      campaignId,
      kind,
      name,
      summary: '',
      body: '',
    });
  }

  beforeEach(async () => {
    await clearDatabase();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    campaignId = campaign.id;
  });

  describe('a resolved chip', () => {
    it('shows the byte-exact token FIRST, then the kind and name', async () => {
      const gate = await seedArtifact('Ash Gate');
      render(<WikiMarkdown value={`Beyond it lies ${PADDED_TOKEN}.`} artifacts={[gate]} />);

      const chip = screen.getByTestId('wiki-chip');
      // The rendered label is the display text — the target is invisible here,
      // which is exactly the complaint.
      expect(chip).toHaveTextContent('the gate');
      expect(chip).toHaveAttribute('data-wiki-name', 'Ash Gate');
      expect(chip).toHaveAttribute('title', '[[ Ash Gate |the gate]] — NPC Ash Gate');
      // The carrier is inspectable on the element itself, independent of the
      // tooltip string.
      expect(chip).toHaveAttribute('data-wiki-raw', PADDED_TOKEN);
    });

    it('shows a plain token byte-exact too', async () => {
      const gate = await seedArtifact('Ash Gate');
      render(<WikiMarkdown value={`Beyond it lies ${PLAIN_TOKEN}.`} artifacts={[gate]} />);

      expect(screen.getByTestId('wiki-chip')).toHaveAttribute(
        'title',
        '[[Ash Gate]] — NPC Ash Gate',
      );
    });

    it('uses the artifact KIND label the chip already used', async () => {
      const tower = await seedArtifact('Old Tower', 'location');
      render(
        <WikiMarkdown
          value={`See ${PLAIN_TOKEN.replace('Ash Gate', 'Old Tower')}.`}
          artifacts={[tower]}
        />,
      );

      expect(screen.getByTestId('wiki-chip')).toHaveAttribute(
        'title',
        '[[Old Tower]] — Location Old Tower',
      );
    });
  });

  describe('an unresolved chip', () => {
    it('shows the token AND keeps "not detailed yet"', () => {
      render(<WikiMarkdown value={`Ask ${MISSING_TOKEN} about it.`} artifacts={[]} />);

      const chip = screen.getByTestId('wiki-chip-unresolved');
      expect(chip).toHaveAttribute('data-wiki-raw', MISSING_TOKEN);
      expect(chip).toHaveAttribute('title', '[[Kael]] — Kael — not detailed yet');
      // The old sentence survives INTACT as the tail — nothing the chip said
      // before was traded away for the token.
      expect(chip.getAttribute('title')).toContain('Kael — not detailed yet');
    });
  });

  describe('an ambiguous chip', () => {
    it('shows the token AND keeps the ⚠ candidate list', async () => {
      // Two campaign rows of the SAME name: the reader keeps its ⚠ verdict.
      await seedArtifact('Ash Gate');
      await seedArtifact('Ash Gate');
      const pool = await import('@/db/artifactRepo').then((repo) =>
        repo.listArtifactsByCampaign(campaignId),
      );

      render(<WikiMarkdown value={`Beyond it lies ${PLAIN_TOKEN}.`} artifacts={pool} />);

      const chip = screen.getByTestId('wiki-chip');
      expect(chip).toHaveAttribute('data-wiki-ambiguous', 'true');
      expect(chip).toHaveAttribute(
        'title',
        '[[Ash Gate]] — ⚠ 2 artifacts match “Ash Gate”: Ash Gate, Ash Gate',
      );
      // The old warning survives intact as the tail.
      expect(chip.getAttribute('title')).toContain('⚠ 2 artifacts match “Ash Gate”');
    });
  });

  describe('non-vacuity: a reconstruction is NOT accepted', () => {
    it('carries neither plausible rebuild of the token from name + display', async () => {
      const gate = await seedArtifact('Ash Gate');
      render(<WikiMarkdown value={`Beyond it lies ${PADDED_TOKEN}.`} artifacts={[gate]} />);

      const title = screen.getByTestId('wiki-chip').getAttribute('title') ?? '';
      const raw = screen.getByTestId('wiki-chip').getAttribute('data-wiki-raw') ?? '';

      // The two things an implementation without the source bytes could build.
      const fromNameOnly = '[[Ash Gate]]';
      const fromNameAndDisplay = '[[Ash Gate|the gate]]';

      expect(raw).toBe(PADDED_TOKEN);
      expect(raw).not.toBe(fromNameOnly);
      expect(raw).not.toBe(fromNameAndDisplay);
      // And the tooltip LEADS with the real token, not a rebuild.
      expect(title.startsWith(PADDED_TOKEN)).toBe(true);
      expect(title.startsWith(`${fromNameOnly} —`)).toBe(false);
      expect(title.startsWith(`${fromNameAndDisplay} —`)).toBe(false);
    });
  });

  describe('surfaces that must NOT grow a raw-token tooltip', () => {
    it('leaves a plain markdown link alone', () => {
      render(
        <WikiMarkdown value="See [the gate](https://example.com/gate) for more." artifacts={[]} />,
      );

      const link = screen.getByRole('link', { name: 'the gate' });
      expect(link).toHaveAttribute('href', 'https://example.com/gate');
      expect(link).not.toHaveAttribute('title');
      expect(document.querySelector('[data-wiki-raw]')).toBeNull();
      expect(screen.queryByTestId('wiki-chip')).toBeNull();
      expect(screen.queryByTestId('wiki-chip-unresolved')).toBeNull();
    });

    it('leaves a token inside a code span literal — no chip, no tooltip', () => {
      render(<WikiMarkdown value={`Write \`${MISSING_TOKEN}\` to link a name.`} artifacts={[]} />);

      // The brackets are visible because it is CODE — that is the point of the
      // span, not a chip whose tooltip happens to hold them.
      expect(screen.getByText(MISSING_TOKEN).tagName).toBe('CODE');
      expect(screen.queryByTestId('wiki-chip-unresolved')).toBeNull();
      expect(screen.queryByTestId('wiki-chip')).toBeNull();
      expect(document.querySelector('[data-wiki-raw]')).toBeNull();
    });

    it('leaves a token nested in markdown link TEXT literal — no chip, no tooltip', () => {
      render(
        <WikiMarkdown
          value={`See [${MISSING_TOKEN} here](https://example.com) please.`}
          artifacts={[]}
        />,
      );

      expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com');
      expect(screen.getByRole('link')).not.toHaveAttribute('title');
      expect(screen.queryByTestId('wiki-chip-unresolved')).toBeNull();
      expect(document.querySelector('[data-wiki-raw]')).toBeNull();
    });

    it('leaves a token inside a fenced code block literal — no chip, no tooltip', () => {
      render(
        <WikiMarkdown value={`Example:\n\n\`\`\`\n${MISSING_TOKEN}\n\`\`\`\n`} artifacts={[]} />,
      );

      expect(screen.getByText(MISSING_TOKEN).tagName).toBe('CODE');
      expect(screen.queryByTestId('wiki-chip-unresolved')).toBeNull();
      expect(document.querySelector('[data-wiki-raw]')).toBeNull();
    });
  });
});

describe('wiki-markdown-tables.test.tsx', () => {
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

  afterEach(cleanup);

  /* ------------------------------------------------------------------------ *
   * The shared renderer, driven directly
   * ------------------------------------------------------------------------ */

  const TABLE = '| Item | Value |\n| --- | --- |\n| Silver bell | 40 gp |\n';

  function mount(
    value: string,
    options: { artifacts?: readonly AnyArtifact[]; sourceOffsets?: boolean } = {},
  ) {
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
    if (table === null)
      throw new Error(`no <table> rendered; text was ${JSON.stringify(root.textContent)}`);
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
      const { container } = mount(
        '| a very wide first column | a very wide second column | third |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n',
      );
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
      const { container } = mount(
        '| [[Ash Gate]] | Value |\n| --- | --- |\n| [[ Ash Gate \\|the gate]] | 40 gp |\n',
        {
          artifacts: [gate],
        },
      );
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
      const { container } = mount(
        '| a | b |\n| --- | --- |\n| [[ Ash Gate |the gate]] | 40 gp |\n',
      );
      const table = tableIn(rootOf(container));
      expect(bodyRowCells(table)).toEqual([['[[ Ash Gate', 'the gate]]']]);
      expect(table.textContent).not.toContain('40 gp');
      // …and the same markdown through the PDF seam really splits it the same way
      // (the agreement that makes the escaping rule a RULE and not a quirk).
      const blocks = parseMarkdown(
        '| a | b |\n| --- | --- |\n| [[ Ash Gate |the gate]] | 40 gp |\n',
      );
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
  async function seedReaderModule(
    partMarkdown: string,
  ): Promise<{ campaign: Campaign; moduleId: Id }> {
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
      const seam = readFileSync(
        join(process.cwd(), 'src/features/campaign/components/wiki-markdown.tsx'),
        'utf8',
      );
      expect(seam).toContain("import remarkGfm from 'remark-gfm';");
      expect(seam).toContain('[remarkGfm, remarkWikiLinks]');

      const found: Record<string, number> = {};
      for (const file of files) {
        const count =
          readFileSync(join(process.cwd(), file), 'utf8').split("from 'remark-gfm'").length - 1;
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
});

describe('module-style-bar.test.tsx', () => {
  /**
   * The "the style has moved on" bar (docs/17 row 86).
   *
   * A module RECORDS the style text it was written in — that is what makes editing
   * a style safe. This bar is the explicit way to move an EXISTING module onto the
   * style's current text, and the test pins the three states that matter: silent
   * when the module is in step (including every pre-styles module, which resolves
   * to the immutable Classic), offering the adopt with the consequence spelled out
   * when the style changed, and merely explaining itself when the style is gone.
   */

  function story(): NonNullable<ReturnType<typeof builtinPromptStyle>> {
    const value = builtinPromptStyle('story');
    if (value === undefined) throw new Error('missing story style');
    return value;
  }

  /**
   * A module that RECORDED a style (or none at all: the pre-styles shape, which
   * resolves to the immutable Classic).
   */
  async function moduleWith(style: PromptStyle | null): Promise<{ campaign: Campaign; id: Id }> {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const saved = await saveModule(
      createModule({
        campaignId: campaign.id,
        title: 'The Drowned Bell',
        concept: 'A harbor bell.',
        levelMin: 1,
        levelMax: 1,
        tone: '',
        sizeDial: 'standard',
      }),
    );
    if (style !== null) {
      await patchModule(saved.id, { promptStyle: modulePromptStyleOf(style) });
    }
    return { campaign, id: saved.id };
  }

  beforeEach(async () => {
    await db.open();
    await db.delete();
    await db.open();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('module style bar', () => {
    it('renders nothing for a module written before styles existed (Classic, in step)', async () => {
      const { id } = await moduleWith(null);
      const row = await getModule(id);
      if (row === undefined) throw new Error('missing module');
      const view = render(<ModuleStyleBar module={row} />);
      await flushAsyncUpdates(6);
      expect(view.container.innerHTML).toBe('');
    }, 30000);

    it('renders nothing while the module matches the style current text', async () => {
      const { id } = await moduleWith(story());
      const row = await getModule(id);
      if (row === undefined) throw new Error('missing module');
      const view = render(<ModuleStyleBar module={row} />);
      await flushAsyncUpdates(6);
      expect(view.container.innerHTML).toBe('');
    }, 30000);

    it('offers the adopt when the style text changed, and adopting re-records the module', async () => {
      const source = story();
      const own = await duplicatePromptStyle(source, 'House Voice');
      const { id } = await moduleWith(own);
      const edited = await savePromptStyle(own.id, {
        templateText: `${own.templateText}\n\nHOUSE-VOICE-V2: keep the prose cold.`,
      });
      expect(edited.version).toBe(2);
      const row = await getModule(id);
      if (row === undefined) throw new Error('missing module');
      render(<ModuleStyleBar module={row} />);
      await flushAsyncUpdates(8);
      const bar = screen.getByTestId('module-style-bar');
      expect(bar.getAttribute('data-state')).toBe('updated');
      expect(bar.textContent).toContain('v1');
      expect(bar.textContent).toContain('v2');

      await userEvent.click(screen.getByTestId('module-style-adopt'));
      await flushAsyncUpdates(2);
      const dialog = screen.getByRole('alertdialog');
      // The consequence is stated BEFORE the click, not discovered afterwards.
      expect(dialog.textContent).toContain('Parts already written keep the text they have');
      await userEvent.click(screen.getByRole('button', { name: 'Adopt v2' }));
      await flushAsyncUpdates(8);
      const updated = await getModule(id);
      expect(updated?.promptStyle?.version).toBe(2);
      expect(updated?.promptStyle?.templateText).toContain('HOUSE-VOICE-V2');
      expect(toastSuccess).toHaveBeenCalled();
    }, 30000);

    it('can be dismissed for the session without changing anything', async () => {
      const own = await duplicatePromptStyle(story(), 'House Voice');
      const { id } = await moduleWith(own);
      await savePromptStyle(own.id, { templateText: `${own.templateText}\n\nV2` });
      const row = await getModule(id);
      if (row === undefined) throw new Error('missing module');
      render(<ModuleStyleBar module={row} />);
      await flushAsyncUpdates(8);
      screen.getByTestId('module-style-bar');
      await userEvent.click(screen.getByTestId('module-style-keep'));
      await flushAsyncUpdates(4);
      expect(screen.queryByTestId('module-style-bar')).toBeNull();
      const unchanged = await getModule(id);
      expect(unchanged?.promptStyle).toEqual(modulePromptStyleOf(own));
    }, 30000);

    it('explains a DELETED style and offers no adopt', async () => {
      const own = await duplicatePromptStyle(story(), 'House Voice');
      const { id } = await moduleWith(own);
      const { deletePromptStyle } = await import('@/db/promptStyleRepo');
      await deletePromptStyle(own.id);
      const row = await getModule(id);
      if (row === undefined) throw new Error('missing module');
      render(<ModuleStyleBar module={row} />);
      const bar = await screen.findByTestId('module-style-bar');
      expect(bar.getAttribute('data-state')).toBe('deleted');
      expect(bar.textContent).toContain('no longer exists');
      expect(bar.textContent).toContain('recorded on the module');
      expect(screen.queryByTestId('module-style-adopt')).toBeNull();
      await waitFor(() => {
        expect(toastError).not.toHaveBeenCalled();
      });
    }, 30000);
  });
});

describe('prompt-styles-section.test.tsx', () => {
  /**
   * Settings → Module writing styles (docs/17 row 86, 05-UI.md §Settings): the
   * authoring editor.
   *
   * What is pinned here: the built-ins are read-only but duplicable, a user style
   * is editable with its version tracking the TEMPLATE, an invalid template is
   * refused LOUDLY and nothing is written, the preview separates the author's text
   * from the contract clauses, deleting a style leaves modules intact, and an
   * unreadable styles blob is reported rather than shown as "no styles".
   */

  function story(): PromptStyle {
    const value = builtinPromptStyle('story');
    if (value === undefined) throw new Error('missing story style');
    return value;
  }

  /** Expands one style row by its id and returns its body. */
  async function openRow(id: string): Promise<HTMLElement> {
    const row = await screen.findByTestId(`prompt-style-row-${id}`);
    await userEvent.click(within(row).getByRole('button'));
    return screen.findByTestId(`prompt-style-body-${id}`);
  }

  beforeEach(async () => {
    await db.open();
    await clearDatabase();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('module writing styles section', () => {
    it('lists the built-ins as read-only with a duplicate affordance', async () => {
      render(<PromptStylesSection />);
      await waitFor(() => {
        expect(screen.getByTestId('prompt-styles-section')).toBeTruthy();
      });
      await flushAsyncUpdates(4);
      expect(screen.getByText('Classic')).toBeTruthy();
      expect(screen.getByText('Story')).toBeTruthy();

      await openRow('classic');
      expect(screen.getByText(/Built-in styles ship with the app/)).toBeTruthy();
      // No template textarea for a built-in: it cannot be edited at all.
      expect(screen.queryByTestId('prompt-style-template-classic')).toBeNull();
      expect(screen.getByTestId('prompt-style-duplicate-classic')).toBeTruthy();
    });

    it('duplicating makes an editable user style and saves name + template with a version bump', async () => {
      render(<PromptStylesSection />);
      await flushAsyncUpdates(4);
      await openRow('story');
      await userEvent.click(screen.getByTestId('prompt-style-duplicate-story'));
      await flushAsyncUpdates(6);

      expect(toastSuccess).toHaveBeenCalled();
      const catalog = await readPromptStyleCatalog('classic');
      expect(catalog.user).toHaveLength(1);
      const copy = catalog.user[0];
      expect(copy?.name).toBe('Story (copy)');
      expect(copy?.basedOn).toBe('story');

      await openRow(copy?.id ?? '');
      const field = await screen.findByTestId(`prompt-style-template-${copy?.id ?? ''}`);
      // A sectioned template (the markers are part of the shape) carrying one
      // unknown placeholder.
      const broken = [
        '--- SPINE ---',
        '{{campaign}}',
        '{{contract.replyFormat}}',
        '{{contract.floor}}',
        '{{contract.entityKinds}}',
        '{{contract.sceneKinds}}',
        '{{contract.wikiLinks}}',
        '{{nope}}',
        '',
        '--- PARTS ---',
        '{{partHeading}}',
        '{{contract.replyFormat}}',
        '{{contract.gmAddress}}',
        '{{contract.wikiLinks}}',
        '{{contract.lengthTarget}}',
        '{{contract.floor}}',
        '{{contract.mechanics}}',
        '{{contract.encounterCasting}}',
      ].join('\n');
      // Bulk edit through a change event: typing ten KB of template would only
      // measure userEvent.
      fireEvent.change(field, { target: { value: broken } });
      await flushAsyncUpdates(4);
      // An invalid template is refused LOUDLY, with the problem named.
      expect(await screen.findByTestId(`prompt-style-problems-${copy?.id ?? ''}`)).toBeTruthy();
      expect(screen.getByText(/Unknown placeholder \{\{nope\}\}/)).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await flushAsyncUpdates(4);
      expect(toastError).toHaveBeenCalled();
      const untouched = await readPromptStyleCatalog('classic');
      expect(untouched.user[0]?.templateText).toBe(copy?.templateText);
      expect(untouched.user[0]?.version).toBe(1);

      // A valid edit saves and bumps the version.
      // A valid edit saves and bumps the version. Bulk edit for the same
      // reason as above — and the text is ten KB, so typing it would measure
      // nothing but userEvent.
      const successesBefore = vi.mocked(toastSuccess).mock.calls.length;
      fireEvent.change(field, { target: { value: story().templateText + '\n\nEXTRA-LINE' } });
      await flushAsyncUpdates(2);
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await flushAsyncUpdates(6);
      expect(vi.mocked(toastSuccess).mock.calls.length).toBeGreaterThan(successesBefore);
      expect(toastError).toHaveBeenCalledTimes(1);
      const saved = await readPromptStyleCatalog('classic');
      expect(saved.user[0]?.version).toBe(2);
      expect(saved.user[0]?.templateText).toContain('EXTRA-LINE');
      expect(saved.user[0]?.templateText).toContain('--- SPINE ---');
    }, 30000);

    it('previews both surfaces and marks the contract lines', async () => {
      await duplicatePromptStyle(story(), 'House Voice');
      render(<PromptStylesSection />);
      await flushAsyncUpdates(6);
      await openRow((await readPromptStyleCatalog('classic')).user[0]?.id ?? '');
      const preview = await screen.findByTestId('prompt-style-preview-parts');
      // The composed preview carries the contract text the app injects…
      expect(within(preview).getAllByText(/Target length for this part/).length).toBeGreaterThan(0);
      // …and the contract segments are tagged for the author.
      expect(preview.querySelectorAll('[data-segment-layer="contract"]').length).toBeGreaterThan(0);
      expect(preview.querySelectorAll('[data-segment-layer="style"]').length).toBeGreaterThan(0);
      // Switching surfaces shows the spine planner's own composition.
      await userEvent.click(screen.getByRole('button', { name: 'Spine planner' }));
      await flushAsyncUpdates(2);
      expect(screen.getByTestId('prompt-style-preview-spine')).toBeTruthy();
    }, 30000);

    it('makes a style the app default', async () => {
      await duplicatePromptStyle(story(), 'House Voice');
      render(<PromptStylesSection />);
      await flushAsyncUpdates(6);
      const copy = (await readPromptStyleCatalog('classic')).user[0];
      await openRow(copy?.id ?? '');
      await userEvent.click(screen.getByTestId(`prompt-style-make-default-${copy?.id ?? ''}`));
      await flushAsyncUpdates(6);
      expect((await getSettings()).defaultPromptStyleId).toBe(copy?.id);
      expect(toastSuccess).toHaveBeenCalled();
    }, 30000);

    it('deleting a style leaves modules that recorded it untouched', async () => {
      const own = await duplicatePromptStyle(story(), 'House Voice');
      const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
      const saved = await saveModule(
        createModule({
          campaignId: campaign.id,
          title: 'The Drowned Bell',
          concept: 'A bell.',
          levelMin: 1,
          levelMax: 1,
          tone: '',
          sizeDial: 'standard',
        }),
      );
      const { patchModule } = await import('@/db/moduleRepo');
      await patchModule(saved.id, { promptStyle: modulePromptStyleOf(own) });

      render(<PromptStylesSection />);
      await flushAsyncUpdates(6);
      await openRow(own.id);
      await userEvent.click(screen.getByTestId(`prompt-style-delete-${own.id}`));
      await flushAsyncUpdates(2);
      // The consequence is stated BEFORE it happens, not discovered afterwards.
      expect(screen.getByText(/Modules already written with it are NOT affected/)).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: 'Delete the style' }));
      await flushAsyncUpdates(8);
      const catalog = await readPromptStyleCatalog('classic');
      expect(catalog.user).toHaveLength(0);
      const row = await getModule(saved.id);
      expect(row?.promptStyle?.templateText).toBe(own.templateText);
    }, 30000);

    it('reports an unreadable styles blob instead of showing no styles', async () => {
      // A settings row must exist before it can be corrupted into the shape a bad
      // import leaves behind.
      await updateSettings({ promptStyles: [] });
      // The corrupt write is deliberate and typed around: Dexie does not
      // validate, which is exactly how a bad import lands in the row.
      await db.settings.update('settings', {
        promptStyles: 'not-an-array',
      } as unknown as Partial<{ promptStyles: never }>);
      render(<PromptStylesSection />);
      const error = await screen.findByTestId('prompt-styles-error');
      expect(within(error).getByText(/could not be read/)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Discard unreadable styles' })).toBeTruthy();
      await flushAsyncUpdates(4);
      // The built-ins are still listed: they ship in code, not in the row.
      expect(screen.getByText('Classic')).toBeTruthy();
      expect(screen.getByText('Story')).toBeTruthy();
      await updateSettings({ promptStyles: [] });
    }, 30000);
  });
});

describe('spawn-picker.test.tsx', () => {
  /**
   * The mid-fight spawn picker (spawn-picker arc): three spawn groups (roster /
   * campaign NPCs / core mobs) behind one Spawn button, one search field, one
   * name/level sort — every pick spawning through the shared expansion path.
   */

  function statBlock(level: string, hp: number): StatBlock {
    return statBlockSchema.parse({
      system: 'dnd5e',
      level,
      size: 'Medium',
      creatureType: 'humanoid',
      ac: 12,
      acNote: '',
      hp,
      hpFormula: '',
      speed: '30 ft.',
      abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
      saves: '',
      skills: '',
      senses: '',
      languages: '',
      traits: [],
      actions: [],
      reactions: [],
      legendary: [],
      extras: {},
    });
  }

  let campaignId = '';
  let moduleId = '';
  let battleId = '';
  let trollId = '';
  let vexraId = '';
  let wispId = '';
  let goblinChunkId: Id = '';
  let roster: MonsterEntry[] = [];

  async function addChunk(bookId: Id, name: string, level: string, hp: number): Promise<Id> {
    const text = `${name}, a test creature of level ${level}.`;
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId,
        pageStart: 1,
        pageEnd: 1,
        chunkType: 'statblock',
        headingPath: [name],
        text,
        statBlock: statBlock(level, hp),
        contentHash: await sha256Hex(text),
      }),
    ]);
    const { db } = await import('@/db/db');
    const chunk = await db.chunks
      .where('bookId')
      .equals(bookId)
      .and((row) => row.headingPath[0] === name)
      .first();
    if (chunk === undefined) throw new Error(`chunk ${name} missing`);
    return chunk.id;
  }

  async function addNpc(name: string, level: string | null, hp: number): Promise<string> {
    const npc = await createArtifact({
      campaignId,
      kind: 'npc',
      name,
      data: {
        appearance: '',
        personality: '',
        statBlock: level === null ? null : statBlock(level, hp),
      },
    });
    return npc.id;
  }

  beforeEach(async () => {
    await clearDatabase();
    vi.mocked(toastError).mockClear();
    // jsdom has no layout: virtual-core reads the scroll element's
    // offsetWidth/offsetHeight synchronously (both 0 in jsdom), so the mob
    // window would render empty. A fixed 800×600 keeps the seeded creatures
    // in the window (same stub as the bestiary roster tests).
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => 800,
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 600,
    });
    campaignId = (await createCampaign({ name: 'Spawn picker', system: 'dnd5e' })).id;

    const book = await createRulebook({
      title: 'Core Bestiary',
      system: 'dnd5e',
      filename: 'core.pdf',
    });
    await updateRulebook(book.id, { status: 'ready', pageCount: 320 });
    goblinChunkId = await addChunk(book.id, 'Goblin Boss', '1', 21);
    await addChunk(book.id, 'Ancient Wyrm', '12', 200);
    await addChunk(book.id, 'Oddling', 'high', 10);

    trollId = await addNpc('Troll', '2', 84);
    vexraId = await addNpc('Vexra', '3', 30);
    wispId = await addNpc('Wisp', null, 0);

    roster = [
      monsterEntrySchema.parse({
        name: 'Troll',
        count: 1,
        notes: '',
        treasure: '',
        source: { type: 'npc-ref', artifactId: trollId },
      }),
    ];
    const encounter = await createArtifact({
      campaignId,
      kind: 'encounter',
      name: 'Bridge ambush',
      data: {
        difficulty: 'medium',
        levelHint: '', partyLevel: 3,
        monsters: roster,
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout: null,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      },
    });
    const module = await saveModule__2(
      createModule({
        campaignId,
        title: 'Spawn Module',
        concept: '',
        levelMin: 1,
        levelMax: 5,
        sizeDial: 'sketch',
      }),
    );
    moduleId = module.id;
    await seedBattleFromEncounter(campaignId, moduleId, encounter.id);
    const [battle] = await listBattlesByModule(moduleId);
    if (battle === undefined) throw new Error('battle row missing');
    battleId = battle.id;
  });

  afterEach(async () => {
    await flushAsyncUpdates(20);
    cleanup();
    delete (HTMLElement.prototype as unknown as { offsetWidth?: unknown }).offsetWidth;
    delete (HTMLElement.prototype as unknown as { offsetHeight?: unknown }).offsetHeight;
  });

  async function currentBattle() {
    const battle = await actDrained(async () => {
      const [row] = await listBattlesByModule(moduleId);
      if (row === undefined) throw new Error('battle row missing');
      return row;
    });
    return battle;
  }

  async function renderPicker(): Promise<void> {
    const artifacts = await listArtifactsByCampaign(campaignId);
    render(
      <SpawnPicker
        open
        onOpenChange={() => undefined}
        battleId={battleId}
        campaignId={campaignId}
        roster={roster}
        encounterName="Bridge ambush"
        artifacts={artifacts}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('spawn-picker-group-roster')).toBeInTheDocument();
    });
    await flushAsyncUpdates();
  }

  describe('spawn picker groups', () => {
    it('lists the roster, campaign NPCs, and core mobs', async () => {
      await renderPicker();
      expect(screen.getByTestId('spawn-picker-group-roster')).toHaveTextContent('Troll ×1');
      const npcs = screen.getByTestId('spawn-picker-group-npcs');
      expect(npcs).toHaveTextContent('Troll');
      expect(npcs).toHaveTextContent('Vexra');
      expect(npcs).toHaveTextContent('Wisp');
      const mobs = screen.getByTestId('spawn-picker-group-mobs');
      await waitFor(() => {
        expect(mobs).toHaveTextContent('Goblin Boss');
      });
      expect(mobs).toHaveTextContent('Ancient Wyrm');
      expect(mobs).toHaveTextContent('Oddling');
    });

    it('spawns a campaign NPC through the shared expansion (same artifact, fresh HP, visible)', async () => {
      await renderPicker();
      const user = userEvent.setup();
      await user.click(screen.getByTestId(`spawn-pick-npc-${vexraId}`));
      await flushAsyncUpdates();
      const battle = await currentBattle();
      const spawned = battle.board.tokens.find((token) => token.label === 'Vexra 1');
      if (spawned === undefined) throw new Error('spawned Vexra missing');
      expect(spawned.artifactId).toBe(vexraId);
      expect(spawned.currentHp).toBe(30);
      expect(spawned.visible).toBe(true);
      expect(vi.mocked(toastError)).not.toHaveBeenCalled();
    });

    it('spawns a core mob through the CITATION (no artifact, one frozen seed row, shared identity)', async () => {
      // The campaign's npc rows BEFORE the spawn: the claim is that this path
      // creates none, and the fixture's own NPCs must not be mistaken for new
      // ones.
      const npcsBefore = (await listArtifactsByCampaign(campaignId)).filter(
        (row) => row.kind === 'npc',
      ).length;
      await renderPicker();
      const mobs = screen.getByTestId('spawn-picker-group-mobs');
      await waitFor(() => {
        expect(mobs).toHaveTextContent('Goblin Boss');
      });
      const user = userEvent.setup();
      await user.click(screen.getByTestId(`spawn-pick-mob-${goblinChunkId}`));
      await flushAsyncUpdates();
      const battle = await currentBattle();
      const spawned = battle.board.tokens.find((token) => token.label === 'Goblin Boss 1');
      if (spawned === undefined) throw new Error('spawned goblin missing');
      // REWRITTEN (ledger row 106): the shared path used to get-or-create ONE mob
      // artifact for the chunk and key the token's `artifactId` on it. The
      // citation IS the reference now, so the token carries the creature IDENTITY
      // and NOTHING is created; the frozen seed row is still exactly one.
      expect(spawned.creatureKey).toBe(libraryCreatureKey(goblinChunkId));
      // `artifactId` is the SYNTHETIC seed-row id the stat carrier gets
      // (`db/battleSeed`) and names no artifact at all — the pin that matters is
      // that no campaign row exists behind it, not the literal null.
      expect(await getAnyArtifact(spawned.artifactId ?? '')).toBeUndefined();
      expect(spawned.currentHp).toBe(21);
      expect(spawned.visible).toBe(true);
      expect(battle.seedFighters).toHaveLength(1);
      expect(battle.seedFighters[0]?.creatureKey).toBe(libraryCreatureKey(goblinChunkId));
      expect(
        (await listArtifactsByCampaign(campaignId)).filter((row) => row.kind === 'npc'),
      ).toHaveLength(npcsBefore);
      expect(vi.mocked(toastError)).not.toHaveBeenCalled();
    });

    it('statless picks toast loudly and spawn HP-less tokens without dummy numbers', async () => {
      await renderPicker();
      const user = userEvent.setup();
      await user.click(screen.getByTestId(`spawn-pick-npc-${wispId}`));
      await flushAsyncUpdates();
      expect(vi.mocked(toastError)).toHaveBeenCalledWith(
        expect.stringContaining('No combat stats for:'),
      );
      const battle = await currentBattle();
      const spawned = battle.board.tokens.find((token) => token.label === 'Wisp 1');
      if (spawned === undefined) throw new Error('spawned wisp missing');
      // No placeholder numbers: the token carries null HP and resolves no
      // fighter stats (initiative excludes it, like the seed-time convention).
      expect(spawned.currentHp).toBeNull();
      const stats = buildFighterStatsLookup(battle, await listArtifactsByCampaign(campaignId));
      expect(stats(wispId)).toBeUndefined();
    });
  });

  describe('spawn picker search and sort', () => {
    it('filters all three groups by one name query', async () => {
      await renderPicker();
      const mobs = screen.getByTestId('spawn-picker-group-mobs');
      await waitFor(() => {
        expect(mobs).toHaveTextContent('Goblin Boss');
      });
      const user = userEvent.setup();
      await user.type(screen.getByTestId('spawn-picker-search'), 'vex');
      await flushAsyncUpdates();
      expect(screen.getByTestId('spawn-picker-group-roster')).toHaveTextContent(
        'No roster entries match.',
      );
      const npcs = screen.getByTestId('spawn-picker-group-npcs');
      expect(npcs).toHaveTextContent('Vexra');
      expect(npcs).not.toHaveTextContent('Troll');
      expect(screen.getByTestId('spawn-picker-group-mobs')).toHaveTextContent(
        'No creatures match.',
      );
    });

    it('toggles name/level order with statless and unparsable levels last', async () => {
      await renderPicker();
      const mobs = screen.getByTestId('spawn-picker-group-mobs');
      await waitFor(() => {
        expect(mobs).toHaveTextContent('Oddling');
      });
      const npcItems = (): (string | null)[] =>
        within(screen.getByTestId('spawn-picker-group-npcs'))
          .getAllByRole('listitem')
          .map((item) => item.textContent);
      // Default: name order.
      expect(npcItems()[0]).toContain('Troll');
      expect(npcItems()[1]).toContain('Vexra');
      expect(npcItems()[2]).toContain('Wisp');
      const user = userEvent.setup();
      await user.click(screen.getByTestId('spawn-picker-sort'));
      await flushAsyncUpdates();
      expect(screen.getByTestId('spawn-picker-sort')).toHaveTextContent('Sort: Level');
      // Level order: Troll (2), Vexra (3), then the statless Wisp last.
      expect(npcItems()[0]).toContain('Lv 2');
      expect(npcItems()[1]).toContain('Lv 3');
      expect(npcItems()[2]).toContain('no stats');
      // Core mobs: Goblin Boss (1), Ancient Wyrm (12), then the unparsable
      // 'high' Oddling last.
      const mobRows = within(screen.getByTestId('spawn-picker-mob-list')).getAllByTestId(
        'spawn-picker-mob-row',
      );
      const mobName = (row: Element): string => {
        const head = row.textContent.split('Lv')[0];
        if (head === undefined) throw new Error('mob row has no name part');
        return head.replace('Spawn', '').trim();
      };
      expect(mobRows.map((row) => mobName(row))).toEqual([
        'Goblin Boss',
        'Ancient Wyrm',
        'Oddling',
      ]);
      expect(mobRows[0]?.textContent).toContain('Lv 1');
      expect(mobRows[1]?.textContent).toContain('Lv 12');
      expect(mobRows[2]?.textContent).toContain('Lv high');
    });
  });

  describe('spawn placement', () => {
    it('lands picks on a free spot, never stacked exactly atop an existing token', async () => {
      const battle = await currentBattle();
      // Park an existing token exactly on the next computed spawn base.
      const base = nextFreeSpawnPoint(battle.board.tokens, battle.board.stagingGround);
      const victim = battle.board.tokens[0];
      if (victim === undefined) throw new Error('no tokens on the board');
      await act(async () => {
        await saveBattleBoard(battle.id, {
          ...battle.board,
          tokens: battle.board.tokens.map((token) =>
            token.id === victim.id ? { ...token, x: base.x, y: base.y } : token,
          ),
        });
      });
      await flushAsyncUpdates();
      await renderPicker();
      const user = userEvent.setup();
      await user.click(screen.getByTestId(`spawn-pick-npc-${vexraId}`));
      await flushAsyncUpdates();
      const after = await currentBattle();
      const spawned = after.board.tokens.find((token) => token.label === 'Vexra 1');
      if (spawned === undefined) throw new Error('spawned Vexra missing');
      expect(spawned.x === base.x && spawned.y === base.y).toBe(false);
    });
  });

  describe('spawn picker helpers', () => {
    it('parseLevelOrLast orders levels numerically and sorts the unparsable last', () => {
      expect(parseLevelOrLast('3')).toBe(3);
      expect(parseLevelOrLast('-1')).toBe(-1);
      expect(parseLevelOrLast('1/2')).toBe(0.5);
      expect(parseLevelOrLast('—')).toBe(Number.POSITIVE_INFINITY);
      expect(parseLevelOrLast('high')).toBe(Number.POSITIVE_INFINITY);
      // The junk the owner's materialized monster carried (docs/17 row 90): the
      // ONE level parser throws on it, and this wrapper is the picker's
      // documented containment — the creature sorts last instead of taking the
      // mid-fight picker down with it.
      expect(() => parseLevelSort('sourceName')).toThrow();
      expect(parseLevelOrLast('sourceName')).toBe(Number.POSITIVE_INFINITY);
      expect(parseLevelOrLast('')).toBe(Number.POSITIVE_INFINITY);
      expect(parseLevelOrLast(null)).toBe(Number.POSITIVE_INFINITY);
      expect(parseLevelOrLast(undefined)).toBe(Number.POSITIVE_INFINITY);
    });

    it('countLabelSlots continues the on-board count without matching longer names', () => {
      const tokens = [{ label: 'Goblin' }, { label: 'Goblin 2' }, { label: 'Goblin Chef' }];
      expect(countLabelSlots(tokens, 'Goblin')).toBe(2);
    });

    it('nextFreeSpawnPoint reuses the seeding base and nudges off occupied spots', () => {
      const base = fallbackSpawnPoint(0);
      expect(nextFreeSpawnPoint([], null)).toEqual(base);
      const nudged = nextFreeSpawnPoint([{ x: base.x, y: base.y }], null);
      expect(nudged.x === base.x && nudged.y === base.y).toBe(false);
    });

    it('spawnPickedEntry throws loudly for a missing battle (never a silent no-op)', async () => {
      const entry = monsterEntrySchema.parse({
        name: 'Ghost',
        count: 1,
        notes: '',
        treasure: '',
        source: { type: 'none' as const },
      });
      await expect(spawnPickedEntry(newId(), entry)).rejects.toThrow();
    });

    it('buildMobPickEntry COPIES the pick — the block, the stamped book line, the chunk token, no pointer', async () => {
      const entry = await buildMobPickEntry(goblinChunkId, 'Goblin Boss');
      if (entry.source.type !== 'inline') throw new Error('expected a copied inline block');
      const { db } = await import('@/db/db');
      const chunk = await db.chunks.get(goblinChunkId);
      // The library bytes, copied in full.
      expect(entry.source.statBlock).toEqual(chunk?.statBlock);
      // The label was composed at READ time before this arc; now it is STAMPED.
      expect(entry.sourceLine).toBe('Core Bestiary p.1');
      // The opaque identity token keeps the creature's portrait slot.
      expect(entry.originToken).toBe(`chunk:${goblinChunkId}`);
      // No citation spelling is born: the pick is self-contained.
      expect(JSON.stringify(entry)).not.toContain('rulebook');
    });

    it('buildMobPickEntry REFUSES a vanished chunk — no pointer is minted as a consolation', async () => {
      await expect(buildMobPickEntry(newId(), 'Ghost')).rejects.toThrow(/not in this workspace/);
    });
  });
});
