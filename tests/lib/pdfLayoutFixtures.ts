import 'fake-indexeddb/auto';

import {
  createModule as buildModule,
  moduleDocumentPlanSchema,
  modulePartSchema,
  moduleSpineSchema,
  statBlockSchema,
  type AnyArtifact,
  type Artifact,
  type Id,
  type Module,
  type ModuleDocumentPlan,
  type StatBlock,
} from '@/domain';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createImage } from '@/db/imageRepo';
import { saveModule } from '@/db/moduleRepo';

/**
 * TWO REAL MODULE FIXTURES for the pdf page model (docs/19, docs/17 row 148).
 *
 * They exist because the page model is a CONTENT-PRESERVING rewrite: the
 * layout of every artifact kind moves (main column + sidebar, adjacency for
 * the oversized ones), so the landing needs a differential that would notice
 * a string going missing while every definition-level pin still passes.
 *
 * - `pdfLayoutLargeFixture()` is the one that exercises the MOST artifact
 *   kinds in ONE module: `pc`, `npc`, `location`, `event`, `faction`,
 *   `encounter` (with a map plate and a four-entry roster covering `inline`,
 *   `npc-ref`, `none` and a `rulebook` citation), `plotarc` and a `gm-only`
 *   `note` — plus a three-part spine, a cover image and two `tables` worth of
 *   structured fields. It is the fixture a layout change is most likely to
 *   lose something in.
 * - `pdfLayoutSmallFixture()` is the degenerate one: premise, ONE part, two
 *   artifacts, no images, no plan. A document with too little material to
 *   fill a sidebar is a real document, and it must still render.
 *
 * NOTHING here is a test: the file holds the seeds and the ONE extractor the
 * differential and the spec pins both read, so the two can never disagree
 * about what "the document's content strings" means.
 */

/** A real 1×1 PNG — the smallest image pdfmake can genuinely embed. */
export const LAYOUT_ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4z8AAAAMBAQD3A0FDAAAAAElFTkSuQmCC';

