import { useMemo } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';

import type { AnyArtifact, Id, Module } from '@/domain';
import { buildWikiGraph, type WikiGraphNode } from '@/domain/wikiGraph';
import { mentionModuleTitle, mentionRoute, whereLabel } from '@/features/campaign/mentionView';
import { useModules } from '@/features/modules/hooks';

export interface MentionsPanelProps {
  artifact: AnyArtifact;
  campaignId: Id;
  /** The reader's resolution pool — campaign artifacts + global library,
   * exactly what the editor already holds (the reader's pool, 5b28bc2). */
  campaignArtifacts: readonly AnyArtifact[];
}

/**
 * Mentions panel (14-BACKLINKS-ORPHANS): every wiki-link mention of this
 * entity across all modules, one row per (module, document) with the module
 * title, the Premise/Part N location and the ×count, each row deep-linking
 * to the reader location. Mentions ONLY — the hand-curated relations stay in
 * the Relations section rendered right above this panel; the two graphs are
 * never mixed into one list.
 *
 * The derivation is the Graph page's `buildWikiGraph` with the reader's pool
 * — alias matches merge in, a module-tier same-named artifact shadows its own
 * prose exactly as the reader resolves it. It is derived UNCAPPED
 * (`cap: Number.POSITIVE_INFINITY`): the graph page's 120-node cap must never
 * silently hide this entity's mentions. Rows are per (module, document),
 * bounded by the documents mentioning the entity — no cap of its own,
 * decision 1 says every mention. Nothing persists; memoized. The pool comes
 * in as a prop (stable while typing — no live query on the artifacts table
 * re-firing through every autosave); only the module list is a live query.
 */
export function MentionsPanel({
  artifact,
  campaignId,
  campaignArtifacts,
}: MentionsPanelProps): JSX.Element {
  const modules = useModules(campaignId);

  // The node of THIS artifact in the derived graph; `null` (loaded, not
  // mentioned) is distinct from `undefined` (still loading).
  const node = useMemo<WikiGraphNode | null | undefined>(() => {
    if (modules === undefined) return undefined;
    const graph = buildWikiGraph(modules, campaignArtifacts, {
      cap: Number.POSITIVE_INFINITY,
    });
    return graph.nodes.find((candidate) => candidate.key === artifact.id) ?? null;
  }, [modules, campaignArtifacts, artifact.id]);

  const total =
    node?.mentionsByDocument.reduce((sum, mention) => sum + mention.count, 0) ?? 0;

  return (
    <section
      className="flex flex-col gap-2"
      data-testid="mentions-panel"
      aria-label="Mentioned in module prose"
    >
      <h2 className="text-sm font-medium">
        Mentioned in
        {node != null && (
          <span className="ml-2 text-xs font-normal text-muted-foreground" data-testid="mentions-count">
            {total} {total === 1 ? 'mention' : 'mentions'}
          </span>
        )}
      </h2>
      <p className="text-xs text-muted-foreground">
        Wiki-link mentions in module prose, derived with the reader&apos;s resolution. Hand-curated
        relations stay in the Relations section above.
      </p>
      {node === undefined || modules === undefined ? (
        <p className="text-xs text-muted-foreground" data-testid="mentions-loading">
          Loading…
        </p>
      ) : node === null ? (
        <p className="text-xs text-muted-foreground" data-testid="mentions-empty">
          No mentions yet — write <code>[[{artifact.name}]]</code>
          {artifact.aliases.length > 0 ? ' or one of its aliases' : ''} in a module&apos;s premise
          or parts.
        </p>
      ) : (
        <MentionRows node={node} modules={modules} campaignId={campaignId} />
      )}
    </section>
  );
}

/** The loaded rows: spellings line, ambiguous note, and one deep link per
 * (module, document) mention. Split out so `modules` arrives narrowed. */
function MentionRows({
  node,
  modules,
  campaignId,
}: {
  node: WikiGraphNode;
  modules: readonly Module[];
  campaignId: Id;
}): JSX.Element {
  return (
    <>
      {node.names.length > 1 && (
        <p className="text-xs text-muted-foreground" data-testid="mentions-aliases">
          Mentioned as {node.names.map((name) => `[[${name}]]`).join(', ')}
        </p>
      )}
      {node.status === 'ambiguous' && (
        <p className="text-xs text-muted-foreground" data-testid="mentions-ambiguous">
          ⚠ Several artifacts match a resolving name — the reader&apos;s winner is this one.
        </p>
      )}
      <ul className="flex flex-col">
        {node.mentionsByDocument.map((mention) => (
          <li key={`${mention.moduleId}-${mention.where}`}>
            <Link
              to={mentionRoute(campaignId, mention)}
              className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent"
              data-testid="mention-row"
              data-where={mention.where}
            >
              <span className="min-w-0 flex-1 truncate">
                {mentionModuleTitle(modules, mention.moduleId)}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {whereLabel(mention.where)}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                ×{String(mention.count)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
