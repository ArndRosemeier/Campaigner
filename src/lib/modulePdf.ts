import type { Content, ContentImage, Style, TDocumentDefinitions } from 'pdfmake/interfaces';

import type {
  AnyArtifact,
  ArtifactKind,
  Battle,
  DocumentPlanAudience,
  DocumentPlanRole,
  DocumentPlanSource,
  GameSystem,
  Id,
  MobSpellIndex,
  Module,
  MonsterEntry,
  StatBlock,
} from '@/domain';
import {
  abilityModifier,
  assembleModulePartsDocument,
  casterStatLine,
  documentPlanIssues,
  documentPlanSectionDestination,
  formatModifier,
  mobCasterLevel,
  mobSpellChipDetail,
  mobSpellChips,
  printsAbilityModifiers,
  readStoredDocumentPlan,
  splitPartsDocument,
  statBlockStatesNoSpellDc,
} from '@/domain';
import {
  missingCreatureOrigin,
  rosterReferenceFor,
  rosterStatBlockFor,
  rosterTreasureFor,
  stampedSourceLine,
  type ResolvedMonster,
} from '@/domain/encounterResolve';
import { listBattlesByModule } from '@/db/battleRepo';
import { resolveMonsterEntries } from '@/db/monsterResolve';
import { loadSpellIndexesFor, statBlockSystems } from '@/db/spellRepo';
import { extractWikiLinks, resolveWikiLink } from '@/lib/wikilinks';
import { mdToPdfmakeContent } from '@/lib/mdToPdfmake';
import { blockText, textBlocks } from '@/lib/textBlocks';
import {
  COLUMN_GUTTER,
  DETAIL_FONT_SIZE,
  MAIN_COLUMN_WIDTH,
  PAGE_CONTENT_WIDTH,
  PAGE_MARGIN,
  SIDEBAR_COLUMN_WIDTH,
  earlierDetailMarker,
  estimateHeight,
  isMarkerContent,
  paginateDocument,
  detailPlacement,
  type DocumentPage,
  type MeasureStyle,
  type PageBlock,
} from '@/lib/pdfPageModel';
import {
  NO_PDF_IMAGES,
  PDF_COVER_MAX_LONG_EDGE,
  PDF_MAP_MAX_LONG_EDGE,
  assertPdfmakeImageDataUrl,
  failureFor,
  imageDataUrlFor,
  loadPdfImages,
  type PdfImageCodec,
  type PdfImageRequest,
  type PdfImages,
} from '@/lib/pdfImages';

/**
 * Module PDF renderer (07-MILESTONE-3 M3-D, module-sourced since docs/17 row
 * 108): **the module IS the document.** There is no deliverable, no outline and
 * no second document-authoring model — the renderer reads the module's own
 * premise, its part plan, its parts (through the ONE parts-document seam) and
 * the artifacts its prose owns or mentions, and lays them out as an
 * adventure-module PDF: cover, generated ToC, part banners with kickers, boxed
 * read-aloud quotes, labeled per-kind sections, two-column stat boxes, map
 * plates at each encounter, the NPC gallery and the treasure ledger.
 *
 * THREE contracts shape every branch below:
 *
 * 1. **GM and player are ONE code path** with the audience an explicit render
 *    option (`ModulePdfInput.audience`). The player document omits the module's
 *    planning and secrets: GM-only-tagged artifacts, every `note`, encounter
 *    `tactics`/`treasure`, faction `methods`, PC `notes`, the part plan, the
 *    treasure ledger, and — the audit's finding recorded in docs/07 §M3-D —
 *    every `plotarc` chapter, because an arc's premise/stakes/beats/climax ARE
 *    the module's structural secrets (the shipped renderer printed them to
 *    players). Read-aloud boxes and public body prose survive in both.
 * 2. **A PDF renders the DISPLAY text of a wiki token, never the token**
 *    (docs/17 row 105): every body goes through `lib/mdToPdfmake`, which emits
 *    bold display runs.
 * 3. **Nothing fails silently** (AGENTS 1–2). An image that cannot be embedded
 *    prints a LOUD placeholder naming the site and the reason; a part section
 *    the parts-document seam refuses prints a LOUD placeholder; the closed set
 *    of problems rides back to the export surface, which reports them. The
 *    build itself never fails on missing data — a missing row or blob is a
 *    visible defect INSIDE the document, not a lost document.
 * 4. **An artifact's OWN image is the description's, not the plan's** (docs/17
 *    row 187). Its cover art and its map plate print wherever the artifact is
 *    described — the procedural chapter, the NPC gallery and a PLANNED section
 *    alike — through the ONE `artifactDetail`/`companionContent` seam, whatever
 *    ROLE the plan gave the section. The plan's `images` anchors stay
 *    meaningful as EXTRAS, never as the gate for the artifact's own artwork.
 * 5. **A section may introduce ONE COMPANION** (docs/17 row 188): the row whose
 *    profile prints in the section's sidebar BESIDE the story that introduces
 *    it. The companion is composed into the section's DETAIL through the SAME
 *    seam contract 4 names, so §10.1's once-rule, the role gate and the artwork
 *    rule apply to it unchanged; the PLANNER decides which introductions earn a
 *    sidebar (the owner's own delegation of that judgement call), and the page
 *    model still decides where the result fits.
 */

const ACCENT = '#9a7b4f';
const ALERT = '#b91c1c';

/** A map plate never exceeds this printed height (it then scales by width).
 * The WIDTH it prints at is the page's own content width (`pdfPageModel`
 * owns every geometry value, so the margins the page model sets and the box
 * a plate is allowed to fill cannot drift apart). */
const MAP_PLATE_MAX_HEIGHT = 660;

/** GM-only tag: artifacts tagged so are skipped for audience 'player'. */
const GM_ONLY_TAG = 'gm-only';

/** A loud, non-fatal problem the render knows about (never a silent drop). */
export interface ModulePdfProblem {
  /** The site, addressable by the owner, e.g. `the map of “Pier Ambush”`. */
  where: string;
  reason: string;
}

export type ModulePdfAudience = 'gm' | 'player';

/**
 * The renderer's input. Deliberately a bag. The LLM-authored document plan is
 * NOT one of these fields: it rides the MODULE ROW (`module.documentPlan`,
 * docs/17 row 109), so every caller — the export button, the campaign tree, a
 * test — gets the same document without passing anything new, and there is
 * exactly ONE reader of the stored plan (`resolveDocumentPlan` below).
 */
export interface ModulePdfInput {
  module: Module;
  /**
   * The rows the document may draw from: the campaign's artifacts plus the
   * shared library. The renderer scopes them itself (owned by this module, or
   * MENTIONED by its prose — `modulePdfArtifacts`), so a caller never decides
   * what is in the book.
   */
  artifacts: readonly AnyArtifact[];
  /** The module's battle, when one exists: its `board.mapImageId` is the map of
   * the encounter it was seeded from (one live battle per module). */
  battles?: readonly Battle[];
  /** Preloaded images (`loadPdfImages`); omitted ⇒ covers/maps print loudly. */
  images?: PdfImages;
  /** The GM document (default) or the player document. */
  audience?: ModulePdfAudience;
  /**
   * Per-encounter roster RESOLUTION (the async pre-pass in `buildModulePdf`):
   * encounter artifact id → one resolved monster per roster row, in order.
   *
   * It carries BOTH halves of what a roster row prints (docs/17 row 144): the
   * `origin` — the reference line, through the ONE formatter
   * `domain/encounterResolve.rosterReferenceFor` — and, for a cited creature,
   * the library chunk's own `statBlock`, which the row's stat box prints.
   *
   * Absent ⇒ every roster row still prints: an `inline` entry carries its own
   * block, an `npc-ref` still cross-references its row, and a `rulebook`
   * citation states loudly that THIS build resolved no origin for it — it never
   * falls back to a citation-shaped claim the document cannot honour (the
   * `(see Bestiary)` constant this replaced pointed at a chapter no module PDF
   * has; docs/17 row 108 amended by reference, row 144).
   */
  rosterResolution?: Readonly<Record<Id, readonly ResolvedMonster[]>>;
  /**
   * The imported spell corpus per game system, for a mob's spell CHIPS
   * (docs/17 row 184). Built by the async `buildModulePdf` pre-pass from the
   * systems the scoped stat blocks actually carry.
   *
   * OMITTED IS NOT "NO SPELLS": a stat block that carries `spells` and has no
   * index here prints a LOUD line saying so (a direct `buildModulePdfDocument`
   * caller never silently loses them), never an empty section.
   */
  spellIndexes?: ReadonlyMap<GameSystem, MobSpellIndex> | undefined;
  /**
   * When this document was compiled. Defaults to now, and it is PRINTED (the
   * cover's "Compiled with Campaigner · <date>") and pinned into the PDF's own
   * metadata at DAY granularity. Pass it to make a re-render byte-identical:
   * with a fixed instant, the same (module, plan, artifacts, images) produces
   * the same definition AND the same bytes — measured, see the determinism
   * test. Without it, a compile on another day is a different document,
   * because the printed date is part of the document.
   */
  compiledAt?: Date;
  /**
   * Why THIS build carries no freshly planned document (docs/17 row 139): set
   * by the export when its automatic planning step FAILED, and absent on every
   * other build. It is not a plan and it never becomes one — it is the report
   * of a failed attempt, and the renderer prints it IN the document (beside the
   * export's own loud toast) so a book produced without planning can never be
   * mistaken for the planned one (AGENTS rules 1–2). The plan itself still
   * comes off the module row and nowhere else.
   */
  planFailure?: string;
}

function isGmOnly(artifact: AnyArtifact): boolean {
  return artifact.tags.includes(GM_ONLY_TAG);
}

/** Small-caps kicker line above part/artifact headers ("Kapitel 2 · …"). */
function kicker(text: string): Content {
  return { text: text.toUpperCase(), style: 'kicker' };
}

/**
 * One labeled section — `Label: body` — with the body's OWN STRUCTURE honoured
 * (docs/17 row 146, docs/18 §2.3). `lib/textBlocks.textBlocks` is the ONE rule
 * for where a body's paragraphs are: each block becomes its own run, so a BLANK
 * line reads as a paragraph break, while a SINGLE newline stays a line break
 * INSIDE its run (pdfmake prints `\n` as a line break) — the two behaviours are
 * deliberately different and pinned apart. Before this, the whole body was one
 * run: the model's paragraphs arrived as the owner's *"big text blobs without
 * any paragraph"*.
 *
 * A single-block body is BYTE-IDENTICAL to what it printed before — ONE node,
 * the label run followed by the body run — so every existing definition and
 * every existing assertion is unchanged; only a body with several blocks (the
 * defect) gains the following paragraph runs, in source order.
 */
function labeledSection(label: string, body: string): Content | null {
  const blocks = textBlocks(body);
  if (blocks.length === 0) return null;
  const paragraphs = blocks.map(blockText);
  const first = paragraphs[0] ?? '';
  if (paragraphs.length === 1) {
    return {
      text: [
        { text: `${label}: `, bold: true, style: 'label' },
        { text: first },
      ],
      margin: [0, 0, 0, 3],
    };
  }
  return {
    stack: paragraphs.map(
      (paragraph, index): Content => ({
        text:
          index === 0
            ? [
                { text: `${label}: `, bold: true, style: 'label' },
                { text: paragraph },
              ]
            : { text: paragraph },
        margin: [0, 0, 0, 3],
      }),
    ),
  };
}

/** Pushes labeled sections, dropping null (empty) ones. */
function pushSections(out: Content[], ...items: (Content | null)[]): void {
  for (const item of items) {
    if (item !== null) out.push(item);
  }
}

const ALERT_BOX_LAYOUT = {
  hLineWidth: () => 1,
  vLineWidth: () => 1,
  hLineColor: () => ALERT,
  vLineColor: () => ALERT,
  paddingLeft: () => 8,
  paddingRight: () => 8,
  paddingTop: () => 6,
  paddingBottom: () => 6,
};

/**
 * The ONE loud box for something the document could not carry — a failed
 * image, a refused parts document, a dangling reference. Red-bordered, italic,
 * naming the site and the reason: a reader of the PDF must never have to guess
 * why a plate or a section is absent (AGENTS rule 1).
 */
/**
 * A statement the reader must not miss, in the page's own main column. It
 * carries NO page break: whether it stands on a page of its own is the page
 * model's decision, asked for by the block that holds it (row 148's rule, and
 * row 156 moved the remaining `pageBreak` arguments onto blocks).
 */
function alertBox(text: string): Content {
  return {
    table: { widths: ['*'], body: [[{ text, italics: true, color: ALERT }]] },
    layout: ALERT_BOX_LAYOUT,
    margin: [0, 4, 0, 6],
  };
}

/** An `image` node. The data URL is checked against pdfmake's registered
 * formats HERE, at the ONE place a data URL becomes an image node — an
 * unsupported one (a WebP data URL above all) throws a named error instead of
 * reaching pdfmake's synchronous image measurement. */
function assertImage(dataUrl: string, where: string): string {
  return assertPdfmakeImageDataUrl(dataUrl, where);
}

interface ImageNodeOptions {
  fit?: [number, number];
  alignment?: 'center';
  margin?: [number, number, number, number];
}

function imageNode(dataUrl: string, where: string, options: ImageNodeOptions): ContentImage {
  return { image: assertImage(dataUrl, where), ...options };
}

/**
 * A mob's spells, as the SAME bytes the in-app chip's detail shows (docs/17 row
 * 184): every line is `domain/mobSpells.mobSpellChipDetail` over the ONE
 * resolver, at the cast rank the heightening rule computes for this block's own
 * level. An unresolved name prints in the alert colour with the name visible —
 * never blank, never dropped.
 *
 * A block that CARRIES spells but has no index for its system (a direct
 * `buildModulePdfDocument` caller) is not silently empty: the section states
 * that this build resolved nothing, so the omission is visible in the book.
 */
