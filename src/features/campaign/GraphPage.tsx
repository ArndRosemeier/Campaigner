import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeftIcon } from 'lucide-react';

import { ROUTES, artifactPath, modulePath, modulesPath, workspacePath } from '@/app/routes';
import { ARTIFACT_KINDS, ARTIFACT_KIND_LABELS, type ArtifactKind } from '@/domain';
import {
  buildWikiGraph,
  type WikiGraphKindFilter,
  type WikiGraphNode,
} from '@/domain/wikiGraph';
import { Button, buttonVariants } from '@/components/ui/button';
import { HelpButton } from '@/help/HelpButton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useArtifacts, useGlobalArtifacts } from '@/features/campaign/hooks';
import { useModules } from '@/features/modules/hooks';
import { layoutWikiGraph } from '@/lib/graphLayout';

/** Node fill colors per kind (Tailwind palette, dark-mode friendly). */
const KIND_COLORS: Readonly<Record<ArtifactKind, string>> = {
  pc: '#fda4af',
  npc: '#7dd3fc',
  location: '#86efac',
  faction: '#fca5a5',
  note: '#d8b4fe',
  encounter: '#fdba74',
  plotarc: '#fde047',
};

/** Module hub fill (a neutral square — hubs are prose, not artifacts). */
const MODULE_COLOR = '#a1a1aa';

const NODE_RADIUS = 14;
/** Gap between a node's rim and the start of its edges. */
const EDGE_TRIM = NODE_RADIUS + 2;

type KindFilter = 'all' | WikiGraphKindFilter;

/**
 * Wiki-link graph (13-WIKI-GRAPH): the REAL graph — [[wiki-link]] mentions in
 * module prose (premise + parts), resolved exactly like the reader resolves
 * them (campaign pool + globals, module context tier-0). Derived at read time
 * by `buildWikiGraph`, memoized; nothing is persisted. Module hubs connect to
 * the entities their prose mentions; edge thickness/label = mention count;
 * unresolved names render as dashed phantom nodes — the campaign's to-do
 * list. Hand-curated relations are NOT drawn here; they live on each
 * artifact's Relations section.
 */
