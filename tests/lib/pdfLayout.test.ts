import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';

import type { Content } from 'pdfmake/interfaces';

import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/db';
import { buildModuleDefinition, buildModulePdfDocument } from '@/lib/modulePdf';
import { generatePdfBlob } from '@/lib/pdfExport';
import { copyBytes, openPdfDocument } from '@/lib/pdfRuntime';
import {
  COLUMN_GUTTER,
  DETAIL_FONT_SIZE,
  MAIN_COLUMN_WIDTH,
  PAGE_CONTENT_HEIGHT,
  PAGE_MARGIN,
  SIDEBAR_COLUMN_WIDTH,
  continuedNote,
  detailPlacement,
  earlierDetailNote,
  estimateHeight,
  isMarkerContent,
  ownPageNote,
  paginateDocument,
  type MeasureContext,
  type PageBlock,
} from '@/lib/pdfPageModel';
import { clearDatabase } from '../db/helpers';
import {
  contentRuns,
  contentStrings,
  linkedRuns,
  nodeAnchors,
  pdfLayoutCarryFixture,
  pdfLayoutCarryPlan,
  pdfLayoutCompanionRepeatPlan,
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
 * 6. **THE CONTENTS PAGE'S PAGE NUMBERS, on the RENDERED document** (docs/17
 *    row 156, docs/19 §7's second bullet) — the ToC's numbers are pdfmake's own
 *    page references, so this is the first pin in the repo that opens the PDF
 *    the export actually produces (pdfjs), reads each page's text layer back,
 *    and requires the number the Contents prints to BE the page that section
 *    lands on. A definition-level pin cannot see a page number at all: the
 *    entries and their numbers do not exist until pdfmake lays the document out
 *    (`pdfmake/js/DocMeasure.js` → `measureToc`), which is why two earlier
 *    slices could not tell whether the numbers were real. This one can, and it
 *    does not re-derive pdfmake's rule: the expected page is read off the
 *    rendered page that carries the section's heading at its own type size.
 * 7. **A ONE-SIDED PAGE USES THE WHOLE SHEET** (docs/17 row 186, the owner:
 *    *"Some pages have just a sidebar, nothing else. Makes no sense. If there
 *    is nothing else, of course the sidebar can use all room."* / *"Similar
 *    problem with main area. If there IS no sidebar, use all room"* / *"Some
 *    pages just say \"x has its own page, following this one\". Which is
 *    comical. A whole empty page to announce the following."*) — a page lays
 *    out as ONE full-width column unless BOTH columns carry REAL content, and
 *    a marker sentence (`ownPageNote` / `continuedNote` / `earlierDetailNote`)
 *    is not content: it rides the TEXT column and may never form a page or own
 *    a column. The marker/real question is answered in ONE place
 *    (`pdfPageModel.isMarkerContent`, the brand `marker()` stamps on every
 *    marker), never by matching prose, and the pins below hold it at the node
 *    shape AND on the RENDERED page (pdfjs item geometry), because the old
 *    defect was a page whose only text started at the sidebar's x offset.
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
    // The runs the document gains over the pre-layout renderer, by name and in
    // order, because this assertion is an EQUALITY on purpose — an extra run
    // still fails, and so does a missing one:
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
    //    own-page pointers in `large-procedural` are row 148's);
    // 4. **the four cells of the small fixture's markdown table** (docs/17 row
    //    157): `Item`, `Value`, `Silver bell`, `40 gp`, in the table's own
    //    reading order, and ONLY in `small-procedural`, because that fixture's
    //    part is the one that carries a table. The baseline beside this list is
    //    a capture of the renderer that DELETED a table row, so the table's
    //    cells are additions by construction — they are the slice's own,
    //    measured contribution, and they sit FIRST for the part page, which the
    //    extractor reaches before the artifact chapters' back-references. This
    //    is the differential's table alarm: a renderer that drops a row (or
    //    pads one away) removes a string from THIS list and reds an equality.
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
        // The small fixture's markdown TABLE, cell by cell (docs/17 row 157):
        // the part page is read before the artifact chapters, so the table's
        // four cells lead the list.
        'Item',
        'Value',
        'Silver bell',
        '40 gp',
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
    // AFTER the markdown-table slice (docs/17 row 157): `small-procedural`'s
    // part carries a table, so that document gains +4 runs / +4 distinct
    // strings — its four cells, the same four itemised as item 4 of the added
    // list above. `large-procedural` and `large-planned` do NOT move: neither
    // fixture carries a table, which is why the table's delta is visible in
    // exactly one document and nothing else in the document shifted.
    //
    // The road here, for a reader checking the arithmetic: row 148 captured
    // 220 / 165 / 53 runs; the navigation slice (row 151) added +24 / +18 / +4
    // (the §7 back-reference lines) with +2 / +2 / +1 distinct strings
    // (`Referenced from: ` and the ` · ` separator — every place label already
    // printed as a heading); this slice adds +4 / +0 / +0 runs and strings.
    expect(counts).toEqual({
      'large-procedural': { runs: 244, strings: 161 },
      'large-planned': { runs: 183, strings: 132 },
      'small-procedural': { runs: 61, strings: 53 },
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
    // §5 step 3: the pointer is left where the text runs, and the own page is
    // the node that FOLLOWS it. UPDATED BY docs/17 row 186 (the owner: *"Some
    // pages just say \"x has its own page, following this one\". Which is
    // comical. A whole empty page to announce the following."*): the pointer is
    // a MARKER, so it rides the TEXT column and never owns a sidebar — the page
    // before the own page is the ONE full-width `stack` below, where the OLD
    // form made it a two-column page whose sidebar held the sentence alone. The
    // pointer itself is unchanged and still prints on the same page, in the same
    // "following this one" sense.
    const list = pages(definition);
    const ownIndex = list.indexOf(own);
    expect(ownIndex).toBeGreaterThan(0);
    const before = list[ownIndex - 1];
    if (before === undefined) throw new Error('the own page must follow a page');
    expect(isTwoColumn(before)).toBe(false);
    expect(json(before)).toContain('“PIER AMBUSH” HAS ITS OWN PAGE, FOLLOWING THIS ONE.');
    expect(json(before)).toContain('Encounters');
  });

  it('prints the artifact’s OWN cover and map plate in a PLANNED document with no anchors at all (docs/17 row 187)', async () => {
    const large = await pdfLayoutLargeFixture();
    const plan = pdfLayoutLargePlan(large);
    // Every section's anchors removed: the plan contributes NO image, so what
    // prints is the artifact's own art or nothing.
    const unanchored = {
      ...plan,
      sections: plan.sections.map((section) => ({ ...section, images: [] })),
    };
    const planned = buildModuleDefinition({
      module: { ...large.module, documentPlan: unanchored },
      artifacts: large.artifacts,
      images: large.images,
    });
    const procedural = buildModuleDefinition({
      module: { ...large.module, documentPlan: null },
      artifacts: large.artifacts,
      images: large.images,
    });
    const imageNodes = (definition: { content: unknown }): number =>
      (json(definition).match(/"image":/g) ?? []).length;
    // The module cover, the location's own cover art and the encounter's own
    // map plate — the SAME three nodes the procedural outline prints, because
    // the artifact's own image was never the plan's to gate.
    expect(imageNodes(planned)).toBe(3);
    expect(imageNodes(procedural)).toBe(3);
    expect(json(planned)).toContain('"fit":[450,320]');
    expect(json(planned)).toContain('"fit":[481.9,660]');
    // …and the §4 full-width treatment a location with a cover needs: its own
    // page follows the page that announces it, exactly as in the procedural
    // document.
    expect(json(planned)).toContain('“OLD TOWER” HAS ITS OWN PAGE, FOLLOWING THIS ONE.');
  });
});

