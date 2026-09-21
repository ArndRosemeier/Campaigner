import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  artifactSchema,
  createModule as buildModule,
  modulePartSchema,
  moduleSpineSchema,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
  type Artifact,
  type Module,
  type MonsterEntry,
  type RuleChunk,
  type StatBlock,
} from '@/domain';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { saveModule } from '@/db/moduleRepo';
import { buildModuleDefinition, statBoxContent } from '@/lib/modulePdf';
import { buildGmNotesDefinition, resolveExportRoster } from '@/lib/pdfExport';
import { rosterTreasureFor } from '@/domain/encounterResolve';
import { sha256Hex } from '@/lib/hash';
import { clearDatabase } from '../db/helpers';

/**
 * ONE reference formatter, BOTH exporters (docs/17 row 144).
 *
 * The owner reported reading `Zombie ×4 — (see Bestiary)` in the exported module
 * PDF: the module PDF threw away a reference it had already resolved and printed
 * a constant pointing at a bestiary chapter the book does not have, and the
 * single-artifact GM export printed no reference and no numbers at all. Both now
 * render the SAME domain rule, and these pins hold them to it:
 *
 * - DIFFERENTIAL — the two real documents, built over the same entry, print the
 *   identical reference string, EXTRACTED from each document on its own and
 *   compared (`rosterRowRuns`/`printedReference` below) so an exporter that
 *   decorates its own line reds this file (docs/17 row 146 — the containment
 *   pins alone could not see that);
 * - EXACTLY ONE (AGENTS rule 4, made mechanical) — a source scan proves there is
 *   no second implementation of the rule and that the dead constant is gone.
 */

/** Every text run of a document definition, joined — a document is READ as
 * text, so a pin on the printed words joins the runs the way a reader sees
 * them. The join does not merge adjacent runs, so a reference SPLIT across
 * runs (a linked name) is asserted as the concatenation it renders as. */
function textOf(node: unknown): string {
  return referenceRuns(node).join('');
}

/** Every text run of a pdfmake node, in document order. */
function referenceRuns(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') return out;
  if (Array.isArray(node)) {
    for (const child of node) referenceRuns(child, out);
    return out;
  }
  if (typeof node !== 'object' || node === null) return out;
  const record = node as Record<string, unknown>;
  const text: unknown = record.text;
  if (typeof text === 'string') out.push(text);
  else if (text !== undefined) referenceRuns(text, out);
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'text') referenceRuns(value, out);
  }
  return out;
}

/**
 * The roster ROW a document prints for ONE creature, read back from that
 * document ALONE: the text array whose runs start with the creature's own
 * `Name ×count` label. `null` means the document prints no such row, and every
 * caller below treats that as a FAILURE — an extraction that silently answered
 * `''` would make the cross-book equality pass on nothing (the vacuity this
 * differential exists to prevent).
 */
