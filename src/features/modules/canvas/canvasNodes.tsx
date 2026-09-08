import { createContext, memo, useContext, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps, NodeTypes } from '@xyflow/react';
import { LoaderCircleIcon, RotateCcwIcon, TriangleAlertIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { AnyArtifact, Id } from '@/domain';
import { CANVAS_PREMISE_NODE_KEY, planIndexFromCanvasNodeKey } from '@/domain';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import { cn } from '@/lib/utils';
import { CANVAS_LOD_FULL_ABOVE, useCanvasStore, type PartCardSlice, type PriorCardSlice } from './canvasStore';
import { useStagedRewritesStore, type StagedRewrite } from '@/features/modules/canvas/stagedRewrites';
import { Button } from '@/components/ui/button';

/**
 * Whole-module canvas cards (08-MODULE-DESIGNER §Module canvas): TEXT-ONLY
 * v1 — premise/part cards for the current module and read-only text groups
 * for prior modules. No entity cards, no phantom cards, no artifact detail
 * cards: wiki chips render inline through the shared `WikiMarkdown` but stay
 * INERT (entity actions are deferred) — ambiguity ⚠ and unresolved-dashed
 * markers come from the renderer itself, exactly as in the reader.
 *
 * Cards are memoized and read their content from per-node store slices, so a
 * change to one part re-renders one card. React Flow owns ALL viewport
 * gestures (pan/zoom/pinch/drag): cards mount plain buttons only, scrollable
 * bodies carry `nowheel` (wheel scrolls the card, never the canvas) and no
 * component here ever arms a second pointer-gesture path.
 */

/** The wiki-chip resolution pool shared by every card on the canvas. */
export interface CanvasPoolContextValue {
  /** Campaign artifacts + global library — the reader's resolution pool. */
  pool: readonly AnyArtifact[];
  /** The CURRENT module's id: its own entities win tier-0 in its cards. */
  moduleId: Id;
}

const CanvasPoolContext = createContext<CanvasPoolContextValue | null>(null);

export function CanvasPoolProvider({
  value,
  children,
}: {
  value: CanvasPoolContextValue;
  children: ReactNode;
}): JSX.Element {
  return <CanvasPoolContext.Provider value={value}>{children}</CanvasPoolContext.Provider>;
}

/** Hooks-order-safe pool read: called unconditionally, throws when absent. */
function useCanvasPool(): CanvasPoolContextValue {
  const value = useContext(CanvasPoolContext);
  if (value === null) {
    // AGENTS rule 1: a card rendered outside the provider is a bug, never a
    // silent degradation to an empty pool.
    throw new Error('Canvas card rendered outside CanvasPoolProvider');
  }
  return value;
}

/** Page-level actions the cards can trigger (all plain buttons, `nodrag`). */
export interface CanvasActionsContextValue {
  /** Opens the rewrite dialog for this part. */
  onRewrite: (planIndex: number, nodeKey: string) => void;
  /** Applies the staged rewrite through the ONE part-text save path. */
  onApplyStaged: (nodeKey: string) => void;
  /** Discards the staged rewrite and restores the previous text. */
  onDiscardStaged: (nodeKey: string) => void;
}

const CanvasActionsContext = createContext<CanvasActionsContextValue | null>(null);

export function CanvasActionsProvider({
  value,
  children,
}: {
  value: CanvasActionsContextValue;
  children: ReactNode;
}): JSX.Element {
  return <CanvasActionsContext.Provider value={value}>{children}</CanvasActionsContext.Provider>;
}

function useCanvasActions(): CanvasActionsContextValue {
  const value = useContext(CanvasActionsContext);
  if (value === null) {
    throw new Error('Canvas card rendered outside CanvasActionsProvider');
  }
  return value;
}

export const CANVAS_CARD_BODY_CLASS =
  'nowheel max-h-[360px] overflow-y-auto overscroll-contain px-3 pb-3';

const CARD_CLASS = 'w-[420px] rounded-lg border bg-card text-card-foreground shadow-sm';

const HEADER_CLASS = 'flex items-center gap-2 border-b px-3 py-2';

const BODY_TEXT_CLASS = 'prose-module text-sm leading-relaxed';

/**
 * Edge anchors for the derived continuity edges. Invisible (the canvas is
 * TEXT-ONLY v1 — no connect affordances; `nodesConnectable` is false), but
 * structurally present: React Flow anchors an edge at its endpoints'
 * handles, so a node without them draws no edges.
 */
function CardHandles(): JSX.Element {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} className="opacity-0" />
      <Handle type="source" position={Position.Right} isConnectable={false} className="opacity-0" />
    </>
  );
}

// --- Premise card -------------------------------------------------------------