export function GraphPage(): JSX.Element {
  const { campaignId } = useParams<{ campaignId: string }>();
  const artifacts = useArtifacts(campaignId ?? undefined);
  // Module text resolves against the campaign pool PLUS the shared library —
  // the reader's combined pool (5b28bc2); the graph must not phantomize a
  // name the reader resolves.
  const globalArtifacts = useGlobalArtifacts();
  const modules = useModules(campaignId ?? undefined);
  const navigate = useNavigate();

  const [moduleFilter, setModuleFilter] = useState<string>('all');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');

  const pool = useMemo(() => {
    if (artifacts === undefined || globalArtifacts === undefined) return undefined;
    return [...artifacts, ...globalArtifacts];
  }, [artifacts, globalArtifacts]);

  // Unfiltered graph: the stable module list for the module filter (every
  // module whose prose mentions at least one name, whatever is displayed).
  const allGraph = useMemo(() => {
    if (modules === undefined || pool === undefined) return undefined;
    return buildWikiGraph(modules, pool);
  }, [modules, pool]);
  // Display graph: the filters recompute the prose scope and node scope.
  const graph = useMemo(() => {
    if (modules === undefined || pool === undefined) return undefined;
    return buildWikiGraph(modules, pool, {
      moduleId: moduleFilter === 'all' ? undefined : moduleFilter,
      kind: kindFilter === 'all' ? undefined : kindFilter,
    });
  }, [modules, pool, moduleFilter, kindFilter]);

  const layout = useMemo(() => (graph === undefined ? undefined : layoutWikiGraph(graph)), [graph]);
  const nodeByKey = useMemo(
    () => new Map((graph?.nodes ?? []).map((node) => [node.key, node])),
    [graph],
  );

  if (campaignId === undefined) {
    return <Missing message="No campaign selected." />;
  }

  const loading =
    artifacts === undefined || globalArtifacts === undefined || modules === undefined;
  const phantomCount = (graph?.nodes ?? []).filter((node) => node.status === 'unresolved').length;
  const mentionTotal = (graph?.nodes ?? []).reduce((sum, node) => sum + node.mentions, 0);
  const entityTotal = (graph?.nodes.length ?? 0) + (graph?.truncated ?? 0);

  /** Phantom click-through: the reader location of the first mention — the
   * dashed chip (and its stub/adopt flow) already lives there. */
  const phantomRoute = (node: WikiGraphNode): string => {
    const first = node.mentionsByDocument[0];
    if (first === undefined) return modulesPath(campaignId);
    const match = /^part-(\d+)$/.exec(first.where);
    return match !== null
      ? modulePath(campaignId, first.moduleId, Number(match[1]))
      : modulePath(campaignId, first.moduleId);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b p-2">
        <Button
          variant="ghost"
          size="icon-sm"
          render={<Link to={workspacePath(campaignId)} />}
          nativeButton={false}
          aria-label="Back to workspace"
        >
          <ArrowLeftIcon aria-hidden />
        </Button>
        <h1 className="flex items-center gap-1 text-sm font-semibold">
          Wiki-link graph
          <HelpButton topic="graph" label="wiki-link graph" />
        </h1>
        {graph !== undefined && (
          <span className="text-xs text-muted-foreground" data-testid="graph-counts">
            {String(graph.nodes.length)} entities · {String(phantomCount)} phantoms ·{' '}
            {String(mentionTotal)} mentions
          </span>
        )}
      </div>

      {loading || graph === undefined || layout === undefined ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b px-2 py-2">
            <Select
              value={moduleFilter}
              onValueChange={(next) => {
                if (next !== null) setModuleFilter(next);
              }}
            >
              <SelectTrigger
                size="sm"
                className="min-w-44"
                aria-label="Filter by module"
                data-testid="graph-module-filter"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All modules</SelectItem>
                {(allGraph?.modules ?? []).map((module) => (
                  <SelectItem key={module.id} value={module.id}>
                    {module.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={kindFilter}
              onValueChange={(next) => {
                if (next !== null) setKindFilter(next);
              }}
            >
              <SelectTrigger
                size="sm"
                className="min-w-40"
                aria-label="Filter by entity kind"
                data-testid="graph-kind-filter"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All kinds</SelectItem>
                {ARTIFACT_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {ARTIFACT_KIND_LABELS[kind]}
                  </SelectItem>
                ))}
                <SelectItem value="unresolved">Unresolved (phantoms)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {layout.nodes.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm text-muted-foreground" data-testid="graph-empty">
                {allGraph?.nodes.length === 0
                  ? 'Nothing to graph yet — write [[wiki-links]] in a module\u2019s premise or parts.'
                  : 'Nothing matches the current filters.'}
              </p>
              <Link
                to={workspacePath(campaignId)}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                Back to workspace
              </Link>
            </div>
          ) : (
            <div className="flex-1 overflow-auto p-4" data-testid="link-graph">
              {/* Honest copy (13-WIKI-GRAPH decision 9): this graph draws the
                  derived wiki-link graph of the module prose; hand-curated
                  relations stay on the artifact card. */}
              <p className="mx-auto mb-3 max-w-2xl text-center text-xs text-muted-foreground">
                Derived from [[wiki-links]] in module prose (premise + parts), resolved the way the
                reader resolves them. Dashed nodes are unresolved names — the campaign&apos;s to-do
                list. Hand-curated relations stay on each artifact&apos;s Relations section.
              </p>
              {graph.truncated > 0 && (
                <p className="mb-3 text-center text-xs text-muted-foreground" data-testid="graph-truncation-note">
                  Showing {String(graph.nodes.length)} of {String(entityTotal)} entities (graph
                  truncated; {String(graph.truncated)} more)
                </p>
              )}
              <svg
                width={layout.width}
                height={layout.height}
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                className="mx-auto"
                role="img"
                aria-label="Wiki-link graph of campaign modules"
              >
                {layout.edges.map((edge) => {
                  const from = layout.nodes.find((node) => node.key === edge.from);
                  const to = layout.nodes.find((node) => node.key === edge.to);
                  if (from === undefined || to === undefined) return null;
                  const dx = to.x - from.x;
                  const dy = to.y - from.y;
                  const length = Math.hypot(dx, dy) || 1;
                  const ux = dx / length;
                  const uy = dy / length;
                  const x1 = from.x + ux * EDGE_TRIM;
                  const y1 = from.y + uy * EDGE_TRIM;
                  const x2 = to.x - ux * EDGE_TRIM;
                  const y2 = to.y - uy * EDGE_TRIM;
                  const midX = (x1 + x2) / 2;
                  const midY = (y1 + y2) / 2;
                  // Weight = mention count: thicker line, ×N label from 2 on.
                  const strokeWidth = 1 + Math.min(edge.weight - 1, 4);
                  return (
                    <g key={`${edge.from}-${edge.to}`}>
                      <line
                        x1={x1}
                        y1={y1}
                        x2={x2}
                        y2={y2}
                        stroke="currentColor"
                        className="text-muted-foreground/50"
                        strokeWidth={strokeWidth}
                      />
                      {edge.weight > 1 && (
                        <text
                          x={midX}
                          y={midY - 3}
                          textAnchor="middle"
                          className="fill-muted-foreground"
                          fontSize={9}
                        >
                          ×{String(edge.weight)}
                        </text>
                      )}
                    </g>
                  );
                })}
                {layout.nodes.map((node) => (
                  <g
                    key={node.key}
                    transform={`translate(${node.x}, ${node.y})`}
                    className="cursor-pointer"
                    onClick={() => {
                      if (node.group === 'module') {
                        navigate(modulePath(campaignId, node.key));
                        return;
                      }
                      if (node.group === 'phantom') {
                        const target = nodeByKey.get(node.key);
                        if (target !== undefined) navigate(phantomRoute(target));
                        return;
                      }
                      navigate(artifactPath(campaignId, node.key));
                    }}
                  >
                    {node.group === 'module' ? (
                      <rect
                        x={-NODE_RADIUS}
                        y={-NODE_RADIUS}
                        width={NODE_RADIUS * 2}
                        height={NODE_RADIUS * 2}
                        rx={6}
                        fill={MODULE_COLOR}
                        className="stroke-background"
                        strokeWidth={2}
                      />
                    ) : node.group === 'phantom' ? (
                      <circle
                        r={NODE_RADIUS}
                        fill="transparent"
                        className="stroke-muted-foreground"
                        strokeWidth={2}
                        strokeDasharray="4 3"
                      />
                    ) : (
                      <circle
                        r={NODE_RADIUS}
                        fill={KIND_COLORS[node.group]}
                        className="stroke-background"
                        strokeWidth={2}
                      />
                    )}
                    <text textAnchor="middle" dy={32} fontSize={10} className="fill-foreground">
                      {node.label.length > 18 ? `${node.label.slice(0, 17)}…` : node.label}
                    </text>
                    <title>
                      {node.group === 'module'
                        ? `Module — ${node.label}`
                        : node.group === 'phantom'
                          ? `${node.label} — not detailed yet`
                          : `${ARTIFACT_KIND_LABELS[node.group]} — ${node.label}`}
                    </title>
                  </g>
                ))}
              </svg>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 border-t p-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block size-3.5 rounded-[4px]"
                style={{ backgroundColor: MODULE_COLOR }}
              />
              Module
            </span>
            {Object.entries(ARTIFACT_KIND_LABELS).map(([kind, label]) => (
              <span key={kind} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block size-2.5 rounded-full"
                  style={{ backgroundColor: KIND_COLORS[kind as ArtifactKind] }}
                />
                {label}
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block size-2.5 rounded-full border border-dashed border-muted-foreground"
              />
              Unresolved
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function Missing({ message }: { message: string }): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
      {message}
      <Button
        variant="outline"
        size="sm"
        render={<Link to={ROUTES.campaignPicker} />}
        nativeButton={false}
      >
        All campaigns
      </Button>
    </div>
  );
}
