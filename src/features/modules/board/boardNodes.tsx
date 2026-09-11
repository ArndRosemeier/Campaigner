import { createContext, memo, useContext, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps, NodeTypes } from '@xyflow/react';
import { LoaderCircleIcon, RotateCcwIcon, TriangleAlertIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { BlockedControl } from '@/components/blocked-control';
import type { AnyArtifact, Id } from '@/domain';
import { CANVAS_PREMISE_NODE_KEY, planIndexFromCanvasNodeKey } from '@/domain';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import { cn } from '@/lib/utils';
import { BOARD_LOD_FULL_ABOVE, useBoardStore, type PartCardSlice, type PriorCardSlice } from './boardStore';
import { useStagedRewritesStore, type StagedRewrite } from '@/features/modules/board/stagedRewrites';
import { Button } from '@/components/ui/button';

/**
 * Whole-module board cards (08-MODULE-DESIGNER §Module board): TEXT-ONLY
 * v1 — premise/part cards for the current module and read-only text groups
 * for prior modules. No entity cards, no phantom cards, no artifact detail
 * cards: wiki chips render inline through the shared `WikiMarkdown` but stay
 * INERT (entity actions are deferred) — ambiguity ⚠ and unresolved-dashed
 * markers come from the renderer itself, exactly as in the reader.
 *
 * Cards are memoized and read their content from per-node store slices, so a
 * change to one part re-renders one card. React Flow owns ALL viewport
 * gestures (pan/zoom/pinch/drag): cards mount plain buttons only, scrollable
 * bodies carry `nowheel` (wheel scrolls the card, never the board) and no
 * component here ever arms a second pointer-gesture path.
 */

/** The wiki-chip resolution pool shared by every card on the board. */
export interface BoardPoolContextValue {
  /** Campaign artifacts + global library — the reader's resolution pool. */
  pool: readonly AnyArtifact[];
  /** The CURRENT module's id: its own entities win tier-0 in its cards. */
  moduleId: Id;
}

const BoardPoolContext = createContext<BoardPoolContextValue | null>(null);

export function BoardPoolProvider({
  value,
  children,
}: {
  value: BoardPoolContextValue;
  children: ReactNode;
}): JSX.Element {
  return <BoardPoolContext.Provider value={value}>{children}</BoardPoolContext.Provider>;
}

/** Hooks-order-safe pool read: called unconditionally, throws when absent. */
function useBoardPool(): BoardPoolContextValue {
  const value = useContext(BoardPoolContext);
  if (value === null) {
    // AGENTS rule 1: a card rendered outside the provider is a bug, never a
    // silent degradation to an empty pool.
    throw new Error('Board card rendered outside BoardPoolProvider');
  }
  return value;
}

/** Page-level actions the cards can trigger (all plain buttons, `nodrag`). */
export interface BoardActionsContextValue {
  /** Opens the rewrite dialog for this part. */
  onRewrite: (planIndex: number, nodeKey: string) => void;
  /** Applies the staged rewrite through the ONE part-text save path. */
  onApplyStaged: (nodeKey: string) => void;
  /** Discards the staged rewrite and restores the previous text. */
  onDiscardStaged: (nodeKey: string) => void;
}

const BoardActionsContext = createContext<BoardActionsContextValue | null>(null);

export function BoardActionsProvider({
  value,
  children,
}: {
  value: BoardActionsContextValue;
  children: ReactNode;
}): JSX.Element {
  return <BoardActionsContext.Provider value={value}>{children}</BoardActionsContext.Provider>;
}

function useBoardActions(): BoardActionsContextValue {
  const value = useContext(BoardActionsContext);
  if (value === null) {
    throw new Error('Board card rendered outside BoardActionsProvider');
  }
  return value;
}

export const BOARD_CARD_BODY_CLASS =
  'nowheel max-h-[360px] overflow-y-auto overscroll-contain px-3 pb-3';

const CARD_CLASS = 'w-[420px] rounded-lg border bg-card text-card-foreground shadow-sm';

const HEADER_CLASS = 'flex items-center gap-2 border-b px-3 py-2';

const BODY_TEXT_CLASS = 'prose-module text-sm leading-relaxed';

/**
 * WHY a card's rewrite affordance cannot act while the module is generating
 * (docs/18 §2.3, docs/05 §Why a control cannot act): `busy` IS
 * `moduleStatus === 'generating'`, the flag its gate reads, so the sentence can
 * never disagree with the state it explains — and it is the SAME sentence the
 * canvas uses for the same state, so one state is never explained two ways in
 * this app. The way out is real and reachable on this very screen: the board
 * header shows the live "generating" badge and the board's own **Stop**
 * (`board-stop` → `cancelModuleGen`, the one module-forge stop path).
 *
 * Needed at all because the card is NOT covered by that badge: the rewrite
 * affordance renders only for a part whose status is already `ready`, so a
 * card can read "ready" while this module-wide flag holds its one button.
 */
const MODULE_GENERATING_REASON =
  'The module is generating right now — wait for it (or press Stop).';

/**
 * Edge anchors for the derived continuity edges. Invisible (the board is
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
  const slice = useBoardStore((state) =>
    id === CANVAS_PREMISE_NODE_KEY ? state.content.premise : undefined,
  );
  const detailed = useBoardStore((state) => state.zoom >= BOARD_LOD_FULL_ABOVE);
  const { pool, moduleId } = useBoardPool();
  if (slice === undefined || slice === null) return null;
  return (
    <div
      className={CARD_CLASS}
      data-testid="board-premise-card"
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
        <div className={cn(BOARD_CARD_BODY_CLASS, BODY_TEXT_CLASS)} data-testid="board-premise-body">
          <WikiMarkdown value={slice.premise} artifacts={pool} moduleId={moduleId} />
        </div>
      )}
    </div>
  );
});

// --- Part card ----------------------------------------------------------------

export const PartCardNode = memo(function PartCardNode({ id }: NodeProps): JSX.Element | null {
  const slice = useBoardStore((state) => state.content.parts[id]);
  const busy = useBoardStore((state) => state.content.moduleStatus === 'generating');
  const staged = useStagedRewritesStore((state) => state.byNodeKey[id]);
  const detailed = useBoardStore((state) => state.zoom >= BOARD_LOD_FULL_ABOVE);
  const { pool } = useBoardPool();
  const actions = useBoardActions();
  const planIndex = planIndexFromCanvasNodeKey(id);
  if (slice === undefined || planIndex === null) return null;
  return (
    <div
      className={CARD_CLASS}
      data-testid={`board-part-${String(planIndex)}`}
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
          <BlockedControl
            testId={`board-part-rewrite-${String(planIndex)}`}
            reason={busy ? MODULE_GENERATING_REASON : null}
            className="nodrag ml-auto shrink-0"
          >
            <Button
              variant="ghost"
              size="icon-sm"
              className="nodrag ml-auto shrink-0"
              aria-label={`Rewrite ${slice.title}`}
              data-testid={`board-part-rewrite-${String(planIndex)}`}
              disabled={busy}
              onClick={() => {
                actions.onRewrite(planIndex, id);
              }}
            >
              <RotateCcwIcon aria-hidden className="size-3.5" />
            </Button>
          </BlockedControl>
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
      <div className={cn(BOARD_CARD_BODY_CLASS, BODY_TEXT_CLASS)} data-testid="board-part-body">
        <WikiMarkdown value={slice.markdown} artifacts={pool} moduleId={slice.moduleId} />
      </div>
    );
  }
  if (slice.status === 'failed') {
    return (
      <div
        className="flex items-start gap-2 px-3 pb-3 pt-2 text-sm text-destructive"
        data-testid="board-part-failed"
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
        data-testid="board-part-generating"
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
      data-testid="board-part-pending"
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
  const actions = useBoardActions();
  const [showPrevious, setShowPrevious] = useState(false);
  const streaming = staged.newMarkdown === '';
  const text = showPrevious
    ? staged.oldMarkdown
    : (staged.newMarkdown !== '' ? staged.newMarkdown : staged.ghost);
  return (
    <div
      className="nowheel max-h-[360px] overflow-y-auto overscroll-contain border-x-2 border-amber-500/60 bg-amber-500/5 px-3 pb-3"
      data-testid="board-part-staged"
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
            data-testid="board-part-show-previous"
            onClick={() => {
              setShowPrevious((previous) => !previous);
            }}
          >
            {showPrevious ? 'Show new' : 'Show previous'}
          </Button>
        )}
      </div>
      <div className={BODY_TEXT_CLASS} data-testid="board-part-staged-text">
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
            data-testid="board-part-apply"
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
            data-testid="board-part-discard"
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
  const slice = useBoardStore((state) => state.content.priors[id]);
  const detailed = useBoardStore((state) => state.zoom >= BOARD_LOD_FULL_ABOVE);
  const { pool } = useBoardPool();
  if (slice === undefined) return null;
  return (
    <div
      className={cn(CARD_CLASS, 'opacity-90')}
      data-testid={`board-prior-${slice.moduleId}`}
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
    <div className={BOARD_CARD_BODY_CLASS} data-testid="board-prior-body">
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
 *
 * react-refresh cannot fast-refresh this file because of the export below:
 * that is accepted here rather than split out, because the map's VALUES are
 * the memoized cards declared above — it is the registry half of those
 * components (React Flow's nodeTypes idiom), and its module-scope identity is
 * the whole contract. A separate module would import the cards back and could
 * only drift from them.
 */
// eslint-disable-next-line react-refresh/only-export-components -- the registry's values are this file's own memoized card components, declared with it on purpose; a sibling file would have to import them back and could silently drift out of sync.
export const boardNodeTypes: NodeTypes = {
  premise: PremiseCardNode,
  part: PartCardNode,
  prior: PriorModuleCardNode,
};
