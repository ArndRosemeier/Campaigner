import 'fake-indexeddb/auto';

import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createModule as buildModule,
  encounterLayoutSchema,
  modulePartSchema,
  moduleSpineSchema,
  newId,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
  type Artifact,
  type AnyArtifact,
  type Id,
  type Module,
  type RuleChunk,
  type StatBlock,
} from '@/domain';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { patchBattle, ensureBattle } from '@/db/battleRepo';
import { putChunks } from '@/db/chunkRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { saveModule } from '@/db/moduleRepo';
import { createImage } from '@/db/imageRepo';
import { sha256Hex } from '@/lib/hash';
import {
  assertPdfmakeImageDataUrl,
  loadPdfImages,
  PdfImageError,
  PDF_COVER_MAX_LONG_EDGE,
  PDF_MAP_MAX_LONG_EDGE,
  type PdfImageCodec,
} from '@/lib/pdfImages';
import {
  buildModuleDefinition,
  buildModulePdf,
  buildModulePdfDocument,
  statBoxContent,
} from '@/lib/modulePdf';
import { generatePdfBlob } from '@/lib/pdfExport';
import { clearDatabase } from '../db/helpers';

/**
 * Module PDF renderer (07-MILESTONE-3 M3-D, rewritten for docs/17 row 108):
 * THE MODULE IS THE DOCUMENT. There is no deliverable and no outline any more,
 * so every test here is driven by a module row — its spine (premise + part
 * plan), its parts (through the ONE parts-document seam), and the artifacts
 * its prose OWNS or MENTIONS.
 *
 * The audience is an OPTION on one code path (`{ audience: 'player' }`), which
 * is what makes "GM and player cannot drift" checkable: the player document is
 * the same document minus the planning apparatus and the secrets.
 *
 * Gate holes this file exists to close (D-i, D-ii):
 * - a REAL PDF carrying a REAL image is rendered through `buildModulePdf` —
 *   jsdom has no canvas, so the pipeline's decode step is the injectable
 *   `PdfImageCodec` seam and the injected codec returns genuine PNG bytes;
 * - the FORMAT BOUNDARY is pinned: a data URL pdfmake cannot embed fails
 *   loudly instead of being handed over to throw mid-layout.
 */

/** A real 1×1 PNG — the smallest image pdfmake can genuinely embed. */
const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4z8AAAAMBAQD3A0FDAAAAAElFTkSuQmCC';

/** A WebP data URL: a legal browser image, and NOT one pdfmake can embed. */
const WEBP_DATA_URL = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA=';

/** The injectable codec: jsdom cannot decode or re-encode a real image. */
function fixedCodec(budget?: number[]): PdfImageCodec {
  return (_bytes, _mimeType, maxLongEdge) => {
    budget?.push(maxLongEdge);
    return Promise.resolve({ dataUrl: ONE_PIXEL_PNG, width: 1, height: 1 });
  };
}