// --- 3b. docs/17 row 186: a one-sided page uses the whole sheet --------------

/** The REAL nodes of a page half — every marker sentence filtered out, through
 * the page model's own brand (`isMarkerContent`), never by matching prose. */
function realNodes(half: unknown): unknown[] {
  return ((half as unknown[] | undefined) ?? []).filter(
    (node) => !isMarkerContent(node as Content),
  );
}

/** The nodes of one page node, whichever shape it has. */
function pageNodesOf(page: Json): unknown[] {
  const halves: unknown[] =
    page.columns === undefined
      ? [page.stack]
      : (page.columns as Json[]).map((column) => column.stack);
  return halves.flatMap((half) => (half as unknown[] | undefined) ?? []);
}

/** `documents()` PLUS the two shapes only the row-186 pins build: the repeated
 * companion (whose second reference used to be a page carrying the announcement
 * alone) and the omission fixture. */
async function everyDocument(): Promise<Record<string, ReturnType<typeof buildModuleDefinition>>> {
  const built = await documents();
  const repeated = await pdfLayoutRepeatFixture();
  built['repeat-planned'] = buildModuleDefinition({
    module: { ...repeated.module, documentPlan: pdfLayoutRepeatPlan(repeated) },
    artifacts: repeated.artifacts,
    images: repeated.images,
  });
  const omission = await pdfLayoutOmissionFixture();
  built['omission-planned'] = buildModuleDefinition({
    module: { ...omission.module, documentPlan: pdfLayoutOmissionPlan(omission) },
    artifacts: omission.artifacts,
    images: omission.images,
  });
  return built;
}

