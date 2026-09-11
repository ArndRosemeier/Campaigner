import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { TDocumentDefinitions } from 'pdfmake/interfaces';

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
import { markdownToDisplayText } from '@/lib/markdown';
import { buildModuleDefinition } from '@/lib/modulePdf';
import { buildGmNotesDefinition, buildPlayerHandoutDefinition } from '@/lib/pdfExport';
import { clearDatabase } from '../db/helpers';

/**
 * A PDF is a RENDERING, so an export prints a wiki token's DISPLAY text and
 * never the token itself. The token (`[[Name]]` / `[[Name|display]]`) is the
 * app's INTERNAL representation (owner's standing rule, docs/17 row 105), and
 * one that reaches a reader has leaked that internal.
 *
 * The single-artifact export printed it VERBATIM until row 105. That defect was
 * found and recorded by row 100's arc (docs/18 §4), and THIS FILE is where it
 * was pinned AS the defect. That pin is rewritten, not deleted: the history
 * lives in the ledger, and every assertion below is the fixed behaviour.
 *
 * Two pipelines, one rule, and this file pins them TOGETHER:
 *
 * - `buildModuleDefinition` (deliverables, module PDF) renders markdown through
 *   `lib/mdToPdfmake`, which has been wiki-aware since it existed — a token
 *   becomes its bold DISPLAY text and no brackets survive. UNCHANGED by row 105.
 * - `buildGmNotesDefinition` / `buildPlayerHandoutDefinition` (single-artifact
 *   export) render the body through `lib/markdown.markdownToDisplayText`:
 *   `markdownToText` plus `lib/wikilinks.stripWikiLinks`, the ONE wiki-strip
 *   implementation — so they render the display too.
 *
 * The carrier the chip renderer mints at React render time (`data-wiki-raw`,
 * docs/17 row 100) is still unreachable from every export, and the source scans
 * below keep it that way.
 */

/** The token from the defect report: a display that differs from the name. */
const DISPLAY_TOKEN = '[[Encounter:Ash Gate|the gate]]';
/** The same token with inner padding — the parser trims it, the display wins. */
const PADDED_TOKEN = '[[ Ash Gate |the gate]]';
/** No display: the NAME is the display. */
const PLAIN_TOKEN = '[[Kael]]';
/** A padded DISPLAY — `stripWikiLinks` trims it, so the trim is pinned here. */
const PADDED_DISPLAY_TOKEN = '[[Kael|  the smith  ]]';

/** Every token of the fixture with the text a reader must see instead. */
const TOKENS: readonly { token: string; display: string }[] = [
  { token: DISPLAY_TOKEN, display: 'the gate' },
  { token: PADDED_TOKEN, display: 'the gate' },
  { token: PLAIN_TOKEN, display: 'Kael' },
  { token: PADDED_DISPLAY_TOKEN, display: 'the smith' },
];

/** Prose that only LOOKS like a token: an inner space, and an unclosed `[[`. */
const LITERALS = 'A literal [[ not even this one and an unclosed [[ stay as written.';

const TOKEN_BODY = `He guards ${DISPLAY_TOKEN} and ${PADDED_TOKEN}, and ${PLAIN_TOKEN} answers to ${PADDED_DISPLAY_TOKEN}.`;

/** The same body as a reader must see it — byte-exact, never a substring. */
const TOKEN_BODY_RENDERED = 'He guards the gate and the gate, and Kael answers to the smith.';

/** Library rows are out of PDF context unless explicitly named; narrow
 * loudly rather than casting. */
function owned(artifact: AnyArtifact): Artifact {
  if (artifact.campaignId === null) throw new Error('expected a campaign-owned artifact row');
  return artifact;
}

/**
 * The exported body paragraph: both templates carry exactly ONE `body`-styled
 * node, and reading it off the definition is what makes the assertions below
 * claims about the RENDERED BODY rather than about the definition's JSON.
 */
function exportedBody(definition: TDocumentDefinitions): string {
  const content: unknown = definition.content;
  if (!Array.isArray(content)) throw new Error('expected a content array');
  const bodies = (content as { style?: unknown; text?: unknown }[]).filter(
    (node) => node.style === 'body',
  );
  const text = bodies.length === 1 ? bodies[0]?.text : undefined;
  if (typeof text !== 'string') {
    throw new Error(`expected exactly one string body node, found ${String(bodies.length)}`);
  }
  return text;
}

