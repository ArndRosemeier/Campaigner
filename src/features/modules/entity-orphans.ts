import { useMemo } from 'react';

import type { AnyArtifact, Id, Module } from '@/domain';

import {
  evaluateOrphanGuards,
  orphanCandidatesOf,
  type OrphanGuardInput,
  type OrphanGuardVerdict,
} from '@/db/orphanSweep';

/**
 * Orphaned-entity derivation (08-MODULE-DESIGNER §M4-C "Orphaned entities",
 * read time): tags the module's OWNED artifacts that its own prose never
 * mentions — "orphaned" in the unmentioned sense, distinct from the campaign
 * tree's module-less "Orphaned" group and from phantoms (00-OVERVIEW).
 *
 * PURE over the panel's existing props (`module` + `artifacts`) — no live
 * query, no new props (08 §M4-C binding). The tag and the guards are NOT a
 * second copy of the sweep's logic: this module calls the sweep's own
 * `evaluateOrphanGuards` with the subset of the guard bundle its props can
 * see (`panelOrphanGuardInput`), so the two surfaces decide "deletable" with
 * ONE predicate (`tests/features/orphan-offer-agreement.test.ts` pins the two
 * to identical decisions per candidate on a fixture set covering all five
 * guards). A read-time copy of the guards is exactly what made the panel
 * offer rows the deleter refuses — the owner's report in docs/17 row 92.
 *
 * Reader semantics, inherited from the derivation: mentions are wiki-link
 * TOKENS resolved via `buildWikiGraph` (exact name then aliases,
 * case-insensitive, module-tier precedence per `resolveWikiLink`) — NOT
 * `countOccurrences` substrings. A module-tier same-named artifact in
 * ANOTHER module means that module's prose does not count as a mention of
 * this row (the shadow unit). A name that matches several artifacts is
 * ambiguous — only the reader's winner gets the node — and a shadowed row is
 * flagged so the panel keeps it out of the group AND out of the deletion
 * offer ("same-named entity exists — resolve the duplicate first"; enforced
 * again inside the sweep).
 *
 * A row a guard refuses — or a sweep has already refused — is IN USE, and an
 * in-use row is NOT reported at all (docs/17 row 323): the group is exactly
 * the set a sweep deletes, so a kept row is neither listed nor counted. The
 * refusal itself is not dropped: the row's own verdict carries it for the
 * derivable guards, and the panel's view state records every sweep refusal,
 * so a refusal never leaves the same row offered again. Two guards are
 * derivable from the panel's props — the ambiguity shadow and the encounter
 * roster. The rest (the campaign-wide mention gate, which needs the campaign's
 * OTHER modules' prose; battle tokens/seed fighters) are NOT: their refusals
 * arrive with a sweep's outcome and are held in the panel's view state
 * (`orphanOfferView`).
 */

/** One module-owned unmentioned entity row + the guard verdict it carries. */
export type ModuleOrphanRow = OrphanGuardVerdict;

/** The panel's read model: what the group shows, what a sweep would delete. */
export interface OrphanOfferView {
  /**
   * The group's rows, alphabetical: only rows with NO guard refusal and NO
   * recorded sweep refusal — the DELETABLE set, exactly what a sweep deletes.
   * This list IS the offer; no other row is shown or counted (docs/17 row 323).
   */
  group: ModuleOrphanRow[];
  /**
   * Ambiguity-shadowed rows — outside the group and outside the offer
   * (unchanged, 08 §M4-C: the duplicate must be resolved first).
   */
  hidden: ModuleOrphanRow[];
  /**
   * Rows a guard (or a recorded sweep refusal) keeps IN USE — never shown,
   * never counted, never offered. Carried so the partition of `rows` is
   * complete and the fact that the row was refused is not silently dropped;
   * the sweep's own accounting is untouched.
   */
  keptInUse: ModuleOrphanRow[];
}

/** No recorded sweep refusals (a module the panel has never swept). */
export const NO_SWEEP_REFUSALS: ReadonlyMap<Id, string> = new Map<Id, string>();

