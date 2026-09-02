import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  EyeIcon,
  EyeOffIcon,
  FlagIcon,
  LockIcon,
  LockOpenIcon,
  MinusIcon,
  PlusIcon,
  RotateCcwIcon,
  ShieldIcon,
  SwordsIcon,
  TrashIcon,
  Undo2Icon,
  UsersIcon,
  XIcon,
} from 'lucide-react';

import type { AnyArtifact, Battle, BattleToken, BattleTokenId, BattleVeil, FighterStatsLookup, Id } from '@/domain';
import { nextTokenScale, tokenSizeFittingGrid, VEIL_DEFAULT_CELLS } from '@/domain/battle';
import { combatHpForToken } from '@/domain/battle/board';
import {
  activeInitiativeTokenId,
  nextTurn,
  pruneInitiativeToVisibleFighters,
  rollTokenInitiative,
  sortInitiativeOrder,
  visibleFighterTokenIds,
} from '@/domain/battle/initiative';
import { resizeVeilFromEdge, veilCellPx, type VeilEdge } from '@/domain/battle/veil';
import {
  battleGridStyle,
  snapAxisToGrid,
  snapAxisToLayoutGrid,
  tokenSpanCells,
} from '@/domain/battle/gridSnap';
import {
  beginBoardGesture,
  endBoardGesture,
  isBoardGestureActive,
  isInitiativeDragging,
  initiativeDragEpoch,
  subscribeInitiativeDragEpoch,
} from '@/domain/battle/gestureGate';
import { artifactRepo } from '@/db';
import {
  resetBattleToStage,
  saveBattleBoard,
  saveBattleStage,
} from '@/db/battleRepo';
import { getImage } from '@/db/imageRepo';
import { useImageUrl } from '@/features/images/use-image-url';
import { useBattleState } from './use-battle';
import { InitiativeSidebar } from './initiative-sidebar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * The table surface (09-MILESTONE-5 M5-D): a full-screen dark board rendered
 * from the live battle row. Player-safe contract (binding):
 *
 * - The surface renders ONLY the board — map, grid, tokens, veils, staging
 *   ground, initiative sidebar, HP meters, downed overlay. No artifact
 *   bodies, no stat text, no GM-only material anywhere in the DOM.
 * - Tokens under a veil/fog and `visible: false` tokens are REMOVED from the
 *   DOM (not dimmed) and pruned from initiative — that IS the mechanic.
 * - Token tap shows name + image + HP only (full inspection happens back on
 *   the GM view, never here).
 *
 * Interactions: drag with a local live position + a single repo commit on
 * release (8px tap threshold); wheel/button/pinch pan-zoom; veil add/resize;
 * stage set/reset; gated initiative reconcile; HP floats writing to the
 * token (NPC) or the pc artifact (PC).
 */

const ZOOM_MIN = 0.35;
const ZOOM_MAX = 4;
const DRAG_THRESHOLD_PX = 8;

/** Damage/heal clamp shared by both HP owners. */
function clampHp(value: number, maxHp: number): number {
  return Math.max(0, Math.min(maxHp, value));
}

interface LiveDrag {
  tokenId: BattleTokenId;
  x: number;
  y: number;
  movedPx: number;
  originX: number;
  originY: number;
}

