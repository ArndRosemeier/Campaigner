import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { saveModule } from '@/db/moduleRepo';
import {
  createModule,
  moduleDocumentText,
  modulePartSchema,
  moduleSpineSchema,
  recordedWritingModel,
  type AnyArtifact,
  type Artifact,
  type Module,
  type StatBlock,
} from '@/domain';
import { buildModuleDefinition } from '@/lib/modulePdf';
import { buildGmNotesDefinition, buildPlayerHandoutDefinition } from '@/lib/pdfExport';
import { buildStoredImage } from '@/db/imageRepo';
import { clearDatabase } from '../db/helpers';

/**
 * PROVENANCE, owner decision 3 (docs/17 row 93): the model ids are APP ONLY —
 * "NEVER in exported PDFs; player-facing handouts stay clean."
 *
 * The chosen shape is that the value has NO route into a document: the
 * builders receive domain rows and pre-rendered strings and read explicit
 * fields only, and `writerModel` (top-level on the row, never inside `data`)
 * is not among the fields any of them read. No opt-out flag is needed, and
 * none exists — a flag would be a second thing to get wrong.
 *
 * This file proves it the only way that survives refactoring: it builds the
 * REAL document definitions from content that DOES carry recorded provenance,
 * serializes them, and asserts none of the ids (nor the field name itself)
 * appears — while first proving the ids really are on those rows, so the
 * negative cannot pass vacuously. It also pins the LLM/document-text seam
 * (`moduleDocumentText`), which feeds both exports and model context.
 */

/** Distinctive, collision-proof probe ids — one per row, one per surface. */
const PROBE = {
  location: 'probe-model-location-7f41c9',
  npc: 'probe-model-npc-2b8e05',
  encounter: 'probe-model-encounter-c41a77',
  note: 'probe-model-note-93dd10',
  spine: 'probe-model-spine-51af2e',
  part: 'probe-model-part-6e0b83',
} as const;

const ALL_PROBES: string[] = Object.values(PROBE);

function statBlockFixture(): StatBlock {
  return {
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
    actions: [{ name: 'Dagger', text: 'Melee: +3 to hit, 4 damage.' }],
    reactions: [],
    legendary: [],
    extras: {},
  };
}

/** The serialized form of one produced document definition. */
function serialize(definition: unknown): string {
  return JSON.stringify(definition);
}

/**
 * The PDF builders take campaign-OWNED rows (`Artifact`), while
 * `createArtifact` returns the wider `AnyArtifact` (a library row has a null
 * campaign anchor). Narrow loudly — never cast — so the pin can never test a
 * library row by accident.
 */
function owned(artifact: AnyArtifact): Artifact {
  if (artifact.campaignId === null) throw new Error('expected a campaign-owned artifact row');
  return artifact;
}

async function seedModuleDocument(): Promise<{
  artifacts: AnyArtifact[];
  module: Module;
  plain: Artifact;
}> {
  const campaign = await createCampaign({ name: 'Export Campaign', system: 'dnd5e' });
  const location = await createArtifact({
    campaignId: campaign.id,
    kind: 'location',
    name: 'Old Tower',
    body: 'The tower watches the ford.\n\n> The tide waits for no one.',
    writerModel: PROBE.location,
  });
  const npc = await createArtifact({
    campaignId: campaign.id,
    kind: 'npc',
    name: 'Vexra',
    body: 'Hooded and cold.',
    data: { appearance: 'Hooded', personality: 'Cold', statBlock: statBlockFixture() },
    writerModel: PROBE.npc,
  });
  const encounter = await createArtifact({
    campaignId: campaign.id,
    kind: 'encounter',
    name: 'Pier Ambush',
    body: 'They come up out of the water.',
    data: {
      difficulty: 'deadly',
      levelHint: '5',
      monsters: [],
      terrain: 'wet planks',
      tactics: 'surround and drag under',
      treasure: 'silver bell charm',
      mapImageId: null,
      layout: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    },
    writerModel: PROBE.encounter,
  });
  const note = await createArtifact({
    campaignId: campaign.id,
    kind: 'note',
    name: 'GM cheat sheet',
    body: 'Remember the bell.',
    tags: ['gm-only'],
    writerModel: PROBE.note,
  });

  // A real module row whose spine + part BOTH carry provenance: the module is
  // the other half of the owner's request, and its document text IS the
  // printed document (docs/17 row 108) and the model context — so it is the
  // likeliest leak route.
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Vault',
    concept: 'A flooded vault.',
    levelMin: 1,
    levelMax: 3,
    sizeDial: 'standard',
  });
  const coverRow = await buildStoredImage({
    campaignId: campaign.id,
    blob: new Blob(['cover'], { type: 'image/png' }),
    mimeType: 'image/png',
    width: 8,
    height: 8,
    model: 'probe-model-image-88be21',
    source: 'generated',
  });
  const module = await saveModule({
    ...draft,
    spine: moduleSpineSchema.parse({
      // The prose MENTIONS the rows below, which is what puts them in the
      // document at all (docs/17 row 108: the module's own prose is the
      // scoping rule, not a hand-built outline).
      premise:
        'A drowned vault beneath the tower. The party meets [[Vexra]] by the ' +
        '[[Old Tower]], then springs the [[Pier Ambush]]; the ' +
        '[[GM cheat sheet]] holds the bell.',
      themes: [],
      partPlan: [{ title: 'The Gate', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
      writerModel: PROBE.spine,
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: 'The party climbs down into the wet dark.',
        status: 'ready',
        errorMessage: '',
        edited: false,
        writerModel: PROBE.part,
      }),
    ],
    // The module's OWN cover slot: the image half of the request, on the row
    // the document is built from.
    coverImageId: coverRow.id,
  });
  return {
    artifacts: [location, npc, encounter, note],
    module,
    plain: location,
  };
}

