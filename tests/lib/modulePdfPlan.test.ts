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
/** A real 1×1 PNG — the smallest image pdfmake can genuinely embed. */
const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4z8AAAAMBAQD3A0FDAAAAAElFTkSuQmCC';

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
      levelHint: '5',
      monsters: [{ name: 'Cultist', count: 4, notes: 'netters', treasure: '', source: { type: 'none' } }],
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
    dataUrls: { [seeded.mapImageId]: MAP_MARKER, [seeded.coverImageId]: COVER_MARKER },
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
    const text = textOf(
      buildModuleDefinition({
        module: withPlan(seeded, planFor(seeded)),
        artifacts: seeded.artifacts,
        images: imagesFor(seeded),
      }),
    );

    // The aside's node is addressed by its own destination and carries neither
    // a page break nor a ToC entry (the owner's "genuinely parenthetical").
    const asideIndex = at(text, '"text":"The Bell, Quietly"');
    const asideNode = text.slice(asideIndex - 60, asideIndex + 120);
    expect(asideNode).toContain('node-plan-5');
    expect(asideNode).not.toContain('pageBreak');
    expect(asideNode).not.toContain('tocItem');
    // A chapter DOES carry both (non-vacuity for the negative above).
    expect(at(text, '"id":"node-plan-1"')).toBeGreaterThan(0);
    expect(text).toContain('"id":"node-plan-1","tocItem":"chapters","pageBreak":"before"');
  });

  it('prints exactly the images the plan anchored — and no others', async () => {
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
    // The map is a PLATE: full content width, tall fit.
    expect(withAnchors).toContain('"fit":[515,660]');
    // The cover art is inline art, not a plate.
    expect(withAnchors).toContain('"fit":[450,320]');

    // The same module, planned WITHOUT anchors: no image node at all, and no
    // problem either — an unanchored image is the plan's decision, not a fault.
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
    expect(textOf(bare.definition)).not.toContain(MAP_MARKER);
    expect(textOf(bare.definition)).not.toContain(COVER_MARKER);
    // The ONLY problem is the empty part the plan names — never an image.
    expect(bare.problems).toEqual(EMPTY_PART_PROBLEM);
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
    // MEASURED: the planned definition of this fixture is this many characters.
    expect(first.length).toBe(6359);
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
    expect({ firstDiff, size: a.length }).toEqual({ firstDiff: -1, size: 51271 });
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