export function BattleSurface(): JSX.Element {
  const { campaignId = '', moduleId = '' } = useParams();
  const navigate = useNavigate();

  const [boardSize, setBoardSize] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [liveDrag, setLiveDrag] = useState<LiveDrag | null>(null);
  const [selectedTokenId, setSelectedTokenId] = useState<BattleTokenId | null>(null);
  const [selectedVeilId, setSelectedVeilId] = useState<BattleVeil['id'] | null>(null);
  const [playerSafe, setPlayerSafe] = useState(false);
  const [stageArmed, setStageArmed] = useState(false);
  const [hpDelta, setHpDelta] = useState('');
  const [, setEpochTick] = useState(initiativeDragEpoch());
  const boardRef = useRef<HTMLDivElement | null>(null);
  const openedLiveRef = useRef(false);
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const pinchRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchBaseRef = useRef<{ distance: number; zoom: number } | null>(null);

  const { battle, stats, coveredTokenIds, artifacts } = useBattleState(
    campaignId,
    moduleId,
    boardSize.w,
    boardSize.h,
  );

  const mapImageId = battle?.board.mapImageId ?? null;
  const mapImage = useLiveQuery(
    async () => (mapImageId === null ? undefined : artifactImageById(mapImageId)),
    [mapImageId],
    undefined,
  );

  // The initiative reorder gate publishes an epoch when its last drag ends —
  // the reconcile effect re-runs exactly then.
  useEffect(
    () =>
      subscribeInitiativeDragEpoch(() => {
        setEpochTick(initiativeDragEpoch());
      }),
    [],
  );

  // Track the board's pixel size (coverage + snapping need real px). The
  // effect re-runs when the board mounts (before the battle row loads, the
  // empty state renders and the board ref is null).
  const boardMounted = battle !== undefined;
  useEffect(() => {
    if (!boardMounted) return undefined;
    const element = boardRef.current;
    if (element === null) return undefined;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect !== undefined && (rect.width !== boardSize.w || rect.height !== boardSize.h)) {
        setBoardSize({ w: rect.width, h: rect.height });
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
    // boardSize is intentionally not a dependency (would loop on every resize).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardMounted]);

  // Entering the surface puts the battle on the table (once per mount):
  // live: true AND every token revealed — the source's `liveBoard` rule
  // (artifact-backed tokens and stamps become visible on the table; prep
  // scratch keeps them hidden).
  useEffect(() => {
    if (battle === undefined || openedLiveRef.current || battle.board.live) return;
    openedLiveRef.current = true;
    const tokens = battle.board.tokens.map((token) => ({ ...token, visible: true }));
    void saveBattleBoard(battle.id, { ...battle.board, live: true, tokens }).catch((error: unknown) => {
      toastError('Could not show the battle', error);
    });
  }, [battle]);

  const commit = useCallback(
    (mutate: (board: Battle['board']) => Battle['board']) => {
      if (battle === undefined) return Promise.resolve();
      return saveBattleBoard(battle.id, mutate(battle.board))
        .then(() => undefined)
        .catch((error: unknown) => {
          toastError('Could not save the battle', error);
        });
    },
    [battle],
  );

  // --- Initiative reconcile (gated) -----------------------------------------
  // Effect logic separated so the render body stays a pure function of state.
  useInitiativeReconcile(battle, stats, coveredTokenIds, commit);

  const mapLayout = battle?.board.mapLayout ?? null;
  const cellWidthPx =
    mapLayout !== null && boardSize.w > 0
      ? boardSize.w / mapLayout.cols
      : battle === undefined
        ? 72
        : veilCellPx(battle.board.gridSize, battle.board.tokenSize);
  const cellHeightPx =
    mapLayout !== null && boardSize.h > 0 ? boardSize.h / mapLayout.rows : cellWidthPx;
  const aspect =
    mapLayout !== null
      ? mapLayout.cols / mapLayout.rows
      : mapImage === undefined
        ? 16 / 9
        : mapImage.width / mapImage.height;

  useEffect(() => {
    if (battle === undefined || mapLayout === null || boardSize.w <= 0 || boardSize.h <= 0) return;
    const desired = tokenSizeFittingGrid(Math.max(1, Math.floor(Math.min(cellWidthPx, cellHeightPx))));
    if (desired === battle.board.tokenSize) return;
    void commit((board) => ({ ...board, tokenSize: desired }));
  }, [battle, mapLayout, boardSize.w, boardSize.h, cellWidthPx, cellHeightPx, commit]);

  const displayedTokens = useMemo(() => {
    if (battle === undefined) return [];
    const drag = liveDrag;
    return battle.board.tokens
      .filter((token) => token.visible && !coveredTokenIds.has(token.id))
      .map((token) => (drag !== null && token.id === drag.tokenId ? { ...token, x: drag.x, y: drag.y } : token));
  }, [battle, liveDrag, coveredTokenIds]);

  const artifactById = useMemo(() => new Map(artifacts.map((entry) => [entry.id, entry])), [artifacts]);
  const selectedToken = displayedTokens.find((token) => token.id === selectedTokenId) ?? null;

  function boardPointFromEvent(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = boardRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0 || rect.height === 0) return { x: 0.5, y: 0.5 };
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }

  function snapPoint(x: number, y: number): { x: number; y: number } {
    const grid = battle?.board.gridSize;
    if (battle === undefined || boardSize.w === 0) return { x, y };
    if (battle.board.mapLayout === null && (grid === undefined || grid === null)) return { x, y };
    const token =
      liveDrag === null
        ? undefined
        : battle.board.tokens.find((entry) => entry.id === liveDrag.tokenId);
    const span = tokenSpanCells(token?.scale ?? 1);
    if (battle.board.mapLayout !== null) {
      return {
        x: snapAxisToLayoutGrid(x, battle.board.mapLayout.cols, span),
        y: snapAxisToLayoutGrid(y, battle.board.mapLayout.rows, span),
      };
    }
    return {
      x: snapAxisToGrid(x, boardSize.w, cellWidthPx, span),
      y: snapAxisToGrid(y, boardSize.h, cellHeightPx, span),
    };
  }

  // --- Pointer handling ------------------------------------------------------

  function onBoardPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    // Two fingers → pinch; one finger/middle-drag on the background → pan.
    pinchRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinchRef.current.size === 2) {
      panRef.current = null;
      return;
    }
    const target = event.target as HTMLElement;
    if (event.target === event.currentTarget || target.dataset.boardBackground === 'true') {
      panRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: pan.x,
        originY: pan.y,
      };
    }
  }

  function onBoardPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (pinchRef.current.has(event.pointerId)) {
      pinchRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (pinchRef.current.size === 2) {
      const points = [...pinchRef.current.values()];
      const first = points[0];
      const second = points[1];
      if (first !== undefined && second !== undefined) {
        const distance = Math.hypot(first.x - second.x, first.y - second.y);
        const base = pinchBaseRef.current;
        if (base === null || base.distance <= 0) {
          pinchBaseRef.current = { distance, zoom };
        } else {
          setZoom(clampZoom((base.zoom * distance) / base.distance));
        }
      }
      return;
    }
    const panning = panRef.current;
    if (panning !== null && panning.pointerId === event.pointerId) {
      setPan({ x: panning.originX + (event.clientX - panning.startX), y: panning.originY + (event.clientY - panning.startY) });
    }
  }

  function onBoardPointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    pinchRef.current.delete(event.pointerId);
    if (pinchRef.current.size < 2) pinchBaseRef.current = null;
    panRef.current = null;
  }

  function startTokenDrag(event: React.PointerEvent<HTMLDivElement>, token: BattleToken): void {
    if (playerSafe) return;
    event.stopPropagation();
    // Pointer capture is a browser nicety; jsdom (tests) lacks it.
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    beginBoardGesture();
    const at = boardPointFromEvent(event);
    setLiveDrag({ tokenId: token.id, x: token.x, y: token.y, movedPx: 0, originX: at.x, originY: at.y });
  }

  function moveTokenDrag(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = liveDrag;
    if (drag === null) return;
    const at = boardPointFromEvent(event);
    const movedPx = Math.hypot((at.x - drag.originX) * boardSize.w, (at.y - drag.originY) * boardSize.h);
    setLiveDrag({ ...drag, x: at.x, y: at.y, movedPx: Math.max(drag.movedPx, movedPx) });
  }

  function finishTokenDrag(): void {
    const drag = liveDrag;
    setLiveDrag(null);
    endBoardGesture();
    if (drag === null) return;
    if (drag.movedPx < DRAG_THRESHOLD_PX) {
      // Tap: select (player-safe tap shows name/image/HP only).
      setSelectedTokenId(drag.tokenId);
      setSelectedVeilId(null);
      return;
    }
    const snapped = snapPoint(drag.x, drag.y);
    void commit((board) => ({
      ...board,
      tokens: board.tokens.map((token) => (token.id === drag.tokenId ? { ...token, x: snapped.x, y: snapped.y } : token)),
    }));
  }

  function startVeilDrag(event: React.PointerEvent<HTMLDivElement>, veil: BattleVeil): void {
    if (playerSafe || battle?.board.sceneryMovementLocked === true) return;
    event.stopPropagation();
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    beginBoardGesture();
    const at = boardPointFromEvent(event);
    setLiveDrag({ tokenId: `veil:${veil.id}`, x: veil.x, y: veil.y, movedPx: 0, originX: at.x, originY: at.y });
    setSelectedVeilId(veil.id);
    setSelectedTokenId(null);
  }

  function moveVeilDrag(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = liveDrag;
    if (drag?.tokenId.startsWith('veil:') !== true) return;
    const at = boardPointFromEvent(event);
    const movedPx = Math.hypot((at.x - drag.originX) * boardSize.w, (at.y - drag.originY) * boardSize.h);
    setLiveDrag({ ...drag, x: at.x, y: at.y, movedPx: Math.max(drag.movedPx, movedPx) });
  }

  function finishVeilDrag(): void {
    const drag = liveDrag;
    setLiveDrag(null);
    endBoardGesture();
    if (drag?.tokenId.startsWith('veil:') !== true) return;
    const veilId = drag.tokenId.slice('veil:'.length);
    if (drag.movedPx < DRAG_THRESHOLD_PX) return;
    void commit((board) => ({
      ...board,
      veils: board.veils.map((veil) => (veil.id === veilId ? { ...veil, x: drag.x, y: drag.y } : veil)),
    }));
  }

  function resizeVeil(veil: BattleVeil, edge: VeilEdge, event: React.PointerEvent<HTMLDivElement>): void {
    event.stopPropagation();
    const at = boardPointFromEvent(event);
    try {
      const resized = resizeVeilFromEdge(
        veil,
        edge,
        at,
        boardSize.w,
        boardSize.h,
        cellWidthPx,
        cellHeightPx,
      );
      void commit((board) => ({
        ...board,
        veils: board.veils.map((entry) => (entry.id === veil.id ? resized : entry)),
      }));
    } catch (error) {
      toastError('Could not resize the veil', error);
    }
  }

  // --- Actions ---------------------------------------------------------------

  function enableInitiative(): void {
    if (battle === undefined) return;
    const statsLookup: FighterStatsLookup = stats;
    const visibleIds = visibleFighterTokenIds(battle.board, statsLookup, coveredTokenIds);
    let tokens = battle.board.tokens;
    for (const id of visibleIds) {
      const token = tokens.find((entry) => entry.id === id);
      if (token === undefined) continue;
      tokens = tokens.map((entry) => (entry.id === id ? rollTokenInitiative(entry, statsLookup) : entry));
    }
    const order = sortInitiativeOrder(visibleIds, tokens);
    void commit((board) => ({ ...board, initiativeEnabled: true, initiativeOrder: order, activeIndex: 0, tokens }));
  }

  function addVeil(kind: BattleVeil['kind']): void {
    if (battle === undefined) return;
    const veil: BattleVeil = {
      id: crypto.randomUUID(),
      kind,
      x: 0.5,
      y: 0.5,
      widthCells: VEIL_DEFAULT_CELLS,
      heightCells: VEIL_DEFAULT_CELLS,
    };
    void commit((board) => ({ ...board, veils: [...board.veils, veil] }));
    setSelectedVeilId(veil.id);
  }

  async function applyHp(token: BattleToken, delta: number): Promise<void> {
    if (battle === undefined || token.artifactId === null) return;
    const resolved = combatHpForToken(token, stats);
    if (resolved === null) {
      toastError(`No combat stats for “${token.label}” — HP cannot change`);
      return;
    }
    const next = clampHp(resolved.currentHp + delta, resolved.maxHp);
    try {
      if (resolved.ownedBy === 'artifact') {
        // PCs own their HP on the artifact — it persists across battles.
        const pc = artifactById.get(token.artifactId);
        if (pc?.kind !== 'pc') throw new Error('PC artifact missing');
        await artifactRepo.updateArtifact(pc.id, { data: { ...pc.data, currentHp: next } });
      } else {
        // NPCs own HP on the token instance.
        await commit((board) => ({
          ...board,
          tokens: board.tokens.map((entry) => (entry.id === token.id ? { ...entry, currentHp: next } : entry)),
        }));
      }
    } catch (error) {
      toastError('Could not update HP', error);
    }
  }

  async function removeToken(token: BattleToken): Promise<void> {
    if (battle === undefined) return;
    if (token.artifactId !== null) {
      const artifact = artifactById.get(token.artifactId);
      // Fighter tokens only leave via their artifact (or scrub below when it
      // is a seed token with no artifact backing).
      if (artifact !== undefined) return;
    }
    await commit((board) => ({
      ...board,
      tokens: board.tokens.filter((entry) => entry.id !== token.id),
      initiativeOrder: board.initiativeOrder.filter((id) => id !== token.id),
    }));
    setSelectedTokenId(null);
  }

  async function liftBattle(): Promise<void> {
    if (battle !== undefined) {
      await saveBattleBoard(battle.id, { ...battle.board, live: false }).catch((error: unknown) => {
        toastError('Could not lift the battle', error);
      });
    }
    navigate(-1);
  }

  if (battle === undefined) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 bg-zinc-950 text-zinc-300"
        data-testid="battle-surface-empty"
      >
        <p>No battle is seeded for this module yet.</p>
        <p className="text-sm text-zinc-500">Open an encounter card and press “Run battle” first.</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            navigate(-1);
          }}
        >
          Back to module
        </Button>
      </div>
    );
  }

  const board = battle.board;
  const turnTokenId = activeInitiativeTokenId(board);
  const boardPx = { w: boardSize.w, h: boardSize.h };
  const hasRealSize = boardSize.w > 0 && boardSize.h > 0;

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col bg-zinc-950 text-zinc-100', playerSafe && 'select-none')}
      data-testid="battle-surface"
      data-player-safe={playerSafe ? 'true' : 'false'}
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-white/10 p-2" data-testid="battle-toolbar">
        <Button size="sm" variant="ghost" data-testid="lift-battle" onClick={() => {
          void liftBattle();
        }}>
          <XIcon aria-hidden data-icon="inline-start" />
          Lift
        </Button>
        <span className="mx-1 h-5 w-px bg-white/10" />
        <Button
          size="sm"
          variant={board.initiativeEnabled ? 'secondary' : 'outline'}
          data-testid="toggle-initiative"
          onClick={() => {
            if (board.initiativeEnabled) {
              void commit((current) => ({ ...current, initiativeEnabled: false, initiativeOrder: [], activeIndex: 0 }));
            } else {
              enableInitiative();
            }
          }}
        >
          <SwordsIcon aria-hidden data-icon="inline-start" />
          Initiative
        </Button>
        <Button size="sm" variant="outline" onClick={() => {
          addVeil('veil');
        }} disabled={playerSafe}>
          <ShieldIcon aria-hidden data-icon="inline-start" />
          Veil
        </Button>
        <Button size="sm" variant="outline" onClick={() => {
          addVeil('fog');
        }} disabled={playerSafe}>
          Fog
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={playerSafe}
          data-testid="toggle-scenery-lock"
          aria-pressed={board.sceneryMovementLocked}
          onClick={() => {
            void commit((current) => ({ ...current, sceneryMovementLocked: !current.sceneryMovementLocked }));
          }}
        >
          {board.sceneryMovementLocked ? <LockIcon aria-hidden data-icon="inline-start" /> : <LockOpenIcon aria-hidden data-icon="inline-start" />}
          Scenery lock
        </Button>
        <span className="mx-1 h-5 w-px bg-white/10" />
        {stageArmed ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              data-testid="confirm-stage"
              onClick={() => {
                setStageArmed(false);
                void saveBattleStage(battle.id, board)
                  .then(() => undefined)
                  .catch((error: unknown) => {
                    toastError('Could not set the stage', error);
                  });
              }}
            >
              <FlagIcon aria-hidden data-icon="inline-start" />
              Confirm set stage
            </Button>
            <Button size="sm" variant="ghost" onClick={() => {
              setStageArmed(false);
            }}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" disabled={playerSafe} data-testid="set-stage" onClick={() => {
            setStageArmed(true);
          }}>
            <FlagIcon aria-hidden data-icon="inline-start" />
            Set stage
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={playerSafe || board.stage === null}
          data-testid="reset-stage"
          onClick={() => {
            void resetBattleToStage(battle.id).catch((error: unknown) => {
              toastError('Could not reset to the stage', error);
            });
          }}
        >
          <RotateCcwIcon aria-hidden data-icon="inline-start" />
          Reset
        </Button>
        <span className="mx-1 h-5 w-px bg-white/10" />
        <Button
          size="sm"
          variant="ghost"
          data-testid="player-safe-toggle"
          aria-pressed={playerSafe}
          onClick={() => {
            setPlayerSafe((value) => !value);
          }}
        >
          <UsersIcon aria-hidden data-icon="inline-start" />
          {playerSafe ? 'Player view' : 'GM view'}
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label="Zoom out" onClick={() => {
            setZoom((current) => clampZoom(current / 1.25));
          }}>
            <MinusIcon aria-hidden className="size-4" />
          </Button>
          <span className="w-10 text-center text-xs text-zinc-400">{Math.round(zoom * 100)}%</span>
          <Button size="icon-sm" variant="ghost" aria-label="Zoom in" onClick={() => {
            setZoom((current) => clampZoom(current * 1.25));
          }}>
            <PlusIcon aria-hidden className="size-4" />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Reset view" onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}>
            <Undo2Icon aria-hidden className="size-4" />
          </Button>
        </div>
      </div>

      {/* Board + sidebar */}
      <div className="flex min-h-0 flex-1">
        <div
          ref={boardRef}
          className="relative min-h-0 flex-1 touch-none overflow-hidden bg-zinc-900"
          data-testid="battle-board"
          onPointerDown={onBoardPointerDown}
          onPointerMove={onBoardPointerMove}
          onPointerUp={onBoardPointerUp}
          onPointerCancel={onBoardPointerUp}
          onWheel={(event) => {
            if (!event.ctrlKey && Math.abs(event.deltaY) < 2) return;
            setZoom((current) => clampZoom(current * (event.deltaY > 0 ? 0.9 : 1.1)));
          }}
        >
          <div
            data-board-background="true"
            className="absolute inset-0"
            style={{
              transform: `translate(${String(pan.x)}px, ${String(pan.y)}px) scale(${String(zoom)})`,
              transformOrigin: 'center center',
            }}
          >
            <div
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{ width: '100%', aspectRatio: String(aspect), maxWidth: '100%' }}
            >
              {/* Map (or viewport board) */}
              {mapImage !== undefined ? (
                <MapLayer imageId={mapImage.id} />
              ) : (
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,#27272a_0%,#18181b_100%)]" />
              )}
              {/* Grid */}
              {(board.gridSize !== null || board.mapLayout !== null) && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0"
                  style={battleGridStyle(board.mapLayout, board.gridSize)}
                  data-testid="battle-grid"
                />
              )}
              {/* Staging ground */}
              {board.stagingGround !== null && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute border-2 border-dashed border-emerald-400/50 bg-emerald-400/5"
                  style={{
                    left: `${String((board.stagingGround.x - (1.5 * board.stagingGround.cellWidth)) * 100)}%`,
                    top: `${String((board.stagingGround.y - (1.5 * board.stagingGround.cellHeight)) * 100)}%`,
                    width: `${String(3 * board.stagingGround.cellWidth * 100)}%`,
                    height: `${String(3 * board.stagingGround.cellHeight * 100)}%`,
                  }}
                />
              )}
              {/* Tokens — covered/hidden are REMOVED, never dimmed */}
              {displayedTokens.map((token) => (
                <TokenView
                  key={token.id}
                  token={token}
                  board={boardPx}
                  artifact={token.artifactId === null ? undefined : artifactById.get(token.artifactId)}
                  stats={stats}
                  selected={token.id === selectedTokenId}
                  isActiveTurn={token.id === turnTokenId}
                  dragging={liveDrag?.tokenId === token.id}
                  playerSafe={playerSafe}
                  onPointerDown={(event) => {
                    startTokenDrag(event, token);
                  }}
                  onPointerMove={moveTokenDrag}
                  onPointerUp={finishTokenDrag}
                />
              ))}
              {/* Veils */}
              {board.veils.map((veil) => (
                <VeilView
                  key={veil.id}
                  veil={veil}
                  board={boardPx}
                  cellWidthPx={cellWidthPx}
                  cellHeightPx={cellHeightPx}
                  selected={veil.id === selectedVeilId}
                  resizable={!playerSafe && !board.sceneryMovementLocked}
                  onPointerDown={(event) => {
                    startVeilDrag(event, veil);
                  }}
                  onPointerMove={moveVeilDrag}
                  onPointerUp={finishVeilDrag}
                  onResize={(edge, event) => {
                    resizeVeil(veil, edge, event);
                  }}
                />
              ))}
            </div>
          </div>
          {!hasRealSize && <div className="absolute inset-0" />}
        </div>

        {/* Right rail: initiative + token controls */}
        <div className="flex w-60 flex-col gap-2 overflow-y-auto border-l border-white/10 bg-black/60 p-2">
          <InitiativeSidebar
            battle={battle}
            onReorder={(order) => {
              void commit((current) => ({
                ...current,
                initiativeOrder: order,
                activeIndex: Math.min(current.activeIndex, Math.max(order.length - 1, 0)),
              }));
            }}
            onNextTurn={() => {
              void commit((current) => {
                const next = nextTurn(current);
                return next === current ? current : next;
              });
            }}
            onClose={() => {
              void commit((current) => ({ ...current, initiativeEnabled: false, initiativeOrder: [], activeIndex: 0 }));
            }}
          />
          {selectedToken !== null && !playerSafe && (
            <TokenControls
              token={selectedToken}
              stats={stats}
              hpDelta={hpDelta}
              onHpDeltaChange={setHpDelta}
              onApplyHp={(delta) => {
                void applyHp(selectedToken, delta);
                setHpDelta('');
              }}
              onToggleVisibility={() => {
                void commit((current) => ({
                  ...current,
                  tokens: current.tokens.map((entry) =>
                    entry.id === selectedToken.id ? { ...entry, visible: !entry.visible } : entry,
                  ),
                }));
              }}
              onScale={(delta) => {
                void commit((current) => ({
                  ...current,
                  tokens: current.tokens.map((entry) =>
                    entry.id === selectedToken.id
                      ? { ...entry, scale: nextTokenScale(entry.scale, delta) }
                      : entry,
                  ),
                }));
              }}
              onRemove={
                selectedToken.artifactId === null || artifactById.get(selectedToken.artifactId) === undefined
                  ? () => {
                      void removeToken(selectedToken);
                    }
                  : undefined
              }
            />
          )}
          {selectedVeilId !== null && !playerSafe && (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              data-testid="delete-veil"
              onClick={() => {
                void commit((current) => ({
                  ...current,
                  veils: current.veils.filter((veil) => veil.id !== selectedVeilId),
                }));
                setSelectedVeilId(null);
              }}
            >
              <TrashIcon aria-hidden data-icon="inline-start" />
              Delete veil
            </Button>
          )}
          {!board.initiativeEnabled && !playerSafe && (
            <p className="text-xs text-zinc-500">
              Enable initiative to roll every visible fighter (d20 + frozen bonus) and cycle turns.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function clampZoom(value: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value));
}

