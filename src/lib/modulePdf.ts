import type { Content, ContentImage, Style, TDocumentDefinitions } from 'pdfmake/interfaces';

import type { AnyArtifact, ArtifactKind, Battle, Id, Module, StatBlock } from '@/domain';
import {
  abilityModifier,
  assembleModulePartsDocument,
  formatModifier,
  printsAbilityModifiers,
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
 * The renderer's input. Deliberately a bag: the LLM-authored document plan
 * (sections/order/titles/roles/image anchors, a later slice) lands here as one
 * more optional field and this renderer executes it — nothing else about the
 * call changes.
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
  const { module, artifacts } = input;
  const battles = input.battles ?? [];
  const requests: PdfImageRequest[] = [];
  if (module.coverImageId !== null) {
    requests.push({
      id: module.coverImageId,
      maxLongEdge: PDF_COVER_MAX_LONG_EDGE,
      where: `the cover of “${module.title}”`,
    });
  }
  for (const artifact of modulePdfArtifacts(module, artifacts)) {
    if (artifact.coverImageId !== null) {
      requests.push({
        id: artifact.coverImageId,
        maxLongEdge: PDF_COVER_MAX_LONG_EDGE,
        where: `the cover of “${artifact.name}”`,
      });
    }
    const mapImageId = encounterMapImageId(artifact, battles);
    if (mapImageId !== null) {
      requests.push({
        id: mapImageId,
        maxLongEdge: PDF_MAP_MAX_LONG_EDGE,
        where: `the map of “${artifact.name}”`,
      });
    }
  }
  return requests;
}

