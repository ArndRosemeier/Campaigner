import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createImage } from '@/db/imageRepo';
import { saveModule } from '@/db/moduleRepo';
import {
  createModule,
  moduleDocumentPlanSchema,
  newId,
  modulePartSchema,
  moduleSpineSchema,
  type AnyArtifact,
  type Id,
  type Module,
  type ModuleDocumentPlan,
} from '@/domain';
import { buildModuleDefinition, buildModulePdf, buildModulePdfDocument } from '@/lib/modulePdf';
import { PDF_COVER_MAX_LONG_EDGE, PDF_MAP_MAX_LONG_EDGE, type PdfImageCodec } from '@/lib/pdfImages';
import { generatePdfBlob } from '@/lib/pdfExport';
import { clearDatabase } from '../db/helpers';

/**
 * THE RENDERER EXECUTES THE PLAN (docs/17 row 109, docs/07 §M3-D). The owner's
 * ratified split is what this file measures: the model authors the PLAN, the
 * renderer authors the PAGES — so the plan decides order, titles, roles,
 * audiences and anchors, and the renderer decides every typographic decision
 * and produces the same bytes twice.
 *
 * Three contracts are pinned here and nowhere else:
 *
 * 1. **The plan decides structure.** Order, titles, which existing images print
 *    where, and which artifacts the document even mentions — a plan that names
 *    three artifacts produces a document about those three, not the procedural
 *    chapter set.
 * 2. **The plan cannot smuggle rendering in.** Its roles are four, each with
 *    ONE treatment, and a role changes treatment, never content.
 * 3. **A plan that cannot be applied is LOUD in two places** (a named problem
 *    AND a statement on the page) while the export still lands, and NOTHING of
 *    the plan is rendered in that case.
 *
 * Marker images: `assertPdfmakeImageDataUrl` gates them, so both are real PNG
 * data URLs. The placement tests read the DEFINITION (where two distinct marker
 * strings tell a map from a cover); the byte-determinism and real-PDF tests
 * take the whole pipeline with the injected codec, which is the only way jsdom
 * can embed a genuine image.
 */
const MAP_MARKER = 'data:image/png;base64,MAPmarkerMAPmarkerMAPmarker';
const COVER_MARKER = 'data:image/png;base64,COVERmarkerCOVERmarker';
const PORTRAIT_MARKER = 'data:image/png;base64,PORTRAITmarkerPORTRAITmarker';
/** A real 1×1 PNG — the smallest image pdfmake can genuinely embed. */
const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4z8AAAAMBAQD3A0FDAAAAAElFTkSuQmCC';

/** How many times `needle` occurs in `text` (non-overlapping), for the image
 * counts below: an image node is `"image":"<data url>"`, so counting the
 * marker counts the pictures that really printed. */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * The top-level PAGE node (docs/19 §3: one `columns` node per page, or a
 * full-width `stack` for a page with no companion) whose serialized content
 * names `needle`. Since row 148 a section's break belongs to the page and not
 * to the heading, so a pin about page breaks has to read the page.
 */
function pageContaining(
  definition: { content: unknown },
  needle: string,
): Record<string, unknown> {
  for (const node of definition.content as unknown[]) {
    if (JSON.stringify(node).includes(needle)) return node as Record<string, unknown>;
  }
  throw new Error(`no page node carries ${needle}`);
}

function fixedCodec(): PdfImageCodec {
  return () => Promise.resolve({ dataUrl: ONE_PIXEL_PNG, width: 1, height: 1 });
}

interface Seed {
  campaignId: Id;
  module: Module;
  artifacts: AnyArtifact[];
  locationId: Id;
  npcId: Id;
  encounterId: Id;
  noteId: Id;
  plotarcId: Id;
  mapImageId: Id;
  coverImageId: Id;
  portraitImageId: Id;
}

