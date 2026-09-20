import type { Content, NamedStyle, TDocumentDefinitions } from 'pdfmake/interfaces';

import type { Artifact, GameSystem, MobSpellIndex, StatBlock } from '@/domain';
import { abilityModifier, formatModifier, imageBlob, printsAbilityModifiers } from '@/domain';
import {
  rosterReferenceFor,
  rosterStatBlockFor,
  rosterTreasureFor,
  type ResolvedMonster,
} from '@/domain/encounterResolve';
import { getImage } from '@/db/imageRepo';
import { resolveMonsterEntries } from '@/db/monsterResolve';
import { casterBoxSection, statBoxContent, spellBoxSection } from '@/lib/modulePdf';
import { loadSpellIndexesFor, statBlockSystems } from '@/db/spellRepo';
import { fileSlug } from '@/lib/fileSlug';
import { blobToScaledDataUrl } from '@/lib/imageIntake';
import { markdownToDisplayText } from '@/lib/markdown';
import { blockText, textBlocks } from '@/lib/textBlocks';
import { EXPORT_PDF_TYPES, openSaveTarget } from '@/lib/filePicker';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * PDF export (06-MILESTONES M2): pdfmake definitions for the two templates —
 * **GM notes** (everything: body, structured data, stat block, links) and the
 * **player handout** (name, summary, body only — no structured data, no mechanics).
 * Definition builders are pure; `exportArtifactPdf` loads pdfmake lazily and
 * resolves the artifact's cover image (M3-A) as a ≤1024px data URL.
 *
 * A PDF is a RENDERING, so both bodies print a wiki token's DISPLAY text
 * (`markdownToDisplayText` — the same rule `lib/mdToPdfmake` applies to the
 * module pipeline), never the `[[…]]` token the app stores
 * (docs/07 §Wiki-links in an exported document, docs/18 §2.3, docs/17 row 105).
 */

export type PdfTemplate = 'gm' | 'player';

/** Cover image payload for PDF embedding (M3-A): a JPEG data URL. */
export interface PdfCoverImage {
  dataUrl: string;
  width: number;
  height: number;
}

const STYLES: Record<string, NamedStyle> = {
  title: { fontSize: 20, bold: true, margin: [0, 0, 0, 4] },
  meta: { fontSize: 10, color: '#666666', margin: [0, 0, 0, 12] },
  heading: { fontSize: 13, bold: true, margin: [0, 14, 0, 4] },
  subheading: { fontSize: 11, bold: true, margin: [0, 8, 0, 2] },
  body: { fontSize: 10.5, lineHeight: 1.35, margin: [0, 0, 0, 6] },
  label: { fontSize: 9, bold: true, color: '#555555' },
  value: { fontSize: 10.5, margin: [0, 0, 0, 6] },
};

/**
 * One node of this template's own definition. A label/value helper answers an
 * ARRAY — one node for a single-block value, one node per block for a
 * multi-block one — so a caller SPREADS it and a value that carries nothing
 * contributes no node.
 */
type Row = object;

/**
 * The width of this template's label column (points). It is BOTH the column
 * width and the indent a multi-block continuation inherits, so a paragraph
 * after the first lines up under the value it continues.
 */
const LABEL_COLUMN_WIDTH = 110;

/**
 * The blocks a field's text carries, drawn in this template's own label/value
 * shape (docs/17 row 146, docs/18 §5; the third consumer of the ONE rule).
 *
 * `lib/textBlocks.textBlocks` decides WHERE the paragraphs are and this is
 * only how THIS template DRAWS them — no splitting happens here, ever. A value
 * with ONE block emits the byte-identical `columns` node this template has
 * always printed (`label:` + value, no margin), so every existing definition
 * dump and assertion is unchanged and the other label/value rows are untouched.
 * A value with SEVERAL blocks (the defect: a model's multi-paragraph
 * `appearance`/`personality`, or a trait body) emits one node per block: the
 * LABEL rides the first, and each continuation is indented into the value
 * column, so the label is never repeated and the paragraphs are real pdfmake
 * nodes rather than one blob carrying blank lines.
 */
