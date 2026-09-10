import type { AnyArtifact, Module } from '@/domain';
import { countModuleEncounters, floorRepairTargets } from '@/llm/moduleGen';
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
  /** The part carries hand-written text — the rewrite replaces it. */
  handEdited: boolean;
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

/** `true` when the module text has any problem (the button's visibility). */
export function moduleHasProblems(set: ModuleProblemSet): boolean {
  return set.problems.length > 0;
}

/** "Part 2 — Under the Docks" (the confirmation names parts by number+title). */
function partName(planIndex: number, title: string): string {
  const trimmed = title.trim();
  return trimmed === ''
    ? `Part ${String(planIndex + 1)}`
    : `Part ${String(planIndex + 1)} — ${trimmed}`;
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
    const handEdited = part?.edited === true;
    const head = repeats
      ? `${partName(target.planIndex, target.title)}: the module names ${String(report.found)} distinct encounter${report.found === 1 ? '' : 's'} of ${String(report.required)} — names repeat across parts, so this part must add distinct ones`
      : `${partName(target.planIndex, target.title)} (band ${target.levelBand}): the encounter floor needs ${String(target.required)}, the text names ${String(target.found)}`;
    return {
      check: 'encounter-floor',
      repairable: true,
      label: handEdited
        ? `${head}. Hand-edited — this rewrite replaces your text (a version is saved first).`
        : `${head}.`,
      planIndex: target.planIndex,
      title: target.title,
      levelBand: target.levelBand,
      required: repeats ? report.required : target.required,
      found: repeats ? report.found : target.found,
      moduleTotal: repeats,
      handEdited,
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