/** Initiative reconcile effect: prune covered/hidden, auto-roll newcomers —
 * suppressed while a drag is in flight, re-run when the gate's epoch bumps. */
function useInitiativeReconcile(
  battle: Battle | undefined,
  stats: FighterStatsLookup,
  coveredTokenIds: ReadonlySet<BattleTokenId>,
  commit: (mutate: (board: Battle['board']) => Battle['board']) => Promise<void>,
): void {
  useEffect(() => {
    if (battle?.board.initiativeEnabled !== true) return;
    if (isInitiativeDragging() || isBoardGestureActive()) return;
    const board = battle.board;
    const pruned = pruneInitiativeToVisibleFighters(board, stats, coveredTokenIds);
    const visibleIds = visibleFighterTokenIds(pruned, stats, coveredTokenIds);
    const inOrder = new Set(pruned.initiativeOrder);
    const newcomers = visibleIds.filter((id) => !inOrder.has(id));
    if (newcomers.length === 0) {
      if (pruned !== board) void commit(() => pruned);
      return;
    }
    let tokens = pruned.tokens;
    for (const id of newcomers) {
      const token = tokens.find((entry) => entry.id === id);
      if (token === undefined) continue;
      tokens = tokens.map((entry) => (entry.id === id ? rollTokenInitiative(entry, stats) : entry));
    }
    const order = sortInitiativeOrder([...pruned.initiativeOrder, ...newcomers], tokens);
    void commit((current) => ({ ...current, tokens, initiativeOrder: order }));
    // `battle.board` identity changes on every commit; the reconcile is
    // idempotent (prune + newcomers), and the epoch re-runs it after drags.
  }, [battle, coveredTokenIds, stats, commit]);
}

