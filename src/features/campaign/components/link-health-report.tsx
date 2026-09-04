import { useState } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';

import { artifactPath } from '@/app/routes';
import { ARTIFACT_KIND_LABELS, type AnyArtifact, type Id, type Module } from '@/domain';
import {
  wikiGraphNodeLabel,
  type WikiGraph,
  type WikiGraphKindFilter,
  type WikiGraphNode,
} from '@/domain/wikiGraph';
import {
  mentionSummaryText,
  nodeFirstMentionRoute,
} from '@/features/campaign/mentionView';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

/** Visible rows per sub-list before the truncation note kicks in
 * (14-BACKLINKS-ORPHANS §4 — the proposed, binding cap). */
export const LINK_HEALTH_ROW_CAP = 20;

export interface LinkHealthReportProps {
  campaignId: Id;
  /** The same module list the derivation saw (title lookups). */
  modules: readonly Module[];
  /** The reader's pool — candidates for the never-mentioned list. */
  pool: readonly AnyArtifact[];
  /** The page's current kind filter — the report honors it (14 §4). */
  kindFilter: WikiGraphKindFilter | 'all';
  /** The uncapped, filter-scoped derivation shared with the page. */
  graph: WikiGraph;
}

/**
 * Link-health report (14-BACKLINKS-ORPHANS): a collapsible section below the
 * Graph page's drawing, fed by the same derivation as the graph (uncapped, so
 * the report's own visible caps are the whole truth). Two sub-lists:
 *
 * - **Unresolved mentions** — phantom names (already grouped by name, keyed
 *   `name:<lowercase>`), ranked by mentions desc then name; each row
 *   deep-links to the phantom's FIRST reader location, where the dashed chip
 *   and its stub/adopt flow live.
 * - **Never-mentioned artifacts** — pool artifacts with zero resolving
 *   mentions in the filtered scope, alphabetical; each row links to the
 *   entity detail route (deletion or prose-wiring candidates).
 *
 * The kind filter applies literally: a resolved kind hides the phantom list
 * (phantoms have no kind — a muted note explains), the "Unresolved" filter
 * hides the artifact list. Both sub-lists cap at LINK_HEALTH_ROW_CAP with a
 * roster-style truncation note. Nothing persists; the parent memoizes.
 */
export function LinkHealthReport({
  campaignId,
  modules,
  pool,
  kindFilter,
  graph,
}: LinkHealthReportProps): JSX.Element {
  const [open, setOpen] = useState(false);

  const unresolvedVisible = kindFilter === 'all' || kindFilter === 'unresolved';
  const neverVisible = kindFilter !== 'unresolved';

  const unresolvedAll = graph.nodes
    .filter((node) => node.status === 'unresolved')
    .sort(
      (a, b) =>
        b.mentions - a.mentions ||
        wikiGraphNodeLabel(a).localeCompare(wikiGraphNodeLabel(b)) ||
        a.key.localeCompare(b.key),
    );
  const unresolvedRows = unresolvedAll.slice(0, LINK_HEALTH_ROW_CAP);
  const unresolvedTruncated = unresolvedAll.length - unresolvedRows.length;

  const mentionedIds = new Set(
    graph.nodes.filter((node) => node.artifact !== undefined).map((node) => node.key),
  );
  const kindScope = kindFilter === 'all' || kindFilter === 'unresolved' ? undefined : kindFilter;
  const neverAll = pool
    .filter(
      (artifact) =>
        (kindScope === undefined || artifact.kind === kindScope) &&
        !mentionedIds.has(artifact.id),
    )
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const neverRows = neverAll.slice(0, LINK_HEALTH_ROW_CAP);
  const neverTruncated = neverAll.length - neverRows.length;

  const counts = [
    ...(unresolvedVisible ? [`${String(unresolvedAll.length)} unresolved`] : []),
    ...(neverVisible ? [`${String(neverAll.length)} never mentioned`] : []),
  ].join(' · ');

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid="link-health">
      <CollapsibleTrigger
        className="flex w-full items-center gap-2 border-t px-2 py-2 text-left text-sm font-medium hover:bg-accent"
        data-testid="link-health-toggle"
      >
        {open ? (
          <ChevronDownIcon aria-hidden className="size-4" />
        ) : (
          <ChevronRightIcon aria-hidden className="size-4" />
        )}
        Link health
        <span
          className="ml-auto text-xs font-normal text-muted-foreground"
          data-testid="link-health-counts"
        >
          {counts}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-3 px-3 py-3 text-sm">
          <section className="flex flex-col gap-1" data-testid="link-health-unresolved">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Unresolved mentions
            </h3>
            {!unresolvedVisible ? (
              <p className="text-xs text-muted-foreground" data-testid="link-health-unresolved-note">
                Phantom names have no kind — switch the kind filter to All kinds or Unresolved to
                see them.
              </p>
            ) : unresolvedRows.length === 0 ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid="link-health-unresolved-empty"
              >
                No unresolved mentions — every wiki-link in scope resolves.
              </p>
            ) : (
              <>
                <ul className="flex flex-col">
                  {unresolvedRows.map((node) => (
                    <UnresolvedRow key={node.key} node={node} modules={modules} campaignId={campaignId} />
                  ))}
                </ul>
                {unresolvedTruncated > 0 && (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="link-health-unresolved-truncated"
                  >
                    Showing {String(unresolvedRows.length)} of {String(unresolvedAll.length)}{' '}
                    unresolved names (truncated; {String(unresolvedTruncated)} more)
                  </p>
                )}
              </>
            )}
          </section>

          <section className="flex flex-col gap-1" data-testid="link-health-never-mentioned">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Never mentioned
            </h3>
            {!neverVisible ? (
              <p className="text-xs text-muted-foreground" data-testid="link-health-never-note">
                The Unresolved filter selects phantom names — switch to All kinds or a kind to see
                never-mentioned entities.
              </p>
            ) : neverRows.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="link-health-never-empty">
                Every entity in scope is mentioned in module prose.
              </p>
            ) : (
              <>
                <ul className="flex flex-col">
                  {neverRows.map((artifact) => (
                    <li key={artifact.id}>
                      <Link
                        to={artifactPath(campaignId, artifact.id)}
                        className="flex items-center gap-2 rounded px-2 py-1 hover:bg-accent"
                        data-testid="link-health-never-row"
                        data-name={artifact.name}
                      >
                        <span className="min-w-0 flex-1 truncate">{artifact.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {ARTIFACT_KIND_LABELS[artifact.kind]}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                {neverTruncated > 0 && (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="link-health-never-truncated"
                  >
                    Showing {String(neverRows.length)} of {String(neverAll.length)} never-mentioned
                    entities (truncated; {String(neverTruncated)} more)
                  </p>
                )}
              </>
            )}
          </section>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** One unresolved phantom row: name + total, per-document summary, deep link
 * to the first reader location (the stub/adopt flow lives there). */
function UnresolvedRow({
  node,
  modules,
  campaignId,
}: {
  node: WikiGraphNode;
  modules: readonly Module[];
  campaignId: Id;
}): JSX.Element {
  return (
    <li>
      <Link
        to={nodeFirstMentionRoute(campaignId, node)}
        className="flex flex-col rounded px-2 py-1 hover:bg-accent"
        data-testid="link-health-unresolved-row"
        data-name={wikiGraphNodeLabel(node)}
      >
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{wikiGraphNodeLabel(node)}</span>
          <span className="shrink-0 text-xs text-muted-foreground">×{String(node.mentions)}</span>
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {mentionSummaryText(node, modules)}
        </span>
      </Link>
    </li>
  );
}