function rosterRowRuns(node: unknown, label: string): string[] | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = rosterRowRuns(child, label);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof node !== 'object' || node === null) return null;
  const record = node as Record<string, unknown>;
  const text: unknown = record.text;
  if (Array.isArray(text)) {
    const runs = referenceRuns(text);
    if (runs.join('').startsWith(label)) return runs;
  }
  for (const value of Object.values(record)) {
    const found = rosterRowRuns(value, label);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The REFERENCE one book printed for a roster row: the row's own text after the
 * creature's `Name ×count` label, with the row's trailing notes element removed
 * when the book appends them to the same line (the single-artifact GM export
 * prints `: <notes>` inside the row, the module book prints the notes as a
 * separate node) — so the two books are compared on the REFERENCE, which is
 * what the formatter owns, and not on each renderer's notes convention.
 */
function printedReference(
  document: unknown,
  label: string,
  notes: string,
): string | null {
  const runs = rosterRowRuns(document, label);
  if (runs === null) return null;
  const rest = runs.join('').slice(label.length);
  const notesSuffix = notes === '' ? '' : `: ${notes}`;
  return notesSuffix !== '' && rest.endsWith(notesSuffix)
    ? rest.slice(0, rest.length - notesSuffix.length)
    : rest;
}

/** Whether a node is a roster ROW for `label` (a text array starting with it). */
function isRowNode(node: unknown, label: string): boolean {
  if (typeof node !== 'object' || node === null) return false;
  const text = (node as Record<string, unknown>).text;
  if (!Array.isArray(text)) return false;
  return referenceRuns(text).join('').startsWith(label);
}

/** The nodes printed AFTER a roster row in the same container (the row's own
 * block: the module book's `stack`, the GM export's `Monsters` list). */
function rowSiblings(node: unknown, label: string): unknown[] | null {
  if (Array.isArray(node)) {
    const items: unknown[] = node;
    const index = items.findIndex((child) => isRowNode(child, label));
    if (index >= 0) return items.slice(index + 1);
    for (const child of items) {
      const found = rowSiblings(child, label);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof node !== 'object' || node === null) return null;
  for (const value of Object.values(node as Record<string, unknown>)) {
    const found = rowSiblings(value, label);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The TREASURE line one book printed for ONE roster row, read from that row's
 * OWN block: the row is the text array starting with the creature's
 * `Name ×count` label, and the treasure is its SIBLING in the same container
 * whose runs read `Treasure: …` (docs/17 row 159).
 *
 * `null` means the book printed no treasure for that row. Every caller treats
 * `null` as a FACT TO ASSERT — the mob that carries nothing must answer `null`
 * in BOTH books, and the mob that carries something must answer a line in both —
 * so an extraction that silently answered `''`, or one that found the encounter's
 * own `Treasure` labeled section instead of the row's line, cannot make the
 * cross-book equality below pass on nothing.
 */
function printedTreasure(document: unknown, label: string): string | null {
  const siblings = rowSiblings(document, label);
  if (siblings === null) return null;
  for (const sibling of siblings) {
    const line = referenceRuns(sibling).join('');
    if (line.startsWith('Treasure: ')) return line;
  }
  return null;
}

function citedStatBlock(): StatBlock {
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
    actions: [{ name: 'Mandible', text: 'Melee: +12 to hit.' }],
    reactions: [{ name: 'Reactive Snap', text: 'Strike a creature that enters its reach.' }],
    legendary: [{ name: 'Skitter Away', text: 'Stride without provoking reactions.' }],
    extras: { Perception: '+11' },
  });
}

async function citedChunk(bookId: string, statBlock: StatBlock | null): Promise<RuleChunk> {
  const text = 'Cave Fisher';
  return ruleChunkSchema.parse({
    ...stampNewEntity(),
    bookId,
    pageStart: 132,
    pageEnd: 132,
    chunkType: 'statblock',
    headingPath: ['Cave Fisher'],
    text,
    statBlock,
    contentHash: await sha256Hex(text),
  });
}

/** The same encounter row, as both exporters see it — plus its roster, which
 * the schema itself already gives a precise type for. */
async function seedEncounter(): Promise<{
  artifact: Artifact;
  monsters: MonsterEntry[];
  module: Module;
  artifacts: Artifact[];
}> {
  const campaign = await createCampaign({ name: 'Parity', system: 'pathfinder2e' });
  const rulebook = await createRulebook({
    title: 'Bestiary',
    system: 'pathfinder2e',
    filename: 'bestiary.pdf',
  });
  const chunk = await citedChunk(rulebook.id, citedStatBlock());
  await putChunks([chunk]);

  const encounter = await createArtifact({
    campaignId: campaign.id,
    kind: 'encounter',
    name: 'Pier Ambush',
    body: 'They come up out of the water.',
    data: {
      difficulty: 'severe',
      levelHint: '', partyLevel: 4,
      monsters: [
        {
          name: 'Cave Fisher',
          count: 1,
          notes: 'clings to the pilings',
          // The mob CARRIES something: the treasure line is the third thing the
          // two books must agree about (docs/17 row 159).
          treasure: 'Pouch: 5 gp, a bone key',
          // A COPIED library mob (docs/17 row 255a): it OWNS the block, its
          // stamped origin line and the opaque identity token. The pre-cut
          // `rulebook` citation was deleted (docs/17 row 278); the reference the
          // two books must agree about is now the STAMP.
          source: { type: 'inline' as const, statBlock: citedStatBlock() },
          sourceLine: 'Bestiary p.132',
          originToken: `chunk:${chunk.id}`,
        },
        {
          name: 'Harbour Thug',
          count: 2,
          notes: '',
          treasure: '',
          source: { type: 'none' as const },
        },
      ],
      terrain: 'wet planks',
      tactics: 'drag them under',
      treasure: 'a silver bell',
      mapImageId: null,
      layout: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    },
  });

  // Through the SCHEMA: it is what the app itself does at the repo boundary, and
  // it keeps the encounter's own `data` type (the `Artifact` union widens an
  // unparsed literal to the union of every kind's data).
  const parsed = artifactSchema.parse(encounter);
  if (parsed.kind !== 'encounter') throw new Error('the seed must build an encounter');
  const roster: MonsterEntry[] = parsed.data.monsters;

  const draft = buildModule({
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
      premise: 'They spring the [[Pier Ambush]] at dusk.',
      themes: [],
      partPlan: [{ title: 'The Gate', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: 'The party climbs down into the wet dark.',
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
  return { artifact: encounter, monsters: roster, module, artifacts: [encounter] };
}

/** Comment patterns for the source scan (a rule is what EXECUTES). */
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /\/\/.*$/gm;

beforeEach(clearDatabase);

describe('both exporters print the SAME reference (one formatter)', () => {
  it('a cited mob’s reference is byte-identical in the module book and the GM export', async () => {
    const { artifact, module, artifacts, monsters } = await seedEncounter();
    const roster = await resolveExportRoster(artifact);
    const cited = monsters[0];
    const nameOnly = monsters[1];
    if (cited === undefined || nameOnly === undefined) {
      throw new Error('the seed must build both roster rows');
    }
    const citedLabel = `${cited.name} ×${String(cited.count)}`;
    const nameOnlyLabel = `${nameOnly.name} ×${String(nameOnly.count)}`;

    const moduleDefinition = buildModuleDefinition({
      module,
      artifacts,
      rosterResolution: { [artifact.id]: roster },
    });
    const exportDefinition = buildGmNotesDefinition(artifact, null, roster);
    const moduleRuns = textOf(moduleDefinition);
    const exportRuns = textOf(exportDefinition);

    // The cited row's reference, in both books, character for character.
    expect(moduleRuns).toContain(' — Bestiary p.132');
    expect(exportRuns).toContain(' — Bestiary p.132');
    // The name-only row's statement, likewise.
    const statement = ' — no stats: this roster entry names the creature without a citation';
    expect(moduleRuns).toContain(statement);
    expect(exportRuns).toContain(statement);
    // And the disconnecting injection (I4) REDs this file: the pins above are
    // on the FORMATTED line, not on a bare word the box's attribution could
    // satisfy on its own.
    expect(moduleRuns).toContain('Cave Fisher ×1 — Bestiary p.132');
    // Neither book prints the dead constant, in any spelling.
    for (const text of [moduleRuns, exportRuns]) {
      expect(text).not.toContain('see Bestiary');
      expect(text).not.toContain('(see Bestiary)');
    }

    // THE CROSS-BOOK EQUALITY THIS TEST'S NAME PROMISES (docs/17 row 146): the
    // reference is EXTRACTED from each document on its own — never read from
    // the shared formatter, which would compare the rule with itself — and the
    // two extractions are compared. One-sided containment (`toContain`, one
    // per book) could not see a decoration added to a SINGLE exporter:
    // appending `' [mob]'` to the reference in `lib/pdfExport.ts` left every
    // assertion above green, measured.
    const moduleCitedReference = printedReference(moduleDefinition, citedLabel, cited.notes);
    const exportCitedReference = printedReference(exportDefinition, citedLabel, cited.notes);
    const moduleNameOnlyReference = printedReference(
      moduleDefinition,
      nameOnlyLabel,
      nameOnly.notes,
    );
    const exportNameOnlyReference = printedReference(
      exportDefinition,
      nameOnlyLabel,
      nameOnly.notes,
    );

    // NON-VACUITY, both sides: each book must have printed the row AND a
    // reference ON it (the separator the formatter's `printed` carries), so an
    // empty or absent extraction cannot make the equality below pass.
    for (const reference of [
      moduleCitedReference,
      exportCitedReference,
      moduleNameOnlyReference,
      exportNameOnlyReference,
    ]) {
      expect(reference).not.toBeNull();
      expect(reference?.startsWith(' — ')).toBe(true);
      expect((reference ?? '').length).toBeGreaterThan(' — '.length);
    }

    expect(moduleCitedReference).toBe(exportCitedReference);
    expect(moduleNameOnlyReference).toBe(exportNameOnlyReference);
    // Anchored to the words the seed's chunk actually carries, so a formatter
    // that answered the SAME wrong string in both books still fails here.
    expect(moduleCitedReference).toBe(' — Bestiary p.132');
    expect(moduleNameOnlyReference).toBe(statement);
  });

  it('both exporters print the cited chunk’s NUMBERS, with the source on the box', async () => {
    const { artifact, module, artifacts } = await seedEncounter();
    const roster = await resolveExportRoster(artifact);

    const moduleRuns = textOf(
      buildModuleDefinition({ module, artifacts, rosterResolution: { [artifact.id]: roster } }),
    );
    const exportRuns = textOf(buildGmNotesDefinition(artifact, null, roster));

    for (const text of [moduleRuns, exportRuns]) {
      // The numbers themselves, INCLUDING the sections the module box used to
      // drop (reactions, legendary, extras) — a printed mob must be usable.
      expect(text).toContain('Reactive Snap');
      expect(text).toContain('Skitter Away');
      expect(text).toContain('Perception');
      expect(text).toContain('+11');
      expect(text).toContain('AC ');
      expect(text).toContain('44 (8d8)');
      // The attribution ON the box: whose numbers these are.
      expect(text).toContain('Numbers from Bestiary p.132');
    }
  });

  it('a mob’s TREASURE is the same line in both books — and nothing at all for a mob that carries none', async () => {
    const { artifact, module, artifacts, monsters } = await seedEncounter();
    const roster = await resolveExportRoster(artifact);
    const cited = monsters[0];
    const nameOnly = monsters[1];
    if (cited === undefined || nameOnly === undefined) {
      throw new Error('the seed must build both roster rows');
    }
    const citedLabel = `${cited.name} ×${String(cited.count)}`;
    const nameOnlyLabel = `${nameOnly.name} ×${String(nameOnly.count)}`;

    const moduleDefinition = buildModuleDefinition({
      module,
      artifacts,
      rosterResolution: { [artifact.id]: roster },
    });
    const exportDefinition = buildGmNotesDefinition(artifact, null, roster);

    // EXTRACTED from each book on its own — never read from the shared
    // formatter, which would compare the rule with itself.
    const moduleLine = printedTreasure(moduleDefinition, citedLabel);
    const exportLine = printedTreasure(exportDefinition, citedLabel);

    // NON-VACUITY, both sides, and anchored to the words the seed authored: an
    // absent or empty extraction cannot make the equality below pass.
    expect(moduleLine).not.toBeNull();
    expect(exportLine).not.toBeNull();
    expect(moduleLine).toBe('Treasure: Pouch: 5 gp, a bone key');
    expect(moduleLine).toBe(exportLine);
    // …and it is the ONE rule's own line, printed under the mob that carries it.
    expect(moduleLine).toBe(rosterTreasureFor(cited)?.printed);

    // The mob that carries NOTHING prints no line in EITHER book — and the
    // rule answers `null` for it, so a label over a blank value has nowhere to
    // come from (AGENTS rule 1).
    expect(rosterTreasureFor(nameOnly)).toBeNull();
    expect(printedTreasure(moduleDefinition, nameOnlyLabel)).toBeNull();
    expect(printedTreasure(exportDefinition, nameOnlyLabel)).toBeNull();

    // The treasure is a line of its OWN, never folded into the reference the two
    // books were already pinned on: a renderer that appended it to the row would
    // red the reference differential AND this one, in both books.
    expect(printedReference(moduleDefinition, citedLabel, cited.notes)).toBe(' — Bestiary p.132');
    expect(printedReference(exportDefinition, citedLabel, cited.notes)).toBe(' — Bestiary p.132');

    // The module BOOK's ledger carries the roster's treasure as its own labelled
    // row (docs/17 row 159) — read off the definition's own bytes because a
    // ledger CELL is a plain string, which `textOf` deliberately does not
    // collect (it reads text RUNS, the unit a reader sees).
    expect(JSON.stringify(moduleDefinition)).toContain(`"Pier Ambush · ${citedLabel}"`);
    expect(textOf(moduleDefinition)).toContain('TREASURE LEDGER');
    // …and the single-artifact export grows NO ledger of its own: the back
    // matter belongs to the module book, and a second ledger would be a second
    // mechanism for one idea (AGENTS rule 4).
    expect(textOf(exportDefinition)).not.toContain('TREASURE LEDGER');
    expect(JSON.stringify(exportDefinition)).not.toContain('TREASURE LEDGER');
  });
});

describe('EXACTLY ONE implementation of the roster reference', () => {
  const SOURCES = [
    'src/domain/encounterResolve.ts',
    'src/lib/modulePdf.ts',
    'src/lib/pdfExport.ts',
  ];

  /** Comments stripped: the rule is what EXECUTES, not what is documented. */
  function code(relative: string): string {
    const path = fileURLToPath(new URL('../../' + relative, import.meta.url));
    return readFileSync(path, 'utf8')
      .replace(BLOCK_COMMENT, '')
      .replace(LINE_COMMENT, '');
  }

  function allCode(): string {
    return SOURCES.map(code).join('\n');
  }

  it('no source composes a reference without the shared formatter', () => {
    // The formatter is the ONLY place the words live…
    const domain = code('src/domain/encounterResolve.ts');
    expect(domain).toContain(
      "const NO_CITATION_REFERENCE = 'no stats: this roster entry names the creature without a citation';",
    );
    expect(domain).toContain('export function rosterReferenceFor');
    // …and no other source spells any of them out again: an exporter that grew
    // its own copy is exactly the defect this slice removes (AGENTS rule 4).
    for (const source of SOURCES.slice(1)) {
      const text = code(source);
      expect(text).not.toContain('no stats: this roster entry names');
      expect(text).not.toContain('unresolved citation');
      expect(text).not.toContain(`missing ref (`);
      expect(text).not.toContain('NPC: ');
    }
  });

  it('the dead "(see Bestiary)" constant is gone from every source', () => {
    for (const source of SOURCES) {
      expect(code(source)).not.toContain('see Bestiary');
    }
    // Non-vacuity: the rule the constant belonged to is still implemented.
    expect(allCode()).toContain('rosterReferenceFor');
  });

  it('both exporters call the shared rule and the shared box', () => {
    for (const source of ['src/lib/modulePdf.ts', 'src/lib/pdfExport.ts']) {
      expect(code(source)).toContain('rosterReferenceFor');
      expect(code(source)).toContain('rosterStatBlockFor');
    }
    // ONE box: the single-artifact export renders `modulePdf.statBoxContent`
    // rather than growing a second stat renderer.
    expect(code('src/lib/pdfExport.ts')).toContain('statBoxContent');
    expect(code('src/lib/modulePdf.ts')).toContain('export function statBoxContent');
    // And only the shared box's own definition exists.
    expect(code('src/lib/pdfExport.ts')).not.toContain('export function statBoxContent');
  });

  it('the roster TREASURE goes through its own ONE rule, whose label lives in the domain module alone (docs/17 row 159)', () => {
    const domain = code('src/domain/encounterResolve.ts');
    // The rule and the ONE label live in the domain module…
    expect(domain).toContain('export function rosterTreasureFor');
    expect(domain).toContain("const TREASURE_LABEL = 'Treasure: '");
    // …and EVERY roster-printing surface renders that rule rather than reading
    // the field itself: the module book's encounter section, the single-artifact
    // GM export's roster rows, and the reader's roster row.
    for (const source of [
      'src/lib/modulePdf.ts',
      'src/lib/pdfExport.ts',
      'src/features/campaign/components/monster-source.tsx',
    ]) {
      const text = code(source);
      expect(text).toContain('rosterTreasureFor');
      // No second label, and no second emptiness decision taken by reading the
      // roster entry's raw field for printing: `data.treasure` (the ENCOUNTER's
      // own field, a different thing) is the only `.treasure` these may touch,
      // and it is spelled as one.
      expect(text).not.toContain('Treasure: ');
      expect(text).not.toContain('monster.treasure');
      expect(text).not.toContain('entry.treasure');
    }
    // The encounter's own field still prints through the shared labeled section
    // (row 159 keeps it as the encounter-level line) — so the removal of the
    // roster reads above is not the removal of the whole feature.
    for (const source of ['src/lib/modulePdf.ts', 'src/lib/pdfExport.ts']) {
      expect(code(source)).toContain('data.treasure');
    }
  });

  it('the shared box carries every section a PF2e-style block needs', () => {
    const box = textOf(statBoxContent(citedStatBlock(), 'Cave Fisher ×1', 'Bestiary p.132'));
    expect(box).toContain('Grasping Antennae');
    expect(box).toContain('Mandible');
    expect(box).toContain('Reactive Snap');
    expect(box).toContain('Skitter Away');
    expect(box).toContain('Perception');
    expect(box).toContain('+11');
    expect(box).toContain('Numbers from Bestiary p.132');
  });

  it('a box with no source prints no attribution line (an inline entry)', () => {
    const box = textOf(statBoxContent(citedStatBlock(), 'Cultist ×4'));
    expect(box).not.toContain('Numbers from');
    // Non-vacuity: the box still printed its own content.
    expect(box).toContain('Cultist ×4');
  });

  it('nothing is materialized: neither exporter writes a chunk or a citation', async () => {
    const { artifact, monsters } = await seedEncounter();
    const before = JSON.stringify(monsters);
    await resolveExportRoster(artifact);
    buildGmNotesDefinition(artifact, null, await resolveExportRoster(artifact));
    // The roster row is byte-identical: exporting renders the citation, it
    // never rewrites it (docs/12 §Storage, docs/11 D2/D3).
    expect(JSON.stringify(monsters)).toBe(before);
    expect(JSON.stringify(artifact)).toContain('inline');
  });
});