export const PremiseCardNode = memo(function PremiseCardNode({
  id,
}: NodeProps): JSX.Element | null {
  const slice = useCanvasStore((state) =>
    id === CANVAS_PREMISE_NODE_KEY ? state.content.premise : undefined,
  );
  const detailed = useCanvasStore((state) => state.zoom >= CANVAS_LOD_FULL_ABOVE);
  const { pool, moduleId } = useCanvasPool();
  if (slice === undefined || slice === null) return null;
  return (
    <div
      className={CARD_CLASS}
      data-testid="canvas-premise-card"
      data-lod={detailed ? 'full' : 'skeleton'}
    >
      <div className={HEADER_CLASS}>
        <span className="shrink-0 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Premise
        </span>
        <span className="truncate font-heading text-sm font-semibold">{slice.moduleTitle}</span>
      </div>
      <CardHandles />
      {detailed && (
        <div className={cn(CANVAS_CARD_BODY_CLASS, BODY_TEXT_CLASS)} data-testid="canvas-premise-body">
          <WikiMarkdown value={slice.premise} artifacts={pool} moduleId={moduleId} />
        </div>
      )}
    </div>
  );
});

// --- Part card ----------------------------------------------------------------

export const PartCardNode = memo(function PartCardNode({ id }: NodeProps): JSX.Element | null {
  const slice = useCanvasStore((state) => state.content.parts[id]);
  const busy = useCanvasStore((state) => state.content.moduleStatus === 'generating');
  const staged = useStagedRewritesStore((state) => state.byNodeKey[id]);
  const detailed = useCanvasStore((state) => state.zoom >= CANVAS_LOD_FULL_ABOVE);
  const { pool } = useCanvasPool();
  const actions = useCanvasActions();
  const planIndex = planIndexFromCanvasNodeKey(id);
  if (slice === undefined || planIndex === null) return null;
  return (
    <div
      className={CARD_CLASS}
      data-testid={`canvas-part-${String(planIndex)}`}
      data-lod={detailed ? 'full' : 'skeleton'}
    >
      <CardHandles />
      <div className={HEADER_CLASS}>
        <span className="truncate font-heading text-sm font-semibold">{slice.title}</span>
        <Badge variant="outline" className="shrink-0">
          Levels {slice.levelBand}
        </Badge>
        <PartStatusPill status={slice.status} />
        {slice.edited && (
          <Badge variant="secondary" className="shrink-0">
            hand-edited
          </Badge>
        )}
        {slice.status === 'ready' && staged === undefined && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="nodrag ml-auto shrink-0"
            aria-label={`Rewrite ${slice.title}`}
            data-testid={`canvas-part-rewrite-${String(planIndex)}`}
            disabled={busy}
            onClick={() => {
              actions.onRewrite(planIndex, id);
            }}
          >
            <RotateCcwIcon aria-hidden className="size-3.5" />
          </Button>
        )}
      </div>
      {detailed &&
        (staged !== undefined ? (
          <StagedPartBody staged={staged} moduleId={slice.moduleId} pool={pool} />
        ) : (
          <PartCardBody slice={slice} pool={pool} />
        ))}
    </div>
  );
});

function PartCardBody({
  slice,
  pool,
}: {
  slice: PartCardSlice;
  pool: readonly AnyArtifact[];
}): JSX.Element {
  if (slice.status === 'ready') {
    return (
      <div className={cn(CANVAS_CARD_BODY_CLASS, BODY_TEXT_CLASS)} data-testid="canvas-part-body">
        <WikiMarkdown value={slice.markdown} artifacts={pool} moduleId={slice.moduleId} />
      </div>
    );
  }
  if (slice.status === 'failed') {
    return (
      <div
        className="flex items-start gap-2 px-3 pb-3 pt-2 text-sm text-destructive"
        data-testid="canvas-part-failed"
        role="alert"
      >
        <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>{slice.errorMessage}</span>
      </div>
    );
  }
  if (slice.status === 'generating') {
    return (
      <div
        className="flex items-center gap-2 px-3 pb-3 pt-2 text-sm text-muted-foreground"
        data-testid="canvas-part-generating"
        aria-live="polite"
      >
        <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
        Writing this part…
      </div>
    );
  }
  return (
    <div
      className="px-3 pb-3 pt-2 text-sm text-muted-foreground"
      data-testid="canvas-part-pending"
    >
      Not written yet — it generates after the previous parts.
    </div>
  );
}

/**
 * The staged rewrite's body: the NEW text renders as-is (owner decision —
 * no diff view anywhere), framed as a proposal, with a "Show previous"
 * toggle for the old text and Apply / Discard once the rewrite completed.
 * While the engine still streams, the ghost preview (rAF-throttled tokens)
 * shows the partial text — it never touches the module row.
 */