function labelValue(label: string, value: string): Row[] {
  const blocks = textBlocks(value).map(blockText);
  if (blocks.length === 0) return [];
  const [first = '', ...rest] = blocks;
  const head = {
    columns: [
      { text: `${label}:`, style: 'label', width: LABEL_COLUMN_WIDTH },
      { text: first, style: 'value' },
    ],
  };
  if (rest.length === 0) return [head];
  return [
    head,
    ...rest.map((block) => ({
      text: block,
      style: 'value',
      margin: [LABEL_COLUMN_WIDTH, 0, 0, 0],
    })),
  ];
}

function listItems(items: string[]): Row[] {
  return items.map((item) => ({ text: item, style: 'value' }));
}

function statBlockSection(
  statBlock: StatBlock,
  spellIndexes?: ReadonlyMap<GameSystem, MobSpellIndex>,
): Row[] {
  // A trait/action/reaction/legendary body is prose the rule applies to, and
  // the module book already draws it this way (`modulePdf.labeledSection`). A
  // SINGLE-block body emits exactly the entry this template always printed
  // (`Name. ` bold + one run) — ONE node, so every existing dump is unchanged;
  // the name is BOLD here rather than this template's `label` style, so the
  // entry is built inline while the SHAPE decision (one node per block, no
  // re-splitting) is still the rule's.
  const named = (rows: { name: string; text: string }[]): Row[] =>
    rows.flatMap((row): Row[] => {
      const blocks = textBlocks(row.text).map(blockText);
      const [first = '', ...rest] = blocks;
      return [
        {
          text: [{ text: `${row.name}. `, bold: true }, { text: first }],
          style: 'value',
        },
        ...rest.map((block) => ({
          text: block,
          style: 'value',
          margin: [LABEL_COLUMN_WIDTH, 0, 0, 0],
        })),
      ];
    });
  const { abilities } = statBlock;
  // Per-system ability display (docs/12 §5): a Pathfinder 2e stat block prints
  // the signed BONUS — its stored d20 score means nothing to a PF2e reader, so
  // the exported document must not print it. Every other system's compact
  // score line is unchanged.
  const ability = (score: number): string =>
    printsAbilityModifiers(statBlock.system)
      ? formatModifier(abilityModifier(score))
      : String(score);
  return [
    { text: 'Stat block', style: 'heading' },
    {
      columns: [
        {
          text: `AC ${statBlock.ac}${statBlock.acNote === '' ? '' : ` (${statBlock.acNote})`}`,
          style: 'value',
        },
        {
          text: `HP ${statBlock.hp}${statBlock.hpFormula === '' ? '' : ` (${statBlock.hpFormula})`}`,
          style: 'value',
        },
        { text: `Speed ${statBlock.speed}`, style: 'value' },
      ],
      margin: [0, 0, 0, 4],
    },
    {
      columns: [
        { text: `STR ${ability(abilities.str)}`, style: 'value' },
        { text: `DEX ${ability(abilities.dex)}`, style: 'value' },
        { text: `CON ${ability(abilities.con)}`, style: 'value' },
        { text: `INT ${ability(abilities.int)}`, style: 'value' },
        { text: `WIS ${ability(abilities.wis)}`, style: 'value' },
        { text: `CHA ${ability(abilities.cha)}`, style: 'value' },
      ],
      margin: [0, 0, 0, 4],
    },
    ...named(statBlock.traits),
    ...named(statBlock.actions),
    ...named(statBlock.reactions),
    ...named(statBlock.legendary),
    // The caster line (docs/17 row 201) — the SAME `casterBoxSection` bytes the
    // module book prints, above the spell chips a GM plays from.
    ...(casterBoxSection(statBlock) as object[]),
    // The mob's spells, the SAME bytes the module book and the in-app chip
    // print (docs/17 row 184).
    ...(spellBoxSection(statBlock, spellIndexes) as object[]),
  ];
}