function statBlockFixture(): Parameters<typeof statBoxContent>[0] {
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

/**
 * A LIBRARY creature's block as ingest parsed it — a PF2e-style statblock whose
 * REACTIONS, LEGENDARY actions and `extras` are all populated, because those are
 * exactly the sections the module PDF's box used to drop (docs/17 row 144).
 */
function citedStatBlockFixture(): StatBlock {
  return statBlockSchema.parse({
    ...statBlockFixture(),
    system: 'pathfinder2e',
    level: '4',
    size: 'Medium',
    creatureType: 'animal',
    ac: 18,
    acNote: '',
    hp: 44,
    hpFormula: '8d8',
    abilities: { str: 14, dex: 18, con: 12, int: 2, wis: 14, cha: 6 },
    senses: 'darkvision',
    traits: [{ name: 'Grasping Antennae', text: 'Reach 10 feet.' }],
    actions: [{ name: 'Mandible', text: 'Melee: +12 to hit, 2d8+4 piercing.' }],
    reactions: [{ name: 'Reactive Snap', text: 'Strike a creature that enters its reach.' }],
    legendary: [{ name: 'Skitter Away', text: 'Stride without provoking reactions.' }],
    extras: { Perception: '+11' },
  });
}

/** A statblock chunk as ingestion persists it (its own hash of its text). */
async function citedChunkRow(
  bookId: Id,
  over: { pageStart?: number; statBlock?: StatBlock | null } = {},
): Promise<RuleChunk> {
  const text = 'Cave Fisher';
  return ruleChunkSchema.parse({
    ...stampNewEntity(),
    bookId,
    pageStart: over.pageStart ?? 132,
    pageEnd: over.pageStart ?? 132,
    chunkType: 'statblock',
    headingPath: ['Cave Fisher'],
    text,
    statBlock: over.statBlock === undefined ? citedStatBlockFixture() : over.statBlock,
    contentHash: await sha256Hex(text),
  });
}

function owned(artifact: AnyArtifact): Artifact {
  if (artifact.campaignId === null) throw new Error('expected a campaign-owned row');
  return artifact;
}

/** The seed: a two-part module whose prose mentions every row below. */
interface Seed {
  module: Module;
  artifacts: AnyArtifact[];
  campaignId: Id;
  npcId: Id;
  encounterId: Id;
  gmNoteId: Id;
  mapImageId: Id;
  coverImageId: Id;
}

async function seed(): Promise<Seed> {
  const campaign = await createCampaign({ name: 'Module Campaign', system: 'dnd5e' });
  // REAL image rows: the loader reads the blob off the row, so an id with no
  // row would only ever exercise the "no stored image row" branch.
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
  });
  const event = await createArtifact({
    campaignId: campaign.id,
    kind: 'event',
    name: 'The Turning',
    body: 'The tide turns on the hour.',
    data: {
      locationType: 'ritual',
      inhabitants: '',
      pointsOfInterest: [],
      hooks: ['Someone must hold the rope.'],
    },
  });
  const npc = await createArtifact({
    campaignId: campaign.id,
    kind: 'npc',
    name: 'Vexra',
    body: 'Hooded and cold.',
    data: {
      appearance: 'Hooded',
      personality: 'Cold',
      statBlock: statBlockFixture(),
    },
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
          source: { type: 'inline', statBlock: statBlockFixture() },
        },
        {
          name: 'Vexra',
          count: 1,
          notes: '',
          treasure: '',
          source: { type: 'npc-ref', artifactId: npc.id },
        },
        {
          name: 'Harbour Thug',
          count: 2,
          notes: '',
          treasure: '',
          source: { type: 'none' },
        },
        {
          name: 'Cave Fisher',
          count: 1,
          notes: '',
          treasure: '',
          source: {
            type: 'rulebook',
            chunkId: newId(),
            contentHash: 'a'.repeat(64),
            creatureName: 'Cave Fisher',
          },
        },
      ],
      terrain: 'wet planks',
      tactics: 'surround and drag under',
      treasure: 'silver bell charm',
      mapImageId,
      // A generated LAYOUT rides the row (validated through its own schema —
      // the fixture must be a row the app could really store): it is NOT a map
      // image, and no schematic geometry may ever be drawn in place of one.
      layout: encounterLayoutSchema.parse({
        gridW: 12,
        gridH: 12,
        theme: 'cave',
        rooms: [
          {
            id: newId(),
            name: 'Schematic Room',
            rects: [{ x: 0, y: 0, w: 6, h: 6 }],
            mobsRect: { x: 1, y: 1, w: 2, h: 2 },
            description: 'never printed',
            monsterIndexes: [],
            spawn: true,
          },
        ],
        corridors: [],
      }),
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    },
    links: [{ targetId: location.id, relation: 'at' }],
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
  const gmNote = await createArtifact({
    campaignId: campaign.id,
    kind: 'note',
    name: 'GM cheat sheet',
    body: 'Remember the bell.',
    tags: ['gm-only'],
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

  const module = await saveModule({
    ...buildModule({
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
        'and the [[GM cheat sheet]] holds the bell. [[The Tide Wardens]] watch, and ' +
        '[[The Drowned Crown]] is what they are really guarding.',
      themes: [],
      partPlan: [
        { title: 'The Dockyards', levelBand: '1-2', synopsis: 'Meet the wardens.', levelUpTrigger: 'The bell rings.' },
        { title: 'The Vault', levelBand: '3', synopsis: 'Break the crown.', levelUpTrigger: 'The tide falls.' },
      ],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: 'The party rows out at dusk. [[The Turning]] comes with the tide.',
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
      modulePartSchema.parse({
        planIndex: 1,
        markdown: 'Below the waterline the vault opens.',
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
    coverImageId,
  });

  return {
    module,
    artifacts: [location, event, npc, encounter, plotarc, gmNote, faction],
    campaignId: campaign.id,
    npcId: npc.id,
    encounterId: encounter.id,
    gmNoteId: gmNote.id,
    mapImageId,
    coverImageId,
  };
}

function textOf(definition: unknown): string {
  return JSON.stringify(definition);
}

describe('buildModuleDefinition — the module IS the document', () => {
  beforeEach(clearDatabase);

  it('prints cover, ToC, premise, part plan, parts, kind chapters and back matter (GM)', async () => {
    const seeded = await seed();
    const definition = buildModuleDefinition({
      module: seeded.module,
      artifacts: seeded.artifacts,
    });
    const text = textOf(definition);

    // Cover.
    expect(text).toContain('Beneath the Docks');
    expect(text).toContain('A module for levels 1–3');
    expect(text).toContain('Compiled with Campaigner');
    // …and the date in that line is the REAL compile day, taken from the clock
    // (docs/17 row 154). This is the pin that keeps the layout differential's
    // pinned `compiledAt` (tests/lib/pdfLayout.test.ts) honest: that file fixes
    // the clock so it cannot flake at midnight, so a renderer that started
    // printing a CONSTANT date would otherwise pass everywhere. The clock is
    // moved to a day that is not today, and the build is synchronous, so no
    // other work of this test runs under it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2031-02-03T12:00:00.000Z'));
    try {
      const pinned = buildModuleDefinition({
        module: seeded.module,
        artifacts: seeded.artifacts,
      });
      expect(textOf(pinned)).toContain('Compiled with Campaigner · 2031-02-03');
    } finally {
      vi.useRealTimers();
    }
    // Table of contents.
    expect(text).toContain('"id":"chapters"');
    // Premise + the parts, in plan order, each with its position kicker.
    expect(text).toContain('Premise');
    expect(text).toContain('A drowned vault beneath the');
    expect(text).toContain('PART 1 OF 2 · LEVELS 1-2');
    expect(text).toContain('PART 2 OF 2 · LEVELS 3');
    expect(text.indexOf('The party rows out at dusk')).toBeLessThan(
      text.indexOf('Below the waterline'),
    );
    // The GM-only planning apparatus.
    expect(text).toContain('Part plan');
    expect(text).toContain('Break the crown.');
    // Per-kind chapters and both back-matter appendices.
    expect(text).toContain('Locations');
    expect(text).toContain('Encounters');
    expect(text).toContain('NPC Gallery');
    expect(text).toContain('TREASURE LEDGER');
    expect(text).toContain('silver bell charm');
  });

  it('never prints the parts-document SCAFFOLDING (separators or part labels)', async () => {
    const seeded = await seed();
    const text = textOf(
      buildModuleDefinition({ module: seeded.module, artifacts: seeded.artifacts }),
    );

    // NON-VACUITY: the part text really is in the document…
    expect(text).toContain('The party rows out at dusk.');
    expect(text).toContain('Below the waterline the vault opens.');
    // …and the seam's own characters are nowhere. The kicker above prints
    // "PART 1 OF 2" WITHOUT brackets; the scaffold label is bracketed.
    expect(text).not.toContain('==========');
    expect(text).not.toContain('[Part 1 of');
    expect(text).not.toContain('[part 1 of');
    expect(text).not.toContain('[Part 2 of');
  });

  it('renders the location/event structured data the audit found dropped (C4)', async () => {
    const seeded = await seed();
    const text = textOf(
      buildModuleDefinition({ module: seeded.module, artifacts: seeded.artifacts }),
    );

    expect(text).toContain('Type');
    expect(text).toContain('ruin');
    expect(text).toContain('Inhabitants');
    expect(text).toContain('gulls and one ghost');
    expect(text).toContain('The Bell');
    expect(text).toContain('Cracked, and warm.');
    expect(text).toContain('Hook: ');
    expect(text).toContain('The bell rings at midnight.');
    // The EVENT carries the same fields (one code path, both kinds).
    expect(text).toContain('ritual');
    expect(text).toContain('Someone must hold the rope.');
  });

  it('states each roster origin through the ONE rule (C5)', async () => {
    const seeded = await seed();
    const text = textOf(
      buildModuleDefinition({
        module: seeded.module,
        artifacts: seeded.artifacts,
        rosterResolution: {
          [seeded.encounterId]: [
            { statBlock: null, origin: 'inline' },
            // An `npc-ref`: its row is a real artifact, so the reference is a
            // cross-reference — no library resolution is involved.
            { statBlock: null, origin: 'Vexra' },
            // Nothing satisfies it: the NAMED missing-ref reason.
            { statBlock: null, origin: 'missing ref (Harbour Thug)' },
            // A cited library creature: the REAL origin of its numbers…
            { statBlock: citedStatBlockFixture(), origin: 'Monster Core: Cave Fisher' },
          ],
        },
      }),
    );

    // `npc-ref` CROSS-REFERENCES the row it names (the run is split into
    // runs, so the link target is the pin, not a substring).
    expect(text).toContain('— see ');
    expect(text).toContain(`"linkToDestination":"node-${seeded.npcId}"`);
    // The cited entry prints the origin it RESOLVED — the book and page the
    // numbers come from (docs/17 row 144)…
    expect(text).toContain('Monster Core: Cave Fisher');
    // …and NOT the dead constant this used to print, which pointed at a
    // bestiary chapter the module PDF has never had.
    expect(text).not.toContain('see Bestiary');
    // A citation nothing can satisfy prints its reason, which NAMES the
    // creature (so an exact-stem comparison could never match it).
    expect(text).toContain('missing ref (Harbour Thug)');
    // An INLINE entry carries its own stat box: it gets no origin run at all
    // (never a "no stats" line contradicting the stat block beneath it).
    expect(text).toContain('"text":"Cultist ×4"');
    expect(text).not.toContain('Cultist ×4 — no stats');
  });

  /**
   * The owner's decision 3 (docs/17 row 144, verbatim: *"Print the numbers for
   * cited mobs too."*): a `rulebook`-cited roster row prints the LIBRARY
   * CHUNK'S OWN numbers, in the same box an `inline` entry uses, with the
   * resolved origin printed ON the box so the book says where they came from.
   *
   * Revert-proof: print no box for a non-`inline` source (the pre-142 builder)
   * and this reads no `Cave Fisher ×1` box, no `Grasping Antennae`, no
   * `Reactive Snap`, no `Numbers from …`.
   */
  it('prints a cited mob’s OWN numbers, with the source on the box (owner decision 3)', async () => {
    const seeded = await seed();
    const text = textOf(
      buildModuleDefinition({
        module: seeded.module,
        artifacts: seeded.artifacts,
        rosterResolution: {
          [seeded.encounterId]: [
            { statBlock: null, origin: 'inline' },
            { statBlock: null, origin: 'Vexra' },
            { statBlock: null, origin: 'missing ref (Harbour Thug)' },
            { statBlock: citedStatBlockFixture(), origin: 'Monster Core: Cave Fisher' },
          ],
        },
      }),
    );

    // The chunk's numbers really are in the book: not a pointer, not a stub.
    expect(text).toContain('Cave Fisher ×1');
    expect(text).toContain('"AC "');
    expect(text).toContain('"18"');
    expect(text).toContain('"44 (8d8)"');
    // INCLUDING the sections a PF2e-style block is unusable without.
    expect(text).toContain('Grasping Antennae');
    expect(text).toContain('Reactive Snap');
    expect(text).toContain('Skitter Away');
    expect(text).toContain('"Perception: "');
    expect(text).toContain('"+11"');
    // The box NAMES its source (the resolved origin, on the box itself).
    expect(text).toContain('Numbers from Monster Core: Cave Fisher');
  });

  /**
   * A citation the library cannot supply prints its NAMED reason and NO box.
   * `chunk.statBlock` is legitimately `null` (best-effort ingest parse), so the
   * `null` a resolution returns here is a real state, not a test artefact — and
   * an EMPTY or placeholder box standing in for the numbers would be exactly
   * the silent fallback AGENTS rule 1 forbids.
   */
  it('prints NO box for a citation whose chunk carries no parseable block', async () => {
    const seeded = await seed();
    const text = textOf(
      buildModuleDefinition({
        module: seeded.module,
        artifacts: seeded.artifacts,
        rosterResolution: {
          [seeded.encounterId]: [
            { statBlock: null, origin: 'inline' },
            { statBlock: null, origin: 'Vexra' },
            { statBlock: null, origin: 'missing ref (Harbour Thug)' },
            // The library HAS the chunk; its ingest parsed no stat block.
            { statBlock: null, origin: 'missing ref (Cave Fisher)' },
          ],
        },
      }),
    );

    expect(text).toContain('missing ref (Cave Fisher)');
    // No box, no heading, no placeholder: the row prints its reason and stops.
    expect(text).not.toContain('Cave Fisher ×1');
    expect(text).not.toContain('Numbers from');
    expect(text).not.toContain('unresolved citation');
  });

  /**
   * The pre-pass really is what reaches the renderer: `buildModulePdf` resolves
   * every encounter roster itself, and a cited creature resolves to the chunk's
   * own block through the ONE resolution order — so the module book prints
   * numbers for a citation with nobody handing it a resolution.
   */
  it('resolves a cited roster row itself, end to end through buildModulePdf', async () => {
    const seeded = await seed();
    const rulebook = await createRulebook({
      title: 'Bestiary',
      system: 'pathfinder2e',
      filename: 'bestiary.pdf',
    });
    const chunk = await citedChunkRow(rulebook.id);
    await putChunks([chunk]);
    const withCitation = seeded.artifacts.map((artifact) =>
      artifact.id === seeded.encounterId && artifact.kind === 'encounter'
        ? {
            ...artifact,
            data: {
              ...artifact.data,
              monsters: artifact.data.monsters.map((monster) =>
                monster.name === 'Cave Fisher'
                  ? {
                      ...monster,
                      source: {
                        type: 'rulebook' as const,
                        chunkId: chunk.id,
                        contentHash: chunk.contentHash,
                        creatureName: 'Cave Fisher',
                      },
                    }
                  : monster,
              ),
            },
          }
        : artifact,
    );

    let definition: TDocumentDefinitions | undefined;
    await buildModulePdf(seeded.module, withCitation, (built) => {
      // The generator is the only place the finished definition is visible, so
      // the pin reads the REAL document `buildModulePdf` produced.
      definition = built;
      return Promise.resolve(new Blob(['pdf']));
    });
    if (definition === undefined) throw new Error('the generator was never called');
    const text = textOf(definition);

    expect(text).toContain(`Bestiary p.${chunk.pageStart}`);
    expect(text).not.toContain('see Bestiary');
    expect(text).toContain('Reactive Snap');
    expect(text).toContain('Skitter Away');
    expect(text).toContain('"Perception: "');
    expect(text).toContain('"+11"');
    expect(text).toContain(`Numbers from Bestiary p.${chunk.pageStart}`);
  });

  it('a roster entry with no citation and no resolution says what is true about it', async () => {
    const seeded = await seed();
    // No `rosterOrigins` (the resolution pre-pass did not run): the name-only
    // entry must still not read as "the app lost the stats".
    const text = textOf(
      buildModuleDefinition({ module: seeded.module, artifacts: seeded.artifacts }),
    );
    expect(text).toContain('Harbour Thug');
    expect(text).toContain('no stats: this roster entry names the creature without a citation');
  });

  it('a dangling internal reference is loud, never dropped', async () => {
    const seeded = await seed();
    const ghost = newId();
    const text = textOf(buildModuleDefinition({ module: seeded.module, artifacts: seeded.artifacts }));
    expect(text).not.toContain('missing artifact');

    const withGhostLink: AnyArtifact[] = seeded.artifacts.map((artifact) =>
      artifact.id === seeded.encounterId
        ? { ...artifact, links: [...artifact.links, { targetId: ghost, relation: 'guarded by' }] }
        : artifact,
    );
    const ghostText = textOf(
      buildModuleDefinition({ module: seeded.module, artifacts: withGhostLink }),
    );
    expect(ghostText).toContain('see missing ref (guarded by)');
  });

  it('gives the player the same document minus the planning and the secrets', async () => {
    const seeded = await seed();
    const gm = textOf(
      buildModuleDefinition({ module: seeded.module, artifacts: seeded.artifacts, audience: 'gm' }),
    );
    const player = textOf(
      buildModuleDefinition({
        module: seeded.module,
        artifacts: seeded.artifacts,
        audience: 'player',
      }),
    );

    // Stripped: the part plan, the encounter's GM material, the GM-only note,
    // the plot arc (the module's plan) and the treasure ledger.
    expect(gm).toContain('Part plan');
    expect(player).not.toContain('Part plan');
    expect(player).not.toContain('surround and drag under');
    expect(player).not.toContain('Tactics:');
    expect(player).not.toContain('Terrain:');
    expect(player).not.toContain('Remember the bell.');
    expect(player).not.toContain('"id":"node-notes"');
    expect(player).not.toContain('Plot arcs');
    expect(player).not.toContain('"id":"node-plotarcs"');
    expect(player).not.toContain('The crown wants the tide.');
    expect(player).not.toContain('TREASURE LEDGER');
    // …and the faction's METHODS (its private half) goes with them.
    expect(gm).toContain('Bribes and drowned witnesses.');
    expect(player).not.toContain('Bribes and drowned witnesses.');

    // Kept: the premise, the parts' prose, the public structured data.
    for (const shared of [
      'Premise',
      'A drowned vault beneath the',
      'The party rows out at dusk.',
      'Below the waterline the vault opens.',
      'The tower watches the ford.',
      'Appearance:',
      'Hooded',
      'The tide waits for no one.',
      'gulls and one ghost',
      'Keep the bell dry.',
    ]) {
      expect(gm).toContain(shared);
      expect(player).toContain(shared);
    }
    // The player document is genuinely smaller — the strips are real.
    expect(player.length).toBeLessThan(gm.length);
  });

  it('prints a plot arc for the GM (the audit found it in the PLAYER document)', async () => {
    const seeded = await seed();
    const gm = textOf(buildModuleDefinition({ module: seeded.module, artifacts: seeded.artifacts }));
    expect(gm).toContain('Plot arcs');
    expect(gm).toContain('The crown wants the tide.');
    expect(gm).toContain('The crown is broken on the pier.');
  });

  it('reports a module with no spine loudly instead of printing an empty book', async () => {
    const campaign = await createCampaign({ name: 'Spine-less', system: 'dnd5e' });
    const module = await saveModule(
      buildModule({
        campaignId: campaign.id,
        title: 'Unwritten Vault',
        concept: '',
        levelMin: 1,
        levelMax: 1,
        sizeDial: 'sketch',
      }),
    );
    const { definition, problems } = buildModulePdfDocument({ module, artifacts: [] });

    // The premise and the parts both say so, in the document AND in the report.
    expect(textOf(definition)).toContain('The premise is missing');
    expect(problems.map((problem) => problem.where)).toContain('the premise of the module');
    expect(textOf(definition)).not.toContain('==========');
  });
});

describe('the encounter map plate (owner: maps belong in the PDF, at the right place)', () => {
  beforeEach(clearDatabase);

  it('places the map at the encounter, at the encounter’s own slot', async () => {
    const seeded = await seed();
    const text = textOf(
      buildModuleDefinition({
        module: seeded.module,
        artifacts: seeded.artifacts,
        images: { dataUrls: { [seeded.mapImageId]: ONE_PIXEL_PNG }, failures: [] },
      }),
    );

    expect(text).toContain(ONE_PIXEL_PNG.slice(0, 40));
    // The plate is sized for print (content width × the plate's max height).
    // UPDATED by docs/17 row 148: the content width is docs/19 §3's own
    // geometry (A4 minus 20 mm margins) and is owned by `lib/pdfPageModel`, so
    // it was 515 while the page kept pdfmake's default 40 pt margins and is
    // 481.9 under the spec's page.
    expect(text).toContain('"fit":[481.9,660]');
    // It sits at the ENCOUNTER (its owner wanted the right place), not on the
    // cover or in an appendix: the image node's position follows the
    // encounter's name in the document text.
    expect(text.indexOf('Pier Ambush')).toBeLessThan(text.indexOf(ONE_PIXEL_PNG.slice(0, 40)));
  });

  it('prints NO plate when the encounter has no map — and never a schematic', async () => {
    const seeded = await seed();
    // The fixture's encounter carries a generated `layout` (rooms/rects) and a
    // mapImageId; drop ONLY the image id, so the layout is the only thing left
    // that could be drawn.
    const mapless: AnyArtifact[] = seeded.artifacts.map((artifact) =>
      artifact.id === seeded.encounterId && artifact.kind === 'encounter'
        ? { ...artifact, data: { ...artifact.data, mapImageId: null } }
        : artifact,
    );
    const text = textOf(buildModuleDefinition({ module: seeded.module, artifacts: mapless }));

    // No image at all in the document…
    expect(text).not.toContain('"image"');
    expect(text).not.toContain(ONE_PIXEL_PNG.slice(0, 40));
    // …and the geometry on the row never becomes one: no schematic fallback.
    expect(text).not.toContain('Schematic Room');
    expect(text).not.toContain('never printed');
    expect(text).not.toContain('"rects"');
    // The encounter itself still prints (the plate is the only thing missing).
    expect(text).toContain('Pier Ambush');
  });

  it('falls back to the battle board’s map when the encounter row has none', async () => {
    const seeded = await seed();
    const boardMap = newId();
    const mapless: AnyArtifact[] = seeded.artifacts.map((artifact) =>
      artifact.id === seeded.encounterId && artifact.kind === 'encounter'
        ? { ...artifact, data: { ...artifact.data, mapImageId: null } }
        : artifact,
    );
    // A LIVE battle on the module: the board's own map is the encounter's map
    // once the table has been seeded (the encounter ROW keeps its own slot).
    const battle = await ensureBattle(seeded.campaignId, seeded.module.id);
    await patchBattle(battle.id, {
      encounterArtifactId: seeded.encounterId,
      board: { ...battle.board, mapImageId: boardMap },
    });

    const { definition } = buildModulePdfDocument({
      module: seeded.module,
      artifacts: mapless,
      battles: [await refreshBattle(battle.id)],
      images: { dataUrls: { [boardMap]: ONE_PIXEL_PNG }, failures: [] },
    });
    expect(textOf(definition)).toContain(ONE_PIXEL_PNG.slice(0, 40));
  });

  it('preloads maps at print resolution and covers at the cover budget (C2)', async () => {
    const seeded = await seed();
    const budgets: number[] = [];
    const { blob, problems } = await buildModulePdf(
      seeded.module,
      seeded.artifacts,
      (definition) => generatePdfBlob(definition),
      { codec: fixedCodec(budgets) },
    );
    expect(problems).toEqual([]);

    // One map (4096) + the module cover (1024): the map's budget is a REAL
    // request, not a comment — the intake cap is what makes a plate printable.
    expect(budgets).toContain(PDF_MAP_MAX_LONG_EDGE);
    expect(budgets).toContain(PDF_COVER_MAX_LONG_EDGE);
    expect(blob.size).toBeGreaterThan(1000);
  });

  it('renders a REAL PDF that really carries the image (gate hole D-i)', async () => {
    const seeded = await seed();
    /*
     * The metadata is STRIPPED so the ONLY image this document can carry is the
     * encounter's MAP: with a cover present, a `/Subtype /Image` assertion
     * would pass on the cover alone and prove nothing about the map (measured:
     * injecting the map plate away left a cover-image assertion green — a pin
     * that could not fail).
     */
    const noCover = { ...seeded.module, coverImageId: null };
    const mapless: AnyArtifact[] = seeded.artifacts.map((artifact) =>
      artifact.id === seeded.encounterId && artifact.kind === 'encounter'
        ? { ...artifact, data: { ...artifact.data, mapImageId: null } }
        : artifact,
    );
    const withMap = await buildModulePdf(
      noCover,
      seeded.artifacts,
      (definition) => generatePdfBlob(definition),
      { codec: fixedCodec() },
    );
    const withoutMap = await buildModulePdf(noCover, mapless, (definition) =>
      generatePdfBlob(definition),
    );

    const bytes = new TextDecoder('latin1').decode(await withMap.blob.arrayBuffer());
    expect(withMap.problems).toEqual([]);
    // An embedded image is an XObject of subtype /Image in the PDF stream — and
    // with no cover there is exactly ONE, so it is the map plate.
    expect((bytes.match(/\/Subtype \/Image/g) ?? []).length).toBe(1);
    const bare = new TextDecoder('latin1').decode(await withoutMap.blob.arrayBuffer());
    expect(bare).not.toContain('/Subtype /Image');
    // The blob is a real PDF (magic number), not an empty placeholder.
    expect(bytes.startsWith('%PDF-')).toBe(true);
  });

  it('a map that cannot be embedded is LOUD — placeholder + reported problem, export still lands (C3)', async () => {
    const seeded = await seed();
    const failing: PdfImageCodec = () => Promise.reject(new Error('decode failed: bad bytes'));

    const { blob, problems } = await buildModulePdf(
      seeded.module,
      seeded.artifacts,
      (definition) => generatePdfBlob(definition),
      { codec: failing },
    );

    // The export still produces a document (never a whole-export failure)…
    expect(blob.size).toBeGreaterThan(1000);
    // …the failure is NAMED at its site…
    const mapProblem = problems.find((problem) => problem.where.includes('the map of'));
    expect(mapProblem?.where).toBe('the map of “Pier Ambush”');
    expect(mapProblem?.reason).toContain('decode failed');
    // …and the owner sees it IN the document too, not only in a toast.
    const text = new TextDecoder('latin1').decode(await blob.arrayBuffer());
    expect(text).not.toContain('/Subtype /Image');
  });

  it('shows the loud placeholder in the definition for a map that could not load', async () => {
    const seeded = await seed();
    const { definition, problems } = buildModulePdfDocument({
      module: seeded.module,
      artifacts: seeded.artifacts,
      images: {
        // The cover loaded, the map did not: one broken image must not cost
        // the document its other art.
        dataUrls: { [seeded.coverImageId]: ONE_PIXEL_PNG },
        failures: [
          {
            id: seeded.mapImageId,
            where: 'the map of “Pier Ambush”',
            reason: 'decode failed: bad bytes',
          },
        ],
      },
    });
    const text = textOf(definition);
    expect(text).toContain('could not be embedded');
    expect(text).toContain('decode failed: bad bytes');
    expect(text).toContain(ONE_PIXEL_PNG.slice(0, 40));
    expect(problems).toEqual([
      { where: 'the map of “Pier Ambush”', reason: 'decode failed: bad bytes' },
    ]);
  });
});

describe('the pdfmake format boundary (gate hole D-ii)', () => {
  beforeEach(clearDatabase);

  it('refuses a data URL pdfmake cannot embed, by name', () => {
    expect(() => assertPdfmakeImageDataUrl(WEBP_DATA_URL, 'the map of “Pier Ambush”')).toThrow(
      PdfImageError,
    );
    expect(() => assertPdfmakeImageDataUrl(WEBP_DATA_URL, 'the map of “Pier Ambush”')).toThrow(
      /the map of “Pier Ambush”/,
    );
    // PNG/JPEG pass — the two media types pdfmake registers.
    expect(() => assertPdfmakeImageDataUrl(ONE_PIXEL_PNG, 'x')).not.toThrow();
    expect(() => assertPdfmakeImageDataUrl('data:image/jpeg;base64,AAAA', 'x')).not.toThrow();
    // A string that is not a data URL at all is the OTHER refusal mode, and it
    // is refused too (the renderer only calls this with a loaded URL, so this
    // documents the contract rather than a reachable path).
    expect(() => assertPdfmakeImageDataUrl('image/png;base64,AAAA', 'x')).toThrow(/no media type/);
  });

  it('records a WebP as a FAILURE instead of handing it to pdfmake', async () => {
    // A legal PNG row (the intake door would never store a webp): the codec is
    // what produces the unsupported data URL, so the guard has to re-check the
    // codec's OUTPUT rather than trust the stored mime type.
    const row = await createImage({
      campaignId: null,
      blob: new Blob(['png-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 8,
      height: 8,
      source: 'uploaded',
    });
    const images = await loadPdfImages(
      [{ id: row.id, maxLongEdge: PDF_MAP_MAX_LONG_EDGE, where: 'the map of “Wet Pier”' }],
      { codec: () => Promise.resolve({ dataUrl: WEBP_DATA_URL, width: 8, height: 8 }) },
    );
    expect(images.dataUrls).toEqual({});
    expect(images.failures).toHaveLength(1);
    expect(images.failures[0]?.where).toBe('the map of “Wet Pier”');
    expect(images.failures[0]?.reason).toContain('image/webp');
    expect(images.failures[0]?.reason).toContain('re-encoded');
  });

  it('proves the guard is load-bearing: pdfmake itself throws on a WebP image node', async () => {
    // The assertion above is only worth having if the thing it prevents is
    // real. Hand pdfmake the WebP node directly, bypassing the guard.
    await expect(
      generatePdfBlob({ content: [{ image: WEBP_DATA_URL, fit: [100, 100] }] }),
    ).rejects.toThrow();
  });
});

describe('statBoxContent', () => {
  it('renders a bordered two-column stat box', () => {
    const box = statBoxContent(statBlockFixture(), 'Cultist');
    const text = textOf(box);
    expect(text).toContain('Cultist');
    expect(text).toContain('DEX 12');
    expect(text).toContain('Melee: +3 to hit');
    const widths = (box as { table?: { widths?: string[] } }).table?.widths;
    expect(widths).toEqual(['*', '*']);
  });

  /**
   * The module PDF's compact stat box obeys the same per-system rule as the
   * screen (docs/12 §5, docs/17 row 95): a Pathfinder 2e box prints the signed
   * BONUS, never the stored d20 score — a d20 box is unchanged (the test above
   * still reads `DEX 12`).
   *
   * Revert-proof: print the score for every system (the pre-row-95 builder) and
   * this reads `STR 14 DEX 18` instead of `STR +2 DEX +4`.
   */
  it('prints bonuses only in a Pathfinder 2e stat box', () => {
    const pf2e = statBoxContent(
      {
        ...statBlockFixture(),
        system: 'pathfinder2e',
        // The real Monster Core Wolf: Str +2, Dex +4.
        abilities: { str: 14, dex: 18, con: 12, int: 2, wis: 14, cha: 6 },
      },
      'Wolf',
    );
    const pf2eText = textOf(pf2e);
    expect(pf2eText).toContain('STR +2');
    expect(pf2eText).toContain('DEX +4');
    expect(pf2eText).not.toContain('STR 14');
    expect(pf2eText).not.toContain('DEX 18');
  });
});

/** The battle row as `patchBattle` left it (parse-on-read, repo boundary). */
async function refreshBattle(id: Id) {
  const { getBattle } = await import('@/db/battleRepo');
  const row = await getBattle(id);
  if (row === undefined) throw new Error('battle missing');
  return row;
}

void owned;