function StagedPartBody({
  staged,
  moduleId,
  pool,
}: {
  staged: StagedRewrite;
  moduleId: Id;
  pool: readonly AnyArtifact[];
}): JSX.Element {
  const actions = useCanvasActions();
  const [showPrevious, setShowPrevious] = useState(false);
  const streaming = staged.newMarkdown === '';
  const text = showPrevious
    ? staged.oldMarkdown
    : (staged.newMarkdown !== '' ? staged.newMarkdown : staged.ghost);
  return (
    <div
      className="nowheel max-h-[360px] overflow-y-auto overscroll-contain border-x-2 border-amber-500/60 bg-amber-500/5 px-3 pb-3"
      data-testid="canvas-part-staged"
      data-staged-status={staged.status}
    >
      <div className="flex items-center gap-1.5 pb-1 pt-2 text-xs text-amber-700 dark:text-amber-400">
        <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="font-medium">
          {streaming ? 'Proposed rewrite — still writing…' : 'Proposed rewrite — not applied yet'}
        </span>
        {!streaming && (
          <Button
            variant="ghost"
            size="xs"
            className="nodrag ml-auto"
            data-testid="canvas-part-show-previous"
            onClick={() => {
              setShowPrevious((previous) => !previous);
            }}
          >
            {showPrevious ? 'Show new' : 'Show previous'}
          </Button>
        )}
      </div>
      <div className={BODY_TEXT_CLASS} data-testid="canvas-part-staged-text">
        <WikiMarkdown
          value={text === '' ? '*…*' : text}
          artifacts={pool}
          moduleId={moduleId}
        />
      </div>
      {!streaming && (
        <div className="flex items-center gap-2 pb-1">
          <Button
            size="xs"
            className="nodrag"
            data-testid="canvas-part-apply"
            disabled={staged.status === 'applied'}
            onClick={() => {
              actions.onApplyStaged(staged.nodeKey);
            }}
          >
            {staged.status === 'applied' ? 'Applying…' : 'Apply'}
          </Button>
          <Button
            variant="outline"
            size="xs"
            className="nodrag"
            data-testid="canvas-part-discard"
            disabled={staged.status === 'applied'}
            onClick={() => {
              actions.onDiscardStaged(staged.nodeKey);
            }}
          >
            Discard
          </Button>
        </div>
      )}
    </div>
  );
}

function PartStatusPill({ status }: { status: PartCardSlice['status'] }): JSX.Element {
  if (status === 'failed') {
    return (
      <Badge variant="destructive" className="shrink-0">
        failed
      </Badge>
    );
  }
  if (status === 'generating') {
    return (
      <Badge variant="secondary" className="shrink-0">
        <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
        generating
      </Badge>
    );
  }
  if (status === 'missing') {
    return (
      <Badge variant="outline" className="shrink-0">
        pending
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="shrink-0">
      {status}
    </Badge>
  );
}

// --- Prior module text group --------------------------------------------------

export const PriorModuleCardNode = memo(function PriorModuleCardNode({
  id,
}: NodeProps): JSX.Element | null {
  const slice = useCanvasStore((state) => state.content.priors[id]);
  const detailed = useCanvasStore((state) => state.zoom >= CANVAS_LOD_FULL_ABOVE);
  const { pool } = useCanvasPool();
  if (slice === undefined) return null;
  return (
    <div
      className={cn(CARD_CLASS, 'opacity-90')}
      data-testid={`canvas-prior-${slice.moduleId}`}
      data-lod={detailed ? 'full' : 'skeleton'}
    >
      <div className={HEADER_CLASS}>
        <span className="truncate font-heading text-sm font-semibold">{slice.title}</span>
        <Badge variant="outline" className="shrink-0">
          Levels {String(slice.levelMin)}–{String(slice.levelMax)}
        </Badge>
        <Badge variant="secondary" className="shrink-0">
          earlier module
        </Badge>
      </div>
      <CardHandles />
      {detailed && <PriorCardBody slice={slice} pool={pool} />}
    </div>
  );
});

/**
 * The prior module's whole text (premise + written parts), read-only. Chips
 * resolve against the shared campaign+global pool with THIS module's id as
 * the tier-0 context — each group resolves exactly the way its own reader
 * would (a module-owned entity beats a same-named campaign/global row only
 * inside its own group).
 */
function PriorCardBody({
  slice,
  pool,
}: {
  slice: PriorCardSlice;
  pool: readonly AnyArtifact[];
}): JSX.Element {
  return (
    <div className={CANVAS_CARD_BODY_CLASS} data-testid="canvas-prior-body">
      {slice.premise !== '' && (
        <div className={BODY_TEXT_CLASS}>
          <WikiMarkdown value={slice.premise} artifacts={pool} moduleId={slice.moduleId} />
        </div>
      )}
      {slice.parts.map((part) => (
        <div key={part.planIndex} className={part.title === '' ? '' : 'mt-3'}>
          <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {part.title === '' ? `Part ${String(part.planIndex + 1)}` : part.title}
          </p>
          <WikiMarkdown value={part.markdown} artifacts={pool} moduleId={slice.moduleId} />
        </div>
      ))}
    </div>
  );
}

/**
 * Module-level nodeTypes map, declared AFTER the components it references
 * and created exactly once per module load — React Flow warns (and re-mounts
 * nodes) when the object identity churns.
 */
export const canvasNodeTypes: NodeTypes = {
  premise: PremiseCardNode,
  part: PartCardNode,
  prior: PriorModuleCardNode,
};