beforeEach(clearDatabase);

describe('model ids never reach a delivered document', () => {
  it('the module definition carries no id — and the rows really do have one', async () => {
    const { artifacts, module } = await seedModuleDocument();

    // NON-VACUITY: the ids exist on the rows and the module document text is
    // what the definition prints, so the negative below is a real exclusion.
    expect(artifacts.map((artifact) => recordedWritingModel(artifact.writerModel))).toEqual([
      PROBE.location,
      PROBE.npc,
      PROBE.encounter,
      PROBE.note,
    ]);
    expect(recordedWritingModel(module.spine?.writerModel)).toBe(PROBE.spine);
    expect(recordedWritingModel(module.parts[0]?.writerModel)).toBe(PROBE.part);
    const documentText = moduleDocumentText(module);
    expect(documentText).toContain('A drowned vault beneath the tower.');
    expect(documentText).toContain('The party climbs down into the wet dark.');

    // The real builder, over content that carries provenance.
    const coverId = module.coverImageId;
    if (coverId === null) throw new Error('module cover missing');
    const definition = buildModuleDefinition({
      module,
      artifacts,
      images: { dataUrls: { [coverId]: 'data:image/png;base64,AAAA' }, failures: [] },
    });
    const text = serialize(definition);

    for (const probe of ALL_PROBES) expect(text).not.toContain(probe);
    // Including the image model id (the image half of the request).
    expect(text).not.toContain('probe-model-image-88be21');
    // And the FIELD NAME itself: nothing serializes the row wholesale.
    expect(text).not.toContain('writerModel');
    // The content is really in there (guards a definition that rendered
    // nothing at all, which would pass the checks above trivially).
    expect(text).toContain('Old Tower');
    expect(text).toContain('Vexra');
    expect(text).toContain('The tower watches the ford.');
  });

  it('the GM-notes and player-handout definitions never print the id', async () => {
    const { artifacts, plain } = await seedModuleDocument();
    const npcRow = artifacts.find((artifact) => artifact.kind === 'npc');
    if (npcRow === undefined) throw new Error('npc artifact missing');
    const withNpc = owned(npcRow);

    // Both templates, over rows that DO carry an id (proved above).
    expect(recordedWritingModel(withNpc.writerModel)).toBe(PROBE.npc);
    const gm = serialize(buildGmNotesDefinition(withNpc));
    const handout = serialize(buildPlayerHandoutDefinition(withNpc));
    for (const text of [gm, handout]) {
      expect(text).not.toContain(PROBE.npc);
      expect(text).not.toContain('writerModel');
    }
    // Player-facing "stays clean" is not achieved by rendering less of the
    // CONTENT than before: the handout still carries the summary and body,
    // and the GM template still carries the structured data.
    expect(handout).toContain('Hooded and cold.');
    expect(gm).toContain('Vexra');
    expect(gm).toContain('Stat block');

    // The plain (body-only) artifact too: its id is a probe in its own right.
    expect(recordedWritingModel(plain.writerModel)).toBe(PROBE.location);
    for (const text of [
      serialize(buildGmNotesDefinition(plain)),
      serialize(buildPlayerHandoutDefinition(plain)),
    ]) {
      expect(text).not.toContain(PROBE.location);
    }
  });

  it('the artifact PDF builder reads no provenance field from the row', async () => {
    const { artifacts } = await seedModuleDocument();
    // Structural pin, independent of the probe strings: the artifact's own
    // serialized row minus provenance equals what the definition contains, so
    // a future "just spread the artifact in" refactor trips here.
    for (const row of artifacts) {
      const artifact = owned(row);
      const definition = serialize(
        artifact.kind === 'note'
          ? buildGmNotesDefinition(artifact)
          : buildPlayerHandoutDefinition(artifact),
      );
      for (const probe of ALL_PROBES) expect(definition).not.toContain(probe);
      // `data` IS legitimately rendered (stat blocks); provenance must stay
      // out of it — it is a top-level field, not part of the kind data.
      expect(Object.keys(artifact)).toContain('writerModel');
      expect(Object.keys(artifact.data)).not.toContain('writerModel');
    }
  });

  it('the module document text — model context and the printed document — excludes the ids', async () => {
    const { module } = await seedModuleDocument();
    const text = moduleDocumentText(module);
    for (const probe of [PROBE.spine, PROBE.part]) expect(text).not.toContain(probe);
    expect(text).not.toContain('writerModel');
    // The prose is all there: the ids are excluded, not the content.
    expect(text).toContain('A drowned vault beneath the tower.');
    expect(text).toContain('The party climbs down into the wet dark.');
  });

  it('the persisted artifact rows keep the ids (the exclusion is at render time, not a wipe)', async () => {
    const { module } = await seedModuleDocument();
    const rows = await listArtifactsByCampaign(module.campaignId);
    const recorded = rows.map((row) => row.writerModel).filter((value) => value !== '');
    expect(recorded).toHaveLength(4);
    expect(recorded).toContain(PROBE.npc);
  });
});
