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
import { ArrowLeftIcon, BanIcon, LoaderCircleIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { modulePath, modulesPath } from '@/app/routes';
import {
  CANVAS_PREMISE_NODE_KEY,
  canvasPartNodeKey,
  canvasPriorModuleNodeKey,
  planIndexFromCanvasNodeKey,
  type Campaign,
  type Module,
  type ModuleCanvas,
} from '@/domain';
import { getModule, patchModule } from '@/db/moduleRepo';
import { saveModulePartText } from '@/features/modules/partText';
import { moduleGenEvents, ModuleBusyError, runParts } from '@/llm/moduleGen';
import { stopModuleGeneration } from '@/llm/moduleGenReconcile';
import { toastError, toastSuccess } from '@/lib/toast';
import { useArtifacts, useCampaign, useGlobalArtifacts } from '@/features/campaign/hooks';
import { useModule, useModules } from '@/features/modules/hooks';
import {
  BoardActionsProvider,
  BoardPoolProvider,
  boardNodeTypes,
  type BoardActionsContextValue,
  type BoardPoolContextValue,
} from '@/features/modules/board/boardNodes';
import { RewritePartDialog } from '@/features/modules/board/rewriteDialog';
import { useStagedRewritesStore } from '@/features/modules/board/stagedRewrites';
import {
  BOARD_NODE_WIDTH,
  resolveBoardNodePositions,
  seedBoardNodePositions,
} from '@/features/modules/board/boardLayout';
import { deriveContinuityEdges } from '@/features/modules/board/boardEdges';
import { useBoardStore, type PartCardSlice } from '@/features/modules/board/boardStore';

/**
 * Whole-module board (08-MODULE-DESIGNER §Module board): the entire module
 * — premise card + one card per part — on a React Flow board (the module's
 * spatial overview), with every
 * prior module of the campaign present as a read-only text group. React Flow
 * owns ALL viewport gestures (pan/zoom/pinch/drag); cards mount plain
 * buttons only. Drags and the viewport persist through the module row's
 * `canvas` field (persisted layout schema — debounced single `patchModule`
 * transaction), so the layout
 * rides backup/export and survives reloads. Continuity edges (prior group →
 * current card sharing a canonical wiki-name) are derived, capped, and the
 * cap is surfaced — never a silent drop.
 */

const BOARD_PERSIST_DEBOUNCE_MS = 600;

type BoardFlowNode = Node<Record<string, never>>;

const EMPTY_NODE_DATA: Record<string, never> = {};

export function BoardPage(): JSX.Element {
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
  // pass it with THEIR OWN module id as the tier-0 context (boardNodes).
  const poolValue = useMemo<BoardPoolContextValue | undefined>(() => {
    if (artifacts === undefined || globalArtifacts === undefined) return undefined;
    return { pool: [...artifacts, ...globalArtifacts], moduleId };
  }, [artifacts, globalArtifacts, moduleId]);

  // --- staged rewrites + rewrite flow -----------------------------------------
  const [rewriteTarget, setRewriteTarget] = useState<{ planIndex: number; nodeKey: string } | null>(
    null,
  );
  /** Ghost buffers: moduleGenEvents part-token deltas land here and flush to
   * the staging store once per animation frame (rAF-throttle — partial text
   * never touches the module row, and the store only sees per-frame batches). */
  const ghostBuffers = useRef<Map<string, string>>(new Map());
  const ghostRaf = useRef<number | null>(null);
  const flushGhosts = useCallback((): void => {
    ghostRaf.current = null;
    const staging = useStagedRewritesStore.getState();
    for (const [nodeKey, buffer] of ghostBuffers.current) {
      staging.appendGhost(nodeKey, buffer);
    }
    ghostBuffers.current.clear();
  }, []);
  useEffect(() => {
    return moduleGenEvents.on((event) => {
      if (event.moduleId !== moduleId || event.kind !== 'part-token') return;
      const nodeKey = canvasPartNodeKey(event.planIndex);
      if (useStagedRewritesStore.getState().byNodeKey[nodeKey] === undefined) return;
      const buffer = ghostBuffers.current.get(nodeKey);
      ghostBuffers.current.set(nodeKey, (buffer ?? '') + event.delta);
      ghostRaf.current ??= requestAnimationFrame(flushGhosts);
    });
  }, [moduleId, flushGhosts]);
  useEffect(() => {
    // The cleanup clears the buffer THIS effect was mounted with: the ref's
    // value is read once here, never at teardown time (exhaustive-deps). The
    // Map is created once by `useRef` and never replaced, so this is the same
    // object `flushGhosts` and the event sink above write to.
    const buffers = ghostBuffers.current;
    return () => {
      if (ghostRaf.current !== null) cancelAnimationFrame(ghostRaf.current);
      ghostRaf.current = null;
      buffers.clear();
    };
  }, [moduleId]);

  /**
   * Runs the rewrite through THE rewrite engine (`runParts` subset — the
   * exact `rewritePart` semantics without its swallow-all catch, so a busy
   * module surfaces LOUDLY instead of queueing silently; floor gates own
   * their bands inside the subset run, normalization included). The engine
   * writes the part row itself (generating → ready/failed); staging captures
   * the old text before the run and frames the new one for the decision.
   */
  const runRewrite = useCallback(
    async (
      campaign: Campaign,
      planIndex: number,
      nodeKey: string,
      instruction: string,
      includePriorModules: boolean,
    ): Promise<void> => {
      const current = await getModule(moduleId);
      if (current === undefined) throw new Error('Module no longer exists');
      const previous = current.parts.find((part) => part.planIndex === planIndex);
      useStagedRewritesStore.getState().stageProposal({
        nodeKey,
        planIndex,
        oldMarkdown: previous?.markdown ?? '',
        // AUTHORSHIP (docs/17 row 113): the rewrite below OVERWRITES this row,
        // so who wrote the text being replaced can only be captured now — a
        // Discard must put the old text back with its own authorship.
        oldOrigin: previous?.origin ?? null,
        oldWriterModel: previous?.writerModel ?? '',
      });
      try {
        await runParts(moduleId, campaign, {
          planIndexes: [planIndex],
          extraInstruction: instruction,
          includePriorModules,
        });
        const finished = await getModule(moduleId);
        const finishedPart = finished?.parts.find((part) => part.planIndex === planIndex);
        if (finishedPart?.status === 'ready' && finishedPart.markdown !== '') {
          useStagedRewritesStore.getState().finishProposal(nodeKey, finishedPart.markdown);
        } else {
          // Cancelled or failed run: the part row carries the truth (pending
          // slot / failed card); staging has nothing to decide on.
          useStagedRewritesStore.getState().drop(nodeKey);
        }
      } catch (error) {
        useStagedRewritesStore.getState().drop(nodeKey);
        if (error instanceof ModuleBusyError) {
          // ONE generation per module — surface busy LOUDLY, never queue.
          toastError(
            'A generation is already running for this module — wait for it or stop it first',
            error,
          );
        }
        // Other failures are owned by the engine (failModule toasts; the part
        // card renders part.status/errorMessage).
      }
    },
    [moduleId],
  );

  const applyStaged = useCallback(
    async (nodeKey: string): Promise<void> => {
      const entry = useStagedRewritesStore.getState().byNodeKey[nodeKey];
      if (entry === undefined) return;
      useStagedRewritesStore.getState().markApplied(nodeKey);
      try {
        // The text is the ENGINE's own ready write (it already stamped the row
        // `origin: 'model'` with the serving model); Apply adopts it, so the
        // authorship must survive this write rather than being re-derived from
        // an omitted writer model (docs/17 row 113).
        await saveModulePartText(moduleId, entry.planIndex, entry.newMarkdown, undefined, 'model');
        useStagedRewritesStore.getState().drop(nodeKey);
        toastSuccess('Rewrite applied');
      } catch (error) {
        useStagedRewritesStore.getState().revertToProposed(nodeKey);
        toastError('Could not apply the rewrite', error);
      }
    },
    [moduleId],
  );

  const discardStaged = useCallback(
    async (nodeKey: string): Promise<void> => {
      const entry = useStagedRewritesStore.getState().byNodeKey[nodeKey];
      if (entry === undefined) return;
      try {
        // The engine already wrote its text to the row; discarding restores
        // the previous text through THE one save path — WITH the authorship
        // and the recorded model those bytes had before the rewrite (docs/17
        // row 113), so a restored machine-written part is never relabelled as
        // the owner's.
        await saveModulePartText(
          moduleId,
          entry.planIndex,
          entry.oldMarkdown,
          entry.oldWriterModel,
          entry.oldOrigin,
        );
        useStagedRewritesStore.getState().drop(nodeKey);
      } catch (error) {
        toastError('Could not restore the previous part text', error);
      }
    },
    [moduleId],
  );

  const boardActions = useMemo<BoardActionsContextValue>(
    () => ({
      onRewrite: (planIndex, nodeKey) => {
        setRewriteTarget({ planIndex, nodeKey });
      },
      onApplyStaged: (nodeKey) => {
        void applyStaged(nodeKey);
      },
      onDiscardStaged: (nodeKey) => {
        void discardStaged(nodeKey);
      },
    }),
    [applyStaged, discardStaged],
  );

  const [nodes, setNodes] = useState<BoardFlowNode[]>([]);
  const nodesRef = useRef<BoardFlowNode[]>([]);
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 1 });
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loaded = campaign !== undefined && module !== undefined && modules !== undefined && poolValue !== undefined;

  // --- content sync ----------------------------------------------------------
  useEffect(() => {
    if (module === null || module === undefined) return;
    const store = useBoardStore.getState();
    if (store.ownerId !== moduleId) store.resetFor(moduleId);
    store.syncContent({
      moduleId,
      moduleTitle: module.title,
      moduleStatus: module.status,
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
    const seeds = seedBoardNodePositions({
      planCount: module?.spine?.partPlan.length ?? 0,
      priorModuleIds: priorModules.map((prior) => prior.id),
    });
    return resolveBoardNodePositions(module?.canvas?.nodes ?? null, seeds);
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
        } satisfies BoardFlowNode;
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
      toastError('Could not save the board layout', error);
    }
  }, [moduleId]);

  const schedulePersist = useCallback((): void => {
    if (persistTimer.current !== null) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null;
      void persistLayout();
    }, BOARD_PERSIST_DEBOUNCE_MS);
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
    (changes: NodeChange<BoardFlowNode>[]) => {
      setNodes((previous) => applyNodeChanges(changes, previous));
      if (changes.some((change) => change.type === 'position')) schedulePersist();
    },
    [schedulePersist],
  );

  const onMove = useCallback((_event: unknown, viewport: Viewport): void => {
    viewportRef.current = viewport;
    useBoardStore.getState().setZoom(Math.round(viewport.zoom * 1000) / 1000);
  }, []);

  const onMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport): void => {
      viewportRef.current = viewport;
      schedulePersist();
    },
    [schedulePersist],
  );

  // --- deep link (#node-<key>, optional) --------------------------------------
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<BoardFlowNode> | null>(null);
  useEffect(() => {
    if (flowInstance === null) return;
    const match = /^#node-(.+)$/.exec(location.hash);
    if (match === null) return;
    const key = decodeURIComponent(match[1] ?? '');
    const node = nodesRef.current.find((candidate) => candidate.id === key);
    if (node === undefined) return;
    void flowInstance.setCenter(
      node.position.x + BOARD_NODE_WIDTH / 2,
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
    return <MissingBoard message="This campaign does not exist (it may have been deleted)." campaignId={campaignId} />;
  }
  if (module === null) {
    return <MissingBoard message="This module does not exist (it may have been deleted)." campaignId={campaignId} />;
  }
  const currentModule: Module = module;
  const currentCampaign: Campaign = campaign;
  const busy = currentModule.status === 'generating';

  return (
    <div className="relative h-full min-h-0" data-testid="module-board">
      <BoardActionsProvider value={boardActions}>
      <BoardPoolProvider value={poolValue}>
        <ReactFlow<BoardFlowNode>
          key={moduleId}
          nodes={nodes}
          edges={edges}
          nodeTypes={boardNodeTypes}
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
              data-testid="board-header"
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
                <>
                  <Badge variant="secondary">
                    <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
                    generating
                  </Badge>
                  {/* ONE stop behaviour for every Stop control (the reader's
                      too, and the dock's Stop all composes cancelModuleGen):
                      a live forge is aborted, a row nobody owns is reconciled
                      loudly, and a row another TAB owns is reported rather than
                      silently ignored (docs/17 row 110). */}
                  <Button
                    variant="outline"
                    size="xs"
                    data-testid="board-stop"
                    onClick={() => {
                      void stopModuleGeneration(currentModule.id).catch((error: unknown) => {
                        toastError('Could not stop or reconcile that generation', error);
                      });
                    }}
                  >
                    <BanIcon aria-hidden data-icon="inline-start" />
                    Stop
                  </Button>
                </>
              ) : (
                <Badge variant="secondary">{currentModule.status}</Badge>
              )}
              {derivation.truncated > 0 && (
                <span className="text-xs text-muted-foreground" data-testid="board-edges-truncated">
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
      </BoardPoolProvider>
      </BoardActionsProvider>
      {rewriteTarget !== null && (
        <RewritePartDialog
          module={currentModule}
          target={rewriteTarget}
          onConfirm={(instruction, includePriorModules) => {
            const target = rewriteTarget;
            setRewriteTarget(null);
            void runRewrite(currentCampaign, target.planIndex, target.nodeKey, instruction, includePriorModules).catch(
              (error: unknown) => {
                toastError('Could not run the rewrite', error);
              },
            );
          }}
          onClose={() => {
            setRewriteTarget(null);
          }}
        />
      )}
    </div>
  );
}

// --- helpers -------------------------------------------------------------------

function nodeTypeFor(key: string): BoardFlowNode['type'] {
  if (key === CANVAS_PREMISE_NODE_KEY) return 'premise';
  if (planIndexFromCanvasNodeKey(key) !== null) return 'part';
  if (key.startsWith('prior-')) return 'prior';
  throw new Error(`Unknown board node key: ${key}`);
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
      origin: part?.origin ?? null,
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

function MissingBoard({ message, campaignId }: { message: string; campaignId: string }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" render={<Link to={modulesPath(campaignId)} />} nativeButton={false}>
        Back to modules
      </Button>
    </div>
  );
}