export function spellBoxSection(
  statBlock: StatBlock,
  spellIndexes: ReadonlyMap<GameSystem, MobSpellIndex> | undefined,
): Content[] {
  const spells = statBlock.spells;
  if (spells === null || spells === undefined || spells.length === 0) return [];
  const index = spellIndexes?.get(statBlock.system);
  if (index === undefined) {
    return [
      {
        text: `Spells: this build resolved none of the ${String(spells.length)} spell(s) this creature carries — re-export from the app.`,
        color: ALERT,
      },
    ];
  }
  return mobSpellChips(spells, mobCasterLevel(statBlock.level), index).map((chip): Content => ({
    text: mobSpellChipDetail(chip).replace(/\n/g, ' · '),
    ...(chip.resolved && chip.result !== null ? {} : { color: ALERT }),
    margin: [0, 0, 0, 2],
  }));
}

/**
 * The caster line a PRINTED stat box carries (docs/17 row 201) — the SAME bytes
 * `domain/statblock.casterStatLine` gives the in-app card, so the book and the
 * screen cannot disagree about a mob's spell DC. A caster that states no DC
 * prints the LOUD marker in the alert colour (never a computed number); a
 * mundane or legacy block returns `[]` and its box is unchanged.
 */
export function casterBoxSection(statBlock: StatBlock): Content[] {
  const line = casterStatLine(statBlock);
  if (line === null) return [];
  return [
    {
      text: line,
      ...(statBlockStatesNoSpellDc(statBlock) ? { color: ALERT, bold: true } : {}),
      margin: [0, 0, 0, 2],
    },
  ];
}

/**
 * Bordered two-column stat box (M2 export layout, module styling).
 *
 * THE box every roster surface prints — `inline` and a CITED library creature
 * alike (docs/17 row 144) — so a printed mob's numbers are the same block
 * wherever they appear and the single-artifact exporter can never print a
 * different one. Every section a block may carry prints: traits, actions,
 * REACTIONS, LEGENDARY actions and `extras` (a PF2e-style block without its
 * reactions is not usable at the table, and the owner decided a printed mob must
 * be).
 *
 * `source`: the resolved origin of a CITED creature. A box standing for numbers
 * the book took from somewhere else says so — a reader must be able to tell
 * whose numbers these are without turning back to the roster line.
 */
export function statBoxContent(
  statBlock: StatBlock,
  name: string,
  source?: string,
  spellIndexes?: ReadonlyMap<GameSystem, MobSpellIndex>,
): Content {
  const spells = spellBoxSection(statBlock, spellIndexes);
  // The caster line (docs/17 row 201) prints ABOVE the spell chips: the GM
  // needs the DC before the spell descriptions. Empty for a non-caster.
  const caster = casterBoxSection(statBlock);
  const left: Content[] = [
    {
      text: [statBlock.size, statBlock.creatureType, statBlock.level]
        .filter((part) => part !== '')
        .join(', '),
    },
    {
      text: [
        { text: 'AC ', bold: true },
        { text: `${statBlock.ac}${statBlock.acNote === '' ? '' : ` (${statBlock.acNote})`}` },
        { text: '  HP ', bold: true },
        { text: `${statBlock.hp}${statBlock.hpFormula === '' ? '' : ` (${statBlock.hpFormula})`}` },
        { text: '  Speed ', bold: true },
        { text: statBlock.speed },
      ],
      margin: [0, 4, 0, 4],
    },
  ];
  // Per-system ability display (docs/12 §5): a Pathfinder 2e stat box prints
  // the signed BONUS — printing its stored d20 score would be a number no PF2e
  // reader uses. Every other system's compact score line is unchanged.
  const abilities = Object.entries(statBlock.abilities)
    .map(([key, value]) =>
      printsAbilityModifiers(statBlock.system)
        ? `${key.toUpperCase()} ${formatModifier(abilityModifier(value))}`
        : `${key.toUpperCase()} ${value}`,
    )
    .join('  ');
  const right: Content[] = [
    { text: abilities },
    labeledSection('Saves', statBlock.saves),
    labeledSection('Skills', statBlock.skills),
    labeledSection('Senses', statBlock.senses),
    labeledSection('Languages', statBlock.languages),
    ...Object.entries(statBlock.extras).map(
      ([label, value]): Content | null => labeledSection(label, value),
    ),
  ].filter((entry): entry is Content => entry !== null);
  /** One full-width section of named entries (traits → reactions). */
  const namedSection = (rows: readonly { name: string; text: string }[]): Content[] =>
    rows.map(
      (row): Content => labeledSection(row.name, row.text) ?? { text: row.text },
    );
  const box: Content = {
    table: {
      widths: ['*', '*'],
      body: [
        [{ colSpan: 2, text: name, bold: true, style: 'h3' }, ''],
        ...(source === undefined
          ? []
          : [
              [
                {
                  colSpan: 2,
                  text: `Numbers from ${source}`,
                  italics: true,
                  style: 'label',
                },
                '',
              ],
            ]),
        [left, right],
        [
          {
            colSpan: 2,
            stack: namedSection(statBlock.traits),
          },
          '',
        ],
        [
          {
            colSpan: 2,
            stack: namedSection(statBlock.actions),
          },
          '',
        ],
        [
          {
            colSpan: 2,
            stack: namedSection(statBlock.reactions),
          },
          '',
        ],
        [
          {
            colSpan: 2,
            stack: namedSection(statBlock.legendary),
          },
          '',
        ],
        ...(caster.length === 0
          ? []
          : [
              [
                {
                  colSpan: 2,
                  stack: caster,
                },
                '',
              ],
            ]),
        ...(spells.length === 0
          ? []
          : [
              [
                {
                  colSpan: 2,
                  stack: spells,
                },
                '',
              ],
            ]),
      ],
    },
    layout: {
      hLineWidth: () => 1,
      vLineWidth: () => 1,
      hLineColor: () => ACCENT,
      vLineColor: () => ACCENT,
      paddingLeft: () => 6,
      paddingRight: () => 6,
      paddingTop: () => 4,
      paddingBottom: () => 4,
    },
    margin: [0, 6, 0, 6],
  };
  return box;
}

/** The module's prose, in the order a reader meets it (premise, then parts). */
function moduleProse(module: Module): string[] {
  const parts = [...module.parts].sort((a, b) => a.planIndex - b.planIndex);
  return [module.spine?.premise ?? '', ...parts.map((part) => part.markdown)].filter(
    (text) => text.trim() !== '',
  );
}

/**
 * First-mention order of the artifacts the module's prose names: artifact id →
 * its index in the order the wiki-links appear (premise, then parts). THE one
 * ordering rule — the document follows the narrative the module was written in,
 * not the alphabet.
 */
export function moduleMentionOrder(
  module: Module,
  artifacts: readonly AnyArtifact[],
): Map<Id, number> {
  const order = new Map<Id, number>();
  let index = 0;
  for (const text of moduleProse(module)) {
    for (const link of extractWikiLinks(text)) {
      // The READER'S resolver over the reader's pool, module tier included, so
      // the document and the wiki chips can never name different rows.
      const resolved = resolveWikiLink(link.name, artifacts, { moduleId: module.id });
      const artifact = resolved.artifact;
      if (artifact === undefined || order.has(artifact.id)) continue;
      order.set(artifact.id, index);
      index += 1;
    }
  }
  return order;
}

/**
 * The artifacts the module's PDF may carry (the ONE scope rule, replacing the
 * outline's "explicitly named" test): rows the module OWNS (`moduleId` is this
 * module) plus rows its prose MENTIONS. Ordered by first mention, then by name,
 * so a row no prose names (an owned orphan) has a deterministic place at the
 * end of its kind.
 */
export function modulePdfArtifacts(
  module: Module,
  artifacts: readonly AnyArtifact[],
): AnyArtifact[] {
  const mentionOrder = moduleMentionOrder(module, artifacts);
  const byId = new Map<Id, AnyArtifact>();
  for (const artifact of artifacts) {
    if (artifact.moduleId === module.id) byId.set(artifact.id, artifact);
  }
  for (const artifact of artifacts) {
    if (byId.has(artifact.id)) continue;
    if (mentionOrder.has(artifact.id)) byId.set(artifact.id, artifact);
  }
  return [...byId.values()].sort((a, b) => {
    const left = mentionOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const right = mentionOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (left !== right) return left - right;
    return a.name.localeCompare(b.name);
  });
}

/** The map image id of an encounter: its own, else its battle's board map. */
export function encounterMapImageId(encounter: AnyArtifact, battles: readonly Battle[]): Id | null {
  if (encounter.kind !== 'encounter') return null;
  if (encounter.data.mapImageId !== null) return encounter.data.mapImageId;
  const battle = battles.find((entry) => entry.encounterArtifactId === encounter.id);
  return battle?.board.mapImageId ?? null;
}

/** One image an artifact carries OF ITS OWN, with what the image IS — which the
 * RENDERER decides (a map prints as a plate, a cover as art), never the plan. */
interface ArtifactOwnImage {
  id: Id;
  kind: 'map' | 'cover';
  /** The addressable site, e.g. `the map of “Pier Ambush”`. */
  where: string;
}

/**
 * An artifact's OWN images — its cover, and (for an encounter) its map plate.
 * THE one derivation of "which pictures does this row bring, and what are
 * they", read by THREE callers that must agree (docs/17 row 187):
 *
 * - the placement decision: a non-empty answer is `hasImage` (docs/19 §4 — an
 *   image needs the page);
 * - the plan-anchor filter in `plannedSectionBlock`: an anchor naming one of
 *   these is redundant, because the artwork rides the artifact's description;
 * - `imageInventories`: this IS the artifact half of the ONE preload list, so
 *   the loaded set, the printed set and the placement decision are one
 *   derivation rather than three that can drift.
 */
function artifactOwnImages(artifact: AnyArtifact, battles: readonly Battle[]): ArtifactOwnImage[] {
  const images: ArtifactOwnImage[] = [];
  if (artifact.coverImageId !== null) {
    images.push({ id: artifact.coverImageId, kind: 'cover', where: `the cover of “${artifact.name}”` });
  }
  const mapImageId = encounterMapImageId(artifact, battles);
  if (mapImageId !== null) {
    images.push({ id: mapImageId, kind: 'map', where: `the map of “${artifact.name}”` });
  }
  return images;
}

/**
 * Every image the document wants, with the budget each one prints at. Maps get
 * `PDF_MAP_MAX_LONG_EDGE` (a battlemap must survive print at the intake cap);
 * covers keep the `PDF_COVER_MAX_LONG_EDGE` file-size discipline. THE one
 * producer of image requests, so what the loader preloads and what the renderer
 * places can never disagree.
 */
export function modulePdfImageRequests(input: {
  module: Module;
  artifacts: readonly AnyArtifact[];
  battles?: readonly Battle[];
}): PdfImageRequest[] {
  return imageInventories({
    module: input.module,
    scoped: modulePdfArtifacts(input.module, input.artifacts),
    battles: input.battles ?? [],
  }).requests;
}

/** The parts of the module, split through the ONE parts-document seam. */
interface RenderedPart {
  planIndex: number;
  title: string;
  levelBand: string;
  text: string;
}

// --- The document plan (docs/17 row 109) ------------------------------------

/**
 * One image a plan anchors: the id, and what the image IS — which the RENDERER
 * decides (a map prints as a plate, a cover as art), never the plan.
 */
interface PlannedImage {
  id: Id;
  kind: 'map' | 'cover';
  /** The addressable site, e.g. `the map of “Pier Ambush”`. */
  where: string;
}

/** One plan section, reference-checked and resolved against live rows. */
interface PlannedSection {
  title: string;
  role: DocumentPlanRole;
  audience: DocumentPlanAudience;
  source: DocumentPlanSource;
  images: readonly PlannedImage[];
  /** The section's stable pdfmake destination (`node-plan-<index>`). */
  destination: string;
  /** The artifact this section prints, when its source names one. */
  artifact: AnyArtifact | null;
  /**
   * The ONE row this section INTRODUCES in its sidebar (docs/17 row 188), or
   * `null` for the overwhelmingly normal case. Resolved from the plan's
   * `companion` reference, which `documentPlanIssues` already proved exists and
   * is neither an encounter nor the section's own source.
   */
  companion: AnyArtifact | null;
}

/**
 * What the module row's plan means for THIS document. Four outcomes, and the
 * difference between the last two is the whole failure contract:
 *
 * - `absent` — no plan stored (or `null`): the PROCEDURAL outline, silently.
 *   This is the normal state, not a failure.
 * - `invalid` — a stored value that is not a plan at all: LOUD.
 * - `rejected` — a well-formed plan naming a part, artifact, encounter or
 *   image the module does not have (it went stale, or the model invented one):
 *   LOUD, and NOTHING from the plan is rendered.
 * - `applied` — every reference checked out; the sections below are the
 *   document's body, in plan order.
 */
type DocumentPlanOutcome =
  | { status: 'absent' }
  | { status: 'invalid'; reason: string }
  | { status: 'rejected'; reason: string }
  | { status: 'applied'; sections: readonly PlannedSection[] };

/** The named problem site for a plan this document could not apply. */
const PLAN_PROBLEM_WHERE = 'the document plan';

