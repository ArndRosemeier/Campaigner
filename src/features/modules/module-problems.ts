import type { AnyArtifact, Module, ModulePart, TextOrigin } from '@/domain';
import { countModuleEncounters, floorRepairTargets } from '@/llm/moduleGen';
import { recordedWriterLabel, recordedWritingModel } from '@/domain';
import { extractWikiLinks, resolveWikiLink } from '@/lib/wikilinks';

/**
 * "Fix module problems" — the DERIVED problem set of the module TEXT
 * (owner intent, verbatim: *"Fix module problems"* only when problems exist;
 * on scope, verbatim: *"This is about the module text, not entities. Entities
 * are automated in other ways. So... when the text is fixed, entities can be
 * regenerated just by the second part of my request."*).
 *
 * THE BOUNDARY. This derivation answers ONE question — "does the module's
 * PROSE/DOCUMENT have problems?" — and it never answers an entity or an image
 * question: the text's unresolved names are entities' business (the entity
 * panel and the post-generation automation own them), so the only check here
 * that a text rewrite can fix is the encounter floor. That is why the type
 * carries `repairable` explicitly instead of letting the UI guess: a problem
 * that no rewrite can fix is REPORTED, never silently dropped and never
 * quietly turned into an entity job.
 *
 * WHICH DETECTORS (all pre-existing, one way to do X — nothing new is
 * invented, and no new runtime gate is added):
 *
 * - **The encounter floor, per level band** — `countModuleEncounters`, the
 *   module's own resolved guardrail (`encounterFloorGuardrailFor`), exactly
 *   the numbers the generation gate and the in-pass repair judge by. Its
 *   `deficient` list is the per-part shortfall; the whole-module total covers
 *   the case where every band is met but the names REPEAT across parts.
 * - **Unresolved wiki-links** — the READER's own detector: for every wiki-link
 *   of every module-text document, `resolveWikiLink` against the reader's pool
 *   (campaign + shared library) and the same `status === 'unresolved' ||
 *   artifact === undefined` test `wiki-markdown` renders the dashed chip with.
 *   A link the reader shows as a stub IS a text problem; the reader is the
 *   surface that defines it, so this module consumes that verdict rather than
 *   re-deciding it.
 *
 * EXCLUDED DELIBERATELY (candidates that would need a classifier guessing at
 * a gate, which AGENTS rules 1/3 forbid, or that are entity-level work):
 * "is the story conflicted", "is the pacing right", "is a clue fair" — prompt
 * discipline, docs/08 §M4-B-1; heuristic/fuzzy name matching for an unresolved
 * link (a variant of an existing name is the normalization pass's job, judged
 * by the model, never by a client heuristic); anything counting artifacts,
 * images or maps (that is the "Resume automatic module creation" deviation —
 * entity work, and its own derivation).
 *
 * PURE and derived at RENDER time: nothing here is stored on the module row,
 * so fixing the text by hand (or breaking it) flips the answer with no flag to
 * go stale.
 */

/** The premise is a document too — the reader renders it in the Intro block. */
export const PREMISE_WHERE = 'premise';

/** One module-text document, named the way the reader names it. */
interface ModuleTextDocument {
  where: string;
  markdown: string;
}

/** The premise + every part, in plan order — the reader's own document list. */
function documentsOf(module: Module): ModuleTextDocument[] {
  const documents: ModuleTextDocument[] = [
    { where: PREMISE_WHERE, markdown: module.spine?.premise ?? '' },
    ...module.parts
      .slice()
      .sort((a, b) => a.planIndex - b.planIndex)
      .map((part) => ({
        where: `part ${String(part.planIndex + 1)}`,
        markdown: part.markdown,
      })),
  ];
  return documents.filter((document) => document.markdown.trim() !== '');
}

/**
 * One part short of the module's encounter floor — the ONE check a scoped text
 * rewrite can fix, through the existing floor-repair seam (`moduleGen`'s
 * `floorRepairInstruction` + `generatePart`).
 */
