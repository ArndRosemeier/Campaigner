import { useMemo } from 'react';
import type { JSX } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeftIcon } from 'lucide-react';

import { ROUTES, artifactPath, workspacePath } from '@/app/routes';
import { ARTIFACT_KIND_LABELS, type ArtifactKind } from '@/domain';
import { Button, buttonVariants } from '@/components/ui/button';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { layoutGraph } from '@/lib/graphLayout';

/** Node fill colors per kind (Tailwind palette, dark-mode friendly). */
const KIND_COLORS: Readonly<Record<ArtifactKind, string>> = {
  npc: '#7dd3fc',
  location: '#86efac',
  faction: '#fca5a5',
  note: '#d8b4fe',
  encounter: '#fdba74',
  plotarc: '#fde047',
  session: '#a5b4fc',
};

/**
 * Graph view (06-MILESTONES M2): artifacts as nodes clustered by kind rows,
 * outgoing links as labeled edges; clicking a node opens the artifact.
 */
export function GraphPage(): JSX.Element {
  const { campaignId } = useParams<{ campaignId: string }>();
  const artifacts = useLiveQuery(() => listArtifactsByCampaign(campaignId ?? ''), [campaignId]);
  const navigate = useNavigate();

  const layout = useMemo(() => layoutGraph(artifacts ?? []), [artifacts]);

  const nodeById = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout]);

  if (campaignId === undefined) {
    return <Missing message="No campaign selected." />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b p-2">
        <Button
          variant="ghost"
          size="icon-sm"
          render={<Link to={workspacePath(campaignId)} />}
          aria-label="Back to workspace"
        >
          <ArrowLeftIcon aria-hidden />
        </Button>
        <h1 className="text-sm font-semibold">Link graph</h1>
        <span className="text-xs text-muted-foreground">
          {layout.nodes.length} artifacts · {layout.edges.length} links
        </span>
      </div>

      {artifacts === undefined ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : layout.nodes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <p className="text-sm text-muted-foreground">
            Nothing to graph yet — create artifacts and link them in the editor.
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
          <svg
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="mx-auto"
            role="img"
            aria-label="Link graph of campaign artifacts"
          >
            {layout.edges.map((edge) => {
              const from = nodeById.get(edge.from);
              const to = nodeById.get(edge.to);
              if (from === undefined || to === undefined) return null;
              const x1 = from.x + 60;
              const y1 = from.y + 14;
              const x2 = to.x + 14;
              const y2 = to.y + 14;
              const mx = (x1 + x2) / 2;
              const my = (y1 + y2) / 2;
              return (
                <g key={`${edge.from}-${edge.to}-${edge.relation}`}>
                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke="currentColor"
                    className="text-muted-foreground/50"
                    strokeWidth={1.5}
                  />
                  <text
                    x={mx}
                    y={my - 4}
                    textAnchor="middle"
                    className="fill-muted-foreground"
                    fontSize={9}
                  >
                    {edge.relation}
                  </text>
                </g>
              );
            })}
            {layout.nodes.map((node) => (
              <g
                key={node.id}
                transform={`translate(${node.x}, ${node.y})`}
                className="cursor-pointer"
                onClick={() => {
                  navigate(artifactPath(campaignId, node.id));
                }}
              >
                <circle
                  r={14}
                  fill={KIND_COLORS[node.kind]}
                  className="stroke-background"
                  strokeWidth={2}
                />
                <text textAnchor="middle" dy={32} fontSize={10} className="fill-foreground">
                  {node.name.length > 18 ? `${node.name.slice(0, 17)}…` : node.name}
                </text>
                <title>{`${ARTIFACT_KIND_LABELS[node.kind]} — ${node.name}`}</title>
              </g>
            ))}
          </svg>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t p-2 text-xs text-muted-foreground">
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
      </div>
    </div>
  );
}

function Missing({ message }: { message: string }): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
      {message}
      <Button variant="outline" size="sm" render={<Link to={ROUTES.campaignPicker} />}>
        All campaigns
      </Button>
    </div>
  );
}