/** Every image the document could print, by id: budget + site + what it IS. */
function imageInventories(input: {
  module: Module;
  scoped: readonly AnyArtifact[];
  battles: readonly Battle[];
}): { byId: Map<Id, PlannedImage>; requests: PdfImageRequest[] } {
  const byId = new Map<Id, PlannedImage>();
  const requests: PdfImageRequest[] = [];
  const { module, scoped, battles } = input;
  const add = (
    id: Id,
    kind: 'map' | 'cover',
    where: string,
    maxLongEdge: number,
  ): void => {
    requests.push({ id, maxLongEdge, where });
    // First classification wins: an id used as BOTH a cover and a map (the same
    // row referenced twice) prints as the plate, which is the larger treatment
    // and the one a battlemap needs.
    const existing = byId.get(id);
    if (existing === undefined || (existing.kind === 'cover' && kind === 'map')) {
      byId.set(id, { id, kind, where });
    }
  };
  if (module.coverImageId !== null) {
    add(
      module.coverImageId,
      'cover',
      `the cover of “${module.title}”`,
      PDF_COVER_MAX_LONG_EDGE,
    );
  }
  for (const artifact of scoped) {
    for (const image of artifactOwnImages(artifact, battles)) {
      add(
        image.id,
        image.kind,
        image.where,
        image.kind === 'map' ? PDF_MAP_MAX_LONG_EDGE : PDF_COVER_MAX_LONG_EDGE,
      );
    }
  }
  return { byId, requests };
}

/**
 * Reads the module's stored plan and turns it into renderable sections — THE
 * one reader, used by the definition builder (which renders) and by the plan
 * INSPECTOR. It is NOT the preloader's source any more (docs/17 row 187): what
 * the document prints is no longer a subset of what the plan anchored, so the
 * preloader takes `imageInventories` — the SAME set the renderer draws from.
 */
export function resolveDocumentPlan(input: {
  module: Module;
  scoped: readonly AnyArtifact[];
  battles: readonly Battle[];
}): DocumentPlanOutcome {
  const { module, scoped, battles } = input;
  const stored = readStoredDocumentPlan(module.documentPlan);
  if (stored.status === 'absent') return { status: 'absent' };
  if (stored.status === 'invalid') {
    return {
      status: 'invalid',
      reason: `the stored plan is not a valid document plan (${stored.reason})`,
    };
  }
  const images = imageInventories({ module, scoped, battles });
  const issues = documentPlanIssues(stored.plan.sections, {
    partPlan: module.spine?.partPlan ?? [],
    hasPremise: (module.spine?.premise ?? '').trim() !== '',
    artifacts: scoped,
    imageIds: [...images.byId.keys()],
  });
  if (issues.length > 0) {
    return {
      status: 'rejected',
      reason: issues.map((issue) => `${issue.where} — ${issue.reason}`).join('; '),
    };
  }
  const byId = new Map(scoped.map((artifact) => [artifact.id, artifact]));
  return {
    status: 'applied',
    sections: stored.plan.sections.map((section, index) => ({
      title: section.title,
      role: section.role,
      audience: section.audience,
      source: section.source,
      images: section.images.map((imageId) => {
        const image = images.byId.get(imageId);
        // The reference check above proved every anchor exists, so this is
        // total for an applied plan; the fallback keeps the type honest.
        return image ?? { id: imageId, kind: 'cover' as const, where: `image ${imageId}` };
      }),
      destination: documentPlanSectionDestination(index),
      artifact: section.source.type === 'part' ? null : (byId.get(section.source.artifactId) ?? null),
      // The reference check above proved a named companion exists, so this is
      // total for an applied plan; `?? null` keeps the type honest for a
      // section with no companion at all (absent or explicit `null`).
      companion:
        section.companion === null || section.companion === undefined
          ? null
          : (byId.get(section.companion.artifactId) ?? null),
    })),
  };
}

/** The one-line statement a document carries when its plan could not be used. */
function planFallbackStatement(reason: string): string {
  return (
    'This document was laid out from the procedural outline: the module’s document plan ' +
    `could not be applied — ${reason}. Regenerate it from the module’s “Document plan” ` +
    'surface to print the planned document.'
  );
}

/**
 * The statement a document carries when the plan placed artifacts the module's
 * own text never refers to (docs/17 row 148, the owner's decision).
 *
 * WHY THEY ARE NOT PRINTED. Since docs/19 the artifact's mechanics are a
 * COMPANION: they sit in the sidebar of the page whose text refers to them, or
 * on their own page right after it. An artifact nothing refers to has no such
 * page — there is no "where it is referred to" to place it at — and the owner's
 * answer to docs/19 §10's third OPEN question is that it is DROPPED rather than
 * scattered to the back (which is the one thing §4 forbids).
 *
 * WHY THIS SENTENCE EXISTS. §9's rule binds whatever the answer is: *"any
 * promotion, continuation or omission is visible in the document and
 * diagnosable afterwards"*. So an omission is never a silent disappearance —
 * the reader is told which rows were planned and why they are not here, and the
 * export's own problem list carries the same fact with the same site name.
 */
function omittedArtifactsStatement(omitted: readonly AnyArtifact[]): string {
  const names = omitted.map((artifact) => `“${artifact.name}”`).join(', ');
  const verb = omitted.length === 1 ? 'is' : 'are';
  return (
    `Not placed: ${names} ${verb} named by the module’s document plan, but nothing in the ` +
    'module’s own text refers to ' +
    (omitted.length === 1 ? 'it' : 'them') +
    ' — so there is no page for ' +
    (omitted.length === 1 ? 'it' : 'them') +
    ' to sit beside. Reference ' +
    (omitted.length === 1 ? 'it' : 'them') +
    ' in the module’s prose (or remove ' +
    (omitted.length === 1 ? 'it' : 'them') +
    ' from the plan) and export again.'
  );
}

/**
 * The statement a document carries when the export's AUTOMATIC planning failed
 * (docs/17 row 139). Two sentences, because the two outcomes are different
 * documents and a reader must be able to tell them apart: with a stored plan
 * still on the row the book is the LAST planned one, without one it is the
 * procedural outline. Either way the reason is named verbatim.
 */
function planFailureStatement(planApplied: boolean, reason: string): string {
  const head = planApplied
    ? 'This document was laid out from the module’s LAST STORED document plan'
    : 'This document was laid out from the procedural outline';
  return (
    `${head}: the automatic planning step for this export failed — ${reason}. ` +
    'Regenerate the plan from the module’s “Document plan” surface and export again.'
  );
}