/**
 * The encounter roster AS PRINTED by this export, one row per participant:
 * `Name ×count — Bestiary p.132: notes`, then the treasure it carries, then the
 * creature's stat box.
 *
 * THE reference rule and THE box rule are the SHARED ones (docs/17 row 144):
 * `domain/encounterResolve.rosterReferenceFor` decides what the reference says and
 * `rosterStatBlockFor` which numbers print, and `modulePdf.statBoxContent` is
 * the box — the same three seams the module book uses, so one entry cannot read
 * or count differently in the two books. Before this, a `rulebook`-cited mob
 * reached the GM as a bare name with no reference and no numbers at all.
 *
 * THE treasure rule is shared the same way (docs/17 row 159): the line comes
 * from `rosterTreasureFor` and it is a NODE OF ITS OWN, never appended to the
 * roster line — the reference rendered beside the name would otherwise end up
 * carrying the treasure, and the module book prints the mob's treasure under the
 * same name in its own line. A mob that carries nothing prints no line.
 *
 * The numbers are the cited library chunk's own, read at export time; nothing is
 * copied into the database (docs/12 §Storage).
 */
function rosterRows(
  artifact: Artifact,
  roster?: readonly ResolvedMonster[],
  spellIndexes?: ReadonlyMap<GameSystem, MobSpellIndex>,
): Row[] {
  if (artifact.kind !== 'encounter') return [];
  return artifact.data.monsters.flatMap((monster, index): Row[] => {
    const resolved = roster?.[index];
    const reference = rosterReferenceFor(monster, resolved).printed;
    const statBlock = rosterStatBlockFor(monster);
    const treasure = rosterTreasureFor(monster);
    return [
      {
        text: [
          { text: `${monster.name} ×${monster.count}`, bold: true },
          ...(reference === '' ? [] : [{ text: reference }]),
          ...(monster.notes === '' ? [] : [{ text: `: ${monster.notes}` }]),
        ],
        style: 'value',
      },
      ...(treasure === null ? [] : [{ text: treasure.printed, style: 'value' } as object]),
      ...(statBlock === null
        ? []
        : [
            statBoxContent(
              statBlock,
              `${monster.name} ×${monster.count}`,
              undefined,
              spellIndexes,
            ) as object,
          ]),
    ];
  });
}

