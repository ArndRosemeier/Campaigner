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
      levelHint: '4',
      monsters: [
        {
          name: 'Cave Fisher',
          count: 1,
          notes: 'clings to the pilings',
          treasure: '',
          source: {
            type: 'rulebook',
            chunkId: chunk.id,
            contentHash: chunk.contentHash,
            creatureName: 'Cave Fisher',
          },
        },
        {
          name: 'Harbour Thug',
          count: 2,
          notes: '',
          treasure: '',
          source: { type: 'none' },
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

  it('a citation whose chunk carries no parseable block prints NO box in either book', async () => {
    const { artifact, module, artifacts, monsters } = await seedEncounter();
    // Re-ingest the same creature with NO parsed block (best-effort ingest).
    const rulebook = await createRulebook({
      title: 'Bestiary',
      system: 'pathfinder2e',
      filename: 'bestiary.pdf',
    });
    const statless = await citedChunk(rulebook.id, null);
    await putChunks([statless]);
    const rewritten = artifactSchema.parse({
      ...artifact,
      data: {
        ...artifact.data,
        monsters: monsters.map((monster): MonsterEntry =>
          monster.name === 'Cave Fisher'
            ? {
                ...monster,
                source: {
                  type: 'rulebook',
                  chunkId: statless.id,
                  contentHash: statless.contentHash,
                  creatureName: 'Cave Fisher',
                },
              }
            : monster,
        ),
      },
    });
    const scoped: Artifact[] = artifacts.map((row) => (row.id === artifact.id ? rewritten : row));
    const roster = await resolveExportRoster(rewritten);

    const moduleText = textOf(
      buildModuleDefinition({
        module,
        artifacts: scoped,
        rosterResolution: { [rewritten.id]: roster },
      }),
    );
    const exportText = textOf(buildGmNotesDefinition(rewritten, null, roster));

    for (const text of [moduleText, exportText]) {
      // The NAMED missing-ref reason, and nothing standing in for the numbers.
      expect(text).toContain(' — missing ref (Cave Fisher)');
      expect(text).not.toContain('Numbers from');
      expect(text).not.toContain('Reactive Snap');
      expect(text).not.toContain('44 (8d8)');
    }
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
    expect(domain).toContain("const UNRESOLVED_CITATION_REFERENCE = 'unresolved citation");
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
    expect(JSON.stringify(artifact)).toContain('rulebook');
  });
});