function renderedParts(module: Module, problems: ModulePdfProblem[]): RenderedPart[] {
  const spine = module.spine;
  if (spine === null) {
    problems.push({
      where: 'the parts of the module',
      reason: 'the module has no part plan yet (the spine pass has not run)',
    });
    return [];
  }
  const plan = spine.partPlan;
  try {
    // The whole-module DOCUMENT, split with the seam the canvas owns: the
    // `==========` separators and the `[Part n of total]` labels are
    // scaffolding and never reach a PDF, and a section whose text FAKES a
    // label fails the split loudly rather than printing the scaffolding.
    const { document } = assembleModulePartsDocument({
      partPlan: plan,
      parts: module.parts.map((part) => ({ planIndex: part.planIndex, markdown: part.markdown })),
    });
    return splitPartsDocument(document, plan).map((section) => ({
      planIndex: section.planIndex,
      title: plan[section.planIndex]?.title ?? section.title,
      levelBand: plan[section.planIndex]?.levelBand ?? '',
      text: section.text,
    }));
  } catch (error) {
    problems.push({
      where: 'the parts of the module',
      reason: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** Render context shared by every artifact body. */
interface RenderState {
  input: ModulePdfInput;
  audience: ModulePdfAudience;
  /**
   * Every artifact the document actually prints → the pdfmake destination id
   * it prints AT. Internal cross-references are emitted only for a destination
   * that exists (pdfmake throws otherwise), so this is the ONE place that
   * decides linkability — in the procedural document an artifact's id IS its
   * destination (`node-<id>`), while a planned section is addressed by its
   * section (`node-plan-<index>`), because a plan may name one row twice.
   */
  destinations: ReadonlyMap<Id, string>;
  byId: ReadonlyMap<Id, AnyArtifact>;
  problems: ModulePdfProblem[];
  /**
   * The document's `styles` dictionary, for the ONE height estimator the page
   * model runs (`lib/pdfPageModel.estimateHeight`). It is here because the
   * styles are declared by THIS builder and the estimator must read the same
   * type sizes the renderer prints — a second copy of the tiers would let the
   * arithmetic measure a document nobody prints.
   */
  measureStyles: Readonly<Record<string, MeasureStyle>>;
  /**
   * Every artifact the document prints → the places in the DOCUMENT'S OWN TEXT
   * that refer to it (docs/19 §7). Built once, from the same reader's rule that
   * decides placement, so an artifact's back-references and its locality can
   * never disagree.
   */
  referenceSites: ReadonlyMap<Id, readonly ReferenceSite[]>;
  /**
   * The destination a wiki-link's NAME prints at, resolved through the reader's
   * own rule (`lib/wikilinks.resolveWikiLink`) against the same pool the wiki
   * chips resolve against — THE one answer every body of the document links by
   * (docs/19 §7's first bullet). `undefined` ⇒ no destination in this document,
   * so the run stays the bold display text it always was (pdfmake throws on a
   * dangling `linkToDestination`).
   */
  wikiDestination: (name: string) => string | undefined;
  /**
   * The companion already printed, by artifact id (docs/19 §10.1). Mutable by
   * design and per BUILD: "prints once" is a fact about one document, never
   * about a stored row.
   */
  companionsPrinted: Map<Id, string>;
  /**
   * The imported spell corpus per game system (docs/17 row 184), for a mob's
   * spell chips. Empty ⇒ a block that carries spells prints the loud
   * "not resolved for this build" line.
   */
  spellIndexes: ReadonlyMap<GameSystem, MobSpellIndex>;
}

/**
 * ONE place in the document's own text where a row is referred to — the unit
 * docs/19 §7's *"Every artifact section states where it is referenced from"* is
 * made of.
 */
export interface ReferenceSite {
  /** The name the place carries IN THE DOCUMENT: a section's (or part's) title,
   * or the derived `Referenced from` label. */
  label: string;
  /** The pdfmake destination that place prints at. */
  destination: string;
  /** The place's own text — what the ONE reference rule is applied to. */
  text: string;
}

/**
 * docs/19 §7, DERIVED: the places in the document's own text whose wiki-links
 * name this row, in document order.
 *
 * THE one rule, and deliberately the SAME one the document already asks "does
 * anything refer to this row?" with — `moduleMentionOrder`, which is what the
 * owner's §10.3 omission decision and the document's scope are computed from:
 * `extractWikiLinks` over the place's text, resolved by the reader's own
 * resolver (`lib/wikilinks.resolveWikiLink`) against the reader's own pool,
 * module tier included. Stated precisely, because the two are easy to confuse:
 * the PLACEMENT TIER is §4/§5's arithmetic (`detailPlacement`, kind + image +
 * measured height) and does not read references at all — §4's "after the text
 * that first refers to it" is realized by the plan's own section ORDER. What
 * this shares with placement is the ORDER the document is built in, not a
 * formula: a second "is this row mentioned" rule here would let a row be
 * dropped as unreferenced while its own back-reference line named the sentence
 * that refers to it.
 *
 * The places are only the MODULE'S OWN TEXT (premise, parts), never another
 * artifact section: §7 asks where the artifact is referred to FROM, and the
 * module's prose is where a reader meets it.
 */
export function referenceSitesFor(
  artifact: AnyArtifact,
  sites: readonly ReferenceSite[],
  module: Module,
  artifacts: readonly AnyArtifact[],
): ReferenceSite[] {
  return sites.filter((site) =>
    extractWikiLinks(site.text).some(
      (link) =>
        resolveWikiLink(link.name, artifacts, { moduleId: module.id }).artifact?.id ===
        artifact.id,
    ),
  );
}

/**
 * §7's back-reference line, as content: `Referenced from: <place> · <place>`,
 * every place an INTERNAL LINK to where it prints. It is appended to the
 * artifact section's own text column, because §7 binds the SECTION to state it
 * and NOT every artifact section has a companion to state it in — a
 * `read-aloud`/`aside` section can carry no mechanics by role (docs/17 row 187
 * still lets it carry its artifact's own picture), and an artifact section must
 * not lose its back-references because of the role the plan chose for it.
 *
 * A row the document's own text never names gets NO line: there is nothing to
 * state (and the procedural outline may legitimately print such a row, docs/19
 * §10 question 3's two limits).
 */
function referencedFromContent(artifact: AnyArtifact, state: RenderState): Content[] {
  const sites = state.referenceSites.get(artifact.id) ?? [];
  if (sites.length === 0) return [];
  const runs: Content[] = [{ text: 'Referenced from: ', bold: true }];
  sites.forEach((site, index) => {
    if (index > 0) runs.push({ text: ' · ' });
    runs.push({ text: site.label, linkToDestination: site.destination });
  });
  return [{ text: runs, style: 'muted', margin: [0, 4, 0, 0] }];
}

/**
 * docs/19 §10.1, the owner's own answer — *"ONCE, with a link back"*: the ONE
 * rule for a companion that would print a second time.
 *
 * The FIRST section that actually carries the artifact's MECHANICS prints them
 * and is recorded; every later one prints the §5-shaped pointer instead,
 * LINKED to where they printed. The record is taken only when mechanics are
 * really emitted: a section whose role carries none (`read-aloud`, `aside`)
 * must not claim the row and then point a reader at a sidebar that holds
 * nothing — the artifact's mechanics would print NOWHERE, which §10's second
 * answer ("the document is COMPLETE") forbids.
 *
 * WHAT IT IS *NOT* ABOUT (docs/17 row 187): the artifact's own ARTWORK. Its
 * cover and its map plate belong to the artifact's DESCRIPTION, so they print
 * at EVERY place the artifact is described, whatever the role decided
 * (`companionContent` composes the two — artwork first, then this rule's
 * mechanics).
 */
function companionOnce(input: {
  artifact: AnyArtifact;
  destination: string;
  detail: Content[];
  state: RenderState;
}): Content[] {
  if (input.detail.length === 0) return input.detail;
  const earlier = input.state.companionsPrinted.get(input.artifact.id);
  if (earlier === undefined) {
    input.state.companionsPrinted.set(input.artifact.id, input.destination);
    return input.detail;
  }
  return [earlierDetailMarker(input.artifact.name, earlier)];
}

/**
 * The companion ONE artifact description emits, with BOTH rules applied in ONE
 * place (docs/17 row 187) so the procedural chapter, the gallery and a planned
 * section cannot disagree about what an artifact's detail is:
 *
 * - **`artwork` always prints** — the artifact's OWN cover and its map plate
 *   (docs/19 §4: an image is a full-width item, which is why the caller's
 *   `hasImage` is computed from the same fact). It is the description's, never
 *   the plan's to gate.
 * - **`mechanics` print through §10.1's `companionOnce`** — the half a REPEATED
 *   description replaces with a link back, and the half a `read-aloud`/`aside`
 *   role suppresses (`roleDetail`).
 */
function companionContent(input: {
  artifact: AnyArtifact;
  destination: string;
  detail: { artwork: Content[]; mechanics: Content[] };
  state: RenderState;
}): Content[] {
  return [
    ...input.detail.artwork,
    ...companionOnce({
      artifact: input.artifact,
      destination: input.destination,
      detail: input.detail.mechanics,
      state: input.state,
    }),
  ];
}

/**
 * A roster row's reference AS PRINTED — the ONE run every roster reference goes
 * through (`domain/encounterResolve.rosterReferenceFor` decides WHAT it says,
 * docs/17 row 144). Two styling outcomes, never a second rule:
 *
 * - the named missing-ref reason is LOUD (italics + the alert colour);
 * - an internal cross-reference keeps its `linkToDestination`, emitted only for
 *   a row this document actually prints (pdfmake throws on a dangling one);
 * - everything else is the formatter's plain text.
 *
 * No reference at all (an `inline` entry) is an EMPTY run: its stat box prints
 * immediately below and an origin line there would contradict it.
 */
function referenceRun(
  entry: MonsterEntry,
  resolved: ResolvedMonster | undefined,
  artifactId: Id | null,
  state: RenderState,
): Content[] {
  const target = artifactId === null ? undefined : state.byId.get(artifactId);
  const destination = target === undefined ? undefined : state.destinations.get(target.id);
  const reference = rosterReferenceFor(
    entry,
    resolved,
    target === undefined || destination === undefined
      ? undefined
      : { name: target.name, destination },
  );
  if (reference.printed === '') return [];
  if (reference.link !== undefined) {
    // The SAME characters the formatter's `printed` carries (` — see <name>`),
    // with the name LINKED — the document composes runs, it never rewords the
    // rule.
    return [
      { text: ' — see ', italics: true },
      { text: reference.link.name, italics: true, linkToDestination: reference.link.destination },
    ];
  }
  // A resolved citation is a plain label; the named missing-ref reason and the
  // no-citation statement are the document TELLING the GM something is wrong,
  // so they stay loud.
  const loud = entry.source.type === 'none' || resolved?.statBlock == null;
  return [
    {
      text: reference.printed,
      italics: true,
      ...(loud ? { color: entry.source.type === 'none' ? '#555555' : ALERT } : {}),
    },
  ];
}

/** Per-kind labeled data sections (the book's description → creatures → …). */
function dataSections(artifact: AnyArtifact, state: RenderState): Content[] {
  const out: Content[] = [];
  const player = state.audience === 'player';
  if (artifact.kind === 'pc') {
    // M5-A: the player variant renders the PC card (name, portrait, HP) with
    // no notes — notes may carry secrets and never reach the player PDF.
    pushSections(
      out,
      labeledSection('Current HP', String(artifact.data.currentHp)),
      player ? null : labeledSection('Notes', artifact.data.notes),
    );
    if (artifact.data.statBlock !== null) {
      pushSections(
        out,
        statBoxContent(artifact.data.statBlock, artifact.name, undefined, state.spellIndexes),
      );
    }
  } else if (artifact.kind === 'npc') {
    pushSections(
      out,
      labeledSection('Appearance', artifact.data.appearance),
      labeledSection('Personality', artifact.data.personality),
    );
    if (artifact.data.statBlock !== null) {
      pushSections(
        out,
        statBoxContent(artifact.data.statBlock, artifact.name, undefined, state.spellIndexes),
      );
    }
  } else if (artifact.kind === 'faction') {
    pushSections(
      out,
      labeledSection('Goals', artifact.data.goals),
      player ? null : labeledSection('Methods', artifact.data.methods),
      labeledSection('Resources', artifact.data.resources),
      ...artifact.data.ranks.map((rank): Content | null =>
        labeledSection(rank.title, rank.description),
      ),
    );
  } else if (artifact.kind === 'location' || artifact.kind === 'event') {
    // The audit's C4: the module PDF dropped location/event structured data
    // while the single-artifact export rendered it.
    pushSections(
      out,
      labeledSection('Type', artifact.data.locationType),
      labeledSection('Inhabitants', artifact.data.inhabitants),
      ...artifact.data.pointsOfInterest.map((point): Content | null =>
        labeledSection(point.name, point.description),
      ),
      ...artifact.data.hooks.map(
        (hook): Content => ({ text: [{ text: 'Hook: ', bold: true }, { text: hook }] }),
      ),
    );
  } else if (artifact.kind === 'encounter') {
    pushSections(
      out,
      monsterHeaderKicker(artifact.data.difficulty, artifact.data.levelHint),
      ...artifact.data.monsters.map((monster, index): Content => {
        const resolved = state.input.rosterResolution?.[artifact.id]?.[index];
        // THE box rule and THE reference rule, both shared with the
        // single-artifact exporter (docs/17 row 144): a CITED creature prints
        // the library's own numbers and the reference NAMES where they came
        // from. A citation whose chunk carries no parseable block resolves to
        // `null` — then no box prints at all, and the named missing-ref line
        // above the notes stands alone (never an empty or invented block).
        const statBlock = rosterStatBlockFor(monster);
        // THE treasure rule, shared with the single-artifact export and the
        // reader's roster row (docs/17 row 159): what ONE instance carries is
        // authored on the roster entry, and `rosterTreasureFor` decides whether
        // there is anything to print at all. `null` prints NOTHING — no line and
        // no label standing over a blank value (AGENTS rule 1).
        //
        // GM ONLY, like the encounter's own `Treasure` line below: mob treasure
        // is a GM checklist (`docs/11 §Room keys`, the token card's own rule), so
        // the player document carries none of it — never in the section and
        // never in the ledger, which the player export drops whole.
        const treasure = player ? null : rosterTreasureFor(monster);
        return {
          stack: [
            {
              text: [
                { text: monster.name, bold: true },
                { text: ` ×${monster.count}` },
                ...referenceRun(
                  monster,
                  resolved,
                  monster.source.type === 'npc-ref' ? monster.source.artifactId : null,
                  state,
                ),
              ],
            },
            ...(monster.notes === '' ? [] : [{ text: monster.notes, style: 'muted' }]),
            ...(treasure === null ? [] : [{ text: treasure.printed, style: 'muted' }]),
            ...(statBlock === null
              ? []
              : [
                  statBoxContent(
                    statBlock,
                    `${monster.name} ×${monster.count}`,
                    stampedSourceLine(monster),
                    state.spellIndexes,
                  ),
                ]),
          ],
          margin: [0, 0, 0, 3],
        };
      }),
      player ? null : labeledSection('Terrain', artifact.data.terrain),
      player ? null : labeledSection('Tactics', artifact.data.tactics),
      player ? null : labeledSection('Treasure', artifact.data.treasure),
    );
  } else if (artifact.kind === 'plotarc') {
    pushSections(
      out,
      labeledSection('Arc type', artifact.data.arcType),
      labeledSection('Premise', artifact.data.premise),
      labeledSection('Stakes', artifact.data.stakes),
      ...artifact.data.beats.map((beat): Content | null =>
        labeledSection(beat.title, beat.description),
      ),
      ...artifact.data.hooks.map(
        (hook): Content => ({ text: [{ text: 'Hook: ', bold: true }, { text: hook }] }),
      ),
      labeledSection('Climax', artifact.data.climax),
    );
  } else {
    void artifact;
  }
  return out;
}

function monsterHeaderKicker(difficulty: string, levelHint: string): Content | null {
  if (difficulty === '' && levelHint === '') return null;
  return {
    text: [difficulty, levelHint].filter((part) => part !== '').join(' · ').toUpperCase(),
    style: 'kicker',
    margin: [0, 2, 0, 4],
  };
}

/**
 * One artifact's cover image, loudly. An image that EXISTS on the row but
 * cannot be embedded prints a named placeholder and reports a problem — the
 * shipped renderer silently skipped it.
 */
function artifactCoverContent(artifact: AnyArtifact, state: RenderState): Content[] {
  if (artifact.coverImageId === null) return [];
  const images = state.input.images ?? NO_PDF_IMAGES;
  const where = `the cover of “${artifact.name}”`;
  const dataUrl = imageDataUrlFor(images, artifact.coverImageId);
  if (dataUrl === undefined) {
    const failure = failureFor(images, artifact.coverImageId);
    const reason = failure?.reason ?? 'it was not in the preloaded image set';
    state.problems.push({ where, reason });
    return [alertBox(`“${artifact.name}” has a cover image that could not be embedded — ${reason}`)];
  }
  if (artifact.kind === 'location' || artifact.kind === 'event') {
    // Locations and events may span full width; everything else ≤45% via
    // columns (pdfmake has no float).
    return [imageNode(dataUrl, where, { fit: [450, 320], margin: [0, 0, 0, 6] })];
  }
  return [
    {
      columns: [
        { image: assertImage(dataUrl, where), fit: [200, 150] },
        { text: '', width: '55%' },
      ],
      margin: [0, 0, 0, 6],
    },
  ];
}

/**
 * The map plate of an encounter at its own anchor (owner, verbatim: "Encounter
 * maps should obviously be part of the PDF. They need to be included at the
 * right places."). An encounter with NO map image prints NO plate — the owner's
 * decision, not a failure. A map that EXISTS but cannot be embedded is loud,
 * always: never a silent drop.
 */
function encounterMapPlate(artifact: AnyArtifact, state: RenderState): Content[] {
  if (artifact.kind !== 'encounter') return [];
  const mapImageId = encounterMapImageId(artifact, state.input.battles ?? []);
  if (mapImageId === null) return [];
  const images = state.input.images ?? NO_PDF_IMAGES;
  const where = `the map of “${artifact.name}”`;
  const dataUrl = imageDataUrlFor(images, mapImageId);
  if (dataUrl === undefined) {
    const failure = failureFor(images, mapImageId);
    const reason = failure?.reason ?? 'it was not in the preloaded image set';
    state.problems.push({ where, reason });
    return [alertBox(`The map of “${artifact.name}” could not be embedded — ${reason}`)];
  }
  return [
    imageNode(dataUrl, where, {
      fit: [PAGE_CONTENT_WIDTH, MAP_PLATE_MAX_HEIGHT],
      alignment: 'center',
      margin: [0, 2, 0, 8],
    }),
  ];
}

/** An artifact's outgoing relations, with the dangling-reference placeholder. */
function artifactLinksContent(artifact: AnyArtifact, state: RenderState): Content[] {
  if (artifact.links.length === 0) return [];
  const refs: Content[] = artifact.links.map((link): Content => {
    const target = state.byId.get(link.targetId);
    if (target === undefined) {
      // The dangling-reference placeholder, kept and made loud: the shipped
      // renderer dropped a relation whose target row is gone, silently.
      const named = link.relation.trim() === '' ? link.targetId : link.relation;
      return {
        text: `see ${missingCreatureOrigin(named)}`,
        italics: true,
        color: ALERT,
        margin: [0, 0, 0, 2],
      };
    }
    const destination = state.destinations.get(target.id);
    return destination === undefined
      ? { text: `see ${target.name}`, italics: true, margin: [0, 0, 0, 2] }
      : {
          text: `see ${target.name}`,
          italics: true,
          linkToDestination: destination,
          margin: [0, 0, 0, 2],
        };
  });
  return [{ text: refs, margin: [0, 4, 0, 0] }];
}

/**
 * One artifact's PROSE — "the text" (docs/19 §3): the row's own body, through
 * the ONE markdown seam. Always main-column content, never a companion.
 *
 * Every `[[wiki-link]]` the body carries is an INTERNAL LINK to where that row
 * prints (docs/19 §7: *"Every reference in the text is an internal link to the
 * thing it names"*) — resolved by the SAME reader's resolver the chips use, so
 * the PDF and the app cannot name different rows. A name this document has no
 * destination for keeps its bold display run and gets no link at all.
 */
function artifactProse(artifact: AnyArtifact, state: RenderState): Content[] {
  if (artifact.body.trim() === '') return [];
  return mdToPdfmakeContent(artifact.body, { destinationFor: state.wikiDestination });
}

/**
 * One artifact's DETAIL — the mechanics a reader keeps beside the text
 * (docs/19 §3, §4): its cover art, its map plate, every per-kind labeled
 * section, and its cross-references. This is the list the page model routes to
 * a sidebar or to the artifact's own page; it is built by the SAME builders
 * that always built it, so the layout moves content and never rewrites it.
 *
 * It answers in its TWO halves because they are governed by DIFFERENT rules
 * (docs/17 row 187) — `artwork` is the artifact's own described picture and
 * prints at every description, whatever the plan and the section's ROLE say,
 * while `mechanics` is the half §10.1's "ONCE, with a link back" and the
 * `read-aloud`/`aside` role gate apply to. `companionContent` is the ONE place
 * they are composed into a companion, so the printed order cannot drift.
 */
function artifactDetail(
  artifact: AnyArtifact,
  state: RenderState,
  options: { covers: boolean },
): { artwork: Content[]; mechanics: Content[] } {
  const artwork: Content[] = [];
  if (options.covers) artwork.push(...artifactCoverContent(artifact, state));
  artwork.push(...encounterMapPlate(artifact, state));
  return {
    artwork,
    mechanics: [...dataSections(artifact, state), ...artifactLinksContent(artifact, state)],
  };
}

/** The chapters the document prints, in order, with audience filtering. */
interface KindChapter {
  title: string;
  id: string;
  artifacts: AnyArtifact[];
}

const KIND_CHAPTERS: readonly { kind: ArtifactKind; title: string; id: string }[] = [
  { kind: 'location', title: 'Locations', id: 'locations' },
  { kind: 'event', title: 'Events', id: 'events' },
  { kind: 'encounter', title: 'Encounters', id: 'encounters' },
  { kind: 'faction', title: 'Factions', id: 'factions' },
  { kind: 'pc', title: 'Party', id: 'party' },
  // `plotarc` and `note` are NOT here: an arc's premise/stakes/beats/climax and
  // a note's text are GM material, so they are their own GM-only chapters.
];

/**
 * Whether an artifact belongs in the audience's document: the ONE predicate
 * every chapter, gallery and ledger row goes through. The player document
 * carries no `gm-only`-tagged row, no `note` (GM material by definition) and no
 * `plotarc` (the module's plan — docs/07 §M3-D, docs/17 row 108).
 */
function audible(artifact: AnyArtifact, audience: ModulePdfAudience): boolean {
  if (audience === 'gm') return true;
  if (isGmOnly(artifact)) return false;
  return artifact.kind !== 'note' && artifact.kind !== 'plotarc';
}

function kindChapters(scoped: readonly AnyArtifact[], audience: ModulePdfAudience): KindChapter[] {
  const chapters: KindChapter[] = [];
  for (const entry of KIND_CHAPTERS) {
    const rows = scoped.filter(
      (artifact) => artifact.kind === entry.kind && audible(artifact, audience),
    );
    if (rows.length === 0) continue;
    chapters.push({ title: entry.title, id: entry.id, artifacts: rows });
  }
  if (audience === 'gm') {
    for (const entry of [
      { kind: 'plotarc' as const, title: 'Plot arcs', id: 'plotarcs' },
      { kind: 'note' as const, title: 'Notes', id: 'notes' },
    ]) {
      const rows = scoped.filter((artifact) => artifact.kind === entry.kind);
      if (rows.length === 0) continue;
      chapters.push({ title: entry.title, id: entry.id, artifacts: rows });
    }
  }
  return chapters;
}

/** The NPC gallery: every audible NPC, stat box each (the book's back matter). */
function npcGallery(scoped: readonly AnyArtifact[], audience: ModulePdfAudience): AnyArtifact[] {
  return scoped.filter((artifact) => artifact.kind === 'npc' && audible(artifact, audience));
}

/**
 * The separator between an encounter's name and the mob that carries the
 * treasure, in a ledger row's own label.
 */
const LEDGER_CARRIER_SEPARATOR = ' · ';

/** One ledger row: WHO the treasure belongs to, and the treasure itself. */
interface TreasureLedgerRow {
  /** The encounter, or `<encounter> · <mob> ×count` for a mob's own row. */
  where: string;
  treasure: string;
}

/**
 * The treasure ledger rows: every encounter the BODY printed that stores
 * treasure (the encounters chapter in the procedural document; the planned
 * encounter sections when a plan is applied) — and, for each of those
 * encounters, the treasure ITS MOBS carry (docs/17 row 159).
 *
 * TWO SOURCES, ONE TABLE, NEVER ONE MERGED STRING. The encounter's own
 * `treasure` field is the encounter-level line, exactly as it always was; a
 * roster entry's `treasure` gets a row of its OWN, labelled by the creature that
 * carries it (`Pier Ambush · Cultist ×4`), because a GM reading back matter has
 * to know WHICH mob the pouch is on — the per-mob treasure was authored, stored,
 * shown on the token card and rendered in the encounter section, and reached no
 * ledger at all before this row. Whether a mob has anything to contribute is
 * `rosterTreasureFor`'s answer and nobody else's (the ONE emptiness rule): a mob
 * that carries nothing adds NO row, never a label standing over a blank value.
 *
 * The label is the carrier rather than a nested block on purpose: a row survives
 * a page break, and a mob row read at the top of a fresh page still names its
 * encounter.
 */
function treasureLedger(printed: readonly AnyArtifact[]): TreasureLedgerRow[] {
  return printed
    .filter((entry) => entry.kind === 'encounter')
    .flatMap((entry): TreasureLedgerRow[] => {
      const rows: TreasureLedgerRow[] = [];
      // The encounter's OWN field, untouched (including its whitespace): this is
      // the line the ledger has always printed for it.
      if (entry.data.treasure.trim() !== '') {
        rows.push({ where: entry.name, treasure: entry.data.treasure });
      }
      for (const monster of entry.data.monsters) {
        const treasure = rosterTreasureFor(monster);
        if (treasure === null) continue;
        rows.push({
          where: `${entry.name}${LEDGER_CARRIER_SEPARATOR}${monster.name} ×${monster.count}`,
          treasure: treasure.text,
        });
      }
      return rows;
    });
}

// --- The four role treatments ----------------------------------------------
//
// The owner's layout insight, made explicit and CLOSED (docs/17 row 109): the
// explanation is the body, the module's own narration is a read-aloud element,
// mechanical content is a GM note, and a genuinely parenthetical insert is an
// aside. Every treatment below is the RENDERER's decision — the plan picks a
// role by name and can express nothing else (no size, no colour, no font, no
// pdfmake node), which is what keeps a re-export byte-identical.

/** Read-aloud boxes and GM notes share ONE box shape, with their own border. */
const ROLE_BOX_PADDING = {
  paddingLeft: () => 8,
  paddingRight: () => 8,
  paddingTop: () => 6,
  paddingBottom: () => 6,
};

/** The neutral border of a GM note — never the ALERT red (that means "problem"). */
const GM_NOTE_BORDER = '#6b7280';

/** An aside is INDENTED, not boxed: a parenthetical insert in the margin. */
const ASIDE_INDENT = 24;

/** One bordered, filled box: the shared shape of read-aloud and GM note. */
function roleBox(input: {
  blocks: Content[];
  style: string;
  border: string;
  fill: string;
  label: string | null;
}): Content {
  const body: Content[] =
    input.label === null
      ? input.blocks
      : [{ text: input.label, style: 'kicker' }, ...input.blocks];
  return {
    table: {
      widths: ['*'],
      body: [[{ stack: body, style: input.style, fillColor: input.fill }]],
    },
    layout: {
      hLineWidth: () => 1,
      vLineWidth: () => 1,
      hLineColor: () => input.border,
      vLineColor: () => input.border,
      ...ROLE_BOX_PADDING,
    },
    margin: [0, 4, 0, 6],
  };
}

/** `read-aloud`: the module's own narration, boxed in the read-aloud style. */
function readAloudRoleContent(blocks: Content[]): Content[] {
  return [roleBox({ blocks, style: 'readAloud', border: ACCENT, fill: '#f6efe2', label: null })];
}

/** `gm-note`: mechanical/GM content, boxed and LABELED as the GM's. */
function gmNoteRoleContent(blocks: Content[]): Content[] {
  return [
    roleBox({ blocks, style: 'gmNote', border: GM_NOTE_BORDER, fill: '#f4f4f5', label: 'GM note' }),
  ];
}

/** `aside`: a small, indented, muted parenthetical insert (never a chapter). */
function asideRoleContent(blocks: Content[]): Content[] {
  return [
    {
      table: {
        widths: [ASIDE_INDENT, '*'],
        body: [[{ text: '' }, { stack: blocks, style: 'aside' }]],
      },
      layout: 'noBorders',
      margin: [0, 2, 0, 6],
    },
  ];
}

/**
 * The PROSE of a planned section, by ROLE — the ONE place a role becomes a
 * treatment. Since docs/19 row 148 the split is explicit: a role dresses the
 * section's TEXT, and the section's mechanical data (`roleDetail` below) is the
 * companion the page model places. The two are different columns of the page,
 * never two renderings of one thing.
 *
 * `read-aloud` and `aside` carry prose only — a stat block inside narration or
 * a parenthetical would be a lie about what the section is — which is why
 * `roleDetail` answers "no MECHANICS" for exactly those two roles. It never
 * answers "no companion" (docs/17 row 187): the artifact's own picture is not
 * mechanics and prints whatever the role is.
 */
function roleProse(role: DocumentPlanRole, blocks: Content[]): Content[] {
  switch (role) {
    case 'read-aloud':
      return readAloudRoleContent(blocks);
    case 'aside':
      return asideRoleContent(blocks);
    case 'gm-note':
      return gmNoteRoleContent(blocks);
    case 'explanation':
      return blocks;
  }
}

/**
 * The COMPANION of a planned section, split the way its two rules apply
 * (docs/17 row 187): the artifact's own ARTWORK always prints, and its
 * MECHANICS — the source's own structured data (a roster, a stat box, kind
 * fields) and its outgoing cross-references — are the part a ROLE governs. It
 * stays filtered by the DOCUMENT's audience, so the plan can never print GM
 * mechanics into the player book — and it is the SAME `artifactDetail` the
 * procedural document prints, so one artifact's mechanics read identically in
 * both.
 *
 * `read-aloud` and `aside` carry prose only — a stat block inside narration or
 * a parenthetical would be a lie about what the section is — which is why their
 * MECHANICS are empty and their artwork is not: the artifact's own picture is
 * not mechanics, and a location or NPC whose role is narration still has a
 * picture the reader asked for.
 */
function roleDetail(
  role: DocumentPlanRole,
  artifact: AnyArtifact,
  state: RenderState,
): { artwork: Content[]; mechanics: Content[] } {
  const detail = artifactDetail(artifact, state, { covers: true });
  if (role === 'read-aloud' || role === 'aside') {
    return { artwork: detail.artwork, mechanics: [] };
  }
  return detail;
}

/**
 * A section's COMPANION as it prints in the sidebar (docs/17 row 188, the
 * owner: *"important NPCs should be introduced in a sidebar where the story
 * introduces them."*). It is the SAME `roleDetail`/`companionContent` seam
 * every other description goes through — never a second companion mechanism —
 * with ONE thing added: the row's own NAME, because a companion has no main
 * column to carry it the way `artifactBlock` does, and an unnamed profile in a
 * sidebar would not tell the reader whose it is.
 *
 * The name rides the MECHANICS half on purpose, so §10.1's once-rule governs it
 * with the profile it names (a later reference's link back already names the
 * row) and a role that suppresses mechanics suppresses the name with them — a
 * `read-aloud`/`aside` section keeps the companion's picture and nothing else,
 * which is docs/17 row 187's split unchanged.
 */
function companionDetail(
  role: DocumentPlanRole,
  companion: AnyArtifact,
  state: RenderState,
): { artwork: Content[]; mechanics: Content[] } {
  const detail = roleDetail(role, companion, state);
  if (detail.mechanics.length === 0) return detail;
  return {
    artwork: detail.artwork,
    mechanics: [{ text: companion.name, style: 'artifact' }, ...detail.mechanics],
  };
}

/** The kicker above a planned section: what the section IS, never its role. */
const PLAN_KIND_LABELS: Readonly<Record<ArtifactKind, string>> = {
  pc: 'PC',
  npc: 'NPC',
  location: 'Location',
  event: 'Event',
  faction: 'Faction',
  note: 'Note',
  encounter: 'Encounter',
  plotarc: 'Plot arc',
};

/** The module's premise as document content, or the LOUD missing-premise box. */
function premiseContent(
  module: Module,
  problems: ModulePdfProblem[],
  state: RenderState,
): Content[] {
  const premise = module.spine?.premise ?? '';
  if (premise.trim() !== '') {
    return mdToPdfmakeContent(premise, { destinationFor: state.wikiDestination });
  }
  const reason = 'the module has no premise yet (the spine pass has not run)';
  problems.push({ where: 'the premise of the module', reason });
  return [alertBox(`The premise is missing — ${reason}`)];
}

/** One part's text, or the LOUD empty-part box naming its position. */
function partTextContent(
  part: RenderedPart,
  total: number,
  problems: ModulePdfProblem[],
  state: RenderState,
): Content[] {
  const position = part.planIndex + 1;
  if (part.text.trim() !== '') {
    return mdToPdfmakeContent(part.text, { destinationFor: state.wikiDestination });
  }
  const reason = `part ${String(position)} of ${String(total)} has no text yet`;
  problems.push({ where: `part ${String(position)} (“${part.title}”)`, reason });
  return [alertBox(`Part ${String(position)} — “${part.title}” is empty — ${reason}`)];
}

/** One image a plan anchored: a MAP prints as a plate, a cover as art. */
function anchoredImageContent(image: PlannedImage, state: RenderState): Content[] {
  const images = state.input.images ?? NO_PDF_IMAGES;
  const dataUrl = imageDataUrlFor(images, image.id);
  if (dataUrl === undefined) {
    const failure = failureFor(images, image.id);
    const reason = failure?.reason ?? 'it was not in the preloaded image set';
    state.problems.push({ where: image.where, reason });
    return [alertBox(`The image at ${image.where} could not be embedded — ${reason}`)];
  }
  if (image.kind === 'map') {
    return [
      imageNode(dataUrl, image.where, {
        fit: [PAGE_CONTENT_WIDTH, MAP_PLATE_MAX_HEIGHT],
        alignment: 'center',
        margin: [0, 2, 0, 8],
      }),
    ];
  }
  return [imageNode(dataUrl, image.where, { fit: [450, 320], margin: [0, 0, 0, 6] })];
}

/** Whether a planned section belongs in THIS audience's document. */
function plannedSectionAudible(
  section: PlannedSection,
  audience: ModulePdfAudience,
): boolean {
  return section.audience === 'all' || section.audience === audience;
}

/**
 * One planned section as a PAGE-MODEL BLOCK (docs/19 §3–§5): the heading, the
 * source-naming kicker, the images the plan anchored and the role-treated prose
 * are MAIN content ("the text"), and the artifact's own detail is the DETAIL
 * companion the page model routes to a sidebar or to an own page.
 *
 * TWO facts about the images, and they are different questions (docs/17 row
 * 187): the artifact's OWN cover art and its map plate are part of the
 * DESCRIPTION (`roleDetail`), so they print whether or not the plan anchored
 * anything; the plan's `images` belong to it as EXTRAS (a plate or picture it
 * deliberately places), and one that names the artifact's own picture is
 * skipped rather than printing the same image twice.
 *
 * THE COMPANION (docs/17 row 188) is the ONE row the section introduces,
 * composed into the SAME detail: a part-sourced section carries the part's
 * story text in MAIN and the introduced row's profile in the sidebar beside it,
 * which is the published-adventure layout the owner asked for, and an
 * artifact-sourced section keeps its own mechanics AND gains the companion.
 * Both rows go through the same `companionContent` (§10.1's once-rule) and the
 * section's ROLE gates both rows' mechanics (docs/17 row 187's split).
 *
 * `pageBreak` is GONE from the heading. docs/19 §3: *"Sections flow. No page
 * break per section"* — a break is now the PAGE MODEL's decision (an own-page
 * artifact, a chapter start), emitted on the page node itself, because a break
 * inside a page's column stack would tear the two columns apart.
 */
function plannedSectionBlock(
  section: PlannedSection,
  state: RenderState,
  parts: ReadonlyMap<number, RenderedPart>,
  total: number,
  module: Module,
): PageBlock {
  const artifact = section.artifact;
  const companion = section.companion;
  // The pictures BOTH rows bring, in one list: the row the section is about and
  // the ONE row it introduces (docs/17 row 188). §4's rule — an image needs the
  // page — reads this list, and the anchor filter below drops an anchor naming
  // a picture either row already prints.
  const ownImages = [artifact, companion]
    .filter((row): row is AnyArtifact => row !== null)
    .flatMap((row) => artifactOwnImages(row, state.input.battles ?? []));
  const main: Content[] = [];
  const aside = section.role === 'aside';
  main.push({
    text: section.title,
    style: aside ? 'h2' : 'chapter',
    id: section.destination,
    ...(aside ? {} : { tocItem: 'chapters' as const }),
  });
  const source = section.source;
  if (source.type === 'part') {
    if (source.planIndex === -1) {
      main.push(kicker(module.title));
    } else {
      const part = parts.get(source.planIndex);
      const levelText =
        part !== undefined && part.levelBand !== '' ? ` · levels ${part.levelBand}` : '';
      main.push(kicker(`Part ${String(source.planIndex + 1)} of ${String(total)}${levelText}`));
    }
  } else {
    main.push(kicker(PLAN_KIND_LABELS[section.artifact?.kind ?? 'note']));
  }

  let blocks: Content[];
  if (source.type === 'part') {
    if (source.planIndex === -1) {
      blocks = premiseContent(module, state.problems, state);
    } else {
      const part = parts.get(source.planIndex);
      // A part the parts-document seam refused (or a module with no spine at
      // all) is LOUD here, never an empty page.
      blocks =
        part === undefined
          ? [
              alertBox(
                `“${section.title}” — the part text could not be read (the parts of the module could not be assembled)`,
              ),
            ]
          : partTextContent(part, total, state.problems, state);
    }
  } else {
    if (artifact === null) {
      blocks = [
        alertBox(`“${section.title}” — the row it names is not in this document's pool`),
      ];
    } else {
      blocks = artifactProse(artifact, state);
    }
  }

  // A plan-anchored image is a full-width item (a plate especially), so it
  // rides the MAIN column of the section's own page — see `blockPlacement`. An
  // anchor that names the artifact's OWN picture is dropped: the artwork prints
  // in the companion below, and the same image must not print twice for one
  // description (docs/17 row 187).
  for (const image of section.images) {
    if (ownImages.some((own) => own.id === image.id)) continue;
    main.push(...anchoredImageContent(image, state));
  }
  main.push(...roleProse(section.role, blocks));
  // §7's back-references: the section states where the row is referred to
  // from. It rides the MAIN column, after the section's text, so an
  // `aside`/`read-aloud` section (whose role suppresses its mechanics, though
  // not its artifact's own picture since docs/17 row 187) states it too.
  if (artifact !== null) {
    main.push(...referencedFromContent(artifact, state));
  }
  // THE DETAIL COMPANION (docs/19 §3–§5): the section's own row, when its
  // source names one, and the ONE row it introduces (docs/17 row 188), each
  // through the SAME `companionContent` seam — so §10.1's once-rule and the
  // role gate apply to both and a planned companion cannot drift from the
  // procedural path. A part-sourced section therefore prints its companion's
  // profile BESIDE the part's own story text, which is the layout the owner
  // asked for; an artifact-sourced one keeps its own mechanics AND gains the
  // companion (additive).
  const detail: Content[] = [];
  if (artifact !== null) {
    detail.push(
      ...companionContent({
        artifact,
        destination: section.destination,
        detail: roleDetail(section.role, artifact, state),
        state,
      }),
    );
  }
  if (companion !== null) {
    detail.push(
      ...companionContent({
        artifact: companion,
        destination: section.destination,
        detail: companionDetail(section.role, companion, state),
        state,
      }),
    );
  }
  return {
    main,
    detail,
    placement: blockPlacement({
      kind: artifact?.kind ?? null,
      // An image needs the page (docs/19 §4), and the OWN artwork of EITHER row
      // is one whether or not the plan anchored anything — a location with a
      // cover, or an introduced NPC with a portrait, must get the full-width
      // treatment its picture needs (docs/17 rows 187/188).
      hasImage: section.images.length > 0 || ownImages.length > 0,
      detail,
      styles: state.measureStyles,
    }),
    // The row this block details, for the sidebar's "(continued)" label and the
    // own-page pointer. A part-sourced section has no source row, so its
    // companion names the block (docs/17 row 188).
    name: artifact?.name ?? companion?.name ?? null,
  };
}

/**
 * THE one place a block's placement is asked for: the block's companion height
 * is measured once, in the column it would actually print in, and handed to the
 * page model's `detailPlacement` — which owns the tiers and the ladder
 * (docs/19 §4/§5). A block with no companion is `beside` with nothing to place,
 * which is what keeps a text-only block flowing in the main column.
 */
function blockPlacement(input: {
  kind: ArtifactKind | null;
  hasImage: boolean;
  detail: readonly Content[];
  styles: Readonly<Record<string, MeasureStyle>>;
}): PageBlock['placement'] {
  if (input.detail.length === 0) return { kind: 'beside' };
  const height = input.detail.reduce<number>(
    (sum, node) =>
      sum +
      estimateHeight(node, {
        width: SIDEBAR_COLUMN_WIDTH,
        fontSize: DETAIL_FONT_SIZE,
        lineHeight: 1.35,
        styles: input.styles,
      }),
    0,
  );
  return detailPlacement({ kind: input.kind, hasImage: input.hasImage, height });
}

/**
 * The pages, as pdfmake nodes: ONE `columns` node per page (docs/19 §3 — the
 * document is built page-level, so a screen viewer's single page carries both
 * bars), or a plain full-width stack for a one-sided page.
 *
 * ONE-SIDED PAGES USE THE WHOLE SHEET (docs/17 row 186, the owner: *"Some pages
 * have just a sidebar, nothing else. Makes no sense. If there is nothing else,
 * of course the sidebar can use all room."* / *"Similar problem with main area.
 * If there IS no sidebar, use all room"*). §3's *"the sidebar exists on every
 * page that has companions"* is read in both directions here, from ONE rule:
 *
 * - no text at all → the companion (the `beside-continued` carry page) prints
 *   full width, in the detail tier, and nothing is dropped to avoid a lonely
 *   page;
 * - no REAL companion → the text gets the whole page, and any marker sentence
 *   rides the text column beside it (markers are not companion content:
 *   `pdfPageModel.isMarkerContent` is the ONE place that is decided, and the
 *   paginator already keeps them out of a sidebar of their own);
 * - both → the two-column frame the owner asked for in row 148 stays.
 *
 * The sidebar COLUMN node carries the detail tier (§3: 9.5 pt), which every
 * stat box, labeled section and table inside it inherits through pdfmake's own
 * style stack — the smaller type for detail is the lever that absorbs the fit
 * problem, and it is applied here, once, rather than at every builder.
 *
 * Every page but the FIRST starts with a break: the body always follows the
 * Contents page, and a break is the PAGE MODEL's to decide (§3), never a node's.
 * The first page takes none because there is nothing to break away from — and
 * because a `pageBreak: 'before'` on the document's first node makes pdfmake
 * emit an EMPTY page in front of the cover (measured: a two-node probe of the
 * exact shape this function emits renders as `['', 'COVER', 'SECOND']`, three
 * pages for two nodes), which would push every number in the document's own
 * Contents out by one.
 */
function pageNodes(pages: readonly DocumentPage[]): Content[] {
  return pages.map((page, index): Content => {
    const breakBefore = index === 0 ? {} : { pageBreak: 'before' as const };
    const realMain = page.main.filter((node) => !isMarkerContent(node));
    const realCompanion = page.sidebar.filter((node) => !isMarkerContent(node));
    if (realMain.length === 0 || realCompanion.length === 0) {
      // ONE full-width column. `realMain.length === 0` is the companion-only
      // page (never a marker-only one: `paginateDocument` drops those), so it
      // takes the whole sheet in the detail tier; otherwise the text takes it,
      // with any marker sentence riding beside it. Nothing is ever dropped to
      // avoid a lonely page (docs/19 §9).
      const oneSided = [...page.main, ...page.sidebar];
      return realMain.length === 0
        ? { stack: oneSided, style: 'detail', fontSize: DETAIL_FONT_SIZE, ...breakBefore }
        : { stack: oneSided, ...breakBefore };
    }
    return {
      columns: [
        { width: MAIN_COLUMN_WIDTH, stack: page.main },
        {
          width: SIDEBAR_COLUMN_WIDTH,
          stack: page.sidebar,
          style: 'detail',
          fontSize: DETAIL_FONT_SIZE,
        },
      ],
      columnGap: COLUMN_GUTTER,
      ...breakBefore,
    };
  });
}

/** A chapter heading: a title node the ToC lists, with NO page break of its
 * own — the page model decides where the page ends (`pageNodes`). */
function chapterHeading(title: string, id: string): Content {
  return { text: title, style: 'chapter', tocItem: 'chapters', id };
}

/**
 * A block with NO companion of its own — the cover, the Contents, a verdict
 * statement, a part's prose, the treasure ledger. Its content is the whole of
 * what it prints, so the page model measures it and decides both its page and
 * where that page ends; `breakBefore` is the ONE break a page can ask for
 * (docs/19 §3), and it is asked HERE rather than by a `pageBreak` on a node.
 */
function plainBlock(main: Content[], options: { breakBefore?: boolean } = {}): PageBlock {
  return {
    main,
    detail: [],
    placement: { kind: 'beside' },
    name: null,
    ...(options.breakBefore === true ? { breakBefore: true } : {}),
  };
}

/**
 * A chapter opening as a flow block: the heading and its kicker, and nothing
 * else. It is `breakBefore` so a chapter always starts a page (docs/19 §3:
 * breaks happen "where content or the plan demands one … a chapter start"),
 * and it carries no companion of its own.
 */
function chapterBlock(title: string, id: string, kickerText: string | null): PageBlock {
  return plainBlock(
    [chapterHeading(title, id), ...(kickerText === null ? [] : [kicker(kickerText)])],
    { breakBefore: true },
  );
}

/**
 * One artifact as a flow block, for the PROCEDURAL outline and the NPC
 * gallery: the chapter's kicker and the artifact's name are the block's main
 * content together with its prose, and `artifactDetail` — its own artwork and
 * its mechanics — is the companion the page model places by §4/§5. The block
 * closes with §7's back-references — the places in the document's own text that
 * name this row.
 */
function artifactBlock(
  artifact: AnyArtifact,
  state: RenderState,
  options: { chapterKicker: string | null; covers: boolean; destination: string },
): PageBlock {
  const main: Content[] = [];
  if (options.chapterKicker !== null) main.push(kicker(options.chapterKicker));
  main.push({
    text: artifact.name,
    style: 'artifact',
    tocItem: 'chapters',
    id: options.destination,
  });
  main.push(...artifactProse(artifact, state));
  main.push(...referencedFromContent(artifact, state));
  const detail = companionContent({
    artifact,
    destination: options.destination,
    detail: artifactDetail(artifact, state, { covers: options.covers }),
    state,
  });
  return {
    main,
    detail,
    placement: blockPlacement({
      kind: artifact.kind,
      hasImage: artifactOwnImages(artifact, state.input.battles ?? []).length > 0,
      detail,
      styles: state.measureStyles,
    }),
    name: artifact.name,
  };
}

/**
 * Builds the whole document AND the loud problems it could not avoid. ONE
 * implementation behind `buildModuleDefinition` (definition only) and
 * `buildModulePdf` (definition + the problems reported to the owner).
 */
export function buildModulePdfDocument(input: ModulePdfInput): {
  definition: TDocumentDefinitions;
  problems: ModulePdfProblem[];
} {
  const { module } = input;
  const audience = input.audience ?? 'gm';
  const problems: ModulePdfProblem[] = [];
  const images = input.images ?? NO_PDF_IMAGES;
  for (const failure of images.failures) {
    problems.push({ where: failure.where, reason: failure.reason });
  }
  const scoped = modulePdfArtifacts(module, input.artifacts);
  const byId = new Map(scoped.map((artifact) => [artifact.id, artifact]));
  const chapters = kindChapters(scoped, audience);
  const battles = input.battles ?? [];
  // THE plan read (docs/17 row 109). `applied` ⇒ the sections below are the
  // document's body; anything else ⇒ the procedural outline, silently when the
  // plan is merely ABSENT and LOUDLY (problem + a statement in the document)
  // when a stored plan exists but cannot be used.
  const planOutcome = resolveDocumentPlan({ module, scoped, battles });
  const plannedSections =
    planOutcome.status === 'applied'
      ? planOutcome.sections.filter((section) => plannedSectionAudible(section, audience))
      : null;
  // THE OWNER'S DECISION, at the one place it can be applied (docs/19 §10's
  // third open question, answered by the owner while this landing was in
  // flight): an artifact the module's own prose refers to NOWHERE is not
  // printed. "Referred to" is the reader's own rule, `moduleMentionOrder`, and
  // "the plan placed it" is the only way it could have reached the document —
  // so the omission is a PLANNING fact with a planning record behind it, and it
  // is stated in the document and reported on the export's problem list rather
  // than silently dropped (§9).
  //
  // It does NOT apply to the procedural outline, which has no plan and no plan
  // record to attribute an omission to: there the renderer's own outline
  // deliberately prints every scoped row, including an owned orphan, exactly as
  // it always has.
  const mentionOrder = moduleMentionOrder(module, scoped);
  const omitted: AnyArtifact[] =
    plannedSections === null
      ? []
      : plannedSections
          .flatMap((section) => (section.artifact === null ? [] : [section.artifact]))
          .filter((artifact) => !mentionOrder.has(artifact.id));
  const omittedIds = new Set<Id>(omitted.map((artifact) => artifact.id));
  /** The planned sections that actually print: the plan's own sections minus
   * the rows its own text never refers to. */
  const printableSections =
    plannedSections === null
      ? null
      : plannedSections.filter(
          (section) => section.artifact === null || !omittedIds.has(section.artifact.id),
        );
  // The parts are read through the ONE seam only when something prints them.
  const total = module.spine?.partPlan.length ?? 0;
  const needsParts =
    printableSections === null || printableSections.some((section) => section.source.type === 'part');
  const parts = needsParts ? renderedParts(module, problems) : [];
  const partsByIndex = new Map(parts.map((part) => [part.planIndex, part]));
  // What the BODY printed: the gallery completes it (an NPC the plan already
  // printed as a section — OR introduced as a section's companion, docs/17 row
  // 188 — is not printed a second time) and the treasure ledger aggregates its
  // encounters. An OMITTED row is neither: the gallery must not smuggle back in
  // the row the plan's own omission statement says is not here.
  const printedArtifacts: AnyArtifact[] =
    printableSections === null
      ? chapters.flatMap((chapter) => chapter.artifacts)
      : printableSections.flatMap((section) => [
          ...(section.artifact === null ? [] : [section.artifact]),
          // A companion IS printed by this document (in the section's sidebar),
          // so the gallery must not describe the same NPC a second time. It is
          // deliberately NOT subject to the omission rule above: a companion
          // always has a page — the section that introduces it — which is the
          // exact thing an unplaced artifact lacks.
          ...(section.companion === null ? [] : [section.companion]),
        ]);
  const printedIds = new Set<Id>(printedArtifacts.map((artifact) => artifact.id));
  const gallery = npcGallery(scoped, audience).filter(
    (npc) => !printedIds.has(npc.id) && !omittedIds.has(npc.id),
  );
  // The ledger aggregates the treasure of the printed encounters — their own
  // `treasure` field AND what each of their mobs carries (docs/17 row 159) —
  // and the player document strips BOTH from every encounter (the encounter
  // fields and the GM-only roster treasure), so it stays a GM-only appendix. The
  // shipped renderer printed it to players, contradicting §M3-D's own rule.
  const ledger =
    audience === 'gm'
      ? treasureLedger(printedArtifacts.filter((artifact) => artifact.kind === 'encounter'))
      : [];
  // EVERY artifact the document actually prints → where it prints, so an
  // internal link is only ever emitted for a destination that exists (pdfmake
  // throws otherwise). A planned section is addressed by its SECTION id: a plan
  // may name one row twice, and two nodes cannot share a destination.
  const destinations = new Map<Id, string>();
  if (printableSections === null) {
    for (const artifact of printedArtifacts) destinations.set(artifact.id, `node-${artifact.id}`);
  } else {
    for (const section of printableSections) {
      // The section's own row AND the companion it introduces (docs/17 row
      // 188) both print at the SECTION's destination: a wiki-link to either
      // jumps to the page whose sidebar carries the description. A row named
      // twice keeps the FIRST destination, which is where §10.1 prints it.
      if (section.artifact !== null && !destinations.has(section.artifact.id)) {
        destinations.set(section.artifact.id, section.destination);
      }
      if (section.companion !== null && !destinations.has(section.companion.id)) {
        destinations.set(section.companion.id, section.destination);
      }
    }
  }
  for (const npc of gallery) {
    if (!destinations.has(npc.id)) destinations.set(npc.id, `node-${npc.id}`);
  }
  // docs/19 §7's reference places: the module's OWN TEXT as THIS document
  // prints it — the premise and every part the document carries — each with the
  // destination a reader can actually jump to. Built from the same two branches
  // the flow below takes, so a place this document does not print (a part
  // section the audience filtered out, a part that was never read) is never
  // offered as a reference site.
  const referencePlaces: ReferenceSite[] =
    printableSections === null
      ? [
          { label: 'Premise', destination: 'node-premise', text: module.spine?.premise ?? '' },
          ...parts.map((part) => ({
            label: part.title,
            destination: `node-part-${String(part.planIndex)}`,
            text: part.text,
          })),
        ]
      : printableSections.flatMap((section): ReferenceSite[] => {
          if (section.source.type !== 'part') return [];
          return [
            {
              label: section.title,
              destination: section.destination,
              text:
                section.source.planIndex === -1
                  ? (module.spine?.premise ?? '')
                  : (partsByIndex.get(section.source.planIndex)?.text ?? ''),
            },
          ];
        });
  // Every row the document prints → where its OWN text refers to it, through
  // the ONE rule (`referenceSitesFor`), so §7's back-references and §4's
  // derived locality are the same reading of the same text.
  const referenceSites = new Map<Id, readonly ReferenceSite[]>(
    [...printedArtifacts, ...gallery].map((artifact) => [
      artifact.id,
      referenceSitesFor(artifact, referencePlaces, module, input.artifacts),
    ]),
  );
  // THE one wiki-link destination rule for the document's own text (docs/19 §7
  // bullet 1): the reader's own resolver over the reader's own pool, then the
  // destination this document printed that row at. A name with no destination
  // here is not a link — there is nothing to jump to, and pdfmake throws on a
  // dangling `linkToDestination`.
  const wikiDestination = (name: string): string | undefined => {
    const artifact = resolveWikiLink(name, input.artifacts, { moduleId: module.id }).artifact;
    return artifact === undefined ? undefined : destinations.get(artifact.id);
  };
  // The document's ONE type repertoire (docs/19 §3): body 11 pt (the
  // defaultStyle), the detail tier 9.5 pt for the sidebar, the kicker at 8 pt,
  // the role treatments. Declared BEFORE the flow is built, because the page
  // model's height estimator reads the same dictionary the renderer prints from
  // — a second copy of the tiers would measure a document nobody prints.
  const measureStyles: Record<string, Style> = {
    coverTitle: { fontSize: 32, bold: true, alignment: 'center' },
    coverSubtitle: { fontSize: 16, italics: true, alignment: 'center', color: '#555555' },
    chapter: { fontSize: 26, bold: true, margin: [0, 0, 0, 10] },
    part: { fontSize: 18, bold: true, margin: [0, 14, 0, 6] },
    artifact: { fontSize: 14, bold: true, margin: [0, 10, 0, 4] },
    h1: { fontSize: 16, bold: true, margin: [0, 8, 0, 4] },
    h2: { fontSize: 14, bold: true, margin: [0, 8, 0, 4] },
    h3: { fontSize: 12, bold: true, margin: [0, 6, 0, 3] },
    kicker: { fontSize: 8, color: ACCENT, characterSpacing: 1 },
    label: { fontSize: 10 },
    muted: { fontSize: 10, color: '#555555' },
    code: { font: 'Roboto', fontSize: 9, background: '#f3f3f3' },
    readAloud: { fontSize: 11, italics: true, fillColor: '#f6efe2' },
    // The detail tier of docs/19 §3: the sidebar's own type size, applied to
    // the sidebar COLUMN so every stat box, labeled section and table inside it
    // inherits 9.5 pt through pdfmake's style stack.
    detail: { fontSize: DETAIL_FONT_SIZE },
    // The two remaining role treatments (docs/17 row 109): a GM note reads as
    // one step smaller than the body, and an aside is the smallest, muted,
    // indented voice in the document.
    gmNote: { fontSize: 10, color: '#3f3f46' },
    aside: { fontSize: 9.5, italics: true, color: '#555555' },
  };

  const state: RenderState = {
    input,
    audience,
    destinations,
    byId,
    problems,
    measureStyles,
    referenceSites,
    wikiDestination,
    // Per BUILD: "a companion prints once" is a fact about the document being
    // built now, never about a stored row (docs/19 §10.1, render-time only).
    companionsPrinted: new Map<Id, string>(),
    spellIndexes: input.spellIndexes ?? new Map<GameSystem, MobSpellIndex>(),
  };

  // THE DOCUMENT IS PAGES, and this list is the whole of it: the cover, the
  // Contents, a verdict statement, the body and the back matter are all
  // `PageBlock`s, and `lib/pdfPageModel` measures every one of them and decides
  // where each page ends (docs/19 §3, docs/17 row 148). Nothing below pushes a
  // page node of its own — a second placement rule is exactly the drift
  // docs/18 §2.3 forbids, and it is what kept the Contents page outside the
  // paginator until row 156.
  const blocks: PageBlock[] = [];

  // The pdfmake definition's content: the pages, and nothing else (filled in
  // ONCE, after the page model has laid every block out).
  const content: Content[] = [];

  // ---- Cover -------------------------------------------------------------
  const cover: Content[] = [];
  const compiledAt = input.compiledAt ?? new Date();
  const compiledDay = compiledAt.toISOString().slice(0, 10);
  const levelLine =
    module.levelMax > module.levelMin
      ? `A module for levels ${String(module.levelMin)}–${String(module.levelMax)}`
      : `A module for level ${String(module.levelMin)}`;
  cover.push(
    { text: module.title, style: 'coverTitle', margin: [0, 120, 0, 8] },
    {
      text: [levelLine, module.tone.trim()].filter((part) => part !== '').join(' · '),
      style: 'coverSubtitle',
    },
  );
  if (module.coverImageId !== null) {
    const where = `the cover of “${module.title}”`;
    const dataUrl = imageDataUrlFor(images, module.coverImageId);
    if (dataUrl === undefined) {
      const failure = failureFor(images, module.coverImageId);
      const reason = failure?.reason ?? 'it was not in the preloaded image set';
      cover.push(
        alertBox(`“${module.title}” has a cover image that could not be embedded — ${reason}`),
      );
      problems.push({ where, reason });
    } else {
      cover.push(imageNode(dataUrl, where, { fit: [300, 300], alignment: 'center', margin: [0, 24, 0, 0] }));
    }
  }
  cover.push({
    text: `Compiled with Campaigner · ${compiledDay}`,
    style: 'muted',
    alignment: 'center',
    margin: [0, 24, 0, 0],
  });
  blocks.push(plainBlock(cover));

  // ---- Contents ----------------------------------------------------------
  // §7's second bullet, and the reason this page is a BLOCK like any other: the
  // Contents lists every section this document prints, in the order it prints
  // them, with the page number pdfmake resolves while it lays the document out
  // (docs/17 row 156). The number is never ours to compute — `{ toc: … }` plus
  // `tocItem: 'chapters'` on the headings is pdfmake's own page reference, and a
  // hand-rolled "which page is this on" map would be a second placement rule
  // that drifts from the paginator (docs/18 §2.3).
  //
  // pdfmake builds each entry as `linkToDestination: getNodeId(node)`
  // (`pdfmake/js/DocMeasure.js` → `measureToc`), i.e. the section heading's OWN
  // `id` — the same identity §7's link seam (`mdToPdfmake.MdRenderOptions.
  // destinationFor`) already links to, so the TOC adds no second link rule.
  //
  // The estimator reserves one page for it (`estimateHeight`'s `toc` branch,
  // docs/17 row 148), which is what keeps it on a page of its own.
  blocks.push(
    plainBlock(
      [
        { text: 'Contents', style: 'part' },
        { toc: { id: 'chapters', title: { text: 'Contents', style: 'part' } } },
      ],
      { breakBefore: true },
    ),
  );

  // ---- The plan's verdict, in the document ---------------------------------
  // A stored plan that CANNOT be applied is never a silent fallback: the owner
  // sees it here, on the page he opens, AND on the export's problems list.
  if (planOutcome.status === 'invalid' || planOutcome.status === 'rejected') {
    problems.push({ where: PLAN_PROBLEM_WHERE, reason: planOutcome.reason });
    blocks.push(plainBlock([alertBox(planFallbackStatement(planOutcome.reason))], { breakBefore: true }));
  } else if (input.planFailure !== undefined) {
    // The export PLANNED and the planning FAILED (docs/17 row 139). The document
    // still lands — the renderer's contract is that a missing row is a visible
    // defect inside the document, not a lost document — but it must never look
    // like a successful planned export: the reason is stated on its own page AND
    // pushed onto the problems list the export surface reports.
    const planApplied = planOutcome.status === 'applied';
    blocks.push(
      plainBlock([alertBox(planFailureStatement(planApplied, input.planFailure))], {
        breakBefore: true,
      }),
    );
    problems.push({
      where: PLAN_PROBLEM_WHERE,
      reason:
        `${planApplied ? 'the module’s last stored plan printed instead' : 'no plan was stored, so the procedural outline printed'}: ` +
        `the automatic planning step failed — ${input.planFailure}`,
    });
  }

  // ---- The plan's omissions, in the document -------------------------------
  // An artifact the plan placed and the module's text never refers to has no
  // page to sit beside: it is not printed, and BOTH this statement and the
  // export's problem list say so by name (docs/19 §9 — never a silent
  // disappearance).
  if (omitted.length > 0) {
    blocks.push(
      plainBlock([alertBox(omittedArtifactsStatement(omitted))], { breakBefore: true }),
    );
    for (const artifact of omitted) {
      problems.push({
        where: `the document plan’s placement of “${artifact.name}”`,
        reason:
          'nothing in the module’s own text refers to this row, so it has no page to sit ' +
          'beside; the row is not printed (docs/19 §10)',
      });
    }
  }

  // ---- The body, as a FLOW the page model lays out ------------------------
  // Every block below is "the text" (its `main`) plus, for an artifact, the
  // companion its mechanics make (its `detail`). Nothing here decides a
  // column, a page break or a type size: that is `lib/pdfPageModel`'s single
  // job — docs/19 §2's split, where the plan says what belongs with what and
  // the renderer says where it fits.
  if (printableSections === null) {
    // ---- Premise ---------------------------------------------------------
    blocks.push(chapterBlock('Premise', 'node-premise', module.title));
    blocks.push(plainBlock(premiseContent(module, problems, state)));

    // ---- Part plan (GM only: the planning apparatus, not the story) ------
    const partPlan = module.spine?.partPlan ?? [];
    if (audience === 'gm' && partPlan.length > 0) {
      blocks.push(chapterBlock('Part plan', 'node-plan', `${String(partPlan.length)} planned parts`));
      blocks.push(
        plainBlock([
          {
            table: {
              widths: ['auto', 'auto', '*', '*'],
              body: [
                [
                  { text: 'Part', bold: true },
                  { text: 'Level', bold: true },
                  { text: 'Synopsis', bold: true },
                  { text: 'Ends when', bold: true },
                ],
                ...partPlan.map((entry) => [
                  entry.title,
                  entry.levelBand,
                  entry.synopsis,
                  entry.levelUpTrigger,
                ]),
              ],
            },
            layout: 'lightHorizontalLines',
          },
        ]),
      );
    }

    // ---- The parts -------------------------------------------------------
    for (const part of parts) {
      const position = part.planIndex + 1;
      const levelText = part.levelBand === '' ? '' : ` · levels ${part.levelBand}`;
      blocks.push(
        chapterBlock(
          part.title,
          `node-part-${String(part.planIndex)}`,
          `Part ${String(position)} of ${String(total)}${levelText}`,
        ),
      );
      blocks.push(plainBlock(partTextContent(part, total, problems, state)));
    }

    // ---- Per-kind reference chapters --------------------------------------
    for (const chapter of chapters) {
      // The kind chapter's OWN heading never carried a kicker (each artifact
      // below names the chapter instead), so it still does not: this layout
      // moves content, it does not invent a second title.
      blocks.push(chapterBlock(chapter.title, `node-${chapter.id}`, null));
      for (const artifact of chapter.artifacts) {
        blocks.push(
          artifactBlock(artifact, state, {
            chapterKicker: chapter.title,
            covers: true,
            destination: `node-${artifact.id}`,
          }),
        );
      }
    }
  } else {
    // ---- The planned document: the plan's sections, in the plan's order ----
    for (const section of printableSections) {
      blocks.push(plannedSectionBlock(section, state, partsByIndex, total, module));
    }
  }

  // ---- Back matter: the NPC gallery --------------------------------------
  if (gallery.length > 0) {
    blocks.push(chapterBlock('NPC Gallery', 'node-npcs', null));
    for (const npc of gallery) {
      // The gallery is where an NPC is described, so an NPC's portrait prints
      // here like any other artifact's own cover (docs/17 row 187, the owner:
      // *"i would at least expect NPCs and locations when they are described
      // anyways"*). This used to pass `covers: false` under a comment claiming
      // the gallery had no cover thumbnails — the claim was false: the cover is
      // the row's own art and `artifactDetail` prints it wherever the row is
      // described.
      blocks.push(
        artifactBlock(npc, state, {
          chapterKicker: 'NPC Gallery',
          covers: true,
          destination: `node-${npc.id}`,
        }),
      );
    }
  }

  // ---- Back matter: the treasure ledger (GM only) ------------------------
  // A ledger is a table, not a companion: it keeps a page of its own, at full
  // width, exactly as it always did — asked for as a BLOCK like every other
  // page, so the paginator measures it and no node carries a break of its own.
  // Its rows carry BOTH sources (docs/17 row 159): the encounter's own line,
  // and one labelled line per mob that carries something — the header keeps the
  // encounter as the column's subject, and a mob's row names the encounter it
  // belongs to AND the creature.
  if (ledger.length > 0) {
    blocks.push(
      plainBlock(
        [
          chapterHeading('Treasure', 'node-treasure'),
          kicker('Treasure ledger'),
          {
            table: {
              widths: ['*', '*'],
              body: [
                [{ text: 'Encounter', bold: true }, { text: 'Treasure', bold: true }],
                ...ledger.map((row) => [row.where, row.treasure]),
              ],
            },
            layout: 'lightHorizontalLines',
          },
        ],
        { breakBefore: true },
      ),
    );
  }

  // The page model turns the flow into pages: main column + sidebar (docs/19
  // §3), own pages for the oversized things (§4), the overflow ladder (§5).
  // Every page of the document is one of these nodes — the cover and the
  // Contents included — so `content` below names no page the paginator has not
  // measured.
  content.push(...pageNodes(paginateDocument(blocks, { styles: measureStyles })));

  // ONE report per problem: a failure the loader recorded is pushed up front
  // (so an image that is no longer referenced is still reported) and the
  // renderer pushes it again at the site it printed a placeholder for. The
  // owner must see each failure once, named by its site.
  const reported = problems.filter(
    (problem, index) =>
      problems.findIndex(
        (other) => other.where === problem.where && other.reason === problem.reason,
      ) === index,
  );

  return {
    definition: {
      content,
      styles: measureStyles,
      defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.35 },
      // docs/19 §3's margins, from the ONE place that owns the page geometry —
      // the main column, the gutter and the sidebar consume the content width
      // they leave behind exactly.
      pageMargins: [PAGE_MARGIN, PAGE_MARGIN, PAGE_MARGIN, PAGE_MARGIN],
      info: documentInfo(module, compiledDay),
      footer: (currentPage): Content => ({
        text: `${module.title} · ${currentPage}`,
        alignment: 'center',
        style: 'muted',
      }),
    },
    problems: reported,
  };
}

/** The app that compiles the document (the PDF's own `Creator` entry). */
const COMPILED_BY = 'Campaigner';

/**
 * The PDF's metadata dictionary. Two reasons this is pinned rather than left to
 * pdfmake:
 *
 * 1. **`creationDate` is pinned to the compile DAY** — the same date the cover
 *    prints. pdfkit derives the document `/ID` AND its `CreationDate` entry
 *    from that one value, so an unpinned document differs between two renders
 *    of the SAME definition (MEASURED: equal sizes, first differing byte at the
 *    trailer's `/ID`). Pinned, two renders of one definition are byte-identical,
 *    which is what makes "the same (module, plan) renders the same book" a
 *    checkable claim instead of a hope.
 * 2. **`title`/`creator` name the document honestly** — the module's title and
 *    the app that compiled it, never a model id (docs/17 row 93: provenance is
 *    app-only and reaches no exported document).
 *
 * The cast carries the ONE field pdfmake's shipped type forgets: its
 * `createMetadata` (build/pdfmake.js) lowercases every key and maps
 * `creationDate` → `CreationDate`, but `TDocumentInformation` declares no date
 * field. Nothing else is loose.
 */
function documentInfo(module: Module, compiledDay: string): TDocumentDefinitions['info'] {
  const info = {
    title: module.title,
    creator: COMPILED_BY,
    creationDate: new Date(`${compiledDay}T00:00:00.000Z`),
  };
  // A plain assignment, not a cast: the extra `creationDate` key is structurally
  // fine on a non-fresh object, so only pdfmake's DECLARATION is narrow here.
  return info;
}

/** The pdfmake definition for a module document (see `buildModulePdfDocument`). */
export function buildModuleDefinition(input: ModulePdfInput): TDocumentDefinitions {
  return buildModulePdfDocument(input).definition;
}

/**
 * The module's live battles — ONE PER ENCOUNTER it owns (docs/17 row 254).
 *
 * This used to be the single module-keyed battle row, which made the PDF's
 * `encounterMapImageId` lookup wrong for the second encounter of a module: the
 * list held one battle, so only the encounter it was seeded from resolved its
 * board map and every other encounter fell back to its own `mapImageId`. The
 * PDF's battle input is a PER-ENCOUNTER lookup table, so it must carry every
 * board the module owns. A battle with no provenance (a legacy row) is in the
 * list but matches no encounter and is simply never consulted.
 */
async function moduleBattles(module: Module): Promise<Battle[]> {
  return listBattlesByModule(module.id);
}

/**
 * Builds the module PDF end to end: resolve the encounters' rosters (so a
 * citation nothing can satisfy reports its NAMED missing-ref reason), preload
 * the images the document will actually print at the budget each site prints
 * at, build the definition, render it.
 *
 * Returns the blob AND the loud problems — an image that could not be embedded,
 * a part the parts-document seam refused, or a stored document plan that could
 * not be applied is visible TWICE: a placeholder or a statement in the document
 * the owner opens, and an entry here for the export surface to report (AGENTS
 * rule 2). The export itself never fails on missing data.
 */
export async function buildModulePdf(
  module: Module,
  artifacts: readonly AnyArtifact[],
  generate: (definition: TDocumentDefinitions) => Promise<Blob>,
  options: {
    audience?: ModulePdfAudience;
    codec?: PdfImageCodec;
    compiledAt?: Date;
    /** See `ModulePdfInput.planFailure`: this build's automatic planning failed. */
    planFailure?: string;
  } = {},
): Promise<{ blob: Blob; problems: ModulePdfProblem[] }> {
  const battles = await moduleBattles(module);
  const scoped = modulePdfArtifacts(module, artifacts);
  const rosterResolution: Record<Id, readonly ResolvedMonster[]> = {};
  // Every block this document may print, through the SAME box rule the
  // renderer uses (`rosterStatBlockFor`), so an inline block and a cited
  // library block both contribute the system their spell chips resolve
  // against (docs/17 row 184). Derived from the BLOCKS, so no caller has to
  // know the campaign's system.
  const blocks: (StatBlock | null)[] = [];
  for (const artifact of scoped) {
    if (artifact.kind === 'encounter') {
      const resolved = await resolveMonsterEntries(artifact.data.monsters);
      rosterResolution[artifact.id] = resolved;
      for (const monster of artifact.data.monsters) {
        blocks.push(rosterStatBlockFor(monster));
      }
    } else if (artifact.kind === 'npc') {
      blocks.push(artifact.data.statBlock);
    }
  }
  const spellIndexes = await loadSpellIndexesFor(statBlockSystems(blocks));
  // What to PRELOAD is `imageInventories`: every scoped artifact's own cover,
  // every encounter's map (its own or the live board's) and the module's cover —
  // the SAME set the printed document draws from in BOTH paths, so the loaded
  // set and the printed set are ONE decision (docs/17 row 187).
  //
  // UNTIL ROW 187 this narrowed the requests to the images the plan ANCHORED
  // (plus the module cover), on the reasoning that a planned document "prints
  // exactly the images the plan anchored". That reasoning was the defect's other
  // half: an artifact's own cover is not the plan's to gate, so the narrowing
  // made the planned path preload the very images it then failed to print — and,
  // once the renderer printed them anyway, would have reported every one of them
  // as "not in the preloaded image set". The narrowing is DELETED rather than
  // extended: a second "what will print" rule beside the renderer's is exactly
  // the drift this seam exists to prevent, and the cost of preloading the
  // scoped set is the cost the procedural outline has always paid.
  const requests = imageInventories({ module, scoped, battles }).requests;
  const images = await loadPdfImages(requests, {
    ...(options.codec === undefined ? {} : { codec: options.codec }),
  });
  const { definition, problems } = buildModulePdfDocument({
    module,
    artifacts,
    battles,
    images,
    rosterResolution,
    spellIndexes,
    ...(options.audience === undefined ? {} : { audience: options.audience }),
    ...(options.compiledAt === undefined ? {} : { compiledAt: options.compiledAt }),
    ...(options.planFailure === undefined ? {} : { planFailure: options.planFailure }),
  });
  return { blob: await generate(definition), problems };
}