export interface EncounterFloorProblem {
  check: 'encounter-floor';
  /** True: the repair action may rewrite this part for this check. */
  repairable: true;
  /** The confirmation's line for this rewrite (honest, structured below). */
  label: string;
  planIndex: number;
  title: string;
  levelBand: string;
  /** Encounters this part's band covers / the module needs in total. */
  required: number;
  /** Distinct canonical encounters the text currently names. */
  found: number;
  /**
   * The shortfall is the module TOTAL (names repeat across parts), so this
   * part is targeted for DISTINCT encounters rather than for its own band.
   */
  moduleTotal: boolean;
  /**
   * The part carries text written OUTSIDE the generator — a hand edit, or a
   * model rewrite applied through the canvas. The rewrite replaces it, so the
   * confirmation must say so; it must NOT call that text the owner's, because
   * `edited` cannot tell those two apart (`origin` can — see
   * `modulePartWriterLabel`, which the label uses).
   */
  writtenOutsideGenerator: boolean;
}

/**
 * A wiki-link in the module text that resolves to nothing (the reader's dashed
 * chip). DETECTED here, and NOT repairable by rewriting prose: the honest
 * repair of a name with no entity is to create the entity (the entity panel's
 * batch, or "Resume automatic module creation"), and silently renaming or
 * deleting the owner's names is exactly the prose damage this action must not
 * do.
 */
export interface UnresolvedLinkProblem {
  check: 'unresolved-link';
  /** False: reported by the confirmation, never rewritten by this action. */
  repairable: false;
  label: string;
  /** The link target as written (first spelling wins). */
  name: string;
  /** Every module-text document it appears in ("premise", "part 2", …). */
  where: string[];
}

export type ModuleProblem = EncounterFloorProblem | UnresolvedLinkProblem;

export interface ModuleProblemSet {
  /** Everything the module text has wrong, in a stable order. */
  problems: ModuleProblem[];
  /** The rewritable subset — the confirmation's "what will be rewritten". */
  repairable: EncounterFloorProblem[];
  /** Detected and reported, but not fixable by a scoped text rewrite. */
  reported: UnresolvedLinkProblem[];
}

/** `true` when the module text has any problem at all (the DERIVED answer). */
export function moduleHasProblems(set: ModuleProblemSet): boolean {
  return set.problems.length > 0;
}

/**
 * `true` when the module text has a problem this action can REWRITE — the
 * visibility rule for "Fix module problems".
 *
 * Why not `moduleHasProblems` (the whole set): the other detected problems are
 * UNRESOLVED wiki-links, and the reader's own chip calls them "not detailed
 * yet" — they are entity work, which the owner placed OUTSIDE this action
 * (verbatim: *"This is about the module text, not entities. Entities are
 * automated in other ways."*). A button that appeared because of missing
 * entities would be entity work wearing a text label, and it would open a
 * dialog with nothing to rewrite. The detected unresolved links are still
 * reported in the confirmation (never hidden), and the entity half has its own
 * action: "Resume automatic module creation".
 */
export function hasRewritableProblems(set: ModuleProblemSet): boolean {
  return set.repairable.length > 0;
}

/** "Part 2 — Under the Docks" (the confirmation names parts by number+title). */
function partName(planIndex: number, title: string): string {
  const trimmed = title.trim();
  return trimmed === ''
    ? `Part ${String(planIndex + 1)}`
    : `Part ${String(planIndex + 1)} — ${trimmed}`;
}

/** The authorship fields of one module-text document. */
export interface ModuleTextDocumentOrigin {
  origin: TextOrigin | null | undefined;
  writerModel: string | null | undefined;
}

/**
 * WHO WROTE one module-text document, as a label a consent surface can print
 * (docs/17 row 113). THE attribution wording for every surface that names the
 * author of module text, so no two of them can disagree — and so none of them
 * can fall back to the unconditional "you wrote this"/"hand-edited" claim this
 * arc removed.
 *
 * Four honest outcomes:
 *   - `'you'` — a HUMAN write: the owner typed it.
 *   - the model id — a model write whose serving model is recorded.
 *   - `'the model'` — a model write with no recorded id (a legacy row, or a
 *     call that reported none): still a model, never a name that was not
 *     captured.
 *   - `'written by hand (or before the app recorded authorship)'` — NOT
 *     RECORDED (`origin: null`): the app cannot tell, and says so. Every
 *     reader treats that text as human-authored (the conservative default,
 *     `textOriginIsMachineWritten`), which is exactly the sentence above.
 *
 * Deliberately NOT keyed on `edited`: that flag only says the text was written
 * outside the generator, which is equally true of a model rewrite the owner
 * accepted through the canvas.
 */