export function layoutStatBlock(): StatBlock {
  return statBlockSchema.parse({
    system: 'dnd5e',
    level: '3',
    size: 'Medium',
    creatureType: 'humanoid (cultist)',
    ac: 12,
    acNote: '',
    hp: 9,
    hpFormula: '2d8',
    speed: '30 ft.',
    abilities: { str: 11, dex: 12, con: 10, int: 10, wis: 11, cha: 10 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    traits: [{ name: 'Dark Devotion', text: 'Advantage on saves vs. charm.' }],
    actions: [{ name: 'Dagger', text: 'Melee: +3 to hit, 4 damage.\nReach 5 ft.' }],
    reactions: [{ name: 'Parry', text: 'Adds 2 to its AC against one melee attack.' }],
    legendary: [],
    extras: { Perception: '+2' },
  });
}

/** A PF2e-style cited block, whose every section must survive the layout. */
export function layoutCitedStatBlock(): StatBlock {
  return statBlockSchema.parse({
    system: 'pathfinder2e',
    level: '4',
    size: 'Medium',
    creatureType: 'animal',
    ac: 18,
    acNote: '',
    hp: 44,
    hpFormula: '8d8',
    speed: '30 ft.',
    abilities: { str: 14, dex: 18, con: 12, int: 2, wis: 14, cha: 6 },
    saves: '',
    skills: '',
    senses: 'darkvision',
    languages: '',
    traits: [{ name: 'Grasping Antennae', text: 'Reach 10 feet.' }],
    actions: [{ name: 'Mandible', text: 'Melee: +12 to hit, 2d8+4 piercing.' }],
    reactions: [{ name: 'Reactive Snap', text: 'Strike a creature that enters its reach.' }],
    legendary: [{ name: 'Skitter Away', text: 'Stride without provoking reactions.' }],
    extras: { Perception: '+11' },
  });
}

function owned(artifact: AnyArtifact): Artifact {
  if (artifact.campaignId === null) throw new Error('expected a campaign-owned row');
  return artifact;
}

export interface LayoutFixture {
  module: Module;
  artifacts: AnyArtifact[];
  /** The per-encounter roster resolution the cited entry needs. */
  rosterResolution?: Readonly<Record<Id, readonly { statBlock: StatBlock | null; origin: string }[]>>;
  /** The images the document's own requests resolve to (marker data URLs). */
  images: { dataUrls: Record<Id, string>; failures: [] };
}

/**
 * The LARGE fixture: one module carrying every artifact kind the renderer
 * knows. Every row is wiki-linked from the premise or a part, so every row is
 * a real reference — a fixture with an unreferenced row would be measuring
 * the owner's decision 3 (an unplaced artifact is dropped) rather than the
 * layout, and the layout is what this differential is about.
 */
export async function pdfLayoutLargeFixture(): Promise<LayoutFixture> {
  const campaign = await createCampaign({ name: 'Layout Campaign', system: 'dnd5e' });
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
    body: 'The tower watches the ford.\n\n> The tide waits for no one.',
    data: {
      locationType: 'ruin',
      inhabitants: 'gulls and one ghost',
      pointsOfInterest: [{ name: 'The Bell', description: 'Cracked, and warm.' }],
      hooks: ['The bell rings at midnight.'],
    },
    coverImageId,
  });
  const event = await createArtifact({
    campaignId: campaign.id,
    kind: 'event',
    name: 'The Turning',
    body: 'The tide turns on the hour.',
    data: {
      locationType: 'ritual',
      inhabitants: 'the drowned',
      pointsOfInterest: [],
      hooks: ['Someone must hold the rope.'],
    },
  });
  const npc = await createArtifact({
    campaignId: campaign.id,
    kind: 'npc',
    name: 'Vexra',
    body: 'Hooded and cold.',
    data: { appearance: 'Hooded', personality: 'Cold', statBlock: layoutStatBlock() },
  });
  const pc = await createArtifact({
    campaignId: campaign.id,
    kind: 'pc',
    name: 'Marek',
    body: 'Sworn to the bell.',
    data: {
      playerName: 'Ana',
      statBlock: layoutStatBlock(),
      currentHp: 22,
      initiativeOverride: null,
      notes: 'Owes the wardens a favour.',
    },
  });
  const faction = await createArtifact({
    campaignId: campaign.id,
    kind: 'faction',
    name: 'The Tide Wardens',
    data: {
      goals: 'Keep the bell dry.',
      methods: 'Bribes and drowned witnesses.',
      resources: 'Two boats.',
      ranks: [{ title: 'Warden', description: 'Holds the rope.' }],
    },
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
      hooks: ['A drowned sailor asks for help.'],
      climax: 'The crown is broken on the pier.',
    },
  });
  const note = await createArtifact({
    campaignId: campaign.id,
    kind: 'note',
    name: 'GM cheat sheet',
    body: 'Remember the bell.',
    tags: ['gm-only'],
  });
  const encounter = await createArtifact({
    campaignId: campaign.id,
    kind: 'encounter',
    name: 'Pier Ambush',
    body: 'They come up out of the water.',
    data: {
      difficulty: 'deadly',
      levelHint: '5',
      monsters: [
        {
          name: 'Cultist',
          count: 4,
          notes: 'netters',
          treasure: '',
          source: { type: 'inline', statBlock: layoutStatBlock() },
        },
        {
          name: 'Vexra',
          count: 1,
          notes: '',
          treasure: '',
          source: { type: 'npc-ref', artifactId: npc.id },
        },
        { name: 'Harbour Thug', count: 2, notes: '', treasure: '', source: { type: 'none' } },
        {
          name: 'Cave Fisher',
          count: 1,
          notes: '',
          treasure: '',
          source: { type: 'rulebook', chunkId: '00000000-0000-4000-8000-0000000000cf', contentHash: 'a'.repeat(64), creatureName: 'Cave Fisher' },
        },
      ],
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

  const module = await saveModule({
    ...buildModule({
      campaignId: campaign.id,
      title: 'Beneath the Docks',
      concept: 'A drowned vault.',
      levelMin: 1,
      levelMax: 3,
      tone: 'grim',
      sizeDial: 'standard',
    }),
    spine: moduleSpineSchema.parse({
      premise:
        'A drowned vault beneath the [[Old Tower]]. [[Vexra]] waits by the [[Pier Ambush]], ' +
        'and the [[GM cheat sheet]] holds the bell. [[The Tide Wardens]] watch, [[Marek]] ' +
        'keeps the watch, and [[The Drowned Crown]] is what they are really guarding. ' +
        'The [[The Turning]] comes with the tide.',
      themes: [],
      partPlan: [
        {
          title: 'The Dockyards',
          levelBand: '1-2',
          synopsis: 'Meet the wardens.',
          levelUpTrigger: 'The bell rings.',
        },
        { title: 'The Vault', levelBand: '3', synopsis: 'Break the crown.', levelUpTrigger: 'The tide falls.' },
      ],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown:
          'The party rows out at dusk.\n\nThe wardens watch from the [[Old Tower]] while ' +
          '[[Vexra]] counts the boats.',
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
      modulePartSchema.parse({
        planIndex: 1,
        markdown:
          'Below the waterline the vault opens.\n\nThe [[Pier Ambush]] waits in the dark, and ' +
          '[[The Drowned Crown]] hums.',
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
    coverImageId,
  });

  return {
    module,
    artifacts: [location, event, npc, pc, faction, plotarc, note, encounter],
    rosterResolution: {
      [encounter.id]: [
        { statBlock: null, origin: 'inline' },
        { statBlock: null, origin: 'Vexra' },
        { statBlock: null, origin: 'missing ref (Harbour Thug)' },
        { statBlock: layoutCitedStatBlock(), origin: 'Monster Core: Cave Fisher' },
      ],
    },
    images: {
      dataUrls: { [mapImageId]: LAYOUT_ONE_PIXEL_PNG, [coverImageId]: LAYOUT_ONE_PIXEL_PNG },
      failures: [],
    },
  };
}

/** The SMALL fixture: premise, one part, two artifacts, no plan, no images. */
export async function pdfLayoutSmallFixture(): Promise<LayoutFixture> {
  const campaign = await createCampaign({ name: 'Small Layout Campaign', system: 'dnd5e' });
  const npc = await createArtifact({
    campaignId: campaign.id,
    kind: 'npc',
    name: 'The Ferryman',
    body: 'He never asks for coin.',
    data: { appearance: 'Weathered', personality: 'Patient', statBlock: layoutStatBlock() },
  });
  const location = await createArtifact({
    campaignId: campaign.id,
    kind: 'location',
    name: 'The Quiet Ford',
    body: 'Nothing has crossed it in years.',
    data: {
      locationType: 'crossing',
      inhabitants: '',
      pointsOfInterest: [],
      hooks: [],
    },
  });
  const module = await saveModule({
    ...buildModule({
      campaignId: campaign.id,
      title: 'The Quiet Ford',
      concept: 'A crossing nobody uses.',
      levelMin: 1,
      levelMax: 1,
      tone: '',
      sizeDial: 'sketch',
    }),
    spine: moduleSpineSchema.parse({
      premise: 'The [[The Quiet Ford]] is held by [[The Ferryman]].',
      themes: [],
      partPlan: [
        { title: 'The Crossing', levelBand: '1', synopsis: 'Cross the water.', levelUpTrigger: '' },
      ],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: 'The party waits for the ferry.\n\nThe water is very still.',
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
  return {
    module,
    artifacts: [npc, location],
    images: { dataUrls: {}, failures: [] },
  };
}

/**
 * The LARGE fixture's PLAN: one section per shape the vocabulary can take, so
 * the planned render exercises role treatments, part sources, artifact
 * sources and plan-anchored images at once.
 */
export function pdfLayoutLargePlan(fixture: LayoutFixture): ModuleDocumentPlan {
  const byName = (name: string): Id => {
    const row = fixture.artifacts.find((artifact) => artifact.name === name);
    if (row === undefined) throw new Error(`the fixture has no row named ${name}`);
    return row.id;
  };
  const location = fixture.artifacts.find((artifact) => artifact.kind === 'location');
  if (location === undefined) throw new Error('the fixture must build a location');
  const coverImageId = owned(location).coverImageId;
  const encounter = fixture.artifacts.find((artifact) => artifact.kind === 'encounter');
  if (encounter?.kind !== 'encounter') {
    throw new Error('the fixture must build an encounter');
  }
  const mapImageId = encounter.data.mapImageId;
  if (mapImageId === null) throw new Error('the fixture encounter must carry a map');
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
        source: { type: 'artifact', artifactId: byName('Old Tower') },
        images: [coverImageId],
      },
      {
        title: 'Vexra at the Gate',
        role: 'explanation',
        audience: 'all',
        source: { type: 'artifact', artifactId: byName('Vexra') },
        images: [],
      },
      {
        title: 'Ambush on the Pier',
        role: 'gm-note',
        audience: 'all',
        source: { type: 'encounter', artifactId: byName('Pier Ambush') },
        images: [mapImageId],
      },
      {
        title: 'The Bell, Quietly',
        role: 'aside',
        audience: 'all',
        source: { type: 'artifact', artifactId: byName('GM cheat sheet') },
        images: [],
      },
      {
        title: 'What the Crown Wants',
        role: 'explanation',
        audience: 'gm',
        source: { type: 'artifact', artifactId: byName('The Drowned Crown') },
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

/**
 * A THIRD fixture, for the owner's decision about an artifact nothing refers
 * to (docs/19 §10 question 3). It is deliberately tiny and deliberately not
 * built by the other two, so that adding it cannot move their content sets:
 *
 * - `The Ford` is wiki-linked from the premise, so it is REFERENCED;
 * - `The Unnamed Ferryman` is NOT, and the plan nevertheless gives it a
 *   section — exactly the case the owner's answer rules on: it must not print,
 *   and it must not vanish silently either.
 */
export async function pdfLayoutOmissionFixture(): Promise<{
  module: Module;
  artifacts: AnyArtifact[];
  images: { dataUrls: Record<Id, string>; failures: [] };
}> {
  const campaign = await createCampaign({ name: 'Omission Campaign', system: 'dnd5e' });
  const module = await saveModule({
    ...buildModule({
      campaignId: campaign.id,
      title: 'The Ford',
      concept: 'A crossing.',
      levelMin: 1,
      levelMax: 1,
      tone: '',
      sizeDial: 'sketch',
    }),
    spine: moduleSpineSchema.parse({
      premise: 'The party reaches [[The Ford]] at dusk.',
      themes: [],
      partPlan: [
        { title: 'The Crossing', levelBand: '1', synopsis: 'Cross.', levelUpTrigger: '' },
      ],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: 'The water is shallow.',
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
  const referenced = await createArtifact({
    campaignId: campaign.id,
    kind: 'location',
    name: 'The Ford',
    body: 'Shallow enough to walk.',
    data: { locationType: 'crossing', inhabitants: '', pointsOfInterest: [], hooks: [] },
  });
  // OWNED by the module but named NOWHERE in its prose. That combination is
  // the only way a plan can place a row nothing refers to: the plan's own pool
  // is "owned ∪ mentioned" (`domain/documentPlan`), so an unowned, unmentioned
  // row is refused by the plan validator before the renderer ever sees it.
  const unreferenced = await createArtifact({
    campaignId: campaign.id,
    moduleId: module.id,
    kind: 'npc',
    name: 'The Unnamed Ferryman',
    body: 'He rows the crossing without ever asking for coin.',
    data: { appearance: 'Silent', personality: 'Patient', statBlock: null },
  });
  return { module, artifacts: [referenced, unreferenced], images: { dataUrls: {}, failures: [] } };
}

/** The plan for that fixture: one section per row, including the unreferenced one. */
export function pdfLayoutOmissionPlan(
  fixture: Awaited<ReturnType<typeof pdfLayoutOmissionFixture>>,
): ModuleDocumentPlan {
  const byName = (name: string): Id => {
    const row = fixture.artifacts.find((artifact) => artifact.name === name);
    if (row === undefined) throw new Error(`the fixture has no row named ${name}`);
    return row.id;
  };
  return moduleDocumentPlanSchema.parse({
    sections: [
      {
        title: 'The Crossing',
        role: 'explanation',
        audience: 'all',
        source: { type: 'part', planIndex: 0 },
        images: [],
      },
      {
        title: 'The Ford',
        role: 'explanation',
        audience: 'all',
        source: { type: 'artifact', artifactId: byName('The Ford') },
        images: [],
      },
      {
        title: 'The Toll',
        role: 'explanation',
        audience: 'all',
        source: { type: 'artifact', artifactId: byName('The Unnamed Ferryman') },
        images: [],
      },
    ],
    plannedByModel: 'vendor/planner-1',
    plannedAt: 1_700_000_000_000,
  });
}

/**
 * A FOURTH fixture, for the owner's sidebar answer to docs/19 §10 question 1
 * (*"ONCE, with a link back"*, docs/17 row 151). It is the ONE shape that can
 * reach the rule and it is NOT one the other fixtures produce: a plan that
 * names the SAME row twice, so the second section is a reference to a companion
 * that already printed.
 *
 * The plan validator permits it (`documentPlanIssues` checks anchors, not
 * duplicates) and the renderer has always had to cope — two sections cannot
 * share one destination id (`destinations` keeps the FIRST). What was never
 * decided until now is what the second one PRINTS: the companion again, or a
 * link back to where it printed.
 *
 * Deliberately tiny and built by nobody else, so adding it cannot move the
 * other fixtures' content sets: one `npc` with a real stat block (so the
 * companion has mechanics to find or lose), named ONCE in the premise, placed
 * by TWO plan sections.
 */
export async function pdfLayoutRepeatFixture(): Promise<{
  module: Module;
  artifacts: AnyArtifact[];
  images: { dataUrls: Record<Id, string>; failures: [] };
}> {
  const campaign = await createCampaign({ name: 'Repeat Campaign', system: 'dnd5e' });
  const module = await saveModule({
    ...buildModule({
      campaignId: campaign.id,
      title: 'The Bell',
      concept: 'A bell nobody should ring twice.',
      levelMin: 1,
      levelMax: 1,
      tone: '',
      sizeDial: 'sketch',
    }),
    spine: moduleSpineSchema.parse({
      premise: 'The rope is tied to [[The Bell Ambush]].',
      themes: [],
      partPlan: [
        { title: 'The Rope', levelBand: '1', synopsis: 'Pull it.', levelUpTrigger: '' },
      ],
    }),
  });
  // An ENCOUNTER, deliberately: §4 sends that kind to its own page whatever its
  // size, so the two referencing sections land on two SEPARATE pages and a pin
  // can tell which one carries the companion and which one the link back. With
  // a kind that flows, both would share one page's sidebar and the two halves
  // would be indistinguishable in the definition.
  const ambush = await createArtifact({
    campaignId: campaign.id,
    kind: 'encounter',
    name: 'The Bell Ambush',
    body: 'They ring it twice.',
    data: {
      difficulty: 'deadly',
      levelHint: '3',
      monsters: [
        {
          name: 'Bellringer',
          count: 1,
          notes: '',
          treasure: '',
          source: { type: 'inline', statBlock: layoutStatBlock() },
        },
      ],
      terrain: 'wet planks by the bell rope',
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
  return { module, artifacts: [ambush], images: { dataUrls: {}, failures: [] } };
}

/**
 * The plan for that fixture: the SAME row in two sections, in plan order. The
 * first is where the companion prints; the second is the later reference the
 * owner's answer rules on. Section indices are the destinations the document
 * uses (`node-plan-1` and `node-plan-2`), which is what the pin links against.
 */
export function pdfLayoutRepeatPlan(
  fixture: Awaited<ReturnType<typeof pdfLayoutRepeatFixture>>,
): ModuleDocumentPlan {
  const row = fixture.artifacts[0];
  if (row === undefined) throw new Error('the repeat fixture must build its row');
  return moduleDocumentPlanSchema.parse({
    sections: [
      {
        title: 'At the Rope',
        role: 'explanation',
        audience: 'all',
        source: { type: 'part', planIndex: -1 },
        images: [],
      },
      {
        title: 'The Bell Ambush, first',
        role: 'explanation',
        audience: 'all',
        source: { type: 'encounter', artifactId: row.id },
        images: [],
      },
      {
        title: 'The Bell Ambush, again',
        role: 'explanation',
        audience: 'all',
        source: { type: 'encounter', artifactId: row.id },
        images: [],
      },
    ],
    plannedByModel: 'vendor/planner-1',
    plannedAt: 1_700_000_000_000,
  });
}

/**
 * Every TEXT RUN of a pdfmake definition, in document order — the document
 * READ as text, through the same walk `tests/lib/roster-reference-parity`
 * uses (a run's `text` may be a string or a nested array of runs; every other
 * object value is walked). It is the ONE extractor the layout differential
 * and the spec pins share.
 */
export function contentRuns(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') return out;
  if (Array.isArray(node)) {
    for (const child of node) contentRuns(child, out);
    return out;
  }
  if (typeof node !== 'object' || node === null) return out;
  const record = node as Record<string, unknown>;
  const text: unknown = record.text;
  if (typeof text === 'string') out.push(text);
  else if (text !== undefined) contentRuns(text, out);
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'text') contentRuns(value, out);
  }
  return out;
}

/** The non-empty, trimmed DISTINCT runs of a definition — the content set. */
export function contentStrings(definition: unknown): string[] {
  const seen = new Set<string>();
  for (const run of contentRuns(definition)) {
    const trimmed = run.trim();
    if (trimmed !== '') seen.add(trimmed);
  }
  return [...seen].sort();
}

/** The document's runs joined, with the ORDER kept (for adjacency pins). */
export function documentText(definition: unknown): string {
  return contentRuns(definition).join('\n');
}

/**
 * Every INTERNAL LINK a definition carries, in document order: the run's own
 * text and the destination it jumps to. A run whose `text` is nested (the
 * linked kicker of docs/19 §10.1) contributes its innermost linked run.
 *
 * The pdfmake contract is that a `linkToDestination` names a node `id` in the
 * SAME document — pdfmake throws at render time otherwise, which a
 * definition-level suite cannot observe, so `nodeAnchors` beside this is how
 * the suite checks it instead.
 */
export function linkedRuns(
  node: unknown,
  out: { text: string; destination: string }[] = [],
): { text: string; destination: string }[] {
  if (typeof node !== 'object' || node === null) return out;
  if (Array.isArray(node)) {
    for (const child of node) linkedRuns(child, out);
    return out;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.linkToDestination === 'string' && typeof record.text === 'string') {
    out.push({ text: record.text, destination: record.linkToDestination });
  }
  for (const value of Object.values(record)) linkedRuns(value, out);
  return out;
}

/** Every destination `id` a definition carries → the text that node prints. */
export function nodeAnchors(
  node: unknown,
  out: Map<string, string> = new Map<string, string>(),
): Map<string, string> {
  if (typeof node !== 'object' || node === null) return out;
  if (Array.isArray(node)) {
    for (const child of node) nodeAnchors(child, out);
    return out;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.id === 'string') {
    const text = record.text;
    out.set(record.id, typeof text === 'string' ? text : contentRuns(text).join(''));
  }
  for (const value of Object.values(record)) nodeAnchors(value, out);
  return out;
}