/** The battlemap layer: object-fit cover so the normalized grid matches. */
function MapLayer({ imageId }: { imageId: Id }): JSX.Element | null {
  const url = useImageUrl(imageId);
  if (url === null) return null;
  return <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />;
}

interface TokenViewProps {
  token: BattleToken;
  board: { w: number; h: number };
  artifact: AnyArtifact | undefined;
  stats: FighterStatsLookup;
  selected: boolean;
  isActiveTurn: boolean;
  dragging: boolean;
  playerSafe: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
}

/** One token: portrait art or deterministic initials, HP meter, downed
 * overlay, turn marker. NAME + IMAGE + HP ONLY — never stats. */
function TokenView({
  token,
  board,
  artifact,
  stats,
  selected,
  isActiveTurn,
  dragging,
  playerSafe,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: TokenViewProps): JSX.Element | null {
  const coverImageId = artifact !== undefined && 'coverImageId' in artifact ? artifact.coverImageId : null;
  const url = useImageUrl(coverImageId);
  const resolved = combatHpForToken(token, stats);
  if (board.w === 0 || board.h === 0) return null;
  // Token size: tokenSize in board px scaled by token.scale — the board div
  // is the reference frame, so width is a percentage of board width.
  const widthPct = ((64 * token.scale) / board.w) * 100;
  const heightPct = ((64 * token.scale) / board.h) * 100;
  const hpRatio = resolved === null ? null : resolved.maxHp === 0 ? 0 : resolved.currentHp / resolved.maxHp;
  const downed = hpRatio === 0;
  const initials = token.label
    .split(/\s+/u)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
  return (
    <div
      className={cn(
        'absolute -translate-x-1/2 -translate-y-1/2 touch-none',
        dragging && 'z-20 opacity-90',
        playerSafe ? 'cursor-default' : 'cursor-grab',
      )}
      style={{ left: `${String(token.x * 100)}%`, top: `${String(token.y * 100)}%`, width: `${String(widthPct)}%`, height: `${String(heightPct)}%` }}
      data-testid="battle-token"
      data-token-label={token.label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div
        className={cn(
          'relative h-full w-full overflow-hidden rounded-full border-2 shadow-lg',
          selected ? 'border-amber-400' : 'border-white/60',
          downed && 'grayscale',
        )}
      >
        {url !== null ? (
          <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <span className="flex h-full w-full items-center justify-center bg-zinc-700 font-bold text-white">
            {initials}
          </span>
        )}
        {/* Vertical HP fill meter */}
        {hpRatio !== null && (
          <div
            aria-hidden
            className="absolute inset-x-0 bottom-0 bg-emerald-500/45"
            style={{ height: `${String(Math.min(hpRatio, 1) * 100)}%` }}
            data-testid="hp-meter"
          />
        )}
        {downed && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-red-950/70 text-[10px] font-bold uppercase text-red-200"
            data-testid="downed-overlay"
          >
            Down
          </div>
        )}
      </div>
      {/* Floating turn marker */}
      {isActiveTurn && (
        <span
          aria-label="Active turn"
          className="absolute -top-2 left-1/2 size-3 -translate-x-1/2 rotate-45 border border-emerald-200 bg-emerald-500"
          data-testid="turn-marker"
        />
      )}
      <span className="pointer-events-none absolute inset-x-0 -bottom-4 truncate text-center text-[10px] text-white drop-shadow">
        {token.label}
      </span>
    </div>
  );
}

interface VeilViewProps {
  veil: BattleVeil;
  board: { w: number; h: number };
  cellWidthPx: number;
  cellHeightPx: number;
  selected: boolean;
  resizable: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  onResize: (edge: VeilEdge, event: React.PointerEvent<HTMLDivElement>) => void;
}

/** A veil/fog rectangle; opaque for players, translucent while selected. */
function VeilView({
  veil,
  board,
  cellWidthPx,
  cellHeightPx,
  selected,
  resizable,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onResize,
}: VeilViewProps): JSX.Element | null {
  if (board.w === 0 || board.h === 0) return null;
  const widthPct = ((veil.widthCells * cellWidthPx) / board.w) * 100;
  const heightPct = ((veil.heightCells * cellHeightPx) / board.h) * 100;
  const handles: { edge: VeilEdge; className: string }[] = [
    { edge: 'n', className: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2' },
    { edge: 's', className: 'left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2' },
    { edge: 'w', className: 'left-0 top-1/2 -translate-y-1/2 -translate-x-1/2' },
    { edge: 'e', className: 'right-0 top-1/2 -translate-y-1/2 translate-x-1/2' },
  ];
  return (
    <div
      className={cn(
        'absolute -translate-x-1/2 -translate-y-1/2 touch-none',
        veil.kind === 'fog' ? 'bg-zinc-200' : 'bg-zinc-800',
        selected ? 'opacity-70 ring-2 ring-amber-400' : 'opacity-100',
        !resizable && 'cursor-default',
      )}
      style={{
        left: `${String(veil.x * 100)}%`,
        top: `${String(veil.y * 100)}%`,
        width: `${String(widthPct)}%`,
        height: `${String(heightPct)}%`,
      }}
      data-testid="battle-veil"
      data-veil-kind={veil.kind}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {resizable &&
        handles.map((handle) => (
          <button
            key={handle.edge}
            type="button"
            aria-label={`Resize veil ${handle.edge}`}
            className={cn('absolute size-3 rounded-full border border-zinc-900 bg-amber-400', handle.className)}
            data-testid={`veil-handle-${handle.edge}`}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              onResize(handle.edge, event as unknown as React.PointerEvent<HTMLDivElement>);
            }}
          />
        ))}
    </div>
  );
}