async function seed(): Promise<Seed> {
  const campaign = await createCampaign({ name: 'Plan PDF Campaign', system: 'dnd5e' });
  const mapImageId = (
    await createImage({
      campaignId: campaign.id,
      blob: new Blob(['map-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 8,
      height: 8,
      source: 'generated',
    })
  ).id;
  const coverImageId = (
    await createImage({
      campaignId: campaign.id,
      blob: new Blob(['cover-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 8,
      height: 8,
      source: 'generated',
    })
  ).id;
  const portraitImageId = (
    await createImage({
      campaignId: campaign.id,
      blob: new Blob(['portrait-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 8,
      height: 8,
      source: 'generated',
    })
  ).id;

  const location = await createArtifact({
    campaignId: campaign.id,
    kind: 'location',
    name: 'Old Tower',
    body: 'The tower watches the ford.',
    data: {
      locationType: 'ruin',
      inhabitants: 'gulls and one ghost',
      pointsOfInterest: [],
      hooks: [],
    },
    coverImageId,
  });
  const npc = await createArtifact({
    campaignId: campaign.id,
    kind: 'npc',
    name: 'Vexra',
    body: 'Hooded and cold.',
    data: { appearance: 'Hooded', personality: 'Cold', statBlock: null },
  });
  const encounter = await createArtifact({
    campaignId: campaign.id,
    kind: 'encounter',
    name: 'Pier Ambush',
    body: 'They come up out of the water.',
    data: {
      difficulty: 'deadly',
      levelHint: '', partyLevel: 5,
      monsters: [{ name: 'Cultist', count: 4, notes: 'netters', treasure: '', source: { type: 'none' as const } }],
      terrain: 'wet planks',
      tactics: 'surround and drag under',
      treasure: 'silver bell charm',
      mapImageId,
      layout: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    },
    links: [{ targetId: location.id, relation: 'at' }],
  });
  const note = await createArtifact({
    campaignId: campaign.id,
    kind: 'note',
    name: 'GM cheat sheet',
    body: 'Remember the bell.',
    tags: ['gm-only'],
  });
  const plotarc = await createArtifact({
    campaignId: campaign.id,
    kind: 'plotarc',
    name: 'The Drowned Crown',
    data: {
      arcType: 'main',
      premise: 'The crown wants the tide.',
      stakes: 'The harbour floods.',
      beats: [{ title: 'The Bell', description: 'It rings once.' }],
      hooks: [],
      climax: 'The crown is broken on the pier.',
    },
  });
  const bystander = await createArtifact({
    campaignId: campaign.id,
    kind: 'npc',
    name: 'Unplanned Bystander',
    body: 'Sells eels.',
    data: { appearance: '', personality: '', statBlock: null },
    // The gallery's portrait (docs/17 row 187): an NPC the plan gives no
    // section, so she is described ONLY in the gallery — which is exactly where
    // her own picture must print.
    coverImageId: portraitImageId,
  });

  const module = await saveModule({
    ...createModule({
      campaignId: campaign.id,
      title: 'Beneath the Docks',
      concept: 'A drowned vault.',
      levelMin: 1,
      levelMax: 3,
      tone: '',
      sizeDial: 'standard',
    }),
    spine: moduleSpineSchema.parse({
      premise:
        'A drowned vault beneath the [[Old Tower]]. [[Vexra]] waits by the [[Pier Ambush]], ' +
        'and the [[GM cheat sheet]] holds the bell. [[The Drowned Crown]] is what they guard, ' +
        'and an [[Unplanned Bystander]] sells eels on the pier.',
      themes: [],
      partPlan: [
        {
          title: 'The Dockyards',
          levelBand: '1-2',
          synopsis: 'Meet the wardens.',
          levelUpTrigger: 'The bell rings.',
        },
        { title: 'The Vault', levelBand: '3', synopsis: 'Break the crown.', levelUpTrigger: '' },
      ],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: 'The party rows out at dusk.',
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
      // Deliberately EMPTY: a plan may name a part whose text has not landed
      // yet, and the renderer must say so loudly rather than print a blank page.
      modulePartSchema.parse({
        planIndex: 1,
        markdown: '',
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });

  return {
    campaignId: campaign.id,
    module,
    artifacts: [location, npc, encounter, note, plotarc, bystander],
    locationId: location.id,
    npcId: npc.id,
    encounterId: encounter.id,
    noteId: note.id,
    plotarcId: plotarc.id,
    mapImageId,
    coverImageId,
    portraitImageId,
  };
}

/** The plan the tests render: one section per shape the vocabulary can take. */
function planFor(seeded: Seed): ModuleDocumentPlan {
  return moduleDocumentPlanSchema.parse({
    sections: [
      {
        title: 'Before the Gate',
        role: 'explanation',
        audience: 'all',
        source: { type: 'part', planIndex: -1 },
        images: [],
      },
      {
        title: 'The Dockyards',
        role: 'read-aloud',
        audience: 'all',
        source: { type: 'part', planIndex: 0 },
        images: [],
      },
      {
        title: 'The Old Tower',
        role: 'explanation',
        audience: 'all',
        source: { type: 'artifact', artifactId: seeded.locationId },
        images: [seeded.coverImageId],
      },
      {
        title: 'Vexra at the Gate',
        role: 'explanation',
        audience: 'all',
        source: { type: 'artifact', artifactId: seeded.npcId },
        images: [],
      },
      {
        title: 'Ambush on the Pier',
        role: 'gm-note',
        audience: 'all',
        source: { type: 'encounter', artifactId: seeded.encounterId },
        images: [seeded.mapImageId],
      },
      {
        title: 'The Bell, Quietly',
        role: 'aside',
        audience: 'all',
        source: { type: 'artifact', artifactId: seeded.noteId },
        images: [],
      },
      {
        title: 'What the Crown Wants',
        role: 'explanation',
        audience: 'gm',
        source: { type: 'artifact', artifactId: seeded.plotarcId },
        images: [],
      },
      {
        title: 'A Word on the Tide',
        role: 'aside',
        audience: 'all',
        source: { type: 'part', planIndex: 1 },
        images: [],
      },
    ],
    plannedByModel: 'vendor/planner-1',
    plannedAt: 1_700_000_000_000,
  });
}

function withPlan(seeded: Seed, plan: unknown): Module {
  return { ...seeded.module, documentPlan: plan };
}

/** The injected image map, keyed by the REAL ids of this fixture's rows. */
function imagesFor(seeded: Seed): { dataUrls: Record<Id, string>; failures: never[] } {
  return {
    dataUrls: {
      [seeded.mapImageId]: MAP_MARKER,
      [seeded.coverImageId]: COVER_MARKER,
      [seeded.portraitImageId]: PORTRAIT_MARKER,
    },
    failures: [],
  };
}

function textOf(definition: unknown): string {
  return JSON.stringify(definition);
}

/**
 * This fixture's part 2 is deliberately empty, so EVERY planned render of it
 * reports exactly this — the loud empty-part rule, unchanged by the plan. Held
 * as a constant so each test asserts the WHOLE problem list and a new, silent
 * problem cannot hide behind a `some(...)`.
 */
const EMPTY_PART_PROBLEM = [{ where: 'part 2 (“The Vault”)', reason: 'part 2 of 2 has no text yet' }];

/** Where a string first appears, for order assertions that cannot pass empty. */
function at(text: string, needle: string): number {
  const index = text.indexOf(needle);
  expect(needle === '' || index >= 0, `missing from the document: ${needle}`).toBe(true);
  return index;
}

describe('the renderer executes the plan', () => {
  beforeEach(clearDatabase);

  it('prints the plan’s sections in the plan’s order, with the plan’s titles', async () => {
    const seeded = await seed();
    const definition = buildModuleDefinition({
      module: withPlan(seeded, planFor(seeded)),
      artifacts: seeded.artifacts,
      images: imagesFor(seeded),
    });
    const text = textOf(definition);

    // The plan's titles are the document's chapters, in the plan's order.
    const order = [
      'Before the Gate',
      'The Dockyards',
      'The Old Tower',
      'Vexra at the Gate',
      'Ambush on the Pier',
      'The Bell, Quietly',
      'What the Crown Wants',
      'A Word on the Tide',
    ];
    const positions = order.map((title) => at(text, title));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    // NON-VACUITY + the structural claim: the procedural outline did NOT print.
    // Its chapter titles and its kind chapters are absent, so this document is
    // the plan's, not the renderer's default.
    expect(text).not.toContain('"text":"Locations"');
    expect(text).not.toContain('"text":"Encounters"');
    expect(text).not.toContain('"text":"Premise"');
    expect(text).not.toContain('"text":"Part plan"');
    // …while the module's own prose IS printed, verbatim, under its new title.
    expect(text).toContain('A drowned vault beneath the');
    expect(text).toContain('The party rows out at dusk.');
    expect(text).toContain('The tower watches the ford.');
  });

  it('gives each role ONE distinct treatment (a role changes treatment, never content)', async () => {
    const seeded = await seed();
    const definition = buildModuleDefinition({
      module: withPlan(seeded, planFor(seeded)),
      artifacts: seeded.artifacts,
      images: imagesFor(seeded),
    });
    const text = textOf(definition);

    // read-aloud: the read-aloud box (accent border, filled, italic).
    expect(text).toContain('"fillColor":"#f6efe2"');
    expect(text).toContain('"style":"readAloud"');
    // gm-note: a LABELED GM box in its own neutral colour.
    expect(text).toContain('"text":"GM note"');
    expect(text).toContain('"fillColor":"#f4f4f5"');
    expect(text).toContain('"style":"gmNote"');
    // aside: no box at all — an indented, muted, italic insert.
    expect(text).toContain('"style":"aside"');
    expect(text).toContain('"layout":"noBorders"');
    expect(text).toContain('"widths":[24,"*"]');
    // explanation: the plain body — its text is printed with NO role style.
    expect(text).toContain('"text":"The tower watches the ford."');

    // The box carries BOTH the style and the fill, exactly once (the style
    // dictionary names the same colour, which is why this pins the pair).
    expect(text.match(/"style":"readAloud","fillColor":"#f6efe2"/g)?.length).toBe(1);
    // A role is not the ALERT red: that colour means "problem" in this
    // document and is reserved for the loud fallback statement.
    expect(text).not.toContain('"fillColor":"#b91c1c"');
    expect(text).not.toContain('"fillColor":"#fef2f2"');
  });

  it('prints a planned section’s source data and its cross-references', async () => {
    const seeded = await seed();
    const text = textOf(
      buildModuleDefinition({
        module: withPlan(seeded, planFor(seeded)),
        artifacts: seeded.artifacts,
        images: imagesFor(seeded),
      }),
    );

    // The encounter's mechanical data is EXPLANATION/GM-NOTE content, so it
    // rides its section: the difficulty header, the roster, the tactics.
    expect(text).toContain('DEADLY');
    expect(text).toContain('Cultist');
    expect(text).toContain('surround and drag under');
    // The location's own fields, and the encounter's cross-reference — which
    // points at the DESTINATION the location actually printed at.
    expect(text).toContain('ruin');
    expect(text).toContain('"linkToDestination":"node-plan-2"');
  });

  it('treats an aside as an insert, never a chapter (no page break, no ToC entry)', async () => {
    const seeded = await seed();
    const definition = buildModuleDefinition({
      module: withPlan(seeded, planFor(seeded)),
      artifacts: seeded.artifacts,
      images: imagesFor(seeded),
    });
    const text = textOf(definition);

    // The aside's node is addressed by its own destination and carries neither
    // a page break nor a ToC entry (the owner's "genuinely parenthetical").
    // The window is the NODE ITSELF, extracted by its own shape: docs/17 row
    // 148 moved the page break off the heading and onto the PAGE (docs/19 §3 —
    // sections flow, a break inside a page's column stack would tear the two
    // columns apart), so the old fixed 60-character reach backwards no longer
    // measures the aside at all — it measures the previous page's break.
    const asideNode = /\{"text":"The Bell, Quietly"[^}]*\}/.exec(text)?.[0] ?? '';
    expect(asideNode).toContain('node-plan-5');
    expect(asideNode).not.toContain('pageBreak');
    expect(asideNode).not.toContain('tocItem');
    // A chapter-start section still OPENS a page (non-vacuity for the negative
    // above) — the ToC entry is on the heading, the break is on the page node
    // that holds it.
    expect(text).toContain('"id":"node-plan-1","tocItem":"chapters"}');
    expect(pageContaining(definition, '"id":"node-plan-1"')).toMatchObject({
      pageBreak: 'before',
    });
    expect(pageContaining(definition, '"text":"The Bell, Quietly"')).not.toBe(
      pageContaining(definition, '"id":"node-plan-1"'),
    );
  });

  it('prints an artifact’s OWN image wherever it is described, and the plan’s anchors as EXTRAS (docs/17 row 187)', async () => {
    const seeded = await seed();
    const withAnchors = textOf(
      buildModuleDefinition({
        module: withPlan(seeded, planFor(seeded)),
        artifacts: seeded.artifacts,
        images: imagesFor(seeded),
      }),
    );
    expect(withAnchors).toContain(MAP_MARKER);
    expect(withAnchors).toContain(COVER_MARKER);
    // The map is a PLATE: full content width, tall fit. The width is the page's
    // own content box — A4 minus docs/19 §3's 20 mm margins, owned by
    // `lib/pdfPageModel` so the plate and the margins cannot drift apart.
    // UPDATED by docs/17 row 148: this was `515` while the page kept pdfmake's
    // default 40 pt margins; the spec's 20 mm margins make it 481.9.
    expect(withAnchors).toContain('"fit":[481.9,660]');
    // The cover art is inline art, not a plate.
    expect(withAnchors).toContain('"fit":[450,320]');
    // …and the pictures that print are exactly the ones the ROWS own: the two
    // anchors in this plan name the location's own cover and the encounter's
    // own map, and neither prints a second time (docs/17 row 187's
    // plan-anchor rule — an anchor naming the artifact's own art is redundant).
    expect(occurrences(withAnchors, '"image":')).toBe(3);
    expect(occurrences(withAnchors, COVER_MARKER)).toBe(1);
    expect(occurrences(withAnchors, MAP_MARKER)).toBe(1);

    // THE REGRESSION PIN (the owner: *"i would at least expect NPCs and
    // locations when they are described anyways"*): the same module, planned
    // WITHOUT a single anchor. The location's cover and the encounter's map
    // plate STILL print — they are the artifacts' own art, and the plan's
    // `images` was never the gate for that. A planned path that went back to
    // plan-only images loses BOTH markers here.
    const planned = planFor(seeded);
    const noAnchors = moduleDocumentPlanSchema.parse({
      ...planned,
      sections: planned.sections.map((section) => ({ ...section, images: [] })),
    });
    const bare = buildModulePdfDocument({
      module: withPlan(seeded, noAnchors),
      artifacts: seeded.artifacts,
      images: imagesFor(seeded),
    });
    const bareText = textOf(bare.definition);
    expect(bareText).toContain(COVER_MARKER);
    expect(bareText).toContain(MAP_MARKER);
    expect(bareText).toContain('"fit":[481.9,660]');
    expect(bareText).toContain('"fit":[450,320]');
    // Exactly the three rows that CARRY an image print one (the location's
    // cover, the encounter's plate, the gallery NPC's portrait) — a row with no
    // image prints no image node and no placeholder.
    expect(occurrences(bareText, '"image":')).toBe(3);
    expect(occurrences(bareText, PORTRAIT_MARKER)).toBe(1);
    // An own image needs the page (docs/19 §4), so the location gets the §5
    // own-page treatment even with the plan anchoring nothing at all.
    expect(bareText).toContain('“OLD TOWER” HAS ITS OWN PAGE, FOLLOWING THIS ONE.');
    // The ONLY problem is the empty part the plan names — never an image.
    expect(bare.problems).toEqual(EMPTY_PART_PROBLEM);
  });

  it('prints the NPC gallery’s portrait — the gallery is where an NPC is described (docs/17 row 187)', async () => {
    const seeded = await seed();
    const bystander = seeded.artifacts.find(
      (artifact) => artifact.kind === 'npc' && artifact.name === 'Unplanned Bystander',
    );
    if (bystander === undefined) throw new Error('the fixture must build the unplanned NPC');
    const definition = buildModuleDefinition({
      module: withPlan(seeded, planFor(seeded)),
      artifacts: seeded.artifacts,
      images: imagesFor(seeded),
    });
    const text = textOf(definition);
    // The gallery chapter and the row it describes.
    expect(text).toContain('"text":"NPC Gallery","style":"chapter"');
    expect(text).toContain('Unplanned Bystander');
    // Her OWN picture rides her own block: the page that carries her heading is
    // the page that carries the portrait (a marker elsewhere would pass a
    // `toContain` while printing the wrong row's art).
    const page = pageContaining(definition, `"id":"node-${bystander.id}"`);
    expect(JSON.stringify(page)).toContain(PORTRAIT_MARKER);
  });

  it('still prints a plan anchor the section does NOT own — the anchors stay meaningful as EXTRAS (docs/17 row 187)', async () => {
    const seeded = await seed();
    const planned = planFor(seeded);
    // The NPC section deliberately anchors the LOCATION's cover: a picture the
    // NPC row does not own, i.e. exactly what an extra is.
    const withExtra = moduleDocumentPlanSchema.parse({
      ...planned,
      sections: planned.sections.map((section) =>
        section.source.type === 'artifact' && section.source.artifactId === seeded.npcId
          ? { ...section, images: [seeded.coverImageId] }
          : section,
      ),
    });
    const text = (plan: ModuleDocumentPlan): string =>
      textOf(
        buildModuleDefinition({
          module: withPlan(seeded, plan),
          artifacts: seeded.artifacts,
          images: imagesFor(seeded),
        }),
      );
    // The location's own section prints its cover once, the NPC's extra once.
    expect(occurrences(text(withExtra), COVER_MARKER)).toBe(2);
    // Non-vacuity: with that ONE anchor removed the count drops to one, so the
    // second copy above is really the anchor and not a duplicate own image.
    expect(occurrences(text(planned), COVER_MARKER)).toBe(1);
  });

  it('still prints the artifact’s own image in a read-aloud or aside section — a role governs the mechanics, never the picture (docs/17 row 187)', async () => {
    const seeded = await seed();
    const single = (role: 'read-aloud' | 'aside'): ModuleDocumentPlan =>
      moduleDocumentPlanSchema.parse({
        sections: [
          {
            title: 'The Old Tower',
            role,
            audience: 'all',
            source: { type: 'artifact', artifactId: seeded.locationId },
            images: [],
          },
        ],
      });

    const readAloud = single('read-aloud');
    const { definition, problems } = buildModulePdfDocument({
      module: withPlan(seeded, readAloud),
      artifacts: seeded.artifacts,
      images: imagesFor(seeded),
    });
    const readAloudText = textOf(definition);
    // The artifact's own cover prints…
    expect(readAloudText).toContain(COVER_MARKER);
    // …the role's prose treatment is intact…
    expect(readAloudText).toContain('"style":"readAloud"');
    // …and the ROLE still governs the mechanics: the location's stored fields
    // are NOT dragged into narration.
    expect(readAloudText).not.toContain('Inhabitants:');
    expect(problems).toEqual([]);

    const asideText = JSON.stringify(
      buildModuleDefinition({
        module: withPlan(seeded, single('aside')),
        artifacts: seeded.artifacts,
        images: imagesFor(seeded),
      }),
    );
    expect(asideText).toContain(COVER_MARKER);
    expect(asideText).not.toContain('Inhabitants:');
  });

  it('prints an introduced NPC’s profile in a PART-sourced section’s sidebar (docs/17 row 188)', async () => {
    const seeded = await seed();
    // The owner, verbatim: *"important NPCs should be introduced in a sidebar
    // where the story introduces them."* Before this row a section's detail was
    // derived from the section's OWN source, so an NPC profile could only ever
    // sit where the NPC's own prose ran — never beside a PART's story text.
    const plan = moduleDocumentPlanSchema.parse({
      sections: [
        {
          title: 'The Dockyards',
          role: 'explanation',
          audience: 'all',
          source: { type: 'part', planIndex: 0 },
          companion: { artifactId: seeded.npcId },
          images: [],
        },
      ],
      plannedByModel: 'vendor/planner-1',
      plannedAt: 1_700_000_000_000,
    });
    const { definition, problems } = buildModulePdfDocument({
      module: withPlan(seeded, plan),
      artifacts: seeded.artifacts,
      images: imagesFor(seeded),
    });
    const page = pageContaining(definition, '"id":"node-plan-0"');
    const columns = page.columns as { stack: unknown }[];
    // The PART's own story text is the MAIN column…
    expect(JSON.stringify(columns[0])).toContain('The party rows out at dusk.');
    expect(JSON.stringify(columns[0])).not.toContain('Appearance');
    // …and the introduced NPC's profile rides the SAME page's sidebar, under her
    // own name so the reader knows whose profile it is.
    expect(JSON.stringify(columns[1])).toContain('Vexra');
    expect(JSON.stringify(columns[1])).toContain('Appearance');
    expect(JSON.stringify(columns[1])).toContain('Hooded');
    expect(JSON.stringify(columns[1])).toContain('Personality');
    expect(JSON.stringify(columns[1])).toContain('Cold');
    // The row was PRINTED by the plan, so the NPC gallery does not describe her a
    // second time: her appearance run occurs exactly once in the document.
    expect(occurrences(textOf(definition), 'Hooded')).toBe(1);
    expect(problems).toEqual([]);
  });

  it('keeps an artifact-sourced section’s own mechanics AND gains its companion (additive, docs/17 row 188)', async () => {
    const seeded = await seed();
    const plan = moduleDocumentPlanSchema.parse({
      sections: [
        {
          title: 'The Old Tower',
          role: 'explanation',
          audience: 'all',
          source: { type: 'artifact', artifactId: seeded.locationId },
          companion: { artifactId: seeded.npcId },
          images: [],
        },
      ],
    });
    const text = textOf(
      buildModuleDefinition({
        module: withPlan(seeded, plan),
        artifacts: seeded.artifacts,
        images: imagesFor(seeded),
      }),
    );
    // The location's own stored fields…
    expect(text).toContain('Inhabitants:');
    expect(text).toContain('gulls and one ghost');
    // …and the introduced NPC's profile, in the SAME detail companion.
    expect(text).toContain('Vexra');
    expect(text).toContain('Appearance');
    expect(text).toContain('Hooded');
  });

  it('is LOUD when a planned section’s own image exists but is not in the preloaded set (docs/17 row 187)', async () => {
    const seeded = await seed();
    // The location's cover EXISTS on the row but is NOT in the loaded set, and
    // no failure entry was recorded for it (the loader never saw the id). The
    // renderer must name the site and print the alert box — never drop the
    // picture silently (AGENTS rules 1–2).
    const { definition, problems } = buildModulePdfDocument({
      module: withPlan(seeded, planFor(seeded)),
      artifacts: seeded.artifacts,
      images: {
        dataUrls: {
          [seeded.mapImageId]: MAP_MARKER,
          [seeded.portraitImageId]: PORTRAIT_MARKER,
        },
        failures: [],
      },
    });
    const text = textOf(definition);
    expect(text).toContain('has a cover image that could not be embedded');
    expect(text).toContain('it was not in the preloaded image set');
    expect(text).not.toContain(COVER_MARKER);
    expect(problems).toContainEqual({
      where: 'the cover of “Old Tower”',
      reason: 'it was not in the preloaded image set',
    });
  });

  it('keeps the cover page out of the plan’s hands (the document’s identity)', async () => {
    const seeded = await seed();
    // The module's own cover is NEVER anchored by this plan, and the cover page
    // still prints it: the cover is the document's identity, not a section.
    const definition = buildModuleDefinition({
      module: seeded.module,
      artifacts: seeded.artifacts,
      images: imagesFor(seeded),
    });
    expect(textOf(definition)).toContain('Beneath the Docks');
    expect(textOf(definition)).toContain('Compiled with Campaigner');
  });

  it('says a planned part with no text yet is EMPTY, loudly', async () => {
    const seeded = await seed();
    const { definition, problems } = buildModulePdfDocument({
      module: withPlan(seeded, planFor(seeded)),
      artifacts: seeded.artifacts,
      images: imagesFor(seeded),
    });
    expect(textOf(definition)).toContain('A Word on the Tide');
    expect(textOf(definition)).toContain('is empty');
    expect(problems).toContainEqual({
      where: 'part 2 (“The Vault”)',
      reason: 'part 2 of 2 has no text yet',
    });
  });
});

describe('the document plan and the TWO documents', () => {
  beforeEach(clearDatabase);

  it('renders GM and player from ONE plan: the gm section is not in the player book', async () => {
    const seeded = await seed();
    const module = withPlan(seeded, planFor(seeded));
    const gm = textOf(
      buildModuleDefinition({ module, artifacts: seeded.artifacts, images: imagesFor(seeded) }),
    );
    const player = textOf(
      buildModuleDefinition({
        module,
        artifacts: seeded.artifacts,
        images: imagesFor(seeded),
        audience: 'player',
      }),
    );

    // The GM-only section prints for the GM and nowhere in the player book.
    expect(gm).toContain('What the Crown Wants');
    expect(gm).toContain('The crown wants the tide.');
    expect(player).not.toContain('What the Crown Wants');
    expect(player).not.toContain('The crown wants the tide.');
    // Everything declared for BOTH audiences survives in both (non-vacuity).
    for (const shared of ['The Dockyards', 'The Old Tower', 'Vexra at the Gate']) {
      expect(gm).toContain(shared);
      expect(player).toContain(shared);
    }
    // Maps stay in BOTH documents (the M3-D rule the plan cannot undo).
    expect(player).toContain(MAP_MARKER);
  });

  it('drops the treasure ledger for players, and keeps the encounter’s secrets out', async () => {
    const seeded = await seed();
    const module = withPlan(seeded, planFor(seeded));
    const custom = moduleDocumentPlanSchema.parse({
      // A section that names the encounter for BOTH audiences: the FIELD rules
      // are the document's, not the section's, and they still hold.
      ...planFor(seeded),
      sections: [
        {
          title: 'Ambush on the Pier',
          role: 'gm-note',
          audience: 'all',
          source: { type: 'encounter', artifactId: seeded.encounterId },
          images: [],
        },
      ],
    });
    const gm = textOf(
      buildModuleDefinition({
        module: withPlan(seeded, custom),
        artifacts: seeded.artifacts,
        images: imagesFor(seeded),
      }),
    );
    const player = textOf(
      buildModuleDefinition({
        module: withPlan(seeded, custom),
        artifacts: seeded.artifacts,
        images: imagesFor(seeded),
        audience: 'player',
      }),
    );
    void module;

    // The ledger is GM back matter: it aggregates the printed encounters.
    expect(gm).toContain('TREASURE LEDGER');
    expect(gm).toContain('silver bell charm');
    expect(player).not.toContain('TREASURE LEDGER');
    expect(player).not.toContain('silver bell charm');
    // The encounter's GM fields do not reach the player document even though
    // this section is declared for both audiences.
    expect(gm).toContain('surround and drag under');
    expect(player).not.toContain('surround and drag under');
    expect(player).not.toContain('wet planks');
  });

  it('honours a plan that puts a gm-only-tagged note in the player document (the override)', async () => {
    const seeded = await seed();
    // The kind rules are the DEFAULT the plan may override (docs/07 §M3-D): a
    // note tagged gm-only, declared for BOTH audiences, prints in both — and it
    // is visible in the plan the owner inspects.
    const override = moduleDocumentPlanSchema.parse({
      ...planFor(seeded),
      sections: [
        {
          title: 'The Bell, Quietly',
          role: 'aside',
          audience: 'all',
          source: { type: 'artifact', artifactId: seeded.noteId },
          images: [],
        },
      ],
    });
    const player = textOf(
      buildModuleDefinition({
        module: withPlan(seeded, override),
        artifacts: seeded.artifacts,
        images: imagesFor(seeded),
        audience: 'player',
      }),
    );
    expect(player).toContain('Remember the bell.');
  });

  it('completes the back matter with the NPCs the plan did NOT print', async () => {
    const seeded = await seed();
    const text = textOf(
      buildModuleDefinition({
        module: withPlan(seeded, planFor(seeded)),
        artifacts: seeded.artifacts,
        images: imagesFor(seeded),
      }),
    );

    // Vexra is a planned section, so the gallery does not print her again.
    expect(text.match(/Vexra/g)?.length).toBeGreaterThan(0);
    expect(text).not.toContain(`"id":"node-${seeded.npcId}"`);
    // The bystander nobody planned is still in the gallery (non-vacuity: the
    // gallery exists and prints someone).
    expect(text).toContain('NPC Gallery');
    expect(text).toContain('Unplanned Bystander');
  });
});

describe('a plan that cannot be applied is loud, and the export still lands', () => {
  beforeEach(clearDatabase);

  it('reports a STALE reference by name, in the document AND in the problems', async () => {
    const seeded = await seed();
    const stale = moduleDocumentPlanSchema.parse({
      ...planFor(seeded),
      sections: [
        {
          title: 'The Vanished Tower',
          role: 'explanation',
          audience: 'all',
          source: { type: 'artifact', artifactId: newId() },
          images: [],
        },
      ],
    });
    const module = withPlan(seeded, stale);
    const options = { codec: fixedCodec(), compiledAt: new Date('2026-01-01T12:00:00.000Z') };
    const { blob, problems } = await buildModulePdf(module, seeded.artifacts, (definition) =>
      generatePdfBlob(definition), options);

    // 1. the export LANDED: a real PDF, not a failed run.
    const bytes = new TextDecoder('latin1').decode(await blob.arrayBuffer());
    expect(bytes.startsWith('%PDF-')).toBe(true);
    expect(bytes).toContain('/Subtype /Image');
    // 2. the problem is NAMED, at the plan, with the reason.
    const problem = problems.find((entry) => entry.where === 'the document plan');
    expect(problem?.reason).toContain('The Vanished Tower');
    expect(problem?.reason).toContain('neither owns nor mentions');
    // 3. the DOCUMENT says it too, on its own page (the owner cannot miss it).
    const { definition } = buildModulePdfDocument({
      module,
      artifacts: seeded.artifacts,
      images: imagesFor(seeded),
      compiledAt: options.compiledAt,
    });
    const text = textOf(definition);
    expect(text).toContain('procedural outline');
    // 4. NOTHING of the plan was rendered. The invented title appears exactly
    //    ONCE — inside the statement that names it — and never as a heading.
    expect(text.match(/The Vanished Tower/g)?.length).toBe(1);
    expect(text).not.toContain('"text":"The Vanished Tower","style":"chapter"');
    //    The PROCEDURAL chapter set is what printed instead.
    expect(text).toContain('"text":"Locations"');
    expect(text).toContain('TREASURE LEDGER');
  });

  it('never renders a HALF-applied plan (the good sections are dropped too)', async () => {
    const seeded = await seed();
    const mixed = moduleDocumentPlanSchema.parse({
      sections: [
        {
          title: 'A Fine Section',
          role: 'explanation',
          audience: 'all',
          source: { type: 'artifact', artifactId: seeded.locationId },
          images: [],
        },
        {
          title: 'A Broken Section',
          role: 'explanation',
          audience: 'all',
          source: { type: 'artifact', artifactId: newId() },
          images: [],
        },
      ],
    });
    const { definition, problems } = buildModulePdfDocument({
      module: withPlan(seeded, mixed),
      artifacts: seeded.artifacts,
      images: imagesFor(seeded),
    });
    const text = textOf(definition);

    expect(problems.some((entry) => entry.where === 'the document plan')).toBe(true);
    expect(text).toContain('procedural outline');
    // The GOOD section is dropped with the bad one: no half-applied plan. Both
    // titles appear at most inside the statement that names the broken one.
    expect(text).not.toContain('"text":"A Fine Section","style":"chapter"');
    expect(text).not.toContain('"text":"A Broken Section","style":"chapter"');
    // The procedural outline (which the plan would have replaced) printed.
    expect(text).toContain('"text":"Locations"');
  });

  it('falls back loudly when the STORED value is not a plan at all', async () => {
    const seeded = await seed();
    const { definition, problems } = buildModulePdfDocument({
      module: withPlan(seeded, { sections: [{ title: 'nope' }] }),
      artifacts: seeded.artifacts,
      images: imagesFor(seeded),
    });

    const problem = problems.find((entry) => entry.where === 'the document plan');
    expect(problem?.reason).toContain('not a valid document plan');
    expect(problem?.reason).toContain('sections.0');
    expect(textOf(definition)).toContain('procedural outline');
  });

  it('is SILENT when there is no plan at all (absence is normal, by design)', async () => {
    const seeded = await seed();
    const { definition, problems } = buildModulePdfDocument({
      module: seeded.module,
      artifacts: seeded.artifacts,
      images: imagesFor(seeded),
    });

    // No plan problem of ANY kind, and the procedural document is byte-for-byte
    // what an explicit `null` produces.
    expect(problems.filter((entry) => entry.where === 'the document plan')).toEqual([]);
    const withNull = textOf(
      buildModuleDefinition({
        module: withPlan(seeded, null),
        artifacts: seeded.artifacts,
        images: imagesFor(seeded),
      }),
    );
    expect(textOf(definition)).toBe(withNull);
    expect(withNull).toContain('Locations');
    expect(withNull).not.toContain('procedural outline');
  });
});

describe('determinism: the same (module, plan) renders the same book', () => {
  beforeEach(clearDatabase);

  it('produces a byte-identical DEFINITION twice (and states the number)', async () => {
    const seeded = await seed();
    const input = {
      module: withPlan(seeded, planFor(seeded)),
      artifacts: seeded.artifacts,
      images: imagesFor(seeded),
      compiledAt: new Date('2026-01-01T12:00:00.000Z'),
    };
    const first = JSON.stringify(buildModuleDefinition(input));
    const second = JSON.stringify(buildModuleDefinition({ ...input }));
    expect(second).toBe(first);
    // MEASURED: the planned definition of this fixture is this many
    // characters. UPDATED by docs/17 row 148 (6359 → 6973): the layout wraps
    // the sections in page nodes (a `columns` per page, a `stack` for a page
    // with no companion), moves each artifact's mechanics into a sidebar column
    // and adds the own-page pointers — so the definition is bigger and the
    // BYTE-IDENTITY above is what this pin is actually about. UPDATED AGAIN by
    // docs/17 row 151 (6973 → 8095): §7's `Referenced from:` line, and the
    // internal link on every wiki-link of the module's own text. UPDATED AGAIN
    // by docs/17 row 156 (8095 → 8131): the cover, the Contents page and the
    // treasure-ledger page are page nodes from the paginator now instead of
    // loose top-level nodes, and each of those three costs exactly its
    // `{"stack":[…]}` wrapper — measured on the small fixture (5235 → 5259),
    // where two of the three are present, because the Contents page's own
    // `pageBreak` merely MOVES from the heading node onto its page node. No
    // text run moves: the differential in `tests/lib/pdfLayout.test.ts` is
    // untouched by row 156 and the rendered pages are byte-identical. UPDATED
    // AGAIN by docs/17 row 186 (8131 → 8030): the owner's own-page pointer now
    // RIDES THE TEXT COLUMN, so a page that used to pay for the two-column
    // frame — `{"columns":[{"width":294.8,"stack":[heading]},{"width":170.1,
    // "stack":[marker],"style":"detail","fontSize":9.5}],"columnGap":17}` —
    // is the one-sided full-width `{"stack":[heading,marker]}` the owner asked
    // for, which is exactly this fixture's single chapter-plus-pointer page.
    // The MARKER BRAND itself is a Symbol, so it adds no byte: the 101-character
    // delta is the frame's, and the BYTE-IDENTITY above is still the point.
    // UPDATED AGAIN by docs/17 row 187 (8030 → 8308): the planned path now
    // prints the artifact's own artwork, and this fixture gained the gallery
    // NPC's portrait (the bystander's `coverImageId`), which is one more image
    // node — a data URL plus its `fit`/`margin` box, +278 characters. The
    // BYTE-IDENTITY above is untouched and is what this pin is about.
    expect(first.length).toBe(8308);
  });

  it('renders a stored plan with NO companion byte-identically, and materializes no key (docs/17 row 188)', async () => {
    const seeded = await seed();
    // THE STORED-PLAN COMPATIBILITY PIN. Every plan stored before the companion
    // field existed has no `companion` key anywhere — and neither does this
    // fixture's. `.nullish()` (never a default) means the key stays ABSENT
    // through parse, so a stored plan re-serializes unchanged…
    const stored = JSON.parse(JSON.stringify(planFor(seeded))) as {
      sections: Record<string, unknown>[];
    };
    for (const section of stored.sections) expect('companion' in section).toBe(false);
    const reparsed = moduleDocumentPlanSchema.parse(stored);
    expect(reparsed.sections.every((section) => !('companion' in section))).toBe(true);
    // …and the document it produces is the measured one the byte-identity pin
    // above states (8308 chars): the no-companion path is untouched by row 188.
    const definition = JSON.stringify(
      buildModuleDefinition({
        module: withPlan(seeded, reparsed),
        artifacts: seeded.artifacts,
        images: imagesFor(seeded),
        compiledAt: new Date('2026-01-01T12:00:00.000Z'),
      }),
    );
    expect(definition.length).toBe(8308);
  });

  it('produces byte-identical PDF BYTES twice (measured size + first-difference)', async () => {
    const seeded = await seed();
    const module = withPlan(seeded, planFor(seeded));
    const options = { codec: fixedCodec(), compiledAt: new Date('2026-01-01T12:00:00.000Z') };
    const first = await buildModulePdf(module, seeded.artifacts, (definition) =>
      generatePdfBlob(definition), options);
    const second = await buildModulePdf(module, seeded.artifacts, (definition) =>
      generatePdfBlob(definition), options);

    const a = new Uint8Array(await first.blob.arrayBuffer());
    const b = new Uint8Array(await second.blob.arrayBuffer());
    // MEASURED: equal length, and NO differing byte (the first difference is
    // reported as -1 rather than asserted away).
    expect(a.length).toBe(b.length);
    let firstDiff = -1;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        firstDiff = i;
        break;
      }
    }
    // UPDATED by docs/17 row 148 (51271 → 51183): the pagination changes how
    // much of the page each item occupies, so the compressed bytes move a
    // little; `firstDiff: -1` — no differing byte at all — is unchanged, and is
    // what this pin exists for. UPDATED AGAIN by docs/17 row 151 (51183 →
    // 59215): §7's back-reference lines and the wiki-link annotations are real
    // content, so the rendered book grows. UPDATED AGAIN by docs/17 row 186
    // (59215 → 59233): the own-page pointer's page prints as ONE full-width
    // column instead of a two-column frame, so the text is laid out at different
    // x positions and the content streams move by 18 bytes. The pin's actual
    // claim is untouched: two builds of the same input are byte-identical
    // (`firstDiff: -1`) and carry the same problems. UPDATED AGAIN by docs/17
    // row 187 (59233 → 60505): the planned book now carries the location's own
    // cover, the encounter's own map plate and the gallery NPC's portrait
    // through the real image pipeline, and the preloader no longer narrows the
    // request set to the plan's anchors (the loaded set and the printed set are
    // ONE decision) — so the embedded image XObjects are in the bytes instead of
    // the loud "not in the preloaded image set" alert. `firstDiff: -1` is
    // unchanged.
    expect({ firstDiff, size: a.length }).toEqual({ firstDiff: -1, size: 60505 });
    expect(first.problems).toEqual(second.problems);
  });

  it('pins the images at the budgets their own sites print at', async () => {
    const seeded = await seed();
    const better: { budgets: number[] } = { budgets: [] };
    const codec: PdfImageCodec = (_bytes, _mimeType, maxLongEdge) => {
      better.budgets.push(maxLongEdge);
      return Promise.resolve({ dataUrl: ONE_PIXEL_PNG, width: 1, height: 1 });
    };
    const { problems } = await buildModulePdf(
      withPlan(seeded, planFor(seeded)),
      seeded.artifacts,
      (definition) => generatePdfBlob(definition),
      { codec, compiledAt: new Date('2026-01-01T12:00:00.000Z') },
    );
    expect(problems).toEqual(EMPTY_PART_PROBLEM);
    expect(better.budgets).toContain(PDF_MAP_MAX_LONG_EDGE);
    expect(better.budgets).toContain(PDF_COVER_MAX_LONG_EDGE);
  });
});
