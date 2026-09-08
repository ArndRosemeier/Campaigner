import { useMemo } from 'react';

import type { AnyArtifact, Module } from '@/domain';
import { buildWikiGraph } from '@/domain/wikiGraph';
import { resolveWikiLink } from '@/lib/wikilinks';

import { orphanCandidatesOf } from '@/db/orphanSweep';

/**
 * Orphaned-entity derivation (08-MODULE-DESIGNER §M4-C "Orphaned entities",
 * read time): tags the module's OWNED artifacts that its own prose never
 * mentions — "orphaned" in the unmentioned sense, distinct from the campaign
 * tree's module-less "Orphaned" group and from phantoms (00-OVERVIEW).
 *
 * PURE over the panel's existing props (`module` + `artifacts`) — no live
 * query, no new props (08 §M4-C binding): the panel tags rows, the SWEEP
 * (db/orphanSweep.ts) re-derives every scope + guard inside its transaction
 * (recount doctrine) and is the only deleter. Both sides consume
 * `buildWikiGraph`/`resolveWikiLink` — never a forked extractor — and the
 * sweep tx tests pin the two to identical decisions on shared fixtures.
 *
 * Reader semantics, inherited from the derivation: mentions are wiki-link
 * TOKENS resolved via `buildWikiGraph` (exact name then aliases,
 * case-insensitive, module-tier precedence per `resolveWikiLink`) — NOT
 * `countOccurrences` substrings. A module-tier same-named artifact in
 * ANOTHER module means that module's prose does not count as a mention of
 * this row (the shadow unit). A name that matches several artifacts is
 * ambiguous — only the reader's winner gets the node — and a shadowed row
 * is flagged so the panel can exclude it from deletion ("same-named entity
 * exists — resolve the duplicate first"; enforced again inside the sweep).
 *
 * The campaign-wide gate (zero mentions across ALL campaign modules —
 * cross-module-mentioned rows are kept) is the SWEEP's guard, re-derived
 * from re-listed rows inside its tx: the panel's props cannot see the
 * campaign's other prose, and a read-time copy of the gate would be thrown
 * away at tx time anyway.
 */

/** One module-owned unmentioned entity, with its deletion-exclusion flag. */
export interface ModuleOrphanRow {
  artifact: AnyArtifact;
  /**
   * The written name is ambiguity-shadowed (a same-named entity wins the
   * node) — the panel excludes the row from deletion.
   */
  ambiguous: boolean;
}

/**
 * Derives the module's orphan rows: owned orphan-kind candidates with ZERO
 * resolving wiki-link mentions in THIS module's prose, alphabetically.
 * The pool is the panel's campaign-only `artifacts` prop — resolution-
 * equivalent for module-owned candidates (a module-owned row always wins
 * its own name's tier 0 in its own module; globals tier last everywhere),
 * so the tag matches the sweep's combined-pool recount.
 */
export function deriveModuleOrphans(
  module: Module,
  artifacts: readonly AnyArtifact[],
): ModuleOrphanRow[] {
  // The module-scope tag: the ids buildWikiGraph resolves to an entity from
  // THIS module's prose (uncapped — a cap must never hide a mention).
  const moduleGraph = buildWikiGraph([module], artifacts, { cap: Number.POSITIVE_INFINITY });
  const mentionedIds = new Set(
    moduleGraph.nodes.filter((node) => node.artifact !== undefined).map((node) => node.key),
  );
  return orphanCandidatesOf(module.id, artifacts)
    .filter((artifact) => !mentionedIds.has(artifact.id))
    .map((artifact) => {
      const resolution = resolveWikiLink(artifact.name, artifacts, { moduleId: module.id });
      const ambiguous =
        resolution.status === 'ambiguous' ||
        (resolution.artifact !== undefined && resolution.artifact.id !== artifact.id);
      return { artifact, ambiguous };
    })
    .sort(
      (a, b) =>
        a.artifact.name.localeCompare(b.artifact.name) ||
        a.artifact.id.localeCompare(b.artifact.id),
    );
}

/**
 * The entity panel's orphan hook (08 §M4-C): memoized over the panel's
 * existing props — no live query, no added props, no reader-surface change.
 * Rows carry the module-scope tag; the deletion-exclusion filter
 * (`!ambiguous`) and the destructive actions live in the panel, and the
 * sweep re-checks everything at tx time.
 */
export function useModuleOrphans(
  module: Module,
  artifacts: readonly AnyArtifact[],
): ModuleOrphanRow[] {
  return useMemo(() => deriveModuleOrphans(module, artifacts), [module, artifacts]);
}
