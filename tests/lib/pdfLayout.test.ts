import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/db';
import { buildModuleDefinition, buildModulePdfDocument } from '@/lib/modulePdf';
import {
  COLUMN_GUTTER,
  DETAIL_FONT_SIZE,
  MAIN_COLUMN_WIDTH,
  PAGE_MARGIN,
  SIDEBAR_COLUMN_WIDTH,
  detailPlacement,
  earlierDetailNote,
  paginateDocument,
  type PageBlock,
} from '@/lib/pdfPageModel';
import { clearDatabase } from '../db/helpers';
import {
  contentRuns,
  contentStrings,
  linkedRuns,
  nodeAnchors,
  pdfLayoutLargeFixture,
  pdfLayoutLargePlan,
  pdfLayoutOmissionFixture,
  pdfLayoutOmissionPlan,
  pdfLayoutRepeatFixture,
  pdfLayoutRepeatPlan,
  pdfLayoutSmallFixture,
} from './pdfLayoutFixtures';

/**
 * THE DOCUMENT'S PAGE MODEL (docs/19 §3–§5, docs/17 row 148).
 *
 * The owner reads the exported PDF and reported the felt problem himself: *"PDF
 * is still completely one dimensional flowing, no sidebars and nothing
 * interesting happening at all."* These pins hold the answer in place at the
 * DEFINITION level, which is all a jsdom suite can see — the last describe
 * block of this file states plainly what that cannot prove.
 *
 * FOUR things are pinned apart here, and they fail in different ways:
 *
 * 1. **CONTENT PRESERVATION** — a differential against the definitions the
 *    renderer produced BEFORE the layout, captured at the base commit with the
 *    SAME extractor this file uses (`tests/lib/pdfLayoutFixtures.ts` →
 *    `pdfLayoutBaseline.json`). A layout rewrite is where content goes missing
 *    silently, and the pre-existing definition pins could not have noticed: they
 *    assert single strings, and a moved page keeps every one of them true.
 * 2. **THE SPEC'S OWN SHAPE** — geometry (§3), the two tiers (§4), the ladder
 *    (§5), pinned BOTH as a pure rule (`detailPlacement`/`paginateDocument`) and
 *    as the definition a real module produces.
 * 3. **THE OWNER'S DECISIONS** (docs/19 §10, answered while this landing was in
 *    flight) — nothing planned is dropped for space; an artifact nothing refers
 *    to is absent AND visible as an omission.
 * 4. **NOTHING MATERIALIZED** — the layout is render-time: no stored byte and no
 *    citation moves, so a module rendered before the change renders under the
 *    new layout on its next export with no migration.
 * 5. **§7 NAVIGATION and the owner's §10.1 sidebar answer** (docs/17 row 151) —
 *    the links, the back-references, and "a companion prints once, later
 *    references link back", each pinned in BOTH directions.
 */

interface Baseline {
  strings: string[];
  runs: string[];
}

const baseline = JSON.parse(
  readFileSync(`${process.cwd()}/tests/lib/pdfLayoutBaseline.json`, 'utf8'),
) as Record<string, Baseline>;

type Json = Record<string, unknown>;

/** The top-level PAGE nodes of a definition (docs/19 §3: one per page). */
function pages(definition: { content: unknown }): Json[] {
  return (definition.content as unknown[]).filter(
    (node): node is Json => typeof node === 'object' && node !== null,
  );
}

/** The JSON of one node — the way a definition is read without re-deriving it. */
function json(node: unknown): string {
  return JSON.stringify(node);
}

/** The page whose serialized content contains `needle`. */
function pageContaining(definition: { content: unknown }, needle: string): Json {
  for (const page of pages(definition)) {
    if (json(page).includes(needle)) return page;
  }
  throw new Error(`no page carries ${needle}`);
}

/** Whether a node is a TWO-COLUMN page (the sidebar form of §3). */
function isTwoColumn(page: Json): boolean {
  return Array.isArray(page.columns);
}

/** The main column and the sidebar of a two-column page. */
function columns(page: Json): { main: Json; sidebar: Json } {
  const pair = page.columns as Json[];
  const main = pair[0];
  const sidebar = pair[1];
  if (main === undefined || sidebar === undefined) throw new Error('not a two-column page');
  return { main, sidebar };
}

/** The page carrying a section, as its main/sidebar halves (or its whole self
 * when it has no companion and so prints full width). */
function pageOf(
  definition: { content: unknown },
  needle: string,
): { main: Json; sidebar: Json | null } {
  const page = pageContaining(definition, needle);
  if (!isTwoColumn(page)) return { main: page, sidebar: null };
  const { main, sidebar } = columns(page);
  return { main, sidebar };
}