/** The parts of the module, split through the ONE parts-document seam. */
interface RenderedPart {
  planIndex: number;
  title: string;
  levelBand: string;
  text: string;
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
  /** Every artifact id the document actually prints (internal links only). */
  rendered: ReadonlySet<Id>;
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
    return state.rendered.has(target.id)
      ? [
          { text: ' — see ', italics: true },
          { text: target.name, italics: true, linkToDestination: `node-${target.id}` },
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

/** One artifact's body: cover image, prose, per-kind data, cross-references. */
function artifactBody(
  artifact: AnyArtifact,
  state: RenderState,
  options: { covers: boolean },
): Content[] {
  const out: Content[] = [];
  const images = state.input.images ?? NO_PDF_IMAGES;
  if (options.covers && artifact.coverImageId !== null) {
    const where = `the cover of “${artifact.name}”`;
    const dataUrl = imageDataUrlFor(images, artifact.coverImageId);
    if (dataUrl === undefined) {
      // The shipped renderer SKIPPED a cover it could not find in the loaded
      // image map — a silent drop of the owner's art. This is the loud form.
      const failure = failureFor(images, artifact.coverImageId);
      const reason = failure?.reason ?? 'it was not in the preloaded image set';
      out.push(
        alertBox(`“${artifact.name}” has a cover image that could not be embedded — ${reason}`),
      );
      state.problems.push({ where, reason });
    } else if (artifact.kind === 'location' || artifact.kind === 'event') {
      // Locations and events may span full width; everything else ≤45% via
      // columns (pdfmake has no float).
      out.push(imageNode(dataUrl, where, { fit: [450, 320], margin: [0, 0, 0, 6] }));
    } else {
      out.push({
        columns: [
          { image: assertImage(dataUrl, where), fit: [200, 150] },
          { text: '', width: '55%' },
        ],
        margin: [0, 0, 0, 6],
      });
    }
  }
  if (artifact.kind === 'encounter') {
    // The map plate at the encounter's own anchor (owner, verbatim: "Encounter
    // maps should obviously be part of the PDF. They need to be included at the
    // right places."). An encounter with NO map image prints NO plate — the
    // owner's decision, not a failure. A map that EXISTS but cannot be embedded
    // is loud, always: never a silent drop.
    const mapImageId = encounterMapImageId(artifact, state.input.battles ?? []);
    if (mapImageId !== null) {
      const where = `the map of “${artifact.name}”`;
      const dataUrl = imageDataUrlFor(images, mapImageId);
      if (dataUrl === undefined) {
        const failure = failureFor(images, mapImageId);
        const reason = failure?.reason ?? 'it was not in the preloaded image set';
        out.push(alertBox(`The map of “${artifact.name}” could not be embedded — ${reason}`));
        state.problems.push({ where, reason });
      } else {
        out.push(
          imageNode(dataUrl, where, {
            fit: [PAGE_CONTENT_WIDTH, MAP_PLATE_MAX_HEIGHT],
            alignment: 'center',
            margin: [0, 2, 0, 8],
          }),
        );
      }
    }
  }
  if (artifact.body.trim() !== '') {
    out.push(...mdToPdfmakeContent(artifact.body));
  }
  out.push(...dataSections(artifact, state));
  if (artifact.links.length > 0) {
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
      return state.rendered.has(target.id)
        ? {
            text: `see ${target.name}`,
            italics: true,
            linkToDestination: `node-${target.id}`,
            margin: [0, 0, 0, 2],
          }
        : { text: `see ${target.name}`, italics: true, margin: [0, 0, 0, 2] };
    });
    out.push({ text: refs, margin: [0, 4, 0, 0] });
  }
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

/** The treasure ledger rows: every PRINTED encounter that stores treasure. */
function treasureLedger(chapters: readonly KindChapter[]): { name: string; treasure: string }[] {
  const encounters = chapters.find((chapter) => chapter.id === 'encounters')?.artifacts ?? [];
  return encounters.flatMap((entry): { name: string; treasure: string }[] =>
    entry.kind === 'encounter' && entry.data.treasure.trim() !== ''
      ? [{ name: entry.name, treasure: entry.data.treasure }]
      : [],
  );
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
  const gallery = npcGallery(scoped, audience);
  // The ledger aggregates the encounters' `treasure` field, which the player
  // document strips from every encounter — so it is a GM-only appendix. The
  // shipped renderer printed it to players, contradicting §M3-D's own rule.
  const ledger = audience === 'gm' ? treasureLedger(chapters) : [];
  // EVERY artifact the document actually prints, so an internal link is only
  // ever emitted for a destination that exists (pdfmake throws otherwise).
  const rendered = new Set<Id>([
    ...chapters.flatMap((chapter) => chapter.artifacts.map((artifact) => artifact.id)),
    ...gallery.map((artifact) => artifact.id),
  ]);
  const state: RenderState = { input, audience, rendered, byId, problems };

  const content: Content[] = [];

  // ---- Cover -------------------------------------------------------------
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
    text: `Compiled with Campaigner · ${new Date().toISOString().slice(0, 10)}`,
    style: 'muted',
    alignment: 'center',
    margin: [0, 24, 0, 0],
  });

  // ---- Contents ----------------------------------------------------------
  content.push({ text: 'Contents', style: 'part', pageBreak: 'before' });
  content.push({ toc: { id: 'chapters', title: { text: 'Contents', style: 'part' } } });

  // ---- Premise -----------------------------------------------------------
  content.push({
    text: 'Premise',
    style: 'chapter',
    tocItem: 'chapters',
    id: 'node-premise',
    pageBreak: 'before',
  });
  content.push(kicker(module.title));
  const premise = module.spine?.premise ?? '';
  if (premise.trim() === '') {
    const reason = 'the module has no premise yet (the spine pass has not run)';
    content.push(alertBox(`The premise is missing — ${reason}`));
    problems.push({ where: 'the premise of the module', reason });
  } else {
    content.push(...mdToPdfmakeContent(premise));
  }

  // ---- Part plan (GM only: the planning apparatus, not the story) ---------
  const plan = module.spine?.partPlan ?? [];
  if (audience === 'gm' && plan.length > 0) {
    content.push({
      text: 'Part plan',
      style: 'chapter',
      tocItem: 'chapters',
      id: 'node-plan',
      pageBreak: 'before',
    });
    content.push(kicker(`${String(plan.length)} planned parts`));
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
          ...plan.map((entry) => [
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

  // ---- The parts ---------------------------------------------------------
  const parts = renderedParts(module, problems);
  const total = plan.length;
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
    if (part.text.trim() === '') {
      const reason = `part ${String(position)} of ${String(total)} has no text yet`;
      content.push(alertBox(`Part ${String(position)} — “${part.title}” is empty — ${reason}`));
      problems.push({ where: `part ${String(position)} (“${part.title}”)`, reason });
    } else {
      content.push(...mdToPdfmakeContent(part.text));
    }
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
      footer: (currentPage): Content => ({
        text: `${module.title} · ${currentPage}`,
        alignment: 'center',
        style: 'muted',
      }),
    },
    problems: reported,
  };
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
 * every image at the budget its site prints at, build the definition, render
 * it.
 *
 * Returns the blob AND the loud problems — an image that could not be embedded
 * or a part the parts-document seam refused is visible TWICE: a placeholder in
 * the document the owner opens, and an entry here for the export surface to
 * report (AGENTS rule 2). The export itself never fails on missing data.
 */
export async function buildModulePdf(
  module: Module,
  artifacts: readonly AnyArtifact[],
  generate: (definition: TDocumentDefinitions) => Promise<Blob>,
  options: { audience?: ModulePdfAudience; codec?: PdfImageCodec } = {},
): Promise<{ blob: Blob; problems: ModulePdfProblem[] }> {
  const battles = await moduleBattles(module);
  const scoped = modulePdfArtifacts(module, artifacts);
  const rosterOrigins: Record<Id, readonly string[]> = {};
  for (const artifact of scoped) {
    if (artifact.kind !== 'encounter') continue;
    const resolved = await resolveMonsterEntries(artifact.data.monsters);
    rosterOrigins[artifact.id] = resolved.map((entry) => entry.origin);
  }
  const images = await loadPdfImages(modulePdfImageRequests({ module, artifacts, battles }), {
    ...(options.codec === undefined ? {} : { codec: options.codec }),
  });
  const { definition, problems } = buildModulePdfDocument({
    module,
    artifacts,
    battles,
    images,
    rosterOrigins,
    ...(options.audience === undefined ? {} : { audience: options.audience }),
  });
  return { blob: await generate(definition), problems };
}