describe('docs/17 row 186 — a one-sided page uses the whole sheet, markers are not content', () => {
  beforeEach(clearDatabase);

  it('never gives a page a two-column frame with no real content on a side, and never prints a page of markers alone', async () => {
    // The owner, verbatim: *"Some pages have just a sidebar, nothing else.
    // Makes no sense. If there is nothing else, of course the sidebar can use
    // all room."* / *"Similar problem with main area. If there IS no sidebar,
    // use all room"* / *"Some pages just say \"x has its own page, following
    // this one\". Which is comical. A whole empty page to announce the
    // following."* Every page of all FIVE fixture documents is walked: a
    // `columns` page must carry REAL content in BOTH halves, and no page may
    // consist of marker sentences alone.
    const built = await everyDocument();
    let twoColumnPages = 0;
    for (const [name, definition] of Object.entries(built)) {
      for (const [index, page] of pages(definition).entries()) {
        const where = `${name} page ${String(index + 1)}`;
        if (page.columns !== undefined) {
          const { main, sidebar } = columns(page);
          twoColumnPages += 1;
          expect(realNodes(main.stack).length, `${where}: a two-column page with an empty main column`).toBeGreaterThan(0);
          expect(realNodes(sidebar.stack).length, `${where}: a two-column page with no real sidebar`).toBeGreaterThan(0);
        }
        const nodes = pageNodesOf(page);
        expect(nodes.length, `${where}: a page with nothing on it`).toBeGreaterThan(0);
        expect(realNodes(nodes).length, `${where}: a page whose only content is marker sentences`).toBeGreaterThan(0);
      }
    }
    // NON-VACUITY: the rule did not become "no page is ever two-column" — the
    // fixtures really do produce pages that genuinely carry both columns.
    expect(twoColumnPages).toBeGreaterThan(0);
  });

  it('never emits a page whose whole content is the own-page announcement (two own-page artifacts in a row)', () => {
    // docs/17 row 186, the owner: *"A whole empty page to announce the
    // following."* This is the shape that produces it, driven at the ONE seam
    // that can: two `adjacent` blocks back to back. The first own page's
    // `pages.push` does NOT fill the paginator's accumulator, so when the second
    // block pushes its pointer, `main` is empty — and without the marker-only
    // boundary in `flush` the pointer would flush as a page of its own. The
    // boundary drops it, and the artifact's own page follows.
    const own = (text: string, name: string): PageBlock => ({
      main: [{ text }],
      detail: [{ text: `${name} companion` }],
      placement: { kind: 'adjacent', reason: 'oversized-kind' },
      name,
    });
    const laid = paginateDocument([own('First artifact', 'Thing One'), own('Second artifact', 'Thing Two')], {
      styles: {},
    });
    // Two pages — one per artifact — and NOTHING else: the two pointers are
    // dropped rather than becoming sheets of their own.
    expect(laid).toHaveLength(2);
    for (const page of laid) {
      expect(page.sidebar).toEqual([]);
      expect(page.main.some((node) => !isMarkerContent(node))).toBe(true);
    }
    // …and NOTHING is lost: each artifact's own companion print survives on its
    // own page (the pointer was the only thing dropped).
    expect(contentRuns(laid)).toContain('Thing One companion');
    expect(contentRuns(laid)).toContain('Thing Two companion');
  });

  it('keeps a companion-only page (an empty main column) instead of dropping its detail', () => {
    // docs/17 row 186 rule (d): the `beside-continued` carry page has an EMPTY
    // main column, and this document owes it its companion — nothing is dropped
    // to make the page nicer (docs/19 §9). The paginator is driven directly with
    // ONE overflowing companion as the LAST block, so no following block can
    // fill the carry page's main column.
    const detail = [0, 1, 2, 3].map((index) => ({
      text: `${'x'.repeat(3000 * (index + 1))} field ${String(index)}`,
    }));
    const long: PageBlock = {
      main: [{ text: 'The only text' }],
      detail,
      placement: { kind: 'beside-continued' },
      name: 'The Overflowing Companion',
    };
    const laid = paginateDocument([long], { styles: {} });
    const carry = laid[laid.length - 1];
    if (carry === undefined) throw new Error('the paginator must emit the carry page');
    // The carry page carries the continuation and NO text …
    expect(carry.main).toEqual([]);
    expect(realNodes(carry.sidebar).length).toBeGreaterThan(0);
    // … and the WHOLE companion reached a page (the split is never a truncation).
    const all = contentRuns(laid);
    for (const label of ['field 0', 'field 1', 'field 2', 'field 3']) {
      expect(all.some((run) => run.includes(label))).toBe(true);
    }
  });

  it('prints a companion-only page as ONE full-width stack, never as an empty column beside a populated one', async () => {
    // The definition-level half of rule (d): the carry fixture's last section is
    // an npc whose detail outgrows one sidebar, so the document's LAST page is
    // the continuation — and `pageNodes` must give it the whole sheet, not an
    // empty 104 mm main column beside the 60 mm companion. The 'CONTINUED' head
    // is the page's own marker, so the pin finds the page by it.
    const fixture = await pdfLayoutCarryFixture();
    const row = fixture.artifacts[0];
    if (row === undefined) throw new Error('the carry fixture must build its row');
    const definition = buildModuleDefinition({
      module: { ...fixture.module, documentPlan: pdfLayoutCarryPlan(fixture) },
      artifacts: fixture.artifacts,
      images: fixture.images,
    });
    const carryPage = pageContaining(definition, continuedNote(row.name, 'next').toUpperCase());
    // Non-vacuity is the companion detail itself: the stat block's own sections
    // reached THIS page (the continuation was neither truncated nor dropped).
    expect(json(carryPage)).toContain('Dark Devotion: ');
    expect(json(carryPage)).toContain('Dagger: ');
    // ONE full-width stack — no `columns` node, so nothing is confined to
    // `MAIN_COLUMN_WIDTH` and no empty column is drawn beside the companion.
    expect(isTwoColumn(carryPage)).toBe(false);
    expect(carryPage.columns).toBeUndefined();
  });

  it('renders a page whose sidebar carries no REAL companion content as ONE full-width stack', async () => {
    // docs/17 row 186, and the owner CONFIRMED this direction is real, not the
    // mirror of the empty-main case: *"Yes, there was a page where the main
    // content was there and narrow without a side bar."* The MECHANISM was a
    // sidebar that is NON-EMPTY but holds only the 8 pt uppercase pointer:
    // `pageNodes` saw a non-empty `sidebar` array and emitted `columns`, so the
    // text was confined to `MAIN_COLUMN_WIDTH` (104 mm) beside a 60 mm column
    // carrying a sentence a reader would not call a sidebar. The shape is now
    // decided on REAL content, so both cases below are ONE full-width `stack`:
    //
    // (1) the page carrying the pointer to “Old Tower” in the PLANNED document,
    //     whose main column holds the two real sections before it — the owner's
    //     exact report, main content present and no real sidebar;
    // (2) the chapter page before an own-page artifact in the PROCEDURAL
    //     document, whose main column holds the chapter heading.
    const built = await documents();
    const planned = built['large-planned'];
    const procedural = built['large-procedural'];
    if (planned === undefined || procedural === undefined) throw new Error('missing fixture');
    const pointer = '“OLD TOWER” HAS ITS OWN PAGE, FOLLOWING THIS ONE.';
    const plannedPage = pageContaining(planned, pointer);
    expect(isTwoColumn(plannedPage)).toBe(false);
    expect(plannedPage.columns).toBeUndefined();
    // The main content really is there, and the pointer rides the SAME text
    // column: it is neither dropped nor given a 60 mm column of its own.
    expect(json(plannedPage)).toContain('"text":"Before the Gate"');
    expect(json(plannedPage)).toContain('"text":"The Dockyards"');
    expect(json(plannedPage)).toContain(pointer);
    expect(realNodes(plannedPage.stack).length).toBeGreaterThanOrEqual(2);
    // The procedural chapter page: one heading, and the marker as its second
    // node — real content and the marker in ONE column.
    const chapterPage = pageContaining(procedural, pointer);
    expect(isTwoColumn(chapterPage)).toBe(false);
    expect(json(chapterPage)).toContain('"text":"Locations","style":"chapter"');
    const chapterStack = chapterPage.stack as Content[];
    expect(chapterStack).toHaveLength(2);
    expect(chapterStack.filter(isMarkerContent)).toHaveLength(1);
    expect(realNodes(chapterStack)).toHaveLength(1);
  });

  it('keeps the own-page artifact’s details AND prints no page that is only the announcement', async () => {
    // The repeat fixture is the shape that reproduced the owner's whole-page
    // announcement: one encounter named by TWO plan sections, so the SECOND
    // reference's own-page pointer was pushed onto an EMPTY page (the first
    // reference's own page had just closed it) and `flush` emitted
    // `{main: [], sidebar: [pointer]}`, a whole sheet for one sentence.
    // docs/17 row 186: the pointer goes onto a page that already carries text,
    // or it is dropped — the artifact's own page follows immediately.
    const fixture = await pdfLayoutRepeatFixture();
    const definition = buildModuleDefinition({
      module: { ...fixture.module, documentPlan: pdfLayoutRepeatPlan(fixture) },
      artifacts: fixture.artifacts,
      images: fixture.images,
    });
    const list = pages(definition);
    // NOTHING IS LOST: the first own page still prints the encounter's own
    // details (the roster's stat block), and the later reference's page carries
    // the link back to them.
    const first = pageContaining(definition, '"text":"The Bell Ambush, first","style":"chapter"');
    expect(json(first)).toContain('Bellringer');
    const later = pageContaining(definition, '"text":"The Bell Ambush, again","style":"chapter"');
    expect(json(later)).toContain(earlierDetailNote('The Bell Ambush').toUpperCase());
    // NO page is only the announcement — the announcement never appears on a
    // page that carries nothing else, and no page here is markers alone.
    for (const [index, page] of list.entries()) {
      const nodes = pageNodesOf(page);
      expect(realNodes(nodes).length, `repeat page ${String(index + 1)}`).toBeGreaterThan(0);
    }
    // The empty announcement page is GONE. MEASURED: this fixture used to
    // paginate to 6 pages (cover, Contents, `At the Rope` + pointer, the first
    // own page, the pointer-ONLY page, the later own page); the fixed document
    // is 5, and the drop is exactly the page that carried one sentence.
    expect(list).toHaveLength(5);
  });
});

