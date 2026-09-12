import type { Content, ContentImage, Style, TDocumentDefinitions } from 'pdfmake/interfaces';

import type {
  AnyArtifact,
  ArtifactKind,
  Battle,
  DocumentPlanAudience,
  DocumentPlanRole,
  DocumentPlanSource,
  Id,
  Module,
  StatBlock,
} from '@/domain';
import {
  abilityModifier,
  assembleModulePartsDocument,
  documentPlanIssues,
  documentPlanSectionDestination,
  formatModifier,
  printsAbilityModifiers,
  readStoredDocumentPlan,
  splitPartsDocument,
} from '@/domain';
import { isMissingRefOrigin, missingCreatureOrigin } from '@/domain/encounterResolve';
import { getBattleByModule } from '@/db/battleRepo';
import { resolveMonsterEntries } from '@/db/monsterResolve';
import { extractWikiLinks, resolveWikiLink } from '@/lib/wikilinks';
import { mdToPdfmakeContent } from '@/lib/mdToPdfmake';
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
 */

const ACCENT = '#9a7b4f';
const ALERT = '#b91c1c';

/** A4 minus pdfmake's default 40pt side margins — the plate's usable width. */
const PAGE_CONTENT_WIDTH = 515;
/** A map plate never exceeds this printed height (it then scales by width). */
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
   * Per-encounter roster resolution (the async pre-pass in `buildModulePdf`):
   * encounter artifact id → one resolved origin per roster row, in order.
   * Absent ⇒ a `rulebook` entry still prints "(see Bestiary)" and an `npc-ref`
   * still cross-references its row; what resolution adds is the NAMED
   * missing-ref reason of a citation the library cannot satisfy.
   */
  rosterOrigins?: Readonly<Record<Id, readonly string[]>>;
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
}

function isGmOnly(artifact: AnyArtifact): boolean {
  return artifact.tags.includes(GM_ONLY_TAG);
}

/** Small-caps kicker line above part/artifact headers ("Kapitel 2 · …"). */
function kicker(text: string): Content {
  return { text: text.toUpperCase(), style: 'kicker' };
}