/**
 * THE DAY THE BASELINE WAS CAPTURED (docs/17 row 154).
 *
 * `pdfLayoutBaseline.json` is a capture of the PRE-layout renderer's runs, and
 * that renderer prints the day it compiled the document on the cover
 * (`src/lib/modulePdf.ts` → `Compiled with Campaigner · ${compiledDay}`), so the
 * baseline carries the day of the capture. Building the compared documents off
 * the ambient clock made this differential depend on WHICH DAY IT RAN: green on
 * the capture day, red at the next midnight, deterministically, for every reader.
 *
 * The cure is the renderer's OWN seam, not a tolerance: `compiledAt` is the
 * documented input for "a re-render is byte-identical" (the same one
 * `tests/lib/modulePdfPlan.test.ts` pins), so pinning it makes the compared
 * document a document with a KNOWN date instead of one with today's. Nothing
 * about the comparison loosens: the loss side is still `missingRuns(...) === []`
 * and the additions side still an exact `toEqual`, and the footer run stays in
 * the baseline BY TEXT — a renderer that stopped stamping the date still fails
 * this file. The product is untouched: given no `compiledAt` the renderer still
 * stamps the real day, and `tests/lib/modulePdf.test.ts` pins exactly that.
 */
const BASELINE_COMPILED_AT = new Date('2026-09-13T12:00:00.000Z');

async function documents(): Promise<Record<string, ReturnType<typeof buildModuleDefinition>>> {
  const large = await pdfLayoutLargeFixture();
  const small = await pdfLayoutSmallFixture();
  return {
    'large-procedural': buildModuleDefinition({
      module: large.module,
      artifacts: large.artifacts,
      images: large.images,
      compiledAt: BASELINE_COMPILED_AT,
      ...(large.rosterResolution === undefined ? {} : { rosterResolution: large.rosterResolution }),
    }),
    'large-planned': buildModuleDefinition({
      module: { ...large.module, documentPlan: pdfLayoutLargePlan(large) },
      artifacts: large.artifacts,
      images: large.images,
      compiledAt: BASELINE_COMPILED_AT,
      ...(large.rosterResolution === undefined ? {} : { rosterResolution: large.rosterResolution }),
    }),
    'small-procedural': buildModuleDefinition({
      module: small.module,
      artifacts: small.artifacts,
      images: small.images,
      compiledAt: BASELINE_COMPILED_AT,
    }),
  };
}

/** What `before` had and `after` has not, as a multiset difference. */
function missingRuns(before: readonly string[], after: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const run of after) remaining.set(run, (remaining.get(run) ?? 0) + 1);
  const missing: string[] = [];
  for (const run of before) {
    const left = remaining.get(run) ?? 0;
    if (left === 0) missing.push(run);
    else remaining.set(run, left - 1);
  }
  return missing;
}

// --- 1. content preservation -------------------------------------------------

