import '@xyflow/react/dist/style.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import {
  Background,
  Controls,
  Panel,
  ReactFlow,
  applyNodeChanges,
} from '@xyflow/react';
import type { Edge, Node, NodeChange, ReactFlowInstance, Viewport } from '@xyflow/react';
import { ArrowLeftIcon, LoaderCircleIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { modulePath, modulesPath } from '@/app/routes';
import {
  CANVAS_PREMISE_NODE_KEY,
  canvasPartNodeKey,
  canvasPriorModuleNodeKey,
  planIndexFromCanvasNodeKey,
  type Module,
  type ModuleCanvas,
} from '@/domain';
import { patchModule } from '@/db/moduleRepo';
import { useArtifacts, useCampaign, useGlobalArtifacts } from '@/features/campaign/hooks';
import { useModule, useModules } from '@/features/modules/hooks';
import { toastError } from '@/lib/toast';
import {
  CanvasPoolProvider,
  canvasNodeTypes,
  type CanvasPoolContextValue,
} from '@/features/modules/canvas/canvasNodes';
import {
  CANVAS_NODE_WIDTH,
  resolveCanvasNodePositions,
  seedCanvasNodePositions,
} from '@/features/modules/canvas/canvasLayout';
import { deriveContinuityEdges } from '@/features/modules/canvas/canvasEdges';
import { useCanvasStore, type PartCardSlice } from '@/features/modules/canvas/canvasStore';

/**
 * Whole-module canvas (08-MODULE-DESIGNER §Module canvas): the entire module
 * — premise card + one card per part — on a React Flow canvas, with every
 * prior module of the campaign present as a read-only text group. React Flow
 * owns ALL viewport gestures (pan/zoom/pinch/drag); cards mount plain
 * buttons only. Drags and the viewport persist through the module row's
 * `canvas` field (debounced single `patchModule` transaction), so the layout
 * rides backup/export and survives reloads. Continuity edges (prior group →
 * current card sharing a canonical wiki-name) are derived, capped, and the
 * cap is surfaced — never a silent drop.
 */

const CANVAS_PERSIST_DEBOUNCE_MS = 600;

type CanvasFlowNode = Node<Record<string, never>>;

const EMPTY_NODE_DATA: Record<string, never> = {};

export function ModuleCanvasPage(): JSX.Element {
  const { campaignId = '', moduleId = '' } = useParams<{
    campaignId: string;
    moduleId: string;
  }>();
  const campaign = useCampaign(campaignId === '' ? undefined : campaignId);
  const module = useModule(moduleId === '' ? undefined : moduleId);
  const modules = useModules(campaignId === '' ? undefined : campaignId);
  const artifacts = useArtifacts(campaignId === '' ? undefined : campaignId);
  const globalArtifacts = useGlobalArtifacts();
  const location = useLocation();

  // Prior modules, story order (createdAt ASC — the repo lists updatedAt
  // DESC), excluding the module on this route. Text-only groups.
  const priorModules = useMemo(() => {
    if (modules === undefined) return [];
    return modules
      .filter((candidate) => candidate.id !== moduleId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }, [modules, moduleId]);

  // The reader's resolution pool (campaign + global library) — prior groups
  // pass it with THEIR OWN module id as the tier-0 context (canvasNodes).
  const poolValue = useMemo<CanvasPoolContextValue | undefined>(() => {
    if (artifacts === undefined || globalArtifacts === undefined) return undefined;
    return { pool: [...artifacts, ...globalArtifacts], moduleId };
  }, [artifacts, globalArtifacts, moduleId]);

  const [nodes, setNodes] = useState<CanvasFlowNode[]>([]);
  const nodesRef = useRef<CanvasFlowNode[]>([]);
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 1 });
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loaded = campaign !== undefined && module !== undefined && modules !== undefined && poolValue !== undefined;

  // --- content sync ----------------------------------------------------------
  useEffect(() => {
    if (module === null || module === undefined) return;
    const store = useCanvasStore.getState();
    if (store.ownerId !== moduleId) store.resetFor(moduleId);
    store.syncContent({
      moduleId,
      moduleTitle: module.title,
      premise: module.spine?.premise ?? null,
      parts: partSlicesFor(module),
      priors: priorSlicesFor(priorModules),
    });
  }, [module, priorModules, moduleId]);

  // --- node list synthesis ---------------------------------------------------
  const nodeKeys = useMemo(() => {
    if (module?.spine == null) return [];
    return [
      CANVAS_PREMISE_NODE_KEY,
      ...module.spine.partPlan.map((_, planIndex) => canvasPartNodeKey(planIndex)),
    ];
  }, [module]);
  const allKeys = useMemo(
    () => [...nodeKeys, ...priorModules.map((prior) => canvasPriorModuleNodeKey(prior.id))],
    [nodeKeys, priorModules],
  );
  const positions = useMemo(() => {
    const seeds = seedCanvasNodePositions({
      planCount: module?.spine?.partPlan.length ?? 0,
      priorModuleIds: priorModules.map((prior) => prior.id),
    });
    return resolveCanvasNodePositions(module?.canvas?.nodes ?? null, seeds);
  }, [module, priorModules]);

  // Cross-module navigation reuses this page instance (same route, new
  // params): clear the in-memory node list so stale positions never leak.
  useEffect(() => {
    setNodes([]);
  }, [moduleId]);

  useEffect(() => {
    setNodes((previous) => {
      const existing = new Map(previous.map((node) => [node.id, node]));
      const next = allKeys.map((key) => {
        const kept = existing.get(key);
        if (kept !== undefined) return kept;
        const position = positions[key] ?? { x: 0, y: 0 };
        return {
          id: key,
          type: nodeTypeFor(key),
          position,
          data: EMPTY_NODE_DATA,
        } satisfies CanvasFlowNode;
      });
      const unchanged =
        next.length === previous.length && next.every((node, index) => previous[index] === node);
      return unchanged ? previous : next;
    });
  }, [allKeys, positions, moduleId]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  // --- layout persistence ----------------------------------------------------
  const persistLayout = useCallback(async (): Promise<void> => {
    const canvas: ModuleCanvas = {
      nodes: nodesRef.current.map((node) => ({ key: node.id, x: node.position.x, y: node.position.y })),
      zoom: viewportRef.current.zoom,
      pan: { x: viewportRef.current.x, y: viewportRef.current.y },
    };
    try {
      await patchModule(moduleId, { canvas });
    } catch (error) {
      toastError('Could not save the canvas layout', error);
    }
  }, [moduleId]);

  const schedulePersist = useCallback((): void => {
    if (persistTimer.current !== null) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null;
      void persistLayout();
    }, CANVAS_PERSIST_DEBOUNCE_MS);
  }, [persistLayout]);

  // A pending debounced write flushes on unmount — a drag followed by an
  // immediate navigation (or reload) must not silently drop the layout.
  useEffect(() => {
    return () => {
      if (persistTimer.current !== null) {
        clearTimeout(persistTimer.current);
        persistTimer.current = null;
        void persistLayout();
      }
    };
  }, [persistLayout]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasFlowNode>[]) => {
      setNodes((previous) => applyNodeChanges(changes, previous));
      if (changes.some((change) => change.type === 'position')) schedulePersist();
    },
    [schedulePersist],
  );

  const onMove = useCallback((_event: unknown, viewport: Viewport): void => {
    viewportRef.current = viewport;
    useCanvasStore.getState().setZoom(Math.round(viewport.zoom * 1000) / 1000);
  }, []);

  const onMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport): void => {
      viewportRef.current = viewport;
      schedulePersist();
    },
    [schedulePersist],
  );

  // --- deep link (#node-<key>, optional) --------------------------------------
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<CanvasFlowNode> | null>(null);
  useEffect(() => {
    if (flowInstance === null) return;
    const match = /^#node-(.+)$/.exec(location.hash);
    if (match === null) return;
    const key = decodeURIComponent(match[1] ?? '');
    const node = nodesRef.current.find((candidate) => candidate.id === key);
    if (node === undefined) return;
    void flowInstance.setCenter(
      node.position.x + CANVAS_NODE_WIDTH / 2,
      node.position.y + 180,
      { zoom: Math.max(flowInstance.getZoom(), 0.75), duration: 0 },
    );
  }, [flowInstance, nodes, location.hash]);

  // --- edges (derived, capped) -------------------------------------------------
  const derivation = useMemo(() => {
    if (module === null || module === undefined || poolValue === undefined) {
      return { edges: [], truncated: 0 };
    }
    return deriveContinuityEdges({ module, priorModules, pool: poolValue.pool });
  }, [module, priorModules, poolValue]);
  const validKeys = useMemo(() => new Set(allKeys), [allKeys]);
  const edges = useMemo<Edge[]>(
    () =>
      derivation.edges
        .filter((edge) => validKeys.has(edge.source) && validKeys.has(edge.target))
        .map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: edge.label,
          labelShowBg: true,
          labelBgPadding: [4, 2] as [number, number],
          labelBgBorderRadius: 4,
          labelStyle: { fontSize: 10, fill: 'var(--muted-foreground, #6b7280)' },
          className: '[&_.react-flow__edge-path]:stroke-muted-foreground/40',
        })),
    [derivation, validKeys],
  );

  if (!loaded) {
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  }
  if (campaign === null) {
    return <MissingCanvas message="This campaign does not exist (it may have been deleted)." campaignId={campaignId} />;
  }
  if (module === null) {
    return <MissingCanvas message="This module does not exist (it may have been deleted)." campaignId={campaignId} />;
  }
  const currentModule: Module = module;
  const busy = currentModule.status === 'generating';

  return (
    <div className="relative h-full min-h-0" data-testid="module-canvas">
      <CanvasPoolProvider value={poolValue}>
        <ReactFlow<CanvasFlowNode>
          key={moduleId}
          nodes={nodes}
          edges={edges}
          nodeTypes={canvasNodeTypes}
          onNodesChange={onNodesChange}
          onMove={onMove}
          onMoveEnd={onMoveEnd}
          onInit={setFlowInstance}
          defaultViewport={{
            x: currentModule.canvas?.pan.x ?? 0,
            y: currentModule.canvas?.pan.y ?? 0,
            zoom: currentModule.canvas?.zoom ?? 1,
          }}
          minZoom={0.2}
          maxZoom={2}
          nodesConnectable={false}
          deleteKeyCode={null}
        >
          <Background />
          <Controls showInteractive={false} />
          <Panel position="top-left">
            <div
              className="flex flex-wrap items-center gap-2 rounded-lg border bg-card/95 px-3 py-2 shadow-sm backdrop-blur"
              data-testid="canvas-header"
            >
              <Button
                variant="ghost"
                size="xs"
                render={<Link to={modulePath(campaignId, moduleId)} />}
                nativeButton={false}
              >
                <ArrowLeftIcon aria-hidden data-icon="inline-start" />
                Reader
              </Button>
              <span className="font-heading text-sm font-semibold">{currentModule.title}</span>
              {busy ? (
                <Badge variant="secondary">
                  <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
                  generating
                </Badge>
              ) : (
                <Badge variant="secondary">{currentModule.status}</Badge>
              )}
              {derivation.truncated > 0 && (
                <span className="text-xs text-muted-foreground" data-testid="canvas-edges-truncated">
                  +{String(derivation.truncated)} more shared-name continuities not drawn
                </span>
              )}
            </div>
          </Panel>
          {currentModule.spine === null && (
            <Panel position="top-center">
              <p className="rounded-lg border border-dashed bg-card/95 px-3 py-2 text-sm text-muted-foreground">
                This module has no spine yet — its premise and parts appear here once generated.
              </p>
            </Panel>
          )}
        </ReactFlow>
      </CanvasPoolProvider>
    </div>
  );
}