function dataSections(
  artifact: Artifact,
  roster?: readonly ResolvedMonster[],
  spellIndexes?: ReadonlyMap<GameSystem, MobSpellIndex>,
): Content[] {
  const sections: Content[] = [];
  const add = (heading: string, rows: Row[]): void => {
    if (rows.length === 0) return;
    sections.push({ text: heading, style: 'heading' }, ...(rows as Content[]));
  };

  switch (artifact.kind) {
    case 'pc': {
      add('PC details', [
        ...labelValue('Player', artifact.data.playerName),
        ...labelValue('Current HP', String(artifact.data.currentHp)),
        ...labelValue(
          'Initiative bonus',
          artifact.data.initiativeOverride === null ? '' : String(artifact.data.initiativeOverride),
        ),
        ...labelValue('Notes', artifact.data.notes),
      ]);
      if (artifact.data.statBlock !== null) {
        sections.push(...(statBlockSection(artifact.data.statBlock, spellIndexes) as Content[]));
      }
      break;
    }
    case 'npc': {
      add('NPC details', [
        ...labelValue('Appearance', artifact.data.appearance),
        ...labelValue('Personality', artifact.data.personality),
      ]);
      if (artifact.data.statBlock !== null) {
        sections.push(...(statBlockSection(artifact.data.statBlock, spellIndexes) as Content[]));
      }
      break;
    }
    case 'location':
    case 'event': {
      add(artifact.kind === 'event' ? 'Event details' : 'Location details', [
        ...labelValue('Type', artifact.data.locationType),
        ...labelValue('Inhabitants', artifact.data.inhabitants),
        ...(artifact.data.pointsOfInterest.length > 0
          ? [
              { text: 'Points of interest', style: 'subheading' },
              ...artifact.data.pointsOfInterest.map((poi) => ({
                text: [{ text: `${poi.name}: `, bold: true }, { text: poi.description }],
                style: 'value',
              })),
            ]
          : []),
        ...(artifact.data.hooks.length > 0
          ? [{ text: 'Hooks', style: 'subheading' }, ...listItems(artifact.data.hooks)]
          : []),
      ]);
      break;
    }
    case 'faction': {
      add('Faction details', [
        ...labelValue('Goals', artifact.data.goals),
        ...labelValue('Methods', artifact.data.methods),
        ...labelValue('Resources', artifact.data.resources),
        ...(artifact.data.ranks.length > 0
          ? [
              { text: 'Ranks', style: 'subheading' },
              ...artifact.data.ranks.map((rank) => ({
                text: [{ text: `${rank.title}: `, bold: true }, { text: rank.description }],
                style: 'value',
              })),
            ]
          : []),
      ]);
      break;
    }
    case 'encounter': {
      add('Encounter details', [
        ...labelValue('Difficulty', artifact.data.difficulty),
        ...labelValue('Party level', artifact.data.levelHint),
        ...labelValue('Terrain', artifact.data.terrain),
        ...labelValue('Tactics', artifact.data.tactics),
        ...labelValue('Treasure', artifact.data.treasure),
        ...(artifact.data.monsters.length === 0
          ? []
          : [
              { text: 'Monsters', style: 'subheading' },
              ...rosterRows(artifact, roster, spellIndexes),
            ]),
      ]);
      break;
    }
    case 'plotarc': {
      add('Plot arc details', [
        ...labelValue('Arc type', artifact.data.arcType),
        ...labelValue('Premise', artifact.data.premise),
        ...labelValue('Stakes', artifact.data.stakes),
        ...labelValue('Climax', artifact.data.climax),
        ...(artifact.data.beats.length > 0
          ? [
              { text: 'Beats', style: 'subheading' },
              ...artifact.data.beats.map((beat, index) => ({
                text: [
                  { text: `${index + 1}. ${beat.title}: `, bold: true },
                  { text: beat.description },
                ],
                style: 'value',
              })),
            ]
          : []),
        ...(artifact.data.hooks.length > 0
          ? [{ text: 'Hooks', style: 'subheading' }, ...listItems(artifact.data.hooks)]
          : []),
      ]);
      break;
    }
    case 'note':
      break;
  }
  return sections;
}

function baseDoc(artifact: Artifact): TDocumentDefinitions {
  const kindLabel = ARTIFACT_KIND_LABELS[artifact.kind];
  return {
    defaultStyle: { font: 'Roboto' },
    styles: STYLES,
    content: [
      { text: artifact.name, style: 'title' },
      {
        text: `${kindLabel}${artifact.tags.length === 0 ? '' : ` · ${artifact.tags.join(', ')}`}`,
        style: 'meta',
      },
    ],
    footer: (currentPage: number, pageCount: number) => ({
      text: `${currentPage} / ${pageCount}`,
      alignment: 'right',
      fontSize: 8,
      color: '#999999',
    }),
  };
}

// Label map kept local to avoid importing the React-only labels module.
const ARTIFACT_KIND_LABELS: Readonly<Record<Artifact['kind'], string>> = {
  pc: 'PC',
  npc: 'NPC',
  location: 'Location',
  event: 'Event',
  faction: 'Faction',
  note: 'Note',
  encounter: 'Encounter',
  plotarc: 'Plot arc',
};

/** Cover image node: centered, scaled to fit ≤480pt width (M3-A). */
function coverImageNode(cover: PdfCoverImage): Content {
  const scale = Math.min(1, 480 / cover.width, 360 / cover.height);
  return {
    image: cover.dataUrl,
    width: Math.max(40, Math.round(cover.width * scale)),
    alignment: 'center',
    margin: [0, 0, 0, 8],
  };
}