describe('the page model preserves the document’s content (docs/17 row 148)', () => {
  beforeEach(clearDatabase);

  it('loses not one text run of the pre-layout renderer, in any of the three documents', async () => {
    const built = await documents();
    for (const [name, definition] of Object.entries(built)) {
      const before = baseline[name];
      if (before === undefined) throw new Error(`no baseline captured for ${name}`);
      const after = contentRuns(definition);
      // Non-vacuity: BOTH sides carry a document, and the extractor found real
      // runs on each — two empty lists agreeing proves nothing.
      expect(before.runs.length).toBeGreaterThan(50);
      expect(after.length).toBeGreaterThan(50);
      expect(missingRuns(before.runs, after)).toEqual([]);
    }
  });

  it('adds exactly the page model’s own pointers and the navigation’s own lines, and nothing else', async () => {
    const built = await documents();
    const added: Record<string, string[]> = {};
    for (const [name, definition] of Object.entries(built)) {
      const before = baseline[name];
      if (before === undefined) throw new Error(`no baseline captured for ${name}`);
      added[name] = missingRuns(contentRuns(definition), before.runs);
    }
    // The ONLY runs the document gains over the pre-layout renderer, by name
    // and in order, because the navigation slice (docs/17 row 151) ADDS runs
    // and this assertion is an EQUALITY on purpose — an extra run still fails,
    // and so does a missing one:
    //
    // 1. the §5 own-page pointer, one per own-page artifact, unchanged since
    //    row 148;
    // 2. §7's back-reference line, one per artifact section that states where
    //    it is referred to from: `Referenced from: ` + one linked run per
    //    reference place + a ` · ` separator between them. A place label that
    //    is ALSO a heading in the document (the premise/part titles) shows up
    //    here once per section that names it, because the diff is a MULTISET
    //    difference, not a set of new strings;
    // 3. the two genuinely new STRINGS are `Referenced from: ` and the ` · `
    //    separator (hence the `strings` delta of +2/+2/+1 in the counts test —
    //    every place LABEL already printed as a heading, and the three
    //    own-page pointers in `large-procedural` are row 148's).
    //
    // and nothing else — in particular not one content run is rewritten, which
    // is what makes "the same set of content strings" a real claim.
    //
    // THE ORDER IS THE DIFF'S OWN, not the document's order, and the tail of
    // `large-planned` shows why: `missingRuns` consumes the BEFORE multiset
    // greedily while it WALKS the after document, so an added run whose text
    // the pre-layout document also printed ELSEWHERE is credited to whichever
    // occurrence the walk reaches first. `A Word on the Tide` is a section
    // heading in BOTH documents, so the walk spends the heading's copy on the
    // first back-reference label that carries it and both added instances then
    // land at the END. Read the list as an exact multiset of additions, in the
    // order the extractor produced them.
    expect(added).toEqual({
      'large-procedural': [
        '“OLD TOWER” HAS ITS OWN PAGE, FOLLOWING THIS ONE.',
        'Referenced from: ',
        'Premise',
        ' · ',
        'The Dockyards',
        '“THE TURNING” HAS ITS OWN PAGE, FOLLOWING THIS ONE.',
        'Referenced from: ',
        'Premise',
        '“PIER AMBUSH” HAS ITS OWN PAGE, FOLLOWING THIS ONE.',
        'Referenced from: ',
        'Premise',
        ' · ',
        'The Vault',
        'Referenced from: ',
        'Premise',
        'Referenced from: ',
        'Premise',
        'Referenced from: ',
        'Premise',
        ' · ',
        'The Vault',
        'Referenced from: ',
        'Premise',
        'Referenced from: ',
        'Premise',
        ' · ',
        'The Dockyards',
      ],
      'large-planned': [
        '“OLD TOWER” HAS ITS OWN PAGE, FOLLOWING THIS ONE.',
        'Referenced from: ',
        'Before the Gate',
        ' · ',
        'The Dockyards',
        'Referenced from: ',
        'Before the Gate',
        ' · ',
        'The Dockyards',
        '“PIER AMBUSH” HAS ITS OWN PAGE, FOLLOWING THIS ONE.',
        'Referenced from: ',
        'Before the Gate',
        ' · ',
        'Referenced from: ',
        'Before the Gate',
        'Referenced from: ',
        'Before the Gate',
        ' · ',
        'A Word on the Tide',
        'A Word on the Tide',
      ],
      'small-procedural': [
        'Referenced from: ',
        'Premise',
        'Referenced from: ',
        'Premise',
      ],
    });
  });

  it('reports the content counts on both sides, so a silent shrink is visible', async () => {
    const built = await documents();
    const counts = Object.fromEntries(
      Object.entries(built).map(([name, definition]) => {
        const runs = contentRuns(definition);
        return [name, { runs: runs.length, strings: contentStrings(definition).length }];
      }),
    );
    // AFTER the navigation slice (docs/17 row 151): +24 / +18 / +4 runs against
    // row 148's numbers (220/165/53), all of them the §7 back-reference lines
    // itemised in the test above; +2/+2/+1 distinct strings (`Referenced from: `
    // and the ` · ` separator — every place label already printed as a heading).
    expect(counts).toEqual({
      'large-procedural': { runs: 244, strings: 161 },
      'large-planned': { runs: 183, strings: 132 },
      'small-procedural': { runs: 57, strings: 49 },
    });
    // The BEFORE numbers, from the same extractor at the base commit.
    expect(
      Object.fromEntries(
        Object.entries(baseline).map(([name, before]) => [
          name,
          { runs: before.runs.length, strings: before.strings.length },
        ]),
      ),
    ).toEqual({
      'large-procedural': { runs: 217, strings: 156 },
      'large-planned': { runs: 163, strings: 128 },
      'small-procedural': { runs: 53, strings: 48 },
    });
  });
});

// --- 2. §3: the page, the main column and the sidebar ------------------------