// --- helpers -------------------------------------------------------------------

function nodeTypeFor(key: string): CanvasFlowNode['type'] {
  if (key === CANVAS_PREMISE_NODE_KEY) return 'premise';
  if (planIndexFromCanvasNodeKey(key) !== null) return 'part';
  if (key.startsWith('prior-')) return 'prior';
  throw new Error(`Unknown canvas node key: ${key}`);
}

/** The plan×part JOIN per part node key (title/band from the plan, the rest
 * from the part row; a missing part renders as `missing`/pending). */
function partSlicesFor(module: Module): Record<string, PartCardSlice> {
  const planList = module.spine?.partPlan ?? [];
  const slices: Record<string, PartCardSlice> = {};
  for (let planIndex = 0; planIndex < planList.length; planIndex += 1) {
    const plan = planList[planIndex];
    if (plan === undefined) continue;
    const part = module.parts.find((entry) => entry.planIndex === planIndex);
    slices[canvasPartNodeKey(planIndex)] = {
      moduleId: module.id,
      planIndex,
      title: plan.title,
      levelBand: plan.levelBand,
      status: part?.status ?? 'missing',
      errorMessage: part?.errorMessage ?? '',
      markdown: part?.markdown ?? '',
      edited: part?.edited ?? false,
    };
  }
  return slices;
}

function priorSlicesFor(priorModules: readonly Module[]) {
  return priorModules.map((prior) => ({
    moduleId: prior.id,
    title: prior.title,
    levelMin: prior.levelMin,
    levelMax: prior.levelMax,
    premise: prior.spine?.premise ?? '',
    parts: (prior.spine?.partPlan ?? [])
      .map((plan, planIndex) => ({
        planIndex,
        title: plan.title,
        markdown: prior.parts.find((entry) => entry.planIndex === planIndex)?.markdown ?? '',
      }))
      .filter((part) => part.markdown !== ''),
  }));
}

function MissingCanvas({ message, campaignId }: { message: string; campaignId: string }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" render={<Link to={modulesPath(campaignId)} />} nativeButton={false}>
        Back to modules
      </Button>
    </div>
  );
}