// --- 4. §3’s degenerate case -------------------------------------------------

describe('§3 the degenerate page: too little for a sidebar still renders', () => {
  beforeEach(clearDatabase);

  it('never renders a two-column page with a side that holds no real content', async () => {
    // UPDATED BY docs/17 row 186 (the owner: *"Some pages have just a sidebar,
    // nothing else. Makes no sense. If there is nothing else, of course the
    // sidebar can use all room."* / *"Similar problem with main area. If there
    // IS no sidebar, use all room"*). The old pin forbade only an EMPTY sidebar
    // array, which a page whose sidebar held one marker sentence passed while
    // it squeezed the text into 104 mm of a blank sheet; the rule is now that a
    // two-column frame exists only for a page whose BOTH sides carry REAL
    // content. The companion pin over every fixture (and every page) is in the
    // row-186 block above.
    const built = await documents();
    for (const definition of Object.values(built)) {
      for (const page of pages(definition)) {
        if (page.columns === undefined) continue;
        const { main, sidebar } = columns(page);
        expect(Array.isArray(sidebar.stack)).toBe(true);
        expect((sidebar.stack as unknown[]).length).toBeGreaterThan(0);
        expect(realNodes(sidebar.stack).length).toBeGreaterThan(0);
        expect(realNodes(main.stack).length).toBeGreaterThan(0);
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

// --- 8b. docs/17 row 188: a section's ONE companion --------------------------

/**
 * THE OWNER'S SIDEBAR WISH, MADE A PLAN DECISION (docs/17 row 188), verbatim:
 * *"Ideally important NPCs should be introduced in a sidebar where the story
 * introduces them. I understand that the sidebar can get crowded though, thats
 * where an LLM needs to make an intelligent judgement call."*
 *
 * The division of labour is the one row 109 ratified: the PLANNER decides WHICH
 * introductions earn a sidebar (the judgement call), and the RENDERER decides
 * WHERE the result fits (the §5 ladder). A companion whose row already printed
 * is a REPEATED companion, so §10.1's once-rule must hold for it exactly as it
 * does for a source row — that is what the pin below measures.
 */
describe('docs/17 row 188 — a section’s ONE companion sits beside the story that introduces it', () => {
  beforeEach(clearDatabase);

  it('prints a companion named by TWO sections ONCE, and the later one carries the §10.1 link back', async () => {
    const fixture = await pdfLayoutLargeFixture();
    const npc = fixture.artifacts.find((artifact) => artifact.kind === 'npc');
    if (npc === undefined) throw new Error('the fixture must build its npc');
    const definition = buildModuleDefinition({
      module: { ...fixture.module, documentPlan: pdfLayoutCompanionRepeatPlan(fixture) },
      artifacts: fixture.artifacts,
      images: fixture.images,
      ...(fixture.rosterResolution === undefined
        ? {}
        : { rosterResolution: fixture.rosterResolution }),
    });
    const runs = contentRuns(definition);
    const pointer = earlierDetailNote(npc.name).toUpperCase();
    // The FIRST section's page carries the NPC's profile in its sidebar, under
    // her own name — this is the owner-visible outcome, on a real fixture.
    const first = pageOf(definition, '"text":"The Dockyards","style":"chapter"');
    expect(json(first.sidebar ?? first.main)).toContain(npc.name);
    expect(json(first.sidebar ?? first.main)).toContain('Appearance');
    // The LATER section states where the profile printed…
    expect(json(pageContaining(definition, '"text":"The Vault","style":"chapter"'))).toContain(
      pointer,
    );
    // …and the link goes BACK to the FIRST section's own anchor, never forward.
    expect(linkedRuns(definition).filter((link) => link.text === pointer)).toEqual([
      { text: pointer, destination: 'node-plan-0' },
    ]);
    // NON-VACUITY, both halves, over the whole document: each appears EXACTLY
    // once. Printing the companion twice reds the first count; making every
    // reference link back reds the second.
    expect(runs.filter((run) => run === 'Hooded')).toEqual(['Hooded']);
    expect(runs.filter((run) => run === pointer)).toEqual([pointer]);
    // The companion IS printed by the plan, so the NPC gallery does not describe
    // her a second time — no `node-<id>` gallery anchor exists for her.
    expect(nodeAnchors(definition).has(`node-${npc.id}`)).toBe(false);
    // A wiki-link to the introduced row jumps to the page whose sidebar carries
    // it (its destination is the introducing section's, docs/17 row 188).
    expect(linkedRuns(definition)).toContainEqual({ text: 'Vexra', destination: 'node-plan-0' });
  });
});

// --- 9. §7’s Contents page, on the RENDERED document --------------------------

/**
 * THE PDF, READ BACK (docs/17 row 156, docs/19 §7's second bullet).
 *
 * Every pin below is about a page a reader holds, not about a definition:
 * `generatePdfBlob` produces the document the export produces, pdfjs opens it,
 * and each page's text layer is read item by item. An item carries its own
 * string AND its own rendered type size (`height`), which is the whole reason
 * this is possible: it lets a section's HEADING be told apart from the same
 * name mentioned in the prose (11 pt) or shouted in a pointer sentence (8 pt).
 *
 * WHY IT HAD TO BE DONE HERE. The Contents entries and their page numbers do
 * not exist in the definition at all — pdfmake builds them while it lays the
 * document out (`pdfmake/js/DocMeasure.js` → `measureToc` reads the `tocItem`
 * nodes and fills the page-number cells with page references). A
 * definition-level suite can therefore see the `toc` node and the `tocItem`
 * markers and still not know whether a single number prints, let alone whether
 * it is the right one — which is exactly the gap docs/17 rows 148 and 151
 * described as "the ToC still prints without page numbers".
 */
interface RenderedItem {
  readonly text: string;
  readonly size: number;
  /** The item's own x on the page, in points — the geometry a definition-level
   * pin cannot see (docs/17 row 186 reads it back to prove a one-sided page's
   * text starts at the PAGE MARGIN and not at the sidebar's offset). */
  readonly x: number;
}

interface RenderedDocument {
  /** Every page's text items, in reading order, empty runs dropped. */
  readonly pages: readonly (readonly RenderedItem[])[];
  /** Every page's internal link DESTINATIONS, in the PDF's own order. */
  readonly linkDests: readonly (readonly string[])[];
}

/** Render a definition and read the whole document back through pdfjs. */
async function render(document: Parameters<typeof generatePdfBlob>[0]): Promise<RenderedDocument> {
  const blob = await generatePdfBlob(document);
  const bytes = copyBytes(new Uint8Array(await blob.arrayBuffer()));
  const { doc, destroy } = await openPdfDocument(bytes);
  try {
    const pages: RenderedItem[][] = [];
    const linkDests: string[][] = [];
    for (let page = 1; page <= doc.numPages; page += 1) {
      const proxy = await doc.getPage(page);
      const content = await proxy.getTextContent();
      pages.push(
        content.items
          .map((item) => {
            if (!('str' in item)) return null;
            // pdfjs types the transform as `any[]`, so it is read as `unknown[]`
            // and the x is taken with a real numeric guard (docs/17 row 186).
            const x = (item.transform as unknown[])[4];
            return {
              text: item.str,
              size: Math.round(item.height),
              x: typeof x === 'number' ? x : 0,
            };
          })
          .filter((item): item is RenderedItem => item !== null)
          .filter((item) => item.text.trim() !== ''),
      );
      linkDests.push(
        (await proxy.getAnnotations())
          .map((annotation) => {
            const dest = (annotation as { dest?: unknown }).dest;
            if (typeof dest === 'string') return dest;
            const ref = Array.isArray(dest) ? (dest[0] as unknown) : undefined;
            const name = (ref as { name?: unknown } | undefined)?.name;
            return typeof name === 'string' ? name : '';
          })
          .filter((dest) => dest !== ''),
      );
    }
    return { pages, linkDests };
  } finally {
    await destroy();
  }
}

/**
 * The sections the Contents lists, READ OFF THE DEFINITION: the text of every
 * `tocItem` node, its own `id`, and the type size its own style gives it. The
 * size is not hardcoded here — it comes from the document's ONE style
 * dictionary, the same one the paginator measures with.
 */
function contentsEntries(
  definition: { content: unknown; styles?: unknown },
  node: unknown = definition.content,
  out: { text: string; id: string; size: number }[] = [],
): { text: string; id: string; size: number }[] {
  if (Array.isArray(node)) {
    for (const child of node) contentsEntries(definition, child, out);
    return out;
  }
  if (typeof node !== 'object' || node === null) return out;
  const record = node as Json;
  if (record.tocItem !== undefined) {
    const styles = (definition.styles ?? {}) as Record<string, { fontSize?: number }>;
    const style = typeof record.style === 'string' ? styles[record.style] : undefined;
    const size = style?.fontSize;
    if (typeof record.text !== 'string' || typeof record.id !== 'string' || size === undefined) {
      throw new Error(`a listed section is missing its own text, id or type size: ${json(record)}`);
    }
    out.push({ text: record.text, id: record.id, size });
  }
  for (const value of Object.values(record)) contentsEntries(definition, value, out);
  return out;
}

/** The 1-based page of the Contents: the page node carrying its heading — the
 * page a reader reads the list off, which is the page these pins measure. */
function contentsPageNumber(definition: { content: unknown }): number {
  const index = pages(definition).findIndex((page) =>
    json(page).includes('"text":"Contents","style":"part"'),
  );
  if (index === -1) throw new Error('the document carries no Contents page');
  return index + 1;
}

/**
 * The page a section's heading ACTUALLY printed on, read from the rendered
 * document: the first page — never the Contents page itself — that carries the
 * heading's own text at the heading's own type size. The size is what
 * distinguishes the heading from the same name in the prose.
 */
function sectionPage(
  rendered: RenderedDocument,
  entry: { text: string; size: number },
  contentsPage: number,
): number {
  for (const [index, items] of rendered.pages.entries()) {
    const page = index + 1;
    if (page === contentsPage) continue;
    if (items.some((item) => item.text === entry.text && item.size === entry.size)) return page;
  }
  throw new Error(`“${entry.text}” (${String(entry.size)} pt) prints on no page`);
}

/**
 * The Contents page decoded: every (label, number) pair the reader sees, in the
 * order it prints. A number cell is the ONLY pure-digit item on that page (the
 * footer is one run, `Beneath the Docks · 2`), and it follows its label.
 */
function printedContents(items: readonly RenderedItem[]): { label: string; number: number }[] {
  const out: { label: string; number: number }[] = [];
  for (let index = 1; index < items.length; index += 1) {
    const item = items[index];
    const label = items[index - 1];
    if (item === undefined || label === undefined) continue;
    if (!/^\d+$/.test(item.text)) continue;
    if (label.text.trim() === '' || /^\d+$/.test(label.text)) continue;
    out.push({ label: label.text, number: Number(item.text) });
  }
  return out;
}

describe('§7 the Contents page’s numbers ARE the pages (docs/17 row 156)', () => {
  beforeEach(clearDatabase);

  it('prints, for every section of all three documents, the page that section really lands on', async () => {
    const built = await documents();
    const measured: Record<string, string[]> = {};
    // The locator's discrimination, collected across the three documents: a
    // heading is found by its own text AT ITS OWN TYPE SIZE, so a listed section
    // must never print at the body size the prose around it uses — and the
    // documents must between them use more than one heading size (checked after
    // the loop), or the size clause would be doing no work.
    const headingSizes = new Set<number>();
    for (const [name, definition] of Object.entries(built)) {
      const entries = contentsEntries(definition);
      const bodySize = (definition.defaultStyle as { fontSize?: number } | undefined)?.fontSize;
      // NON-VACUITY: the document lists real sections, and the Contents is the
      // SECOND page — the cover is first, and the whole comparison below is off
      // if the Contents page is not the page we read it from.
      expect(entries.length).toBeGreaterThan(3);
      expect(bodySize).toBeDefined();
      for (const entry of entries) {
        headingSizes.add(entry.size);
        expect({ section: entry.text, size: entry.size }).not.toEqual({
          section: entry.text,
          size: bodySize,
        });
      }
      const contentsPage = contentsPageNumber(definition);
      expect(contentsPage).toBe(2);

      const rendered = await render(definition);
      const printed = printedContents(rendered.pages[contentsPage - 1] ?? []);
      // The Contents lists exactly the document's sections, once each and in
      // the document's own order: a missing entry, an extra one, a reordering
      // and a page number invented for a section that does not exist each fail
      // here. This is also the pin a TOC WITHOUT ENTRIES cannot pass.
      expect(printed.map((entry) => entry.label)).toEqual(entries.map((entry) => entry.text));
      for (const [index, entry] of entries.entries()) {
        const row = printed[index];
        if (row === undefined) throw new Error(`${name}: no printed row for “${entry.text}”`);
        const real = sectionPage(rendered, entry, contentsPage);
        measured[name] = [...(measured[name] ?? []), `${entry.text}=${String(row.number)}`];
        // THE PIN: the number the reader sees, against the page the heading is
        // actually printed on. A guessed or off-by-one number is exactly what
        // this line catches, and pdfmake's own number is the only thing that
        // can pass it.
        expect({ section: entry.text, page: row.number }).toEqual({ section: entry.text, page: real });
      }
      // …and the numbers really are page numbers: several distinct values, none
      // of them inside the front matter the Contents itself sits in.
      const numbers = printed.map((entry) => entry.number);
      expect(new Set(numbers).size).toBeGreaterThan(1);
      expect(Math.min(...numbers)).toBeGreaterThan(contentsPage);
    }
    expect(headingSizes.size).toBeGreaterThan(1);
    // The measured numbers, stated: if a layout change moves a section, the
    // assertion above tells the two documents apart and this records what the
    // fixtures' Contents pages said, on the rendered page.
    expect(measured).toEqual({
      'large-procedural': [
        'Premise=3', 'Part plan=4', 'The Dockyards=5', 'The Vault=6', 'Locations=7',
        'Old Tower=8', 'Events=9', 'The Turning=10', 'Encounters=11', 'Pier Ambush=12',
        'Factions=14', 'The Tide Wardens=14', 'Party=15', 'Marek=15', 'Plot arcs=16',
        'The Drowned Crown=16', 'Notes=17', 'GM cheat sheet=17', 'NPC Gallery=18',
        'Vexra=18', 'Treasure=19',
      ],
      'large-planned': [
        'Before the Gate=3', 'The Dockyards=3', 'The Old Tower=4', 'Vexra at the Gate=5',
        'Ambush on the Pier=6', 'What the Crown Wants=8', 'Treasure=9',
      ],
      'small-procedural': [
        'Premise=3', 'Part plan=4', 'The Crossing=5', 'Locations=6', 'The Quiet Ford=6',
        'NPC Gallery=7', 'The Ferryman=7',
      ],
    });
  });

  it('links each entry to the section’s OWN destination — the identity §7’s link seam already uses', async () => {
    const built = await documents();
    for (const [name, definition] of Object.entries(built)) {
      const entries = contentsEntries(definition);
      const contentsPage = contentsPageNumber(definition);
      const rendered = await render(definition);
      // pdfmake fills each entry's label AND number with
      // `linkToDestination: getNodeId(node)` (`DocMeasure.measureToc`), i.e.
      // the section node's own `id` — the same destination §7's wiki-link seam
      // (`mdToPdfmake` → `destinationFor`) sends a reader to. So the Contents
      // needs no link rule of its own, and this reads the links out of the
      // rendered PDF, not out of the definition.
      const dests = rendered.linkDests[contentsPage - 1] ?? [];
      expect(dests.length).toBeGreaterThan(0);
      const order: string[] = [];
      for (const dest of dests) if (order[order.length - 1] !== dest) order.push(dest);
      expect(`${name}:${order.join(',')}`).toBe(
        `${name}:${entries.map((entry) => entry.id).join(',')}`,
      );
    }
  });

  it('is a page the page model measured and emitted, like every other page', async () => {
    const built = await documents();
    for (const [name, definition] of Object.entries(built)) {
      const nodes = pages(definition);
      // EVERY page of the document is a page node the paginator produced: one
      // `stack` (a page with no companion) or one `columns` (a page with a
      // sidebar), and only the FIRST carries no break — a `pageBreak` on the
      // document's first node makes pdfmake print an empty page in front of the
      // cover. A second, hand-placed page is what this forbids.
      expect(nodes.length).toBeGreaterThan(3);
      for (const [index, node] of nodes.entries()) {
        expect(Array.isArray(node.stack) || Array.isArray(node.columns)).toBe(true);
        expect(node.pageBreak).toBe(index > 0 ? 'before' : undefined);
      }
      // The Contents is ONE of those pages: its heading carries no break of its
      // own (the page owns the break), and it holds the ToC node.
      const tocPage = nodes[contentsPageNumber(definition) - 1];
      if (tocPage === undefined) throw new Error(`${name}: no Contents page`);
      expect(json(tocPage)).toContain('"toc":{"id":"chapters"');
      expect(json(tocPage)).not.toContain('"text":"Contents","style":"part","pageBreak"');
      // MEASURED, and the reason it keeps a page to itself: the paginator
      // reserves a full page for a ToC (`estimateHeight`'s `toc` branch), so no
      // section can share the page its own Contents sits on.
      const context: MeasureContext = {
        width: MAIN_COLUMN_WIDTH,
        fontSize: 11,
        lineHeight: 1.35,
        styles: (definition.styles ?? {}),
      };
      expect(estimateHeight({ toc: { id: 'chapters' } }, context)).toBe(PAGE_CONTENT_HEIGHT);
      expect(json(tocPage)).not.toContain('"text":"Premise","style":"chapter"');
    }
  });

  it('prints the same numbers for the same document twice (the clock is pinned, not the ambient one)', async () => {
    const large = await pdfLayoutLargeFixture();
    const input = {
      module: large.module,
      artifacts: large.artifacts,
      images: large.images,
      compiledAt: BASELINE_COMPILED_AT,
      ...(large.rosterResolution === undefined ? {} : { rosterResolution: large.rosterResolution }),
    };
    // docs/17 row 154's pin: the compared document is a document with a KNOWN
    // compile day, so the page breaks (and therefore every number in the
    // Contents) cannot depend on when the suite runs.
    const first = buildModuleDefinition(input);
    const second = buildModuleDefinition({ ...input });
    const contentsOf = (definition: { content: unknown }): string =>
      json(pages(definition)[contentsPageNumber(definition) - 1]);
    expect(contentsOf(second)).toBe(contentsOf(first));
    const rendered = await render(first);
    const page = contentsPageNumber(first);
    expect(printedContents(rendered.pages[page - 1] ?? []).map((entry) => entry.number)).toEqual(
      printedContents((await render(second)).pages[page - 1] ?? []).map((entry) => entry.number),
    );
  });
});

// --- 10. docs/17 row 186, MEASURED on the rendered page ----------------------

describe('docs/17 row 186 — the one-sided page, read back off the RENDERED PDF', () => {
  beforeEach(clearDatabase);

  it('prints the announcement on a page that carries other text, at the page margin rather than the sidebar offset', async () => {
    // A definition-level pin cannot see this: the kicker prints ONE CHARACTER
    // AT A TIME, so the sentence only matches the text layer after whitespace is
    // stripped, and whether a page's only text sits at the sidebar's x is a
    // fact about the laid-out page. The owner's report — *"there was a page
    // where the main content was there and narrow without a side bar"* — is
    // measured on BOTH documents that carry the pointer: the PLANNED page whose
    // main holds real sections, and the PROCEDURAL chapter page. The pin is
    // (a) no rendered page's whole text layer IS the announcement and (b) the
    // announcement's own item starts at the PAGE MARGIN, where the old form put
    // it at the SIDEBAR offset (`PAGE_MARGIN + MAIN_COLUMN_WIDTH +
    // COLUMN_GUTTER`) — i.e. across the gutter from the main text.
    const built = await documents();
    const normalized = ownPageNote('Old Tower').toUpperCase().replace(/\s+/g, '');
    const sidebarOffset = PAGE_MARGIN + MAIN_COLUMN_WIDTH + COLUMN_GUTTER;
    for (const name of ['large-procedural', 'large-planned'] as const) {
      const definition = built[name];
      if (definition === undefined) throw new Error(`missing fixture: ${name}`);
      const rendered = await render(definition);
      const hits: { page: number; x: number; pageText: string }[] = [];
      for (const [index, items] of rendered.pages.entries()) {
        for (const item of items) {
          if (item.text.replace(/\s+/g, '').includes(normalized)) {
            hits.push({
              page: index + 1,
              x: item.x,
              pageText: items
                .map((entry) => entry.text)
                .join('')
                .replace(/\s+/g, ''),
            });
          }
        }
      }
      // NON-VACUITY, per document: the pointer really renders (a renderer that
      // dropped it entirely fails here rather than passing the absences below).
      expect(hits.length, `${name} renders no announcement at all`).toBeGreaterThan(0);
      for (const hit of hits) {
        // (a) NO rendered page's whole text layer is the announcement sentence.
        expect(
          hit.pageText,
          `${name} page ${String(hit.page)} carries only the announcement`,
        ).not.toBe(normalized);
        // (b) it starts at the PAGE MARGIN, not at the two-column sidebar offset.
        expect(
          hit.x,
          `${name} page ${String(hit.page)} renders the announcement in the sidebar`,
        ).toBeCloseTo(PAGE_MARGIN, 1);
        expect(hit.x).toBeLessThan(sidebarOffset);
      }
    }
  });
});

/**
 * WHAT THESE PINS STILL CANNOT PROVE (docs/17 row 156), so nobody reads more
 * into them than they carry:
 *
 * - **that a click on an entry MOVES the reader.** The annotations are read out
 *   of the PDF (`dest` names the section's own `id`), which is the condition a
 *   viewer needs — but whether THIS viewer follows an internal destination is
 *   the viewer's behaviour, not the file's, and no test can press the link.
 * - **that the Contents page LOOKS right.** Nothing here says anything about
 *   the visual hierarchy: that the entries are legible, that the page reads as
 *   a Contents page, or — the one a reader will notice first — that the word
 *   “Contents” prints TWICE above the list (a heading node and the ToC's own
 *   title, both since the ToC node landed; removing one would drop a text run
 *   the content-preservation differential pins, which is why row 156 left it
 *   alone rather than quietly changing what the document prints).
 * - **that a screen viewer's own navigation pane agrees.** The footer's page
 *   number, the Contents' numbers and the viewer's outline are three surfaces;
 *   only the first two are ours, and only the second is measured here.
 */
