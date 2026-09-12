import type { Content, NamedStyle, TDocumentDefinitions } from 'pdfmake/interfaces';

import type { Artifact, StatBlock } from '@/domain';
import { abilityModifier, formatModifier, imageBlob, printsAbilityModifiers } from '@/domain';
import { getImage } from '@/db/imageRepo';
import { blobToScaledDataUrl } from '@/lib/imageIntake';
import { markdownToDisplayText } from '@/lib/markdown';
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

function labelValue(label: string, value: string): { columns: object[] } | null {
  if (value === '') return null;
  return {
    columns: [
      { text: `${label}:`, style: 'label', width: 110 },
      { text: value, style: 'value' },
    ],
  };
}

function listItems(items: string[]): object[] {
  return items.map((item) => ({ text: item, style: 'value' }));
}

function statBlockSection(statBlock: StatBlock): object[] {
  const named = (rows: { name: string; text: string }[]): object[] =>
    rows.map((row) => ({
      text: [{ text: `${row.name}. `, bold: true }, { text: row.text }],
      style: 'value',
    }));
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
  ];
}

function dataSections(artifact: Artifact): object[] {
  const sections: object[] = [];
  const add = (heading: string, rows: (object | null)[]): void => {
    const kept = rows.filter((row): row is object => row !== null);
    if (kept.length === 0) return;
    sections.push({ text: heading, style: 'heading' }, ...kept);
  };

  switch (artifact.kind) {
    case 'pc': {
      add('PC details', [
        labelValue('Player', artifact.data.playerName),
        labelValue('Current HP', String(artifact.data.currentHp)),
        labelValue(
          'Initiative bonus',
          artifact.data.initiativeOverride === null ? '' : String(artifact.data.initiativeOverride),
        ),
        labelValue('Notes', artifact.data.notes),
      ]);
      if (artifact.data.statBlock !== null) {
        sections.push(...statBlockSection(artifact.data.statBlock));
      }
      break;
    }
    case 'npc': {
      add('NPC details', [
        labelValue('Appearance', artifact.data.appearance),
        labelValue('Personality', artifact.data.personality),
      ]);
      if (artifact.data.statBlock !== null) {
        sections.push(...statBlockSection(artifact.data.statBlock));
      }
      break;
    }
    case 'location':
    case 'event': {
      add(artifact.kind === 'event' ? 'Event details' : 'Location details', [
        labelValue('Type', artifact.data.locationType),
        labelValue('Inhabitants', artifact.data.inhabitants),
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
        labelValue('Goals', artifact.data.goals),
        labelValue('Methods', artifact.data.methods),
        labelValue('Resources', artifact.data.resources),
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
        labelValue('Difficulty', artifact.data.difficulty),
        labelValue('Party level', artifact.data.levelHint),
        labelValue('Terrain', artifact.data.terrain),
        labelValue('Tactics', artifact.data.tactics),
        labelValue('Treasure', artifact.data.treasure),
        ...(artifact.data.monsters.length > 0
          ? [
              { text: 'Monsters', style: 'subheading' },
              ...artifact.data.monsters.map((monster) => ({
                text: [
                  { text: `${monster.name} ×${monster.count}: `, bold: true },
                  { text: monster.notes },
                ],
                style: 'value',
              })),
            ]
          : []),
      ]);
      break;
    }
    case 'plotarc': {
      add('Plot arc details', [
        labelValue('Arc type', artifact.data.arcType),
        labelValue('Premise', artifact.data.premise),
        labelValue('Stakes', artifact.data.stakes),
        labelValue('Climax', artifact.data.climax),
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
): TDocumentDefinitions {
  const doc = baseDoc(artifact);
  const content: Content[] = [doc.content].flat();
  if (cover !== undefined && cover !== null) content.push(coverImageNode(cover));
  if (artifact.summary !== '') content.push({ text: artifact.summary, style: 'meta' });
  content.push({
    text: artifact.body === '' ? '(no body)' : markdownToDisplayText(artifact.body),
    style: 'body',
  });
  content.push(...(dataSections(artifact) as Content[]));
  if (artifact.links.length > 0) {
    content.push({ text: 'Relations', style: 'heading' });
    content.push(...(listItems(artifact.links.map((link) => link.relation)) as Content[]));
  }
  return { ...doc, content };
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
  const slug =
    artifact.name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-+|-+$/g, '') || 'artifact';
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

/** Generates the PDF blob; pdfmake is loaded on demand (heavy dependency). */
export async function exportArtifactPdf(artifact: Artifact, template: PdfTemplate): Promise<Blob> {
  const cover = await loadPdfCoverImage(artifact);
  const definition =
    template === 'gm'
      ? buildGmNotesDefinition(artifact, cover)
      : buildPlayerHandoutDefinition(artifact, cover);
  return generatePdfBlob(definition);
}

interface PdfDocument {
  /** pdfmake 0.3: callbacks are ignored; the returned promise is the API. */
  getBlob: (callback?: (blob: Blob) => void) => Promise<Blob>;
  getBuffer: (callback?: (buffer: ArrayBuffer) => void) => Promise<ArrayBuffer>;
}