interface TokenControlsProps {
  token: BattleToken;
  stats: FighterStatsLookup;
  hpDelta: string;
  onHpDeltaChange: (value: string) => void;
  onApplyHp: (delta: number) => void;
  onToggleVisibility: () => void;
  onScale: (delta: -1 | 1) => void;
  onRemove: (() => void) | undefined;
}

/** Selected-token floats: HP delta, visibility, scale, remove. */
function TokenControls({
  token,
  stats,
  hpDelta,
  onHpDeltaChange,
  onApplyHp,
  onToggleVisibility,
  onScale,
  onRemove,
}: TokenControlsProps): JSX.Element | null {
  const resolved = combatHpForToken(token, stats);
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-white/10 bg-zinc-900 p-2" data-testid="token-controls">
      <p className="truncate text-sm font-medium">{token.label}</p>
      {resolved !== null ? (
        <p className="text-xs text-zinc-400" data-testid="token-hp">
          HP {String(resolved.currentHp)} / {String(resolved.maxHp)}
          {resolved.ownedBy === 'artifact' ? ' (persists)' : ''}
        </p>
      ) : (
        <p className="text-xs text-amber-400" data-testid="token-no-stats">
          No combat stats — excluded from initiative
        </p>
      )}
      <div className="flex items-center gap-1">
        <Input
          value={hpDelta}
          inputMode="numeric"
          placeholder="±HP"
          aria-label="HP delta"
          className="h-7 w-16 text-sm"
          onChange={(event) => {
            onHpDeltaChange(event.target.value);
          }}
        />
        <Button
          size="xs"
          variant="outline"
          data-testid="damage"
          onClick={() => {
            const parsed = Number.parseInt(hpDelta, 10);
            if (!Number.isNaN(parsed)) onApplyHp(-Math.abs(parsed));
          }}
        >
          Damage
        </Button>
        <Button
          size="xs"
          variant="outline"
          data-testid="heal"
          onClick={() => {
            const parsed = Number.parseInt(hpDelta, 10);
            if (!Number.isNaN(parsed)) onApplyHp(Math.abs(parsed));
          }}
        >
          Heal
        </Button>
      </div>
      <div className="flex items-center gap-1">
        <Button size="xs" variant="ghost" aria-label="Shrink token" onClick={() => {
          onScale(-1);
        }}>
          <MinusIcon aria-hidden className="size-3.5" />
        </Button>
        <Button size="xs" variant="ghost" aria-label="Grow token" onClick={() => {
          onScale(1);
        }}>
          <PlusIcon aria-hidden className="size-3.5" />
        </Button>
        <Button size="xs" variant="ghost" aria-label="Toggle visibility" data-testid="toggle-visibility" onClick={onToggleVisibility}>
          {token.visible ? <EyeIcon aria-hidden className="size-3.5" /> : <EyeOffIcon aria-hidden className="size-3.5" />}
        </Button>
        {onRemove !== undefined && (
          <Button size="xs" variant="ghost" className="text-destructive" aria-label="Remove token" onClick={onRemove}>
            <TrashIcon aria-hidden className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

async function artifactImageById(imageId: Id) {
  return getImage(imageId);
}