/** GM notes: everything, including the structured data and the stat block. */
export function buildGmNotesDefinition(
  artifact: Artifact,
  cover?: PdfCoverImage | null,
  /**
   * The encounter roster's resolved rows, in order — the SAME resolution the
   * module PDF's pre-pass produces (`ModulePdfInput.rosterResolution`), so one
   * entry prints the same reference and the same numbers in either book
   * (docs/17 row 144). Omitted ⇒ an `inline` entry still prints its own block
   * and an `npc-ref` still cross-references its row, while a `rulebook` citation
   * prints the LOUD `unresolved citation` line rather than a citation-shaped
   * claim this export cannot honour: only a cited creature needs the pass,
   * because its numbers live in the library.
   */
  roster?: readonly ResolvedMonster[],
  /**
   * The imported spell corpus per system (docs/17 row 184) — built by the
   * async `exportArtifactPdf` pre-pass. Omitted ⇒ a block that carries spells
   * prints the loud "not resolved for this build" line, never a silent drop.
   */
  spellIndexes?: ReadonlyMap<GameSystem, MobSpellIndex>,
): TDocumentDefinitions {
  const doc = baseDoc(artifact);
  const content: Content[] = [doc.content].flat();
  if (cover !== undefined && cover !== null) content.push(coverImageNode(cover));
  if (artifact.summary !== '') content.push({ text: artifact.summary, style: 'meta' });
  content.push({
    text: artifact.body === '' ? '(no body)' : markdownToDisplayText(artifact.body),
    style: 'body',
  });
  content.push(...dataSections(artifact, roster, spellIndexes));
  if (artifact.links.length > 0) {
    content.push({ text: 'Relations', style: 'heading' });
    content.push(...(listItems(artifact.links.map((link) => link.relation)) as Content[]));
  }
  return { ...doc, content };
}

/**
 * The encounter roster's resolved rows for the export pre-pass — the SAME
 * resolution the module PDF runs (`db/monsterResolve.resolveMonsterEntries`,
 * which delegates to the ONE `domain/encounterResolve.resolveMonsterEntry`), so
 * a cited creature's numbers and origin are the library chunk's own on every
 * surface. Returns `[]` for a non-encounter row: it has no roster.
 */
export function resolveExportRoster(artifact: Artifact): Promise<ResolvedMonster[]> {
  return artifact.kind === 'encounter'
    ? resolveMonsterEntries(artifact.data.monsters)
    : Promise.resolve([]);
}

/** Player handout: name, summary, body — no structured data, no mechanics. */
export function buildPlayerHandoutDefinition(
  artifact: Artifact,
  cover?: PdfCoverImage | null,
): TDocumentDefinitions {
  const doc = baseDoc(artifact);
  const content: Content[] = [...[doc.content].flat()];
  if (cover !== undefined && cover !== null) content.push(coverImageNode(cover));
  content.push(
    ...(artifact.summary === '' ? [] : [{ text: artifact.summary, style: 'meta' }]),
    {
      text: artifact.body === '' ? '(empty)' : markdownToDisplayText(artifact.body),
      style: 'body',
    } satisfies Content,
  );
  return { ...doc, content } satisfies TDocumentDefinitions;
}

/**
 * Loads the artifact's cover image as a ≤1024px JPEG data URL (M3-A).
 * A missing or unreadable image never fails the PDF export.
 */
async function loadPdfCoverImage(artifact: Artifact): Promise<PdfCoverImage | null> {
  if (artifact.coverImageId === null) return null;
  try {
    const image = await getImage(artifact.coverImageId);
    if (image === undefined) return null;
    return await blobToScaledDataUrl(imageBlob(image), 1024);
  } catch {
    return null;
  }
}

/**
 * Generates and saves the PDF for an artifact (used by the tree menu).
 * Click-initiated, and the build is slow (lazy pdfmake load + cover-image
 * fetch), so the destination is acquired FIRST inside the click's gesture
 * window and the finished blob is written to it afterwards (backup-section
 * precedent). Picker cancel is a silent no-op; every failure toasts loudly
 * (previously a failed PDF export vanished into an unhandled rejection).
 */
export async function exportArtifactPdfFile(
  artifact: Artifact,
  template: PdfTemplate,
): Promise<void> {
  let target;
  try {
    target = await openSaveTarget({
      suggestedName: pdfFileName(artifact, template),
      types: EXPORT_PDF_TYPES,
    });
  } catch (error) {
    toastError('PDF export failed', error);
    return;
  }
  if (target.cancelled) return;
  try {
    const blob = await exportArtifactPdf(artifact, template);
    await target.write(blob);
    toastSuccess('PDF exported');
  } catch (error) {
    toastError('PDF export failed', error);
  }
}