function source(relative: string): string {
  return readFileSync(resolve(import.meta.dirname, '..', '..', relative), 'utf8');
}

async function seed(): Promise<{
  deliverable: Deliverable;
  module: Module;
  gate: Artifact;
  literal: Artifact;
}> {
  const campaign = await createCampaign({ name: 'Export Campaign', system: 'dnd5e' });
  const gate = owned(
    await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Ash Gate',
      body: TOKEN_BODY,
    }),
  );
  // A SECOND row carries the non-tokens. Keeping them apart is what stops the
  // two claims from passing vacuously off each other: the token body's "no
  // brackets, and no target" pin is a claim about tokens, and the literal pin
  // is a claim about literalness — the same body could not prove both.
  const literal = owned(
    await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Mira',
      body: LITERALS,
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

  return { deliverable, module, gate, literal };
}

beforeEach(async () => {
  await clearDatabase();
});

describe('an export renders the DISPLAY of a wiki token, never the token', () => {
  /**
   * The defect and its cure, one surface at a time. REVERT-PROOF (measured one
   * revert at a time, each file restored byte-identical and checked with
   * `md5sum -c`): put `markdownToText` back at the GM-notes body site and the
   * GM-notes pin fails naming `[[Encounter:Ash Gate|the gate]]`; put it back at
   * the handout's site and the handout pin fails the same way.
   */
  it('the GM notes body is the RENDERED body: display text, no brackets, no target', async () => {
    const { gate } = await seed();

    // NON-VACUITY: the tokens really are in the row, so a rendered body is a
    // real transform and not an empty fixture.
    expect(gate.body).toContain(DISPLAY_TOKEN);
    expect(gate.body).toContain(PADDED_DISPLAY_TOKEN);

    const body = exportedBody(buildGmNotesDefinition(gate));
    expect(body).toBe(TOKEN_BODY_RENDERED);
    expect(body).not.toContain('[[');
    expect(body).not.toContain(']]');
    // NON-VACUITY INJECTION that motivated these two: a naive `\[\[|\]\]`
    // bracket strip keeps the whole inner text, i.e. it DROPS the display half
    // and leaves `Encounter:Ash Gate|the gate` behind.
    expect(body).not.toContain('Encounter:Ash Gate');
    expect(body).not.toContain('|');
  });

  it('the player handout body is the RENDERED body: display text, no brackets, no target', async () => {
    const { gate } = await seed();

    const body = exportedBody(buildPlayerHandoutDefinition(gate));
    expect(body).toBe(TOKEN_BODY_RENDERED);
    expect(body).not.toContain('[[');
    expect(body).not.toContain(']]');
    expect(body).not.toContain('Encounter:Ash Gate');
    expect(body).not.toContain('|');
  });

  it('a literal that only LOOKS like a token stays literal, in both templates', async () => {
    const { literal } = await seed();

    // The other side of the same rule, and the non-vacuity of the pins above:
    // "strip the token" must never become "strip brackets", so this body keeps
    // every bracket it was written with.
    for (const definition of [
      buildGmNotesDefinition(literal),
      buildPlayerHandoutDefinition(literal),
    ]) {
      const body = exportedBody(definition);
      expect(body).toBe(LITERALS);
      expect(body).toContain('[[ not even this one');
      expect(body).toContain('unclosed [[');
    }
  });

  it('the two pipelines agree: one body, the display in both, brackets in neither', async () => {
    const { deliverable, gate } = await seed();

    const moduleDefinition = JSON.stringify(buildModuleDefinition(deliverable, [gate]));
    const gmNotes = exportedBody(buildGmNotesDefinition(gate));
    const handout = exportedBody(buildPlayerHandoutDefinition(gate));

    for (const { display } of TOKENS) {
      // The display survives in all three renderings…
      expect(moduleDefinition).toContain(display);
      expect(gmNotes).toContain(display);
      expect(handout).toContain(display);
    }
    // …and no pipeline prints the syntax (the module definition's own
    // non-vacuity — the tokens ARE in the row and the document text — is the
    // assertion block above).
    expect(moduleDefinition).not.toContain('[[');
    expect(moduleDefinition).not.toContain(']]');
    expect(gmNotes).not.toContain('[[');
    expect(handout).not.toContain('[[');
  });

  it('the wiki strip has ONE implementation, in lib/markdown, and no carrier reaches an export', () => {
    // Structural, so a future refactor fails HERE instead of quietly growing a
    // second token regex in the export path — or wiring `WikiMarkdown` (or the
    // remark plugin) into a PDF and shipping the chip's render-time carrier.
    const markdown = source('src/lib/markdown.ts');
    expect(markdown).toContain('stripWikiLinks');
    expect(markdown).toContain('markdownToDisplayText');

    const pdfExport = source('src/lib/pdfExport.ts');
    expect(pdfExport).toContain('markdownToDisplayText');
    // It composes the strip in ONE place: no direct wikilinks import, no
    // second wiring site, no private `\[\[…\]\]` regex beside it.
    expect(pdfExport).not.toMatch(/from '@\/lib\/wikilinks'/);
    expect(pdfExport).not.toContain('WIKI_LINK_PATTERN');
    expect(pdfExport).not.toMatch(/\\\[\\\[/);

    const exportModules = ['src/lib/modulePdf.ts', 'src/lib/pdfExport.ts', 'src/lib/mdToPdfmake.ts'];
    for (const relative of exportModules) {
      const file = source(relative);
      expect(file).not.toContain('wiki-markdown');
      expect(file).not.toContain('remark-wikilinks');
      expect(file).not.toContain('data-wiki-raw');
      expect(file).not.toContain('WIKI_RAW_ATTRIBUTE');
    }
    // And the module pipeline keeps its own rich-run renderer: it never borrows
    // the plain-text one (`lib/mdToPdfmake` is UNCHANGED by row 105).
    expect(source('src/lib/mdToPdfmake.ts')).not.toContain('markdownToDisplayText');
    expect(source('src/lib/modulePdf.ts')).not.toContain('markdownToDisplayText');
  });
});

describe('markdownToDisplayText is the ONE export rendering of artifact text', () => {
  it('renders each token form as its display and leaves non-tokens alone', () => {
    expect(markdownToDisplayText(TOKEN_BODY)).toBe(TOKEN_BODY_RENDERED);
    expect(markdownToDisplayText(LITERALS)).toBe(LITERALS);
    // The markdown syntax still goes, in the same pass.
    expect(markdownToDisplayText('**He guards** [[Ash Gate]] — _the gate_')).toBe(
      'He guards Ash Gate — the gate',
    );
  });

  it('trims the display and falls back to the name, exactly as the reader does', () => {
    expect(markdownToDisplayText(PADDED_DISPLAY_TOKEN)).toBe('the smith');
    expect(markdownToDisplayText('[[ Ash Gate ]]')).toBe('Ash Gate');
    // A display that is only whitespace is no display — `stripWikiLinks`' own
    // rule, pinned here because every export surface now depends on it.
    expect(markdownToDisplayText('[[A|   ]] was here.')).toBe('A was here.');
  });

  it('strips the token FIRST, so no markdown syntax survives either (measured order)', () => {
    // MEASURED at row 105: the two orders agree everywhere except here, and
    // here the other order leaves a raw markdown link — the same class of leak
    // as the token itself — because the token had split the link's text.
    expect(markdownToDisplayText('[see [[Ash Gate]]](https://x.y)')).toBe('see Ash Gate');
    // A display carrying markdown emphasis is prose by the time it lands.
    expect(markdownToDisplayText('He guards [[X|the *old* gate]].')).toBe(
      'He guards the old gate.',
    );
  });

  it('gives a code span or fence NO carve-out — a documented divergence, not parity', () => {
    // The plain-text pipeline has no code style: `markdownToText` already
    // unwraps `` `…` `` and strips syntax inside a fence, so a token inside one
    // is ordinary text. `mdToPdfmake` keeps it literal in its code branch —
    // recorded in docs/17 row 105 rather than silently "fixed" here.
    expect(markdownToDisplayText('Code span: `[[Ash Gate]]` stays?')).toBe('Code span: Ash Gate stays?');
    expect(markdownToDisplayText('```\nfenced [[Ash Gate]] block\n```')).toBe('fenced Ash Gate block');
  });
});