function labeledSection(label: string, body: string): Content | null {
  if (body.trim() === '') return null;
  return {
    text: [
      { text: `${label}: `, bold: true, style: 'label' },
      { text: body },
    ],
    margin: [0, 0, 0, 3],
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
function alertBox(text: string, options: { pageBreak?: boolean } = {}): Content {
  return {
    table: { widths: ['*'], body: [[{ text, italics: true, color: ALERT }]] },
    layout: ALERT_BOX_LAYOUT,
    margin: [0, 4, 0, 6],
    ...(options.pageBreak === true ? { pageBreak: 'before' as const } : {}),
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

/** Bordered two-column stat box (M2 export layout, module styling). */
export function statBoxContent(statBlock: StatBlock, name: string): Content {
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
  ].filter((entry): entry is Content => entry !== null);
  return {
    table: {
      widths: ['*', '*'],
      body: [
        [{ colSpan: 2, text: name, bold: true, style: 'h3' }, ''],
        [left, right],
        [
          {
            colSpan: 2,
            stack: statBlock.traits.map(
              (trait): Content => labeledSection(trait.name, trait.text) ?? { text: trait.text },
            ),
          },
          '',
        ],
        [
          {
            colSpan: 2,
            stack: statBlock.actions.map(
              (action): Content =>
                labeledSection(action.name, action.text) ?? { text: action.text },
            ),
          },
          '',
        ],
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
    if (artifact.coverImageId !== null) {
      add(
        artifact.coverImageId,
        'cover',
        `the cover of “${artifact.name}”`,
        PDF_COVER_MAX_LONG_EDGE,
      );
    }
    const mapImageId = encounterMapImageId(artifact, battles);
    if (mapImageId !== null) {
      add(mapImageId, 'map', `the map of “${artifact.name}”`, PDF_MAP_MAX_LONG_EDGE);
    }
  }
  return { byId, requests };
}

/**
 * Reads the module's stored plan and turns it into renderable sections — THE
 * one reader, used by the definition builder (which renders) and by the async
 * builder (which decides what to preload, from the same outcome, so the loaded
 * set and the printed set can never disagree).
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
}

/** The roster entry's origin run, as ONE rule (docs/17 row 108, C5). */
function rosterOriginRun(
  entry: { name: string; source: { type: string } },
  resolvedOrigin: string | undefined,
  artifactId: Id | null,
  state: RenderState,
): Content[] {
  // A citation nothing can satisfy: the NAMED reason, through the ONE
  // predicate — never a `=== 'missing ref'` comparison, which silently never
  // matches because the reason carries the creature's name.
  if (resolvedOrigin !== undefined && isMissingRefOrigin(resolvedOrigin)) {
    return [{ text: ` — ${resolvedOrigin}`, italics: true, color: ALERT }];
  }
  if (entry.source.type === 'inline') {
    // An inline entry CARRIES its stat block, printed immediately below: it
    // needs no origin run at all (the shipped fallback said "no stats" here,
    // which contradicted the stat box under it — a plain lie in the document).
    return [];
  }
  if (entry.source.type === 'npc-ref') {
    const target = artifactId === null ? undefined : state.byId.get(artifactId);
    if (target === undefined) {
      // No row and no resolution: the reference genuinely dangles. Loud, named.
      return [{ text: ` — ${missingCreatureOrigin(entry.name)}`, italics: true, color: ALERT }];
    }
    return state.destinations.has(target.id)
      ? [
          { text: ' — see ', italics: true },
          {
            text: target.name,
            italics: true,
            linkToDestination: state.destinations.get(target.id),
          },
        ]
      : [{ text: ` — see ${target.name}`, italics: true }];
  }
  if (entry.source.type === 'rulebook') {
    // Kept verbatim from the shipped layout: the numbers live in the Bestiary.
    return [{ text: ' (see Bestiary)', italics: true }];
  }
  // A name-only roster entry records no citation at all. The resolution pass
  // normally reports the named missing-ref reason for it (the branch above);
  // with no resolution available this states what is actually true about the
  // row, instead of the shipped renderer's bare "name ×count".
  return [
    {
      text: ' — no stats: this roster entry names the creature without a citation',
      italics: true,
      color: '#555555',
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
      pushSections(out, statBoxContent(artifact.data.statBlock, artifact.name));
    }
  } else if (artifact.kind === 'npc') {
    pushSections(
      out,
      labeledSection('Appearance', artifact.data.appearance),
      labeledSection('Personality', artifact.data.personality),
    );
    if (artifact.data.statBlock !== null) {
      pushSections(out, statBoxContent(artifact.data.statBlock, artifact.name));
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
        const stats =
          monster.source.type === 'inline'
            ? [statBoxContent(monster.source.statBlock, `${monster.name} ×${monster.count}`)]
            : [];
        return {
          stack: [
            {
              text: [
                { text: monster.name, bold: true },
                { text: ` ×${monster.count}` },
                ...rosterOriginRun(
                  monster,
                  state.input.rosterOrigins?.[artifact.id]?.[index],
                  monster.source.type === 'npc-ref' ? monster.source.artifactId : null,
                  state,
                ),
              ],
            },
            ...(monster.notes === '' ? [] : [{ text: monster.notes, style: 'muted' }]),
            ...stats,
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

/** One artifact's body: cover image, prose, per-kind data, cross-references. */
function artifactBody(
  artifact: AnyArtifact,
  state: RenderState,
  options: { covers: boolean },
): Content[] {
  const out: Content[] = [];
  if (options.covers) out.push(...artifactCoverContent(artifact, state));
  out.push(...encounterMapPlate(artifact, state));
  if (artifact.body.trim() !== '') {
    out.push(...mdToPdfmakeContent(artifact.body));
  }
  out.push(...dataSections(artifact, state));
  out.push(...artifactLinksContent(artifact, state));
  return out;
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
 * The treasure ledger rows: every encounter the BODY printed that stores
 * treasure (the encounters chapter in the procedural document; the planned
 * encounter sections when a plan is applied).
 */
function treasureLedger(
  printed: readonly AnyArtifact[],
): { name: string; treasure: string }[] {
  return printed
    .filter((entry) => entry.kind === 'encounter')
    .flatMap((entry): { name: string; treasure: string }[] =>
      entry.data.treasure.trim() !== ''
        ? [{ name: entry.name, treasure: entry.data.treasure }]
        : [],
    );
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
 * The body of a planned section, by ROLE — the ONE place a role becomes a
 * treatment. `explanation` and `gm-note` also carry the source's own structured
 * data (a roster, a stat box, kind fields): that data IS the mechanical content
 * a reader of that section needs, and it stays filtered by the DOCUMENT's
 * audience, so the plan can never print GM mechanics into the player book.
 * `read-aloud` and `aside` carry prose only — a stat block inside narration or
 * a parenthetical would be a lie about what the section is.
 */
function roleBody(
  role: DocumentPlanRole,
  blocks: Content[],
  artifact: AnyArtifact | null,
  state: RenderState,
): Content[] {
  const data = artifact === null ? [] : dataSections(artifact, state);
  switch (role) {
    case 'read-aloud':
      return readAloudRoleContent(blocks);
    case 'aside':
      return asideRoleContent(blocks);
    case 'gm-note':
      return [...gmNoteRoleContent(blocks), ...data];
    case 'explanation':
      return [...blocks, ...data];
  }
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
function premiseContent(module: Module, problems: ModulePdfProblem[]): Content[] {
  const premise = module.spine?.premise ?? '';
  if (premise.trim() !== '') return mdToPdfmakeContent(premise);
  const reason = 'the module has no premise yet (the spine pass has not run)';
  problems.push({ where: 'the premise of the module', reason });
  return [alertBox(`The premise is missing — ${reason}`)];
}

/** One part's text, or the LOUD empty-part box naming its position. */
function partTextContent(
  part: RenderedPart,
  total: number,
  problems: ModulePdfProblem[],
): Content[] {
  const position = part.planIndex + 1;
  if (part.text.trim() !== '') return mdToPdfmakeContent(part.text);
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
 * One planned section, as the document prints it: heading (title from the
 * PLAN, page break and ToC entry from the RENDERER), the source-naming kicker,
 * the images the plan anchored, then the body its role prescribes.
 */
function plannedSectionContent(
  section: PlannedSection,
  state: RenderState,
  parts: ReadonlyMap<number, RenderedPart>,
  total: number,
  module: Module,
): Content[] {
  const out: Content[] = [];
  const aside = section.role === 'aside';
  out.push({
    text: section.title,
    style: aside ? 'h2' : 'chapter',
    id: section.destination,
    ...(aside ? {} : { tocItem: 'chapters' as const, pageBreak: 'before' as const }),
  });
  const source = section.source;
  if (source.type === 'part') {
    if (source.planIndex === -1) {
      out.push(kicker(module.title));
    } else {
      const part = parts.get(source.planIndex);
      const levelText =
        part !== undefined && part.levelBand !== '' ? ` · levels ${part.levelBand}` : '';
      out.push(
        kicker(`Part ${String(source.planIndex + 1)} of ${String(total)}${levelText}`),
      );
    }
  } else {
    out.push(kicker(PLAN_KIND_LABELS[section.artifact?.kind ?? 'note']));
  }
  for (const image of section.images) {
    out.push(...anchoredImageContent(image, state));
  }

  let blocks: Content[];
  if (source.type === 'part') {
    if (source.planIndex === -1) {
      blocks = premiseContent(module, state.problems);
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
          : partTextContent(part, total, state.problems);
    }
  } else {
    const artifact = section.artifact;
    if (artifact === null) {
      blocks = [
        alertBox(`“${section.title}” — the row it names is not in this document's pool`),
      ];
    } else {
      blocks = artifact.body.trim() === '' ? [] : mdToPdfmakeContent(artifact.body);
    }
  }
  out.push(...roleBody(section.role, blocks, section.artifact, state));
  if (section.artifact !== null && section.role !== 'read-aloud' && section.role !== 'aside') {
    out.push(...artifactLinksContent(section.artifact, state));
  }
  return out;
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
  // The parts are read through the ONE seam only when something prints them.
  const total = module.spine?.partPlan.length ?? 0;
  const needsParts =
    plannedSections === null || plannedSections.some((section) => section.source.type === 'part');
  const parts = needsParts ? renderedParts(module, problems) : [];
  const partsByIndex = new Map(parts.map((part) => [part.planIndex, part]));
  // What the BODY printed: the gallery completes it (an NPC the plan already
  // printed as a section is not printed a second time) and the treasure ledger
  // aggregates its encounters.
  const printedArtifacts: AnyArtifact[] =
    plannedSections === null
      ? chapters.flatMap((chapter) => chapter.artifacts)
      : plannedSections.flatMap((section) => (section.artifact === null ? [] : [section.artifact]));
  const printedIds = new Set<Id>(printedArtifacts.map((artifact) => artifact.id));
  const gallery = npcGallery(scoped, audience).filter((npc) => !printedIds.has(npc.id));
  // The ledger aggregates the encounters' `treasure` field, which the player
  // document strips from every encounter — so it is a GM-only appendix. The
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
  if (plannedSections === null) {
    for (const artifact of printedArtifacts) destinations.set(artifact.id, `node-${artifact.id}`);
  } else {
    for (const section of plannedSections) {
      if (section.artifact === null) continue;
      if (!destinations.has(section.artifact.id)) {
        destinations.set(section.artifact.id, section.destination);
      }
    }
  }
  for (const npc of gallery) {
    if (!destinations.has(npc.id)) destinations.set(npc.id, `node-${npc.id}`);
  }
  const state: RenderState = { input, audience, destinations, byId, problems };

  const content: Content[] = [];

  // ---- Cover -------------------------------------------------------------
  const compiledAt = input.compiledAt ?? new Date();
  const compiledDay = compiledAt.toISOString().slice(0, 10);
  const levelLine =
    module.levelMax > module.levelMin
      ? `A module for levels ${String(module.levelMin)}–${String(module.levelMax)}`
      : `A module for level ${String(module.levelMin)}`;
  content.push(
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
      content.push(
        alertBox(`“${module.title}” has a cover image that could not be embedded — ${reason}`),
      );
      problems.push({ where, reason });
    } else {
      content.push(imageNode(dataUrl, where, { fit: [300, 300], alignment: 'center', margin: [0, 24, 0, 0] }));
    }
  }
  content.push({
    text: `Compiled with Campaigner · ${compiledDay}`,
    style: 'muted',
    alignment: 'center',
    margin: [0, 24, 0, 0],
  });

  // ---- Contents ----------------------------------------------------------
  content.push({ text: 'Contents', style: 'part', pageBreak: 'before' });
  content.push({ toc: { id: 'chapters', title: { text: 'Contents', style: 'part' } } });

  // ---- The plan's verdict, in the document ---------------------------------
  // A stored plan that CANNOT be applied is never a silent fallback: the owner
  // sees it here, on the page he opens, AND on the export's problems list.
  if (planOutcome.status === 'invalid' || planOutcome.status === 'rejected') {
    problems.push({ where: PLAN_PROBLEM_WHERE, reason: planOutcome.reason });
    content.push(alertBox(planFallbackStatement(planOutcome.reason), { pageBreak: true }));
  }

  if (plannedSections === null) {
    // ---- Premise ---------------------------------------------------------
    content.push({
      text: 'Premise',
      style: 'chapter',
      tocItem: 'chapters',
      id: 'node-premise',
      pageBreak: 'before',
    });
    content.push(kicker(module.title));
    content.push(...premiseContent(module, problems));

    // ---- Part plan (GM only: the planning apparatus, not the story) ------
    const partPlan = module.spine?.partPlan ?? [];
    if (audience === 'gm' && partPlan.length > 0) {
      content.push({
        text: 'Part plan',
        style: 'chapter',
        tocItem: 'chapters',
        id: 'node-plan',
        pageBreak: 'before',
      });
      content.push(kicker(`${String(partPlan.length)} planned parts`));
      content.push({
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
      });
    }

    // ---- The parts -------------------------------------------------------
    for (const part of parts) {
      const position = part.planIndex + 1;
      const levelText = part.levelBand === '' ? '' : ` · levels ${part.levelBand}`;
      content.push({
        text: part.title,
        style: 'chapter',
        tocItem: 'chapters',
        id: `node-part-${String(part.planIndex)}`,
        pageBreak: 'before',
      });
      content.push(kicker(`Part ${String(position)} of ${String(total)}${levelText}`));
      content.push(...partTextContent(part, total, problems));
    }

    // ---- Per-kind reference chapters --------------------------------------
    for (const chapter of chapters) {
      content.push({
        text: chapter.title,
        style: 'chapter',
        tocItem: 'chapters',
        id: `node-${chapter.id}`,
        pageBreak: 'before',
      });
      for (const artifact of chapter.artifacts) {
        content.push(kicker(chapter.title));
        content.push({
          text: artifact.name,
          style: 'artifact',
          tocItem: 'chapters',
          id: `node-${artifact.id}`,
        });
        content.push(...artifactBody(artifact, state, { covers: true }));
      }
    }
  } else {
    // ---- The planned document: the plan's sections, in the plan's order ----
    for (const section of plannedSections) {
      content.push(...plannedSectionContent(section, state, partsByIndex, total, module));
    }
  }

  // ---- Back matter: the NPC gallery --------------------------------------
  if (gallery.length > 0) {
    content.push({
      text: 'NPC Gallery',
      style: 'chapter',
      tocItem: 'chapters',
      id: 'node-npcs',
      pageBreak: 'before',
    });
    for (const npc of gallery) {
      content.push(kicker('NPC Gallery'));
      content.push({
        text: npc.name,
        style: 'artifact',
        tocItem: 'chapters',
        id: `node-${npc.id}`,
      });
      // The gallery is a reference list: no cover thumbnails (unchanged).
      content.push(...artifactBody(npc, state, { covers: false }));
    }
  }

  // ---- Back matter: the treasure ledger (GM only) ------------------------
  if (ledger.length > 0) {
    content.push({
      text: 'Treasure',
      style: 'chapter',
      tocItem: 'chapters',
      id: 'node-treasure',
      pageBreak: 'before',
    });
    content.push(kicker('Treasure ledger'));
    content.push({
      table: {
        widths: ['*', '*'],
        body: [
          [{ text: 'Encounter', bold: true }, { text: 'Treasure', bold: true }],
          ...ledger.map((row) => [row.name, row.treasure]),
        ],
      },
      layout: 'lightHorizontalLines',
    });
  }

  const styles: Record<string, Style> = {
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
    // The two remaining role treatments (docs/17 row 109): a GM note reads as
    // one step smaller than the body, and an aside is the smallest, muted,
    // indented voice in the document.
    gmNote: { fontSize: 10, color: '#3f3f46' },
    aside: { fontSize: 9.5, italics: true, color: '#555555' },
  };

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
      styles,
      defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.35 },
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

/** The module's live battle, or none (one live battle per module). */
async function moduleBattles(module: Module): Promise<Battle[]> {
  const battle = await getBattleByModule(module.id);
  return battle === undefined ? [] : [battle];
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
  } = {},
): Promise<{ blob: Blob; problems: ModulePdfProblem[] }> {
  const battles = await moduleBattles(module);
  const scoped = modulePdfArtifacts(module, artifacts);
  const rosterOrigins: Record<Id, readonly string[]> = {};
  for (const artifact of scoped) {
    if (artifact.kind !== 'encounter') continue;
    const resolved = await resolveMonsterEntries(artifact.data.monsters);
    rosterOrigins[artifact.id] = resolved.map((entry) => entry.origin);
  }
  // What to PRELOAD comes from the same plan read the renderer uses: with a
  // plan applied the document prints exactly the images the plan anchored, so
  // preloading an unanchored one would both waste the decode and report a
  // failure for an image the document never wanted. A plan that cannot be
  // applied falls back to the procedural document, which wants them all.
  const outcome = resolveDocumentPlan({ module, scoped, battles });
  const allRequests = imageInventories({ module, scoped, battles }).requests;
  const wanted =
    outcome.status === 'applied'
      ? new Set(outcome.sections.flatMap((section) => section.images.map((image) => image.id)))
      : null;
  const requests =
    wanted === null
      ? allRequests
      : allRequests.filter(
          (request) =>
            wanted.has(request.id) ||
            // The cover page is not a planned section: it prints the module's
            // own cover whenever the module has one.
            request.id === module.coverImageId,
        );
  const images = await loadPdfImages(requests, {
    ...(options.codec === undefined ? {} : { codec: options.codec }),
  });
  const { definition, problems } = buildModulePdfDocument({
    module,
    artifacts,
    battles,
    images,
    rosterOrigins,
    ...(options.audience === undefined ? {} : { audience: options.audience }),
    ...(options.compiledAt === undefined ? {} : { compiledAt: options.compiledAt }),
  });
  return { blob: await generate(definition), problems };
}