export function pdfFileName(artifact: Artifact, template: PdfTemplate): string {
  // The one slug seam (lib/fileSlug). The SUFFIX stays this file's own
  // vocabulary — a TEMPLATE name, never the module PDF's audience word
  // (docs/18 §2.3): folding the two naming roles would make two different
  // questions share one answer.
  const slug = fileSlug(artifact.name, 'artifact');
  return `${slug}-${template === 'gm' ? 'gm-notes' : 'handout'}.pdf`;
}

/** Generates a PDF blob from any pdfmake definition (shared bootstrapping). */
export async function generatePdfBlob(definition: TDocumentDefinitions): Promise<Blob> {
  const [pdfmakeModule, fonts] = await Promise.all([
    import('pdfmake/build/pdfmake.js'),
    import('pdfmake/build/vfs_fonts.js'),
  ]);
  const pdfmakeAny = pdfmakeModule as { default?: unknown };
  const engine = (pdfmakeAny.default ?? pdfmakeAny) as unknown as {
    addVirtualFileSystem?: (vfs: Record<string, string>) => void;
    vfs?: Record<string, string>;
  } & { createPdf: (dd: TDocumentDefinitions) => PdfDocument };
  const vfsModule = fonts as unknown as {
    default?: { vfs?: Record<string, string> } | Record<string, string>;
  };
  const candidate: Record<string, unknown> = vfsModule.default ?? {};
  const vfs: Record<string, string> =
    typeof candidate['Roboto-Regular.ttf'] === 'string'
      ? (candidate as Record<string, string>)
      : ((candidate.vfs as Record<string, string> | undefined) ?? {});
  // The browser build keeps fonts in a module-level virtual FS that is only
  // populated via addVirtualFileSystem (engine.vfs is ignored there).
  if (typeof engine.addVirtualFileSystem === 'function') {
    engine.addVirtualFileSystem(vfs);
  } else {
    engine.vfs = vfs;
  }

  const document = engine.createPdf(definition);
  return document.getBlob();
}

/**
 * Generates the PDF blob; pdfmake is loaded on demand (heavy dependency).
 *
 * `generate` is the renderer seam `buildModulePdf` already takes: the default is
 * pdfmake, and a caller can observe the finished DEFINITION (the only place a
 * document is inspectable) without a second code path.
 */
export async function exportArtifactPdf(
  artifact: Artifact,
  template: PdfTemplate,
  generate: (definition: TDocumentDefinitions) => Promise<Blob> = generatePdfBlob,
): Promise<Blob> {
  const cover = await loadPdfCoverImage(artifact);
  // The async PRE-PASS, following `buildModulePdf`'s existing pattern: the
  // definition builders stay pure over rows plus already-resolved data, so a
  // cited creature's numbers and origin are resolved HERE and the render is a
  // pure function of them.
  const roster = template === 'gm' ? await resolveExportRoster(artifact) : [];
  // The spell corpus per system this artifact's blocks carry (docs/17 row
  // 184) — the same pre-pass `buildModulePdf` runs, through the same builder.
  const blocks: (StatBlock | null)[] = [];
  if (template === 'gm') {
    if (artifact.kind === 'npc' || artifact.kind === 'pc') blocks.push(artifact.data.statBlock);
    if (artifact.kind === 'encounter') {
      for (const monster of artifact.data.monsters) {
        blocks.push(rosterStatBlockFor(monster));
      }
    }
  }
  const spellIndexes = await loadSpellIndexesFor(statBlockSystems(blocks));
  const definition =
    template === 'gm'
      ? buildGmNotesDefinition(artifact, cover, roster, spellIndexes)
      : buildPlayerHandoutDefinition(artifact, cover);
  return generate(definition);
}

interface PdfDocument {
  /** pdfmake 0.3: callbacks are ignored; the returned promise is the API. */
  getBlob: (callback?: (blob: Blob) => void) => Promise<Blob>;
  getBuffer: (callback?: (buffer: ArrayBuffer) => void) => Promise<ArrayBuffer>;
}