export function moduleTextWriterLabel(document: ModuleTextDocumentOrigin): string {
  return (
    recordedWriterLabel(document.origin, document.writerModel) ??
    'written by hand (or before the app recorded authorship)'
  );
}

/**
 * The same attribution as a SENTENCE about one PART — "You wrote this part." /
 * "The model `openai/gpt-x` wrote this part." / "This part was written by hand
 * (or before the app recorded authorship)." — the form the confirmations over
 * module text print, so a rewrite is never attributed to the wrong party.
 */
export function modulePartWriterLabel(part: ModulePart | undefined): string {
  const origin = part?.origin ?? null;
  const recorded = recordedWritingModel(part?.writerModel);
  if (origin === 'human') return 'You wrote this part.';
  if (origin === 'model') {
    return recorded === null
      ? 'A model wrote this part.'
      : `The model \`${recorded}\` wrote this part.`;
  }
  return 'This part was written by hand (or before the app recorded authorship).';
}

/**
 * Derives the module text's problems. `artifacts` is the READER's pool
 * (campaign artifacts + shared library) — the pool whose resolution decides
 * whether a chip renders dashed, so the detector can never disagree with what
 * the owner sees on the page.
 */
export function deriveModuleProblems(
  module: Module,
  artifacts: readonly AnyArtifact[],
): ModuleProblemSet {
  const report = countModuleEncounters(module);
  // The SCOPE comes from the repair seam's own derivation (`floorRepairTargets`:
  // the deficient parts, or every planned part when each band is met but the
  // whole-module total is short because names repeat) — so the confirmation can
  // only ever list parts the repair would actually rewrite. The extra facts
  // below (is this the repeats case?) only shape the label.
  const floorTargets = floorRepairTargets(module);
  const repeats = report.deficient.length === 0 && report.found < report.required;

  const floorProblems: EncounterFloorProblem[] = floorTargets.map((target) => {
    const part = module.parts.find((entry) => entry.planIndex === target.planIndex);
    const writtenOutsideGenerator = part?.edited === true;
    const head = repeats
      ? `${partName(target.planIndex, target.title)}: the module names ${String(report.found)} distinct encounter${report.found === 1 ? '' : 's'} of ${String(report.required)} — names repeat across parts, so this part must add distinct ones`
      : `${partName(target.planIndex, target.title)} (band ${target.levelBand}): the encounter floor needs ${String(target.required)}, the text names ${String(target.found)}`;
    return {
      check: 'encounter-floor',
      repairable: true,
      label: writtenOutsideGenerator
        ? `${head}. ${modulePartWriterLabel(part)} This rewrite replaces it (a version is saved first).`
        : `${head}.`,
      planIndex: target.planIndex,
      title: target.title,
      levelBand: target.levelBand,
      required: repeats ? report.required : target.required,
      found: repeats ? report.found : target.found,
      moduleTotal: repeats,
      writtenOutsideGenerator,
    };
  });

  // The reader's detector, per document: an unresolved chip is a text problem
  // the owner already sees on the page.
  const unresolved = new Map<string, { name: string; where: string[] }>();
  for (const document of documentsOf(module)) {
    for (const link of extractWikiLinks(document.markdown)) {
      const resolution = resolveWikiLink(link.name, artifacts, { moduleId: module.id });
      if (resolution.status !== 'unresolved' && resolution.artifact !== undefined) continue;
      const name = link.name.trim();
      const key = name.toLowerCase();
      const existing = unresolved.get(key);
      if (existing === undefined) {
        unresolved.set(key, { name, where: [document.where] });
        continue;
      }
      if (!existing.where.includes(document.where)) existing.where.push(document.where);
    }
  }

  const unresolvedProblems: UnresolvedLinkProblem[] = [...unresolved.values()].map((entry) => ({
    check: 'unresolved-link',
    repairable: false,
    label: `[[${entry.name}]] resolves to nothing (${entry.where.join(', ')}) — not fixed by rewriting text: generate the entity (entity panel, or "Resume automatic module creation") or correct the name by hand.`,
    name: entry.name,
    where: entry.where,
  }));
  const problems: ModuleProblem[] = [...floorProblems, ...unresolvedProblems];
  return {
    problems,
    // Two buckets, never a filter the UI has to re-derive from `check` strings.
    repairable: problems.filter(
      (problem): problem is EncounterFloorProblem => problem.check === 'encounter-floor',
    ),
    reported: problems.filter(
      (problem): problem is UnresolvedLinkProblem => problem.check === 'unresolved-link',
    ),
  };
}