describe('§3 the page: a main column, a sidebar, and geometry in one place', () => {
  beforeEach(clearDatabase);

  it('lays every companion page out as two columns at the spec’s own widths', async () => {
    const built = await documents();
    const definition = built['large-procedural'];
    if (definition === undefined) throw new Error('missing fixture');
    const page = pageContaining(definition, '"text":"The Tide Wardens","style":"artifact"');
    expect(isTwoColumn(page)).toBe(true);
    const { main, sidebar } = columns(page);
    expect(main.width).toBe(MAIN_COLUMN_WIDTH);
    expect(sidebar.width).toBe(SIDEBAR_COLUMN_WIDTH);
    expect(page.columnGap).toBe(COLUMN_GUTTER);
    // The detail tier of §3 (9.5 pt) is a property of the SIDEBAR, so every
    // stat box and labeled section inside it inherits it through pdfmake's own
    // style stack rather than being restyled field by field.
    expect(sidebar.style).toBe('detail');
    expect(sidebar.fontSize).toBe(DETAIL_FONT_SIZE);
    expect(main.style).toBeUndefined();
  });

  it('prints the artifact’s mechanics in the sidebar and its text in the main column', async () => {
    const built = await documents();
    const definition = built['large-procedural'];
    if (definition === undefined) throw new Error('missing fixture');
    // A faction carries no image, so it is a `beside` companion: its fields —
    // the whole point of "related artifacts" in the owner's words — sit beside
    // the prose that names it.
    const { main, sidebar } = pageOf(definition, '"text":"The Tide Wardens","style":"artifact"');
    expect(sidebar).not.toBeNull();
    expect(json(sidebar)).toContain('Keep the bell dry.');
    expect(json(sidebar)).toContain('Bribes and drowned witnesses.');
    expect(json(main)).toContain('The Tide Wardens');
    // The two are really two columns, not one column rendered twice.
    expect(json(main)).not.toContain('Keep the bell dry.');
    expect(json(main)).not.toContain('Bribes and drowned witnesses.');
  });

  it('flows sections: the break belongs to the page, never to a heading', async () => {
    const built = await documents();
    const definition = built['large-planned'];
    if (definition === undefined) throw new Error('missing fixture');
    // §3: "Sections flow. No page break per section." Two planned sections that
    // used to be a full page each now share one page's main column.
    const flow = pageContaining(definition, '"text":"Before the Gate"');
    expect(json(flow)).toContain('"text":"The Dockyards"');
    expect(json(flow)).toContain('"id":"node-plan-1"');
    // Every heading node in the definition lives on a page, and NO heading
    // carries a page break of its own any more.
    const headings = json(definition).match(/\{"text":"[^"]*","style":"(?:chapter|h2)"/g) ?? [];
    expect(headings.length).toBeGreaterThan(4);
    for (const heading of headings) {
      expect(heading).not.toContain('pageBreak');
      expect(pageContaining(definition, heading.slice(1))).toBeDefined();
    }
    expect(pages(definition).filter(isTwoColumn).length).toBeGreaterThan(0);
  });

  it('sets the spec’s page margins, from the page model that owns them', async () => {
    const built = await documents();
    const definition = built['small-procedural'] as { pageMargins?: number[] };
    expect(definition.pageMargins).toEqual([PAGE_MARGIN, PAGE_MARGIN, PAGE_MARGIN, PAGE_MARGIN]);
    expect(PAGE_MARGIN).toBe(56.7);
    // The two columns and the gutter consume the content width exactly.
    expect(MAIN_COLUMN_WIDTH + COLUMN_GUTTER + SIDEBAR_COLUMN_WIDTH).toBeCloseTo(
      595.28 - 2 * PAGE_MARGIN,
      1,
    );
  });
});

// --- 3. §4/§5: the tiers and the ladder --------------------------------------

describe('§4/§5 the placement rule: two tiers, one deterministic ladder', () => {
  it('sends the spec’s oversized kinds, and anything carrying an image, to its own page', () => {
    // §4's list, verbatim: "an encounter, an event, a location with maps".
    expect(detailPlacement({ kind: 'encounter', hasImage: false, height: 10 })).toEqual({
      kind: 'adjacent',
      reason: 'oversized-kind',
    });
    expect(detailPlacement({ kind: 'event', hasImage: false, height: 10 })).toEqual({
      kind: 'adjacent',
      reason: 'oversized-kind',
    });
    // "a location WITH MAPS": the image is what makes it full width — and an
    // image can never live in a 60 mm column, whatever the kind.
    expect(detailPlacement({ kind: 'location', hasImage: true, height: 10 })).toEqual({
      kind: 'adjacent',
      reason: 'oversized-kind',
    });
    expect(detailPlacement({ kind: 'npc', hasImage: true, height: 10 })).toEqual({
      kind: 'adjacent',
      reason: 'oversized-kind',
    });
    // The rule did not become "every artifact gets a page".
    expect(detailPlacement({ kind: 'location', hasImage: false, height: 10 })).toEqual({
      kind: 'beside',
    });
    expect(detailPlacement({ kind: 'npc', hasImage: false, height: 10 })).toEqual({
      kind: 'beside',
    });
  });

  it('walks §5’s ladder in order: beside, continued, then its own page', () => {
    const budget = 728.5 * 0.95;
    expect(detailPlacement({ kind: 'faction', hasImage: false, height: budget - 1 })).toEqual({
      kind: 'beside',
    });
    expect(detailPlacement({ kind: 'faction', hasImage: false, height: budget + 1 })).toEqual({
      kind: 'beside-continued',
    });
    expect(detailPlacement({ kind: 'faction', hasImage: false, height: budget * 2 + 1 })).toEqual({
      kind: 'adjacent',
      reason: 'overflows-the-sidebar',
    });
  });

  it('continues a companion on the NEXT page’s sidebar and never truncates it', () => {
    // The estimator is character-driven, so LONG fields are a real overflow.
    const detail = [0, 1, 2, 3].map((index) => ({
      text: `${'x'.repeat(3000 * (index + 1))} field ${String(index)}`,
    }));
    const long: PageBlock = {
      main: [{ text: 'First block' }],
      detail,
      placement: { kind: 'beside-continued' },
      name: 'The Overflowing Thing',
    };
    const second: PageBlock = {
      main: [{ text: 'Second block' }],
      detail: [],
      placement: { kind: 'beside' },
      name: null,
    };
    const laid = paginateDocument([long, second], { styles: {} });
    expect(laid.length).toBeGreaterThan(1);
    const first = laid[0];
    const next = laid[1];
    if (first === undefined || next === undefined) throw new Error('expected two pages');
    // The first page stops with a marker; the second OPENS with the rest.
    expect(json(first.sidebar)).toContain('CONTINUE IN THE SIDEBAR OF THE NEXT PAGE');
    expect(json(next.sidebar)).toContain('CONTINUED');
    // NOTHING was dropped: every field is on one of the two pages.
    const both = `${json(first.sidebar)}${json(next.sidebar)}`;
    for (const label of ['field 0', 'field 1', 'field 2', 'field 3']) {
      expect(both).toContain(label);
    }
  });

  it('gives an own-page artifact its own full-width page, right after its text', async () => {
    const built = await documents();
    const definition = built['large-procedural'];
    if (definition === undefined) throw new Error('missing fixture');
    const own = pageContaining(definition, '"text":"Pier Ambush","style":"artifact"');
    // Full width: no sidebar, so the plate may use the whole content box.
    expect(isTwoColumn(own)).toBe(false);
    expect(json(own)).toContain('"fit":[481.9,660]');
    // §5 step 3: the pointer is left in the sidebar where the text runs, and
    // the own page is the node that FOLLOWS it.
    const list = pages(definition);
    const ownIndex = list.indexOf(own);
    expect(ownIndex).toBeGreaterThan(0);
    const before = list[ownIndex - 1];
    expect(before === undefined ? '' : json(before)).toContain(
      '“PIER AMBUSH” HAS ITS OWN PAGE, FOLLOWING THIS ONE.',
    );
    expect(json(before)).toContain('Encounters');
  });
});

// --- 4. §3’s degenerate case -------------------------------------------------

describe('§3 the degenerate page: too little for a sidebar still renders', () => {
  beforeEach(clearDatabase);

  it('never renders an empty sidebar', async () => {
    const built = await documents();
    for (const definition of Object.values(built)) {
      for (const page of pages(definition)) {
        if (page.columns === undefined) continue;
        const { sidebar } = columns(page);
        expect(Array.isArray(sidebar.stack)).toBe(true);
        expect((sidebar.stack as unknown[]).length).toBeGreaterThan(0);
      }
    }
  });

  it('renders the small module whole: a full-width text page and a two-column one', async () => {
    const built = await documents();
    const definition = built['small-procedural'];
    if (definition === undefined) throw new Error('missing fixture');
    const all = pages(definition);
    // The premise/part pages have no companion at all → plain full-width
    // stacks, which is how "the sidebar exists on every page that HAS
    // companions" reads on the page.
    expect(all.some((page) => page.columns === undefined && page.stack !== undefined)).toBe(true);
    // The NPC's own fields do give one page a sidebar.
    expect(isTwoColumn(pageContaining(definition, '"text":"The Ferryman","style":"artifact"'))).toBe(true);
  });

  it('renders a document whose only block has no companion without a sidebar at all', () => {
    const laid = paginateDocument(
      [
        {
          main: [{ text: 'A page of pure prose.' }],
          detail: [],
          placement: { kind: 'beside' },
          name: null,
        },
      ],
      { styles: {} },
    );
    expect(laid).toEqual([{ main: [{ text: 'A page of pure prose.' }], sidebar: [] }]);
  });
});

// --- 5. the verbatim contract ------------------------------------------------

describe('the content is verbatim: present, not reflowed, not truncated', () => {
  beforeEach(clearDatabase);

  it('prints a body’s paragraphs and line breaks exactly as the text carries them', async () => {
    const large = await pdfLayoutLargeFixture();
    const definition = buildModuleDefinition({
      module: large.module,
      artifacts: large.artifacts,
      images: large.images,
      ...(large.rosterResolution === undefined ? {} : { rosterResolution: large.rosterResolution }),
    });
    const runs = contentRuns(definition);
    // The location's body is `The tower watches the ford.\n\n> The tide waits
    // for no one.` — the BLANK line is a paragraph break (TWO runs, through the
    // ONE block renderer of docs/17 row 146), and neither half is reflowed or
    // clipped.
    expect(runs).toContain('The tower watches the ford.');
    expect(runs).toContain('The tide waits for no one.');
    // A SINGLE newline inside one field is a LINE BREAK and stays inside ONE
    // run: `Melee: +3 to hit, 4 damage.\nReach 5 ft.` must not become two
    // paragraphs, and must not lose its second line.
    expect(runs).toContain('Melee: +3 to hit, 4 damage.\nReach 5 ft.');
    expect(runs).not.toContain('Melee: +3 to hit, 4 damage.');
    expect(runs).not.toContain('Reach 5 ft.');
    // Every section of a stat block reaches the page, sidebar or not.
    for (const label of ['Dark Devotion: ', 'Dagger: ', 'Parry: ']) {
      expect(runs).toContain(label);
    }
    expect(runs).toContain('Adds 2 to its AC against one melee attack.');
  });

  it('keeps the builder pure: the layout reads rows and writes not one stored byte', async () => {
    const large = await pdfLayoutLargeFixture();
    const before = JSON.stringify(large.artifacts);
    const moduleBefore = JSON.stringify(large.module);
    const counts = {
      artifacts: await db.artifacts.count(),
      modules: await db.modules.count(),
      revisions: await db.revisions.count(),
    };
    buildModulePdfDocument({
      module: { ...large.module, documentPlan: pdfLayoutLargePlan(large) },
      artifacts: large.artifacts,
      images: large.images,
      ...(large.rosterResolution === undefined ? {} : { rosterResolution: large.rosterResolution }),
    });
    // The layout is RENDER-TIME (docs/19 §9): no row, no citation and no
    // revision moves, so a module generated before this change renders under
    // the new layout on its next export with no migration.
    expect(JSON.stringify(large.artifacts)).toBe(before);
    expect(JSON.stringify(large.module)).toBe(moduleBefore);
    expect({
      artifacts: await db.artifacts.count(),
      modules: await db.modules.count(),
      revisions: await db.revisions.count(),
    }).toEqual(counts);
  });
});

// --- 6. the owner’s decisions (docs/19 §10) ----------------------------------

describe('the owner’s answers to docs/19 §10, pinned in both directions', () => {
  beforeEach(clearDatabase);

  it('keeps EVERY artifact the plan places whose text refers to it (completeness binds the plan)', async () => {
    const large = await pdfLayoutLargeFixture();
    const definition = buildModuleDefinition({
      module: { ...large.module, documentPlan: pdfLayoutLargePlan(large) },
      artifacts: large.artifacts,
      images: large.images,
      ...(large.rosterResolution === undefined ? {} : { rosterResolution: large.rosterResolution }),
    });
    // This plan names five artifact sections and the module's own prose refers
    // to every one of them, so every one of them prints — nothing is dropped
    // for space, and no omission statement exists to print. The pin is on the
    // SECTION HEADINGS, not on the names: a name also appears as a bold
    // wiki-link run in the premise, so a name-only pin would stay green while
    // the section itself went missing.
    for (const section of [
      '{"text":"The Old Tower","style":"chapter"',
      '{"text":"Vexra at the Gate","style":"chapter"',
      '{"text":"Ambush on the Pier","style":"chapter"',
      '{"text":"The Bell, Quietly","style":"h2"',
      '{"text":"What the Crown Wants","style":"chapter"',
    ]) {
      expect(json(definition)).toContain(section);
    }
    expect(json(definition)).not.toContain('Not placed:');
  });

  it('drops an artifact nothing refers to, and says so on the page AND in the problems', async () => {
    const fixture = await pdfLayoutOmissionFixture();
    const { definition, problems } = buildModulePdfDocument({
      module: { ...fixture.module, documentPlan: pdfLayoutOmissionPlan(fixture) },
      artifacts: fixture.artifacts,
      images: fixture.images,
    });
    const text = json(definition);
    // The referred-to row prints, with its body.
    expect(text).toContain('The Ford');
    expect(text).toContain('Shallow enough to walk.');
    // The unreferenced row is ABSENT: neither its section title nor its body is
    // in the document.
    expect(text).not.toContain('The Toll');
    expect(text).not.toContain('He rows the crossing without ever asking for coin.');
    // …and NOT SILENT: the omission is a statement in the document naming the
    // row, and a problem on the export's own list naming the same site.
    expect(text).toContain('Not placed:');
    expect(text).toContain('The Unnamed Ferryman');
    expect(problems).toEqual([
      {
        where: 'the document plan’s placement of “The Unnamed Ferryman”',
        reason:
          'nothing in the module’s own text refers to this row, so it has no page to sit ' +
          'beside; the row is not printed (docs/19 §10)',
      },
    ]);
  });

  it('still prints an owned row nothing refers to in the PROCEDURAL outline, which has no plan to record an omission', async () => {
    const fixture = await pdfLayoutOmissionFixture();
    const { definition, problems } = buildModulePdfDocument({
      module: fixture.module,
      artifacts: fixture.artifacts,
      images: fixture.images,
    });
    // No plan ⇒ no planning decision and no plan record: the renderer's own
    // outline prints every scoped row, exactly as it always has. The owner's
    // decision is a PLANNING rule, and this document is not planned.
    expect(json(definition)).toContain('The Unnamed Ferryman');
    expect(json(definition)).toContain('He rows the crossing without ever asking for coin.');
    expect(problems).toEqual([]);
  });
});

// --- 7. §7: navigation --------------------------------------------------------

/**
 * The back-reference LINES of a definition, decoded: for every node whose
 * `text` is the run array `Referenced from: <link> · <link>…`, the places it
 * names and where each one links. Nothing here re-derives the rule — it reads
 * the definition the way pdfmake would.
 */
function backReferenceLines(node: unknown, out: { label: string; destination: string }[][] = []): {
  label: string;
  destination: string;
}[][] {
  if (typeof node !== 'object' || node === null) return out;
  if (Array.isArray(node)) {
    for (const child of node) backReferenceLines(child, out);
    return out;
  }
  const record = node as Json;
  const text = record.text;
  if (Array.isArray(text) && (text[0] as Json | undefined)?.text === 'Referenced from: ') {
    out.push(
      text
        .filter((run): run is Json => typeof run === 'object' && run !== null)
        .filter((run) => typeof run.linkToDestination === 'string')
        .map((run) => ({ label: String(run.text), destination: String(run.linkToDestination) })),
    );
  }
  for (const value of Object.values(record)) backReferenceLines(value, out);
  return out;
}

describe('§7 navigation: links everywhere, back-references, and one companion once', () => {
  beforeEach(clearDatabase);

  it('links the document’s own wiki-links to where that row PRINTS, by the row’s own destination', async () => {
    const large = await pdfLayoutLargeFixture();
    const definition = buildModuleDefinition({
      module: large.module,
      artifacts: large.artifacts,
      images: large.images,
      ...(large.rosterResolution === undefined ? {} : { rosterResolution: large.rosterResolution }),
    });
    const location = large.artifacts.find((artifact) => artifact.kind === 'location');
    if (location === undefined) throw new Error('the fixture must build a location');
    // The premise says `[[Old Tower]]`. In the PROCEDURAL document a row prints
    // at `node-<id>`, so the link's destination is the row's own node — the pin
    // is on the destination, not on "some link exists", because a link that
    // jumps somewhere else is exactly the defect this bullet forbids.
    expect(linkedRuns(definition)).toContainEqual({
      text: 'Old Tower',
      destination: `node-${location.id}`,
    });
    // …and that node really is where the row prints, under its own name.
    expect(nodeAnchors(definition).get(`node-${location.id}`)).toBe('Old Tower');
  });

  it('leaves a name this document does NOT print as plain bold text (never a dangling link)', async () => {
    const large = await pdfLayoutLargeFixture();
    const planned = buildModuleDefinition({
      module: { ...large.module, documentPlan: pdfLayoutLargePlan(large) },
      artifacts: large.artifacts,
      images: large.images,
      ...(large.rosterResolution === undefined ? {} : { rosterResolution: large.rosterResolution }),
    });
    const procedural = buildModuleDefinition({
      module: large.module,
      artifacts: large.artifacts,
      images: large.images,
      ...(large.rosterResolution === undefined ? {} : { rosterResolution: large.rosterResolution }),
    });
    const marek = large.artifacts.find((artifact) => artifact.name === 'Marek');
    if (marek === undefined) throw new Error('the fixture must build Marek');
    // The premise names `[[Marek]]` in BOTH documents. The plan gives Marek no
    // section and he is not an NPC, so the planned document prints him NOWHERE
    // — there is nothing to jump to, and pdfmake throws on a link that names no
    // node. Both directions are pinned: absent there, present in the outline.
    expect(contentRuns(planned)).toContain('Marek');
    expect(linkedRuns(planned).some((link) => link.text === 'Marek')).toBe(false);
    expect(linkedRuns(procedural)).toContainEqual({
      text: 'Marek',
      destination: `node-${marek.id}`,
    });
  });

  it('never emits a link to a destination the same document does not carry, in any audience', async () => {
    const large = await pdfLayoutLargeFixture();
    const small = await pdfLayoutSmallFixture();
    const player = { audience: 'player' as const };
    const built: Record<string, ReturnType<typeof buildModuleDefinition>> = {
      procedural: buildModuleDefinition({
        module: large.module,
        artifacts: large.artifacts,
        images: large.images,
        ...(large.rosterResolution === undefined ? {} : { rosterResolution: large.rosterResolution }),
      }),
      planned: buildModuleDefinition({
        module: { ...large.module, documentPlan: pdfLayoutLargePlan(large) },
        artifacts: large.artifacts,
        images: large.images,
        ...(large.rosterResolution === undefined ? {} : { rosterResolution: large.rosterResolution }),
      }),
      // §7's last bullet: the audience split stays — one plan, a player
      // document from it — and its navigation is internally consistent too.
      'procedural-player': buildModuleDefinition({
        module: large.module,
        artifacts: large.artifacts,
        images: large.images,
        ...player,
        ...(large.rosterResolution === undefined ? {} : { rosterResolution: large.rosterResolution }),
      }),
      'planned-player': buildModuleDefinition({
        module: { ...large.module, documentPlan: pdfLayoutLargePlan(large) },
        artifacts: large.artifacts,
        images: large.images,
        ...player,
        ...(large.rosterResolution === undefined ? {} : { rosterResolution: large.rosterResolution }),
      }),
      small: buildModuleDefinition({
        module: small.module,
        artifacts: small.artifacts,
        images: small.images,
      }),
    };
    for (const [name, definition] of Object.entries(built)) {
      const anchors = nodeAnchors(definition);
      const links = linkedRuns(definition);
      // Non-vacuity: each of these documents really emits links.
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        if (anchors.has(link.destination)) continue;
        throw new Error(`${name}: “${link.text}” links to ${link.destination}, which the document does not carry`);
      }
    }
  });

  it('states where an artifact is referred to from, as internal links to those places', async () => {
    const large = await pdfLayoutLargeFixture();
    const definition = buildModuleDefinition({
      module: large.module,
      artifacts: large.artifacts,
      images: large.images,
      ...(large.rosterResolution === undefined ? {} : { rosterResolution: large.rosterResolution }),
    });
    const location = large.artifacts.find((artifact) => artifact.kind === 'location');
    if (location === undefined) throw new Error('the fixture must build a location');
    // `[[Old Tower]]` is named in the premise and in part 1, and in that order —
    // so the row's section states exactly those two places, each one a link to
    // where it prints (`node-premise`, `node-part-0`). The ORDER is the
    // document's own reading order, which is the only order a reader can use.
    expect(backReferenceLines(definition)).toContainEqual([
      { label: 'Premise', destination: 'node-premise' },
      { label: 'The Dockyards', destination: 'node-part-0' },
    ]);
    // …and the line belongs to the row's own section, not to some other page.
    const section = pageOf(definition, '"text":"Old Tower","style":"artifact"');
    expect(json(section.main)).toContain('"text":"Referenced from: "');
  });

  it('states NOTHING for a row the document’s own text never names', async () => {
    const fixture = await pdfLayoutOmissionFixture();
    const { definition } = buildModulePdfDocument({
      module: fixture.module,
      artifacts: fixture.artifacts,
      images: fixture.images,
    });
    // The procedural outline prints this owned row (no plan records an
    // omission), but nothing refers to it — so it prints no back-reference
    // line: an empty `Referenced from:` would be a claim the text does not
    // support. Its sibling, named by the premise, does state one.
    const silent = pageOf(definition, '"text":"The Unnamed Ferryman","style":"artifact"');
    expect(json(silent.main)).not.toContain('Referenced from:');
    expect(json(pageContaining(definition, '"text":"The Ford","style":"artifact"'))).toContain(
      'Referenced from: ',
    );
  });
});