/**
 * The guard bundle the panel's EXISTING props can see. Deliberately partial
 * and deliberately honest about it (08 §M4-C binding, no added props):
 * - `campaignModules: [module]` — this module's prose only; the campaign-wide
 *   gate needs the campaign's OTHER modules' prose, which the props do not
 *   carry;
 * - `battles: []` — battle boards are not artifacts.
 * The roster guard and the ambiguity shadow ARE complete here (the pool holds
 * every campaign encounter), which is why the owner's case is fixed at read
 * time; the two underivable guards are closed by the panel's recorded
 * refusals after the first sweep (`orphanOfferView`) and named as a
 * limitation in docs/18 §4.
 */
export function panelOrphanGuardInput(
  module: Module,
  artifacts: readonly AnyArtifact[],
): OrphanGuardInput {
  return {
    module,
    campaignModules: [module],
    pool: artifacts,
    battles: [],
  };
}

/**
 * The ONE orphan ordering — by artifact name, id as the tiebreak. Both the
 * derivation and the view's buckets sort through it, so a row cannot order
 * one way in the tag and another in the group.
 */
function compareOrphanRows(a: ModuleOrphanRow, b: ModuleOrphanRow): number {
  return (
    a.artifact.name.localeCompare(b.artifact.name) ||
    a.artifact.id.localeCompare(b.artifact.id)
  );
}

/**
 * Derives the module's orphan rows: owned orphan-kind candidates with ZERO
 * resolving wiki-link mentions in THIS module's prose, each carrying the
 * guard verdict the panel can derive, alphabetically.
 * The pool is the panel's campaign-only `artifacts` prop — resolution-
 * equivalent for module-owned candidates (a module-owned row always wins
 * its own name's tier 0 in its own module; globals tier last everywhere),
 * so the tag matches the sweep's combined-pool recount.
 */
export function deriveModuleOrphans(
  module: Module,
  artifacts: readonly AnyArtifact[],
): ModuleOrphanRow[] {
  const candidates = orphanCandidatesOf(module.id, artifacts);
  if (candidates.length === 0) return [];
  const evaluation = evaluateOrphanGuards(candidates, panelOrphanGuardInput(module, artifacts));
  return evaluation.verdicts
    .filter((verdict) => !evaluation.moduleMentionedIds.has(verdict.artifact.id))
    .sort(compareOrphanRows);
}

/**
 * The panel's offer, composed from the derivation and the refusals a sweep
 * returned in this panel's session. The partition of `rows` is total:
 * - `group` — rows with NO guard refusal and NO recorded sweep refusal: the
 *   deletable set, and the ONLY thing the panel shows or offers (docs/17
 *   row 323);
 * - `keptInUse` — rows a guard or a recorded refusal keeps IN USE, held out
 *   of the group so a refusal never leaves the same row offered again;
 * - `hidden` — ambiguity-shadowed rows (unchanged, 08 §M4-C).
 * Pure: the panel memoizes it over its props + its recorded refusals.
 */
export function orphanOfferView(
  rows: readonly ModuleOrphanRow[],
  sweepRefusals: ReadonlyMap<Id, string>,
): OrphanOfferView {
  const group: ModuleOrphanRow[] = [];
  const hidden: ModuleOrphanRow[] = [];
  const keptInUse: ModuleOrphanRow[] = [];
  for (const row of rows) {
    if (row.refusal?.guard === 'ambiguity') {
      hidden.push(row);
      continue;
    }
    if (row.refusal !== null || sweepRefusals.has(row.artifact.id)) {
      keptInUse.push(row);
      continue;
    }
    group.push(row);
  }
  group.sort(compareOrphanRows);
  keptInUse.sort(compareOrphanRows);
  return { group, hidden, keptInUse };
}

/**
 * The entity panel's orphan hook (08 §M4-C): memoized over the panel's
 * existing props — no live query, no added props, no reader-surface change.
 * Rows carry the module-scope tag and every guard verdict the props can
 * derive; the in-use/deletable split (with the sweep's recorded refusals)
 * and the destructive actions live in the panel, and the sweep re-checks
 * everything at tx time with the same predicate.
 */
export function useModuleOrphans(
  module: Module,
  artifacts: readonly AnyArtifact[],
): ModuleOrphanRow[] {
  return useMemo(() => deriveModuleOrphans(module, artifacts), [module, artifacts]);
}