/** One held normalization proposal, described without an authorship claim. */
export interface HeldRewriteProposal {
  /** `planIndex` −1 is the premise (the stored record's own convention). */
  planIndex: number;
  /** How the reader names the document: `premise`, `part 2`. */
  where: string;
  /** `Premise`, `Part 3` — the label a list row prints. */
  label: string;
  /** How many link rewrites this document's proposal carries. */
  rewriteCount: number;
  /** True when the pass reached this document at all (it always did: the
   * stored record only exists for documents whose text was not rewritten —
   * `moduleGen.applyNormalizationVerdict` holds a proposal exactly when it
   * did NOT apply the rewrite). */
  writer: string;
}

/**
 * What the normalization pass is WAITING for, derived from the stored
 * proposals (docs/17 row 113): the count, and which documents.
 *
 * The banner this feeds used to assert "hand-edited text"/"text you wrote",
 * which the record never said — a proposal exists for text the pass left
 * alone, and since docs/17 row 113 that is text a HUMAN wrote (machine text
 * is normalized immediately, so it never appears here). Even so, the wording
 * is derived from the record rather than asserted about the owner, and the
 * per-document writer comes from the row's own `origin` + `writerModel`.
 */
export function heldRewriteSummary(
  module: Module,
  proposals: readonly { planIndex: number; replacements: readonly unknown[] }[],
): { documents: HeldRewriteProposal[]; rewriteCount: number; documentsProse: string } {
  const documents = proposals.map((proposal) => {
    const planIndex = proposal.planIndex;
    const part =
      planIndex === -1 ? undefined : module.parts.find((entry) => entry.planIndex === planIndex);
    const label = planIndex === -1 ? 'Premise' : `Part ${String(planIndex + 1)}`;
    return {
      planIndex,
      where: planIndex === -1 ? PREMISE_WHERE : `part ${String(planIndex + 1)}`,
      label,
      rewriteCount: proposal.replacements.length,
      writer: moduleTextWriterLabel(
        planIndex === -1
          ? { origin: module.spine?.origin, writerModel: module.spine?.writerModel }
          : { origin: part?.origin, writerModel: part?.writerModel },
      ),
    };
  });
  // Plan order with the premise first — the order the reader reads and the
  // order the proposal builder produced, derived here rather than assumed.
  documents.sort((a, b) => a.planIndex - b.planIndex);
  return {
    documents,
    rewriteCount: documents.reduce((total, document) => total + document.rewriteCount, 0),
    documentsProse: joinNames(documents.map((document) => document.where)),
  };
}

/** `a`, `a and b`, `a, b and c` — the list wording the banner prints. */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

/**
 * THE banner sentence for held normalization rewrites (docs/17 row 113).
 *
 * What it says: how many rewrites are waiting and where. What it deliberately
 * does NOT say: who wrote that text. The previous sentence —
 * *"Normalization wants to update hand-edited text — review the proposed
 * rewrites."* — asserted authorship the record never carried, and it fired on
 * modules the owner had never touched (the generated premise always took the
 * proposal path). The rewrites ARE pending, so a banner is still required; it
 * just reports the pending work instead of blaming him for text he did not
 * write. Who wrote each document is named per row in the dialog, where the
 * row's own `origin`/`writerModel` can be stated precisely.
 */
export function heldRewritesBanner(summary: {
  documents: readonly { where: string }[];
  rewriteCount: number;
  documentsProse: string;
}): string {
  return (
    `Normalization is holding ${String(summary.rewriteCount)} link rewrite${summary.rewriteCount === 1 ? '' : 's'} ` +
    `for review — ${summary.documentsProse}. ${String(summary.documents.length)} ` +
    `${summary.documents.length === 1 ? 'document is' : 'documents are'} waiting on your decision; ` +
    'nothing has been changed.'
  );
}