// --- 8. §10.1: one companion, with a link back --------------------------------

describe('§10.1 the sidebar answer — a companion prints ONCE, later references link BACK', () => {
  beforeEach(clearDatabase);

  /** The repeat fixture's document: one row, named by TWO plan sections. */
  async function repeated(): Promise<{
    definition: ReturnType<typeof buildModuleDefinition>;
    name: string;
  }> {
    const fixture = await pdfLayoutRepeatFixture();
    const row = fixture.artifacts[0];
    if (row === undefined) throw new Error('the fixture must build its row');
    return {
      definition: buildModuleDefinition({
        module: { ...fixture.module, documentPlan: pdfLayoutRepeatPlan(fixture) },
        artifacts: fixture.artifacts,
        images: fixture.images,
      }),
      name: row.name,
    };
  }

  it('prints the companion at the FIRST reference and the link back at the later one', async () => {
    const { definition, name } = await repeated();
    const runs = contentRuns(definition);
    const pointer = earlierDetailNote(name).toUpperCase();
    // §4 sends an encounter to its own page, so the two referencing sections
    // are two pages and each one can be read on its own — which is the whole
    // point of the fixture. The FIRST carries the mechanics and no pointer…
    const first = pageOf(definition, '"text":"The Bell Ambush, first","style":"chapter"');
    expect(json(first.main)).toContain('wet planks by the bell rope');
    expect(json(first.main)).not.toContain(pointer);
    // …and the LATER one carries the pointer and NOT the mechanics.
    const later = pageOf(definition, '"text":"The Bell Ambush, again","style":"chapter"');
    expect(json(later.main)).toContain(pointer);
    expect(json(later.main)).not.toContain('wet planks by the bell rope');
    // The link goes BACK to where the companion printed: the FIRST section's
    // own anchor, never the later section's.
    expect(linkedRuns(definition).filter((link) => link.text === pointer)).toEqual([
      { text: pointer, destination: 'node-plan-1' },
    ]);
    expect(nodeAnchors(definition).get('node-plan-1')).toBe('The Bell Ambush, first');
    expect(nodeAnchors(definition).has('node-plan-2')).toBe(true);
    // NON-VACUITY, both directions, over the whole document as well: each half
    // appears EXACTLY once. Printing the companion twice (no rule) reds the
    // first count; making every reference link back reds the second.
    expect(runs.filter((run) => run === 'wet planks by the bell rope')).toEqual([
      'wet planks by the bell rope',
    ]);
    expect(runs.filter((run) => run === pointer)).toEqual([pointer]);
  });
});
