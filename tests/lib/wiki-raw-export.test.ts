import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createDeliverable } from '@/db/deliverableRepo';
import { saveModule } from '@/db/moduleRepo';
import {
  createModule,
  fullInclude,
  moduleDocumentText,
  modulePartSchema,
  moduleSpineSchema,
  type Artifact,
  type AnyArtifact,
  type Deliverable,
  type Module,
  type OutlineNode,
} from '@/domain';
import { buildModuleDefinition } from '@/lib/modulePdf';
import { buildGmNotesDefinition, buildPlayerHandoutDefinition } from '@/lib/pdfExport';
import { clearDatabase } from '../db/helpers';

/**
 * The raw-token tooltip is an APP-ONLY affordance (docs/17 row 100). The token
 * it carries is minted at React render time by `WikiMarkdown`
 * (`data-wiki-raw`, off the mdast node's `data.hProperties`) and is NEVER
 * written to a row, so no export can reach it — this file pins that, and
 * records the one place the export path does emit literal `[[…]]` (pre-existing
 * and deliberately NOT changed here: the brief for this arc requires export
 * output to stay byte-identical).
 *
 * Two different export pipelines exist and they behave differently:
 *
 * - `buildModuleDefinition` (deliverables, module PDF) renders markdown through
 *   `lib/mdToPdfmake`, which IS wiki-aware — a token becomes its bold DISPLAY
 *   text and no brackets survive.
 * - `buildGmNotesDefinition` / `buildPlayerHandoutDefinition` (single-artifact
 *   export) render the body through `lib/markdown.markdownToText`, which is a
 *   plain markdown-syntax stripper and NOT wiki-aware — so the token reaches
 *   the PDF VERBATIM. That is TRUE AT `origin/main` BEFORE this arc (measured:
 *   `git show origin/main:src/lib/pdfExport.ts` line 278/300 and
 *   `src/lib/markdown.ts` has no wiki handling at all), it is reported rather
 *   than fixed, and the pin below records it so it is a known state and not an
 *   unnoticed one.
 */

const PADDED_TOKEN = '[[ Ash Gate |the gate]]';
const PLAIN_TOKEN = '[[Kael]]';

/** Library rows are out of PDF context unless explicitly named; narrow
 * loudly rather than casting. */
function owned(artifact: AnyArtifact): Artifact {
  if (artifact.campaignId === null) throw new Error('expected a campaign-owned artifact row');
  return artifact;
}

async function seed(): Promise<{
  deliverable: Deliverable;
  module: Module;
  gate: Artifact;
}> {
  const campaign = await createCampaign({ name: 'Export Campaign', system: 'dnd5e' });
  const gate = owned(
    await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Ash Gate',
      body: `He guards ${PADDED_TOKEN} and answers to ${PLAIN_TOKEN}.`,
    }),
  );

  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Vault',
    concept: 'A flooded vault.',
    levelMin: 1,
    levelMax: 3,
    sizeDial: 'standard',
  });
  const module = await saveModule({
    ...draft,
    spine: moduleSpineSchema.parse({
      premise: `The premise names ${PLAIN_TOKEN} outright.`,
      themes: [],
      partPlan: [{ title: 'The Gate', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: `The party bargains with ${PADDED_TOKEN} at dusk.`,
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });

  const outline: OutlineNode[] = [
    {
      type: 'chapter',
      title: 'Act I',
      children: [
        { type: 'part', title: 'The Dockyards', children: [] },
        // The module's own document text, exactly as a deliverable carries it.
        { type: 'text', markdown: moduleDocumentText(module) },
        { type: 'artifact', artifactId: gate.id, include: fullInclude() },
      ],
    },
  ];
  const deliverable = await createDeliverable({
    campaignId: campaign.id,
    title: 'Beneath the Docks',
    subtitle: 'An urban crawl',
    audience: 'gm',
    coverImageId: null,
    outline,
  });

  return { deliverable, module, gate };
}

beforeEach(async () => {
  await clearDatabase();
});

describe('the raw-token carrier has no route into an export', () => {
  it('the module/deliverable definition carries no token syntax and no carrier attribute', async () => {
    const { deliverable, module, gate } = await seed();

    // NON-VACUITY: the tokens really are in the source rows, so a clean export
    // is a real exclusion rather than an empty fixture.
    expect(gate.body).toContain(PADDED_TOKEN);
    expect(moduleDocumentText(module)).toContain(PADDED_TOKEN);
    expect(moduleDocumentText(module)).toContain(PLAIN_TOKEN);

    const definition = JSON.stringify(buildModuleDefinition(deliverable, [gate]));

    // NON-VACUITY: the CONTENT flowed through — the link's display text is in
    // the document — so the negative below is about the SYNTAX, not about the
    // body having been dropped.
    expect(definition).toContain('the gate');
    // The module pipeline is wiki-aware (`mdToPdfmake`): no brackets survive…
    expect(definition).not.toContain('[[');
    expect(definition).not.toContain(']]');
    // …and the app-only carrier attribute is nowhere.
    expect(definition).not.toContain('data-wiki-raw');
  });

  it('has no route at all: the export modules never import the chip renderer', () => {
    // Structural, so a future refactor that wires `WikiMarkdown` (or the
    // remark plugin) into an export fails HERE rather than silently shipping
    // the carrier — or a rendered chip — into a PDF.
    const exportModules = ['src/lib/modulePdf.ts', 'src/lib/pdfExport.ts', 'src/lib/mdToPdfmake.ts'];
    for (const relative of exportModules) {
      const source = readFileSync(resolve(import.meta.dirname, '..', '..', relative), 'utf8');
      expect(source).not.toContain('wiki-markdown');
      expect(source).not.toContain('remark-wikilinks');
      expect(source).not.toContain('data-wiki-raw');
      expect(source).not.toContain('WIKI_RAW_ATTRIBUTE');
    }
  });

  it('RECORDED FINDING (pre-existing, not this arc): the single-artifact export prints the token verbatim', async () => {
    const { gate } = await seed();

    // The body reaches these two definitions through `markdownToText`, which
    // strips markdown syntax but knows nothing about `[[…]]` — so a GM who
    // exports this NPC gets the raw token in the PDF. Measured at
    // `origin/main` BEFORE this arc: export output is byte-identical (this arc
    // changes no export module — see the structural pin above), and
    // `src/lib/wikilinks.stripWikiLinks` has NO production consumer.
    //
    // Reported, not fixed: the brief for THIS arc requires export output to
    // stay unchanged, and the cure belongs to the export path (its own arc).
    for (const definition of [
      JSON.stringify(buildGmNotesDefinition(gate)),
      JSON.stringify(buildPlayerHandoutDefinition(gate)),
    ]) {
      expect(definition).toContain(PADDED_TOKEN);
      // The marker that proves THIS arc's carrier did not leak in is the
      // absent attribute, which is asserted for both definitions.
      expect(definition).not.toContain('data-wiki-raw');
    }
  });
});
