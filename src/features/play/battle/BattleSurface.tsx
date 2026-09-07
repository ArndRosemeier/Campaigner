import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { toast } from 'sonner';
import {
  DicesIcon,
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

import type { AnyArtifact, Battle, BattleEffect, BattleEffectShape, BattleToken, BattleTokenId, BattleVeil, FighterStatsLookup, Id } from '@/domain';
import { CANONICAL_ROOM_MARKERS } from '@/domain';
import { nextTokenScale, TOKEN_STAMP_COLORS, tokenSizeFittingGrid, VEIL_DEFAULT_CELLS } from '@/domain/battle';
import { combatHpForToken } from '@/domain/battle/board';
import { modulePath } from '@/app/routes';
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
import { pointInRect } from '@/domain/battle/pointerFrame';
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
import { getAnyArtifact } from '@/db/artifactRepo';
import { useImageUrl } from '@/features/images/use-image-url';
import { spawnRosterInstance } from '@/db/battleSeed';
import { runBattle } from '@/features/play/run-battle';
import { formatDateTime } from '@/lib/format';
import { NpcCard } from '../artifact-cards';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { DiceRoller } from '@/features/dice/DiceRoller';
import type { DiceRollResult, RollIntent } from '@/features/dice/types';
import { useBattleState } from './use-battle';
import { InitiativeSidebar } from './initiative-sidebar';
import { Button } from '@/components/ui/button';
import { toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * The table surface (09-MILESTONE-5 M5-D): a full-screen dark board rendered
 * from the live battle row. Player-safe contract (binding):
 *
 * - The surface renders ONLY the board — map, grid, tokens, veils, staging
 *   ground, initiative sidebar, HP meters, downed overlay. No artifact
 *   bodies, no stat text, no GM-only material anywhere in the DOM.
 * - Veils tint the map at ~10% in BOTH views; they never blind the GM. In
 *   player view, mob tokens under a veil/fog are REMOVED from the DOM (not
 *   dimmed) and pruned from initiative — that IS the hiding mechanic; PCs
 *   and other tokens are never coverage-hidden and render above the veil.
 *   `visible: false` tokens are removed in both views. The GM view sees
 *   everything under its own veils.
 * - Token tap shows name + image + HP only (full inspection happens back on
 *   the GM view, never here).
 *
 * Interactions: drag with a local live position + a single repo commit on
 * release (8px SCREEN-space tap threshold — client px, so the tap window does
 * not scale with zoom); pan from the letterbox, the map image, or the content
 * frame; wheel/button/pinch pan-zoom; veil add/resize;
 * stage set/reset; gated initiative reconcile; HP floats writing to the
 * token (NPC) or the pc artifact (PC).
 *
 * Frames (the bug family this file guards against): the pan/zoom transform
 * lives on the background wrapper and the aspect-fitted CONTENT div inside it
 * letterboxes, so EVERYTHING piece-related converts/measures against the
 * content div — pointers via its post-transform rect (bakes pan/zoom/
 * letterbox in), px math via its layout size — never the outer container.
 */

/**
 * Entrance glyph rotation (entrance/exit spawn zones, doc 11): the base glyph
 * points down (south), i.e. 0deg for a north-side entrance whose inward
 * direction is south.
 */
const ENTRANCE_ROTATION = { north: 0, east: 90, south: 180, west: 270 } as const;

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
  /** Screen-space (client px) distance from the pointer-down origin — the
   * tap/drag threshold must not scale with zoom. */
  movedPx: number;
  startClientX: number;
  startClientY: number;
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
  const [selectedEffectId, setSelectedEffectId] = useState<BattleEffect['id'] | null>(null);
  // GM-only room-key marker selection (owner-ratified room-keys/treasure
  // arc): the layout-room id whose key card shows in the rail.
  const [selectedKeyRoomId, setSelectedKeyRoomId] = useState<string | null>(null);
  const [playerSafe, setPlayerSafe] = useState(false);
  const [stageArmed, setStageArmed] = useState(false);
  const [reseedArmed, setReseedArmed] = useState(false);
  // The dice roller's open state IS the pending roll intent (M5-D amendment);
  // the roll target is captured at open time so a mid-roll deselect cannot
  // misdirect the applied delta.
  const [diceIntent, setDiceIntent] = useState<RollIntent | null>(null);
  const pendingRollRef = useRef<{ tokenId: BattleTokenId; kind: 'damage' | 'heal' } | null>(null);
  const [, setEpochTick] = useState(initiativeDragEpoch());
  const boardRef = useRef<HTMLDivElement | null>(null);
  // The aspect-fitted content div tokens/veils are %-positioned in — both the
  // pointer frame (post-transform rect) and the px frame (layout size) for
  // snapping/thresholds/coverage. The outer container letterboxes it.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [contentSize, setContentSize] = useState({ w: 0, h: 0 });
  const openedLiveRef = useRef(false);
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const pinchRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchBaseRef = useRef<{ distance: number; zoom: number } | null>(null);

  const { battle, stats, coveredTokenIds, artifacts } = useBattleState(
    campaignId,
    moduleId,
    contentSize.w,
    contentSize.h,
  );

  const mapImageId = battle?.board.mapImageId ?? null;
  const mapImage = useLiveQuery(
    async () => (mapImageId === null ? undefined : artifactImageById(mapImageId)),
    [mapImageId],
    undefined,
  );

  // The seeding encounter (provenance): 'loading' until the query resolves,
  // null when the battle has no provenance, undefined when the artifact id
  // is set but the artifact is gone (deleted encounters scrub their tokens;
  // the row's provenance stays loud).
  const encounterArtifactId = battle?.encounterArtifactId ?? null;
  const encounterArtifact = useLiveQuery(
    async () => (encounterArtifactId === null ? null : getAnyArtifact(encounterArtifactId)),
    [encounterArtifactId],
    'loading' as const,
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

  // Track the content div's layout px size (snapping/coverage/veil sizing
  // need the frame the %-positioned pieces actually resolve against — under
  // letterbox it differs from the container). ResizeObserver reports the
  // untransformed layout box, which is exactly that frame.
  useEffect(() => {
    if (!boardMounted) return undefined;
    const element = contentRef.current;
    if (element === null) return undefined;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect !== undefined && (rect.width !== contentSize.w || rect.height !== contentSize.h)) {
        setContentSize({ w: rect.width, h: rect.height });
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
    // contentSize is intentionally not a dependency (would loop on every resize).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardMounted]);

  // Entering the surface puts the battle on the table (once per mount):
  // live: true, and the first-entry reveal — the source's `liveBoard` rule
  // (artifact-backed tokens and stamps become visible on the table; prep
  // scratch keeps them hidden). The reveal is spent exactly once per seed
  // (`everLive`): a Lift → re-enter cycle resumes the board verbatim instead
  // of re-revealing tokens the GM deliberately hid (encounter-resume arc).
  useEffect(() => {
    if (battle === undefined || openedLiveRef.current || battle.board.live) return;
    openedLiveRef.current = true;
    const firstEntry = !battle.board.everLive;
    const tokens = firstEntry
      ? battle.board.tokens.map((token) => ({ ...token, visible: true }))
      : battle.board.tokens;
    void saveBattleBoard(battle.id, { ...battle.board, live: true, everLive: true, tokens }).catch(
      (error: unknown) => {
        toastError('Could not show the battle', error);
      },
    );
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
    mapLayout !== null && contentSize.w > 0
      ? contentSize.w / mapLayout.cols
      : battle === undefined
        ? 72
        : veilCellPx(battle.board.gridSize, battle.board.tokenSize);
  const cellHeightPx =
    mapLayout !== null && contentSize.h > 0 ? contentSize.h / mapLayout.rows : cellWidthPx;
  const aspect =
    mapLayout !== null
      ? mapLayout.cols / mapLayout.rows
      : mapImage === undefined
        ? 16 / 9
        : mapImage.width / mapImage.height;

  useEffect(() => {
    // The `live` guard also prevents a mount-time lost update: this effect and
    // the first-entry reveal above both write the full board. On the prep row
    // (live: false) the auto-fit write would queue after the reveal write from
    // the same stale row and overwrite it — PC tokens (seeded hidden, revealed
    // only by that write) would never appear, and `everLive` would make the
    // loss permanent. Waiting for the live flip re-runs this effect on the
    // revealed row; a resumed battle (live: true) re-captures immediately.
    if (battle === undefined || !battle.board.live || mapLayout === null || contentSize.w <= 0 || contentSize.h <= 0) return;
    const desired = tokenSizeFittingGrid(Math.max(1, Math.floor(Math.min(cellWidthPx, cellHeightPx))));
    if (desired === battle.board.tokenSize) return;
    void commit((board) => ({ ...board, tokenSize: desired }));
  }, [battle, mapLayout, contentSize.w, contentSize.h, cellWidthPx, cellHeightPx, commit]);

  const displayedTokens = useMemo(() => {
    if (battle === undefined) return [];
    const drag = liveDrag;
    // Coverage REMOVES tokens from the DOM in player view only — and
    // coveredTokenIds holds mob tokens only (use-battle scopes it: PCs and
    // other tokens are never coverage-hidden). The GM sees everything under
    // their own veils.
    return battle.board.tokens
      .filter((token) => token.visible && (!playerSafe || !coveredTokenIds.has(token.id)))
      .map((token) => (drag !== null && token.id === drag.tokenId ? { ...token, x: drag.x, y: drag.y } : token));
  }, [battle, liveDrag, coveredTokenIds, playerSafe]);

  // Same live-render contract as displayedTokens: a dragged veil follows the
  // pointer in local state (persisted exactly once on release).
  const displayedVeils = useMemo(() => {
    if (battle === undefined) return [];
    const drag = liveDrag;
    if (drag?.tokenId.startsWith('veil:') !== true) return battle.board.veils;
    const veilId = drag.tokenId.slice('veil:'.length);
    return battle.board.veils.map((veil) =>
      veil.id === veilId ? { ...veil, x: drag.x, y: drag.y } : veil,
    );
  }, [battle, liveDrag]);

  // Effect markers (D7): the same live-render contract — and NO player-safe
  // filter: effects are showpieces, board material in BOTH views.
  const displayedEffects = useMemo(() => {
    if (battle === undefined) return [];
    const drag = liveDrag;
    if (drag?.tokenId.startsWith('effect:') !== true) return battle.board.effects;
    const effectId = drag.tokenId.slice('effect:'.length);
    return battle.board.effects.map((effect) =>
      effect.id === effectId ? { ...effect, x: drag.x, y: drag.y } : effect,
    );
  }, [battle, liveDrag]);

  const artifactById = useMemo(() => new Map(artifacts.map((entry) => [entry.id, entry])), [artifacts]);
  const selectedToken = displayedTokens.find((token) => token.id === selectedTokenId) ?? null;
  const selectedEffect = battle?.board.effects.find((effect) => effect.id === selectedEffectId) ?? null;

  function boardPointFromEvent(event: { clientX: number; clientY: number }): { x: number; y: number } {
    // Convert against the CONTENT element's post-transform rect: it bakes the
    // pan/zoom transform (which lives on the background wrapper) and the
    // aspect-fit letterbox in, matching the %-positioned tokens and veils.
    // The outer container's rect would drift by (s−c)(1−1/zoom) + pan/zoom
    // plus the letterbox offset. The rect already includes pan/zoom — never
    // re-apply them here (double-application).
    const rect = contentRef.current?.getBoundingClientRect();
    if (rect === undefined) {
      throw new Error('Board content frame missing — cannot convert pointer coordinates');
    }
    return pointInRect(event.clientX, event.clientY, rect);
  }

  function snapPoint(x: number, y: number, spanCells: { x: number; y: number }): { x: number; y: number } {
    const grid = battle?.board.gridSize;
    if (battle === undefined || contentSize.w === 0) return { x, y };
    if (battle.board.mapLayout === null && (grid === undefined || grid === null)) return { x, y };
    if (battle.board.mapLayout !== null) {
      return {
        x: snapAxisToLayoutGrid(x, battle.board.mapLayout.cols, spanCells.x),
        y: snapAxisToLayoutGrid(y, battle.board.mapLayout.rows, spanCells.y),
      };
    }
    return {
      x: snapAxisToGrid(x, contentSize.w, cellWidthPx, spanCells.x),
      y: snapAxisToGrid(y, contentSize.h, cellHeightPx, spanCells.y),
    };
  }

  // --- Pointer handling ------------------------------------------------------

  function onBoardPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    // Two fingers → pinch; one finger on any non-piece surface → pan: the
    // letterbox background, the map image itself, or the content frame (the
    // map is the background layer — M5-D amendment; before it, a drag on the
    // map did nothing). Token/veil pointerdowns stop propagation, so pieces
    // never reach this handler.
    pinchRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinchRef.current.size === 2) {
      panRef.current = null;
      return;
    }
    const target = event.target as HTMLElement;
    if (
      event.target === event.currentTarget ||
      target.dataset.boardBackground === 'true' ||
      target.dataset.boardContent === 'true'
    ) {
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
    // Background tap (down→up within the screen-space threshold) clears the
    // selection — tapping empty board is a deselect, not just a no-op pan.
    // Pan gestures (≥ threshold) keep it. Token/veil pointerdowns stop
    // propagation, so panRef is only set from the background.
    const down = panRef.current;
    if (
      down !== null &&
      down.pointerId === event.pointerId &&
      Math.hypot(event.clientX - down.startX, event.clientY - down.startY) < DRAG_THRESHOLD_PX
    ) {
      setSelectedTokenId(null);
      setSelectedVeilId(null);
      setSelectedEffectId(null);
      setSelectedKeyRoomId(null);
    }
    pinchRef.current.delete(event.pointerId);
    if (pinchRef.current.size < 2) pinchBaseRef.current = null;
    panRef.current = null;
  }

  function startTokenDrag(event: React.PointerEvent<HTMLDivElement>, token: BattleToken): void {
    event.stopPropagation();
    if (playerSafe) {
      // Player-safe tap: selection ONLY — the name+image+HP card (the M5-D
      // token-tap contract). No capture, no live drag, no commit: moving
      // pieces stays GM-only.
      setSelectedTokenId(token.id);
      setSelectedVeilId(null);
      return;
    }
    // Pointer capture is a browser nicety; jsdom (tests) lacks it.
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    beginBoardGesture();
    setLiveDrag({
      tokenId: token.id,
      x: token.x,
      y: token.y,
      movedPx: 0,
      startClientX: event.clientX,
      startClientY: event.clientY,
    });
  }

  function moveTokenDrag(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = liveDrag;
    if (drag === null) return;
    const at = boardPointFromEvent(event);
    // Screen-space threshold: client px from the down origin, so the 8px tap
    // window is zoom-invariant (a board-frame distance would shrink/grow it
    // with zoom — micro-drags when zoomed in, dead taps when zoomed out).
    const movedPx = Math.max(
      drag.movedPx,
      Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY),
    );
    setLiveDrag({ ...drag, x: at.x, y: at.y, movedPx });
  }

  function finishTokenDrag(): void {
    const drag = liveDrag;
    setLiveDrag(null);
    if (drag === null) return;
    // Paired with the begin in startTokenDrag — a pointerup without a begun
    // gesture (player-safe tap, stray release) must not end one.
    endBoardGesture();
    if (drag.movedPx < DRAG_THRESHOLD_PX) {
      // Tap: select (player-safe tap shows name/image/HP only).
      setSelectedTokenId(drag.tokenId);
      setSelectedVeilId(null);
      return;
    }
    const span = tokenSpanCells(
      battle?.board.tokens.find((entry) => entry.id === drag.tokenId)?.scale ?? 1,
    );
    const snapped = snapPoint(drag.x, drag.y, { x: span, y: span });
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
    setLiveDrag({
      tokenId: `veil:${veil.id}`,
      x: veil.x,
      y: veil.y,
      movedPx: 0,
      startClientX: event.clientX,
      startClientY: event.clientY,
    });
    setSelectedVeilId(veil.id);
    setSelectedTokenId(null);
  }

  function moveVeilDrag(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = liveDrag;
    if (drag?.tokenId.startsWith('veil:') !== true) return;
    const at = boardPointFromEvent(event);
    // Screen-space threshold, same as tokens (see moveTokenDrag).
    const movedPx = Math.max(
      drag.movedPx,
      Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY),
    );
    setLiveDrag({ ...drag, x: at.x, y: at.y, movedPx });
  }

  function finishVeilDrag(): void {
    const drag = liveDrag;
    setLiveDrag(null);
    if (drag?.tokenId.startsWith('veil:') !== true) return;
    // Paired with the begin in startVeilDrag (same rule as finishTokenDrag).
    endBoardGesture();
    const veilId = drag.tokenId.slice('veil:'.length);
    if (drag.movedPx < DRAG_THRESHOLD_PX) return;
    // VEIL/TOKEN PARITY (pinned by test): veils snap on drop exactly like
    // tokens — the center quantizes to a widthCells×heightCells grid block,
    // which lands the veil's EDGES on cell boundaries and matches the
    // cell-quantized resize math (resizeVeilFromEdge). An unsnapped commit
    // was the inconsistency, not a choice.
    const veil = battle?.board.veils.find((entry) => entry.id === veilId);
    const snapped = snapPoint(drag.x, drag.y, {
      x: veil?.widthCells ?? 1,
      y: veil?.heightCells ?? 1,
    });
    void commit((board) => ({
      ...board,
      veils: board.veils.map((veil) => (veil.id === veilId ? { ...veil, x: snapped.x, y: snapped.y } : veil)),
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
        contentSize.w,
        contentSize.h,
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

  // --- Effect-marker gestures (D7): the veil drag contract, keyed 'effect:' —
  // scenery lock gates the move exactly like veils/stamps; rendering stays in
  // BOTH views (no playerSafe gate on the pointer handlers' visual result).

  function startEffectDrag(event: React.PointerEvent<HTMLDivElement>, effect: BattleEffect): void {
    if (playerSafe || battle?.board.sceneryMovementLocked === true) return;
    event.stopPropagation();
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    beginBoardGesture();
    setLiveDrag({
      tokenId: `effect:${effect.id}`,
      x: effect.x,
      y: effect.y,
      movedPx: 0,
      startClientX: event.clientX,
      startClientY: event.clientY,
    });
    setSelectedEffectId(effect.id);
    setSelectedTokenId(null);
    setSelectedVeilId(null);
  }

  function moveEffectDrag(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = liveDrag;
    if (drag?.tokenId.startsWith('effect:') !== true) return;
    const at = boardPointFromEvent(event);
    const movedPx = Math.max(
      drag.movedPx,
      Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY),
    );
    setLiveDrag({ ...drag, x: at.x, y: at.y, movedPx });
  }

  function finishEffectDrag(): void {
    const drag = liveDrag;
    setLiveDrag(null);
    if (drag?.tokenId.startsWith('effect:') !== true) return;
    endBoardGesture();
    const effectId = drag.tokenId.slice('effect:'.length);
    if (drag.movedPx < DRAG_THRESHOLD_PX) return;
    // Same drop rule as veils/tokens: the center quantizes to the effect's
    // own sizeCells span, so its edges land on cell boundaries (D7:
    // geometry is layout-anchored, never screen pixels).
    const effect = battle?.board.effects.find((entry) => entry.id === effectId);
    const snapped = snapPoint(drag.x, drag.y, { x: effect?.sizeCells ?? 1, y: effect?.sizeCells ?? 1 });
    void commit((board) => ({
      ...board,
      effects: board.effects.map((entry) =>
        entry.id === effectId ? { ...entry, x: snapped.x, y: snapped.y } : entry,
      ),
    }));
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

  /** Geometric effect marker (D7): spawns at the board center, one cell
   * across, first stamp color — then the GM drags/resizes it like any piece. */
  function addEffect(shape: BattleEffectShape): void {
    if (battle === undefined) return;
    const color = TOKEN_STAMP_COLORS[0];
    if (color === undefined) throw new Error('TOKEN_STAMP_COLORS is empty');
    const effect: BattleEffect = {
      id: crypto.randomUUID(),
      shape,
      x: 0.5,
      y: 0.5,
      sizeCells: 1,
      color,
      label: '',
    };
    void commit((board) => ({ ...board, effects: [...board.effects, effect] }));
    setSelectedEffectId(effect.id);
    setSelectedTokenId(null);
    setSelectedVeilId(null);
  }

  /** Cell-quantized resize of the selected effect (min one cell). */
  function resizeEffect(effectId: BattleEffect['id'], delta: -1 | 1): void {
    void commit((board) => ({
      ...board,
      effects: board.effects.map((effect) =>
        effect.id === effectId
          ? { ...effect, sizeCells: Math.max(1, effect.sizeCells + delta) }
          : effect,
      ),
    }));
  }

  /** Mid-fight spawn (M5-C addition): appends one instance of the provenance
   * roster entry through the shared seed path; statless instances toast
   * loudly (AGENTS rule 1 — no placeholder numbers). */
  async function spawnMonster(entryIndex: number): Promise<void> {
    if (battle === undefined) return;
    try {
      const result = await spawnRosterInstance(battle.id, entryIndex);
      if (result.statless.length > 0) {
        toastError(
          `No combat stats for: ${result.statless.join('; ')} — they will not roll initiative`,
        );
      }
    } catch (error) {
      toastError('Could not spawn from the roster', error);
    }
  }

  async function applyHp(token: BattleToken, delta: number): Promise<boolean> {
    if (battle === undefined || token.artifactId === null) return false;
    const resolved = combatHpForToken(token, stats);
    if (resolved === null) {
      toastError(`No combat stats for “${token.label}” — HP cannot change`);
      return false;
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
      return true;
    } catch (error) {
      toastError('Could not update HP', error);
      return false;
    }
  }

  /** A settled dice roll becomes the applied HP delta, signed by the intent
   * captured at open time (damage ⇒ −|total|, heal ⇒ +|total|). */
  async function applyDiceRoll(result: DiceRollResult): Promise<void> {
    const pending = pendingRollRef.current;
    if (pending === null || battle === undefined) return;
    const token = battle.board.tokens.find((entry) => entry.id === pending.tokenId);
    if (token === undefined) {
      toastError(`Could not apply ${result.summary} — the fighter left the board`);
      pendingRollRef.current = null;
      return;
    }
    const delta = pending.kind === 'damage' ? -Math.abs(result.total) : Math.abs(result.total);
    const applied = await applyHp(token, delta);
    pendingRollRef.current = null;
    if (applied) {
      toast.success(
        `${token.label} ${delta < 0 ? '−' : '+'}${String(Math.abs(delta))} HP (${result.summary})`,
      );
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
    // Deterministic exit: always the module reader, never history-dependent
    // (deep links to the battle must not strand the user in an arbitrary tab).
    navigate(modulePath(campaignId, moduleId));
  }

  /** Destructive re-seed (encounter-resume arc): replaces the running board
   * from the row's own provenance encounter. The fresh row is prep scratch
   * again — re-arm the first-entry reveal so the table goes live with the
   * seeded layout immediately, and drop stale piece selections. */
  async function reseedFromEncounter(): Promise<void> {
    if (battle === undefined) return;
    if (battle.encounterArtifactId === null) return;
    // `?.kind` absorbs every sentinel — 'loading' (string), null, undefined.
    if (encounterArtifact === 'loading' || encounterArtifact?.kind !== 'encounter') {
      return;
    }
    const report = await runBattle(campaignId, moduleId, encounterArtifact, {
      successTitle: `Board re-seeded from “${encounterArtifact.name}”`,
      failureTitle: 'Could not re-seed the battle',
    });
    if (report === null) return;
    openedLiveRef.current = false;
    setSelectedTokenId(null);
    setSelectedVeilId(null);
  }

  // Room keys + dungeon path (owner-ratified; docs/11 D11/D13): derived,
  // never stamped — the seeding encounter's CURRENT layout is the live
  // source of truth, so re-seeding or editing keys is reflected without
  // touching the board. Key markers sit at each room's mobsRect CENTER (the
  // room's own floor, never the board center). Only rooms that actually
  // carry key content get a marker; letters fall back to the canonical
  // sequence by room index.
  const provenanceLayout = useMemo(() => {
    if (encounterArtifact === 'loading' || encounterArtifact === null || encounterArtifact === undefined) return null;
    if (encounterArtifact.kind !== 'encounter') return null;
    // Legacy encounter rows (written before layouts existed and never
    // rewritten) read `layout` as undefined despite the `| null` type —
    // the schema's `.default(null)` only materializes on parse. Treat the
    // absent key exactly like the declared null: a layoutless encounter.
    if (encounterArtifact.data.layout == null) return null;
    return encounterArtifact.data.layout;
  }, [encounterArtifact]);
  // `?.kind` absorbs every sentinel ('loading' string, null, undefined).
  const siteShape =
    encounterArtifact !== 'loading' && encounterArtifact?.kind === 'encounter'
      ? encounterArtifact.data.siteShape
      : 'single';
  const layoutRooms = useMemo(() => {
    if (provenanceLayout === null) return [];
    return provenanceLayout.rooms.map((room, index) => ({
      room,
      letter: room.letter ?? CANONICAL_ROOM_MARKERS[index]?.letter ?? String(index + 1),
      marker: {
        x: (room.mobsRect.x + room.mobsRect.w / 2) / provenanceLayout.gridW,
        y: (room.mobsRect.y + room.mobsRect.h / 2) / provenanceLayout.gridH,
      },
    }));
  }, [provenanceLayout]);
  const keyedRooms = useMemo(
    () => layoutRooms.filter((entry) => entry.room.key !== '' || entry.room.keyTreasure !== ''),
    [layoutRooms],
  );
  // The Path rail (complex sites, GM-only advisory aid): rooms in the
  // layout's stored path order (the room-array order is the fallback —
  // packAttempt rotates rooms, so the array cannot be trusted). The CURRENT
  // room is the revealed frontier: the last path room whose veil is lifted.
  const pathRooms = useMemo(() => {
    if (provenanceLayout === null) return [];
    const ids = provenanceLayout.path ?? provenanceLayout.rooms.map((room) => room.id);
    const byId = new Map(layoutRooms.map((entry) => [entry.room.id, entry]));
    return ids.flatMap((id) => {
      const entry = byId.get(id);
      return entry === undefined ? [] : [entry];
    });
  }, [provenanceLayout, layoutRooms]);
  const veiledRoomIds = useMemo(
    () => new Set((battle?.board.veils ?? []).map((veil) => veil.id)),
    [battle],
  );
  const currentPathIndex = useMemo(() => {
    let current = 0;
    pathRooms.forEach((entry, index) => {
      if (!veiledRoomIds.has(entry.room.id)) current = index;
    });
    return current;
  }, [pathRooms, veiledRoomIds]);
  const nextVeiledRoom =
    pathRooms.find((entry) => veiledRoomIds.has(entry.room.id)) ?? null;
  const selectedKeyRoom = keyedRooms.find((entry) => entry.room.id === selectedKeyRoomId) ?? null;

  if (battle === undefined) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 bg-zinc-950 text-zinc-300"
        data-testid="battle-surface-empty"
      >
        <p>No battle is seeded for this module yet.</p>
        <p className="text-sm text-zinc-500">
          Open an encounter card in the module reader or the encounter editor and press “Run battle”
          first.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            navigate(modulePath(campaignId, moduleId));
          }}
        >
          Back to module
        </Button>
      </div>
    );
  }

  const board = battle.board;
  const turnTokenId = activeInitiativeTokenId(board);
  // Provenance narrowing: 'loading' and no-provenance (null) render nothing;
  // a set id whose artifact is gone stays loud.
  const provenanceEncounter =
    encounterArtifact === 'loading' || encounterArtifact === null ? null : encounterArtifact;
  const spawnSource =
    provenanceEncounter === null || provenanceEncounter === undefined
      ? null
      : provenanceEncounter.kind === 'encounter'
        ? provenanceEncounter
        : null;
  const reseed = battle.reseed ?? null;
  // Spawn source (M5-C addition): mid-fight spawn draws from the PROVENANCE
  // encounter's roster — only a real, loaded encounter artifact offers it
  // ('loading' and a missing artifact spawn nothing; the provenance rail
  // above stays loud for the missing case).
  // The px frame tokens/veils resolve against: the content div, not the
  // container (under letterbox the two differ — the %-denominator must match
  // what the browser resolves the % against).
  const contentPx = { w: contentSize.w, h: contentSize.h };
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
        <Button size="sm" variant="outline" onClick={() => {
          addEffect('disc');
        }} disabled={playerSafe} data-testid="add-effect-disc">
          Disc
        </Button>
        <Button size="sm" variant="outline" onClick={() => {
          addEffect('square');
        }} disabled={playerSafe} data-testid="add-effect-square">
          Square
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
        {battle.encounterArtifactId !== null ? (
          reseedArmed ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                data-testid="confirm-reseed"
                onClick={() => {
                  setReseedArmed(false);
                  void reseedFromEncounter();
                }}
              >
                <SwordsIcon aria-hidden data-icon="inline-start" />
                Confirm re-seed
              </Button>
              <Button size="sm" variant="ghost" onClick={() => {
                setReseedArmed(false);
              }}>
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={playerSafe}
              data-testid="reseed-battle"
              onClick={() => {
                setReseedArmed(true);
              }}
            >
              <SwordsIcon aria-hidden data-icon="inline-start" />
              Re-seed
            </Button>
          )
        ) : null}
        <span className="mx-1 h-5 w-px bg-white/10" />
        <Button
          size="sm"
          variant="ghost"
          data-testid="player-safe-toggle"
          aria-pressed={playerSafe}
          onClick={() => {
            setPlayerSafe((value) => !value);
            setDiceIntent(null);
            pendingRollRef.current = null;
            // A GM-only key card must not survive into player view — and
            // coming back re-shows a fresh selection, not a stale one.
            setSelectedKeyRoomId(null);
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
              ref={contentRef}
              data-board-content="true"
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{ width: '100%', aspectRatio: String(aspect), maxWidth: '100%' }}
            >
              {/* Map (or viewport board) — both are pan-start surfaces */}
              {mapImage !== undefined ? (
                <MapLayer imageId={mapImage.id} />
              ) : (
                <div
                  data-board-background="true"
                  className="absolute inset-0 bg-[radial-gradient(circle_at_center,#27272a_0%,#18181b_100%)]"
                />
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
              {/* Entrance zone (board material — visible in player view):
                  the party's way in, one map cell with an inward triangle. */}
              {(board.entrance ?? null) !== null && board.mapLayout !== null && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute flex items-center justify-center border border-emerald-400/50 bg-emerald-400/10"
                  style={{
                    left: `${String((board.entrance?.x ?? 0) * 100 - 50 / board.mapLayout.cols)}%`,
                    top: `${String((board.entrance?.y ?? 0) * 100 - 50 / board.mapLayout.rows)}%`,
                    width: `${String(100 / board.mapLayout.cols)}%`,
                    height: `${String(100 / board.mapLayout.rows)}%`,
                  }}
                  data-testid="battle-entrance"
                >
                  <div
                    style={{
                      width: 0,
                      height: 0,
                      borderLeft: `${String(Math.max(6, cellWidthPx * 0.28))}px solid transparent`,
                      borderRight: `${String(Math.max(6, cellWidthPx * 0.28))}px solid transparent`,
                      borderTop: `${String(Math.max(10, cellHeightPx * 0.44))}px solid #34d399`,
                      transform: `rotate(${String(ENTRANCE_ROTATION[board.entrance?.side ?? 'north'])}deg)`,
                    }}
                  />
                </div>
              )}
              {/* Room-key markers (owner-ratified, GM view only): one
                  tappable badge per keyed room at its mobsRect CENTER (D11
                  fix — the marker sits on the room's own floor, not the
                  board center). They render BEFORE the veils so a covered
                  room hides its key marker exactly like it hides its mobs —
                  key content is GM-only text and never mounts in player
                  view. */}
              {!playerSafe &&
                hasRealSize &&
                keyedRooms.map(({ room, letter, marker }) => (
                  <button
                    key={room.id}
                    type="button"
                    aria-label={`Room key ${letter} — ${room.name}`}
                    data-testid={`room-key-marker-${letter}`}
                    className="absolute z-10 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-amber-300/70 bg-amber-950/85 text-xs font-bold text-amber-200"
                    style={{
                      left: `${String(marker.x * 100)}%`,
                      top: `${String(marker.y * 100)}%`,
                    }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedKeyRoomId(room.id);
                    }}
                  >
                    {letter}
                  </button>
                ))}
              {/* Veils — UNDER the tokens: covered mob tokens are removed in
                  player view, and every token that survives (PCs, other
                  tokens, GM-view mobs) must render ABOVE the veil. */}
              {displayedVeils.map((veil) => (
                <VeilView
                  key={veil.id}
                  veil={veil}
                  content={contentPx}
                  cellWidthPx={cellWidthPx}
                  cellHeightPx={cellHeightPx}
                  selected={veil.id === selectedVeilId}
                  dragging={liveDrag?.tokenId === `veil:${veil.id}`}
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
              {/* Effect markers (D7) — board material in BOTH views, under
                  the tokens so fighters stay readable above the fill. */}
              {displayedEffects.map((effect) => (
                <EffectView
                  key={effect.id}
                  effect={effect}
                  content={contentPx}
                  cellWidthPx={cellWidthPx}
                  cellHeightPx={cellHeightPx}
                  selected={effect.id === selectedEffectId}
                  dragging={liveDrag?.tokenId === `effect:${effect.id}`}
                  draggable={!playerSafe && !board.sceneryMovementLocked}
                  onPointerDown={(event) => {
                    startEffectDrag(event, effect);
                  }}
                  onPointerMove={moveEffectDrag}
                  onPointerUp={finishEffectDrag}
                />
              ))}
              {/* Tokens — covered/hidden are REMOVED in player view, never dimmed */}
              {displayedTokens.map((token) => (
                <TokenView
                  key={token.id}
                  token={token}
                  content={contentPx}
                  tokenSize={board.tokenSize}
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
            </div>
          </div>
          {!hasRealSize && <div className="absolute inset-0" />}
        </div>

        {/* Right rail: provenance + initiative + token controls */}
        <div className="flex w-60 flex-col gap-2 overflow-y-auto border-l border-white/10 bg-black/60 p-2">
          {/* Who/when/what seeded (and last re-seeded) this board — GM view
          only; the player-safe DOM contract carries board material only. */}
          {!playerSafe && battle.encounterArtifactId !== null && (
            <div
              className="rounded-md border border-white/10 bg-zinc-900 p-2 text-xs text-zinc-400"
              data-testid="battle-provenance"
            >
              {provenanceEncounter === undefined ? (
                <p>Seeded encounter no longer exists.</p>
              ) : provenanceEncounter === null ? null : (
                <p className="truncate">Seeded from “{provenanceEncounter.name}”</p>
              )}
              {reseed !== null && (
                <p className="mt-1" data-testid="battle-reseed-line">
                  Re-seeded {formatDateTime(reseed.at)} from “{reseed.encounterName}”
                </p>
              )}
            </div>
          )}
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
          {selectedToken !== null && (
            <SelectionCard
              token={selectedToken}
              artifact={
                selectedToken.artifactId === null
                  ? undefined
                  : artifactById.get(selectedToken.artifactId)
              }
              stats={stats}
              playerSafe={playerSafe}
            />
          )}
          {/* Dungeon Path rail (docs/11 D11, complex sites, GM-only): an
              ADVISORY aid for sequential play — rooms in path order with the
              revealed frontier highlighted. No locks, no initiative resets:
              "Reveal next room" just lifts the next veiled path room's veil
              exactly like a manual GM lift would; the latecomer auto-roll
              stays an editable aid. */}
          {!playerSafe && siteShape === 'complex' && pathRooms.length > 0 && (
            <div
              className="flex flex-col gap-1 rounded-md border border-sky-300/30 bg-zinc-900 p-2"
              data-testid="path-rail"
            >
              <p className="text-sm font-medium text-sky-200">Dungeon path</p>
              <div className="flex flex-wrap gap-1">
                {pathRooms.map(({ room, letter }, index) => (
                  <button
                    key={room.id}
                    type="button"
                    aria-label={`Path room ${String(index + 1)} — ${room.name}${veiledRoomIds.has(room.id) ? ' (veiled)' : ''}`}
                    data-testid={`path-room-${String(index + 1)}`}
                    className={
                      veiledRoomIds.has(room.id)
                        ? 'rounded border border-zinc-700 px-1.5 py-0.5 text-xs text-zinc-400'
                        : 'rounded border border-sky-400/60 px-1.5 py-0.5 text-xs text-sky-100'
                    }
                    onClick={() => {
                      setSelectedKeyRoomId(room.id);
                    }}
                  >
                    {String(index + 1)}. {letter} · {room.name}
                    {index === currentPathIndex ? ' ◂' : ''}
                  </button>
                ))}
              </div>
              <Button
                size="xs"
                variant="outline"
                className="self-start"
                disabled={nextVeiledRoom === null}
                data-testid="reveal-next-room"
                onClick={() => {
                  if (nextVeiledRoom === null) return;
                  const roomId = nextVeiledRoom.room.id;
                  void commit((current) => ({
                    ...current,
                    veils: current.veils.filter((veil) => veil.id !== roomId),
                  }));
                }}
              >
                Reveal next room
              </Button>
            </div>
          )}
          {!playerSafe && selectedKeyRoom !== null && (
            <div
              className="flex flex-col gap-1 rounded-md border border-amber-300/30 bg-zinc-900 p-2"
              data-testid="room-key-card"
            >
              <p className="text-sm font-medium text-amber-200">
                Room {selectedKeyRoom.letter} — {selectedKeyRoom.room.name}
              </p>
              {selectedKeyRoom.room.key !== '' ? (
                <p className="whitespace-pre-line text-xs text-zinc-300" data-testid="room-key-text">
                  {selectedKeyRoom.room.key}
                </p>
              ) : (
                <p className="text-xs italic text-zinc-500">No key written for this room yet.</p>
              )}
              {selectedKeyRoom.room.keyTreasure !== '' && (
                <div className="mt-1 border-t border-white/10 pt-1">
                  <p className="text-xs font-medium text-zinc-400">Room treasure</p>
                  <p className="whitespace-pre-line text-xs text-zinc-300" data-testid="room-key-treasure">
                    {selectedKeyRoom.room.keyTreasure}
                  </p>
                </div>
              )}
            </div>
          )}
          {selectedToken !== null && !playerSafe && (
            <TokenControls
              token={selectedToken}
              stats={stats}
              onApplyHp={(delta) => {
                void applyHp(selectedToken, delta);
              }}
              onRollHp={(kind) => {
                pendingRollRef.current = { tokenId: selectedToken.id, kind };
                setDiceIntent({ kind, subject: selectedToken.label });
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
          {selectedEffect !== null && !playerSafe && (
            <div className="flex gap-1" data-testid="effect-controls">
              <Button
                size="sm"
                variant="outline"
                className="flex-1"
                aria-label="Grow effect"
                data-testid="grow-effect"
                onClick={() => {
                  resizeEffect(selectedEffect.id, 1);
                }}
              >
                <PlusIcon aria-hidden />
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="flex-1"
                aria-label="Shrink effect"
                data-testid="shrink-effect"
                disabled={selectedEffect.sizeCells <= 1}
                onClick={() => {
                  resizeEffect(selectedEffect.id, -1);
                }}
              >
                <MinusIcon aria-hidden />
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="flex-1 text-destructive"
                aria-label="Delete effect"
                data-testid="delete-effect"
                onClick={() => {
                  void commit((current) => ({
                    ...current,
                    effects: current.effects.filter((effect) => effect.id !== selectedEffect.id),
                  }));
                  setSelectedEffectId(null);
                }}
              >
                <TrashIcon aria-hidden />
              </Button>
            </div>
          )}
          {spawnSource !== null && !playerSafe && (
            <div className="rounded-md border border-white/10 bg-zinc-900 p-2" data-testid="spawn-panel">
              <p className="mb-1 text-xs font-medium text-zinc-400">
                Spawn — “{spawnSource.name}”
              </p>
              {spawnSource.data.monsters.length === 0 ? (
                <p className="text-xs text-zinc-500">The seeding encounter has no roster.</p>
              ) : (
                <ul className="space-y-1">
                  {spawnSource.data.monsters.map((entry, index) => (
                    <li
                      key={`${entry.name}:${String(index)}`}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="min-w-0 truncate text-xs">
                        {entry.name} ×{String(entry.count)}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid={`spawn-monster-${String(index)}`}
                        onClick={() => {
                          void spawnMonster(index);
                        }}
                      >
                        Spawn
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {!board.initiativeEnabled && !playerSafe && (
            <p className="text-xs text-zinc-500">
              Enable initiative to roll every visible fighter (d20 + frozen bonus) and cycle turns.
            </p>
          )}
        </div>

        {/* Dice roller (M5-D amendment): GM-only, mounted above the rail so a
        mid-roll deselect cannot unmount it; player-safe mode never renders it. */}
        {!playerSafe && (
          <DiceRoller
            open={diceIntent !== null}
            onOpenChange={(next) => {
              if (!next) setDiceIntent(null);
            }}
            intent={diceIntent ?? undefined}
            onResult={(result) => {
              void applyDiceRoll(result);
            }}
          />
        )}
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

/** The battlemap layer: object-fit cover so the normalized grid matches.
 * The image is a pan-start surface (M5-D amendment): pressing it drags the
 * board exactly like the letterbox background — a drag on the map used to be
 * a dead zone. */
function MapLayer({ imageId }: { imageId: Id }): JSX.Element | null {
  const url = useImageUrl(imageId);
  if (url === null) return null;
  return (
    <img
      src={url}
      alt=""
      className="absolute inset-0 h-full w-full object-cover"
      draggable={false}
      data-board-background="true"
      data-testid="battle-map"
    />
  );
}

interface TokenViewProps {
  token: BattleToken;
  /** Content-div px frame — the %-denominator for size/position. */
  content: { w: number; h: number };
  /** The board's token size in content px (cell-filling on layout boards). */
  tokenSize: number;
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
  content,
  tokenSize,
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
  if (content.w === 0 || content.h === 0) return null;
  // Token size: board.tokenSize in content px scaled by token.scale — the
  // content div is the reference frame, so width is a percentage of content
  // width. board.tokenSize is the SAME number the fog-coverage math uses
  // (use-battle), so a rendered token and its coverage rect agree: on layout
  // boards the auto-fit effect keeps it cell-filling (docs/11 §M5-D
  // extension) — the former hardcoded 64px rendered a token the coverage
  // test treated as smaller, so fog edges stopped covering fine-grid tokens.
  const widthPct = ((tokenSize * token.scale) / content.w) * 100;
  const heightPct = ((tokenSize * token.scale) / content.h) * 100;
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
  /** Content-div px frame — the %-denominator for size/position. */
  content: { w: number; h: number };
  cellWidthPx: number;
  cellHeightPx: number;
  selected: boolean;
  dragging: boolean;
  resizable: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  onResize: (edge: VeilEdge, event: React.PointerEvent<HTMLDivElement>) => void;
}

/**
 * A veil/fog rectangle at a ~10% tint, ALWAYS (M5-D amendment 2026-09-06):
 * the veil marks unexplored ground and hides mob tokens in player view — it
 * must not blind the GM to their own map. The fog keeps its light tint and
 * the veil its dark one so the kind stays readable at the same strength.
 * Selection and dragging read via outline + lift (ring / z-20, mirroring the
 * token drag lift) — never opacity swings. The solid amber resize handles
 * carry the resize affordance, so the translucent fill hides nothing.
 */
function VeilView({
  veil,
  content,
  cellWidthPx,
  cellHeightPx,
  selected,
  dragging,
  resizable,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onResize,
}: VeilViewProps): JSX.Element | null {
  if (content.w === 0 || content.h === 0) return null;
  const widthPct = ((veil.widthCells * cellWidthPx) / content.w) * 100;
  const heightPct = ((veil.heightCells * cellHeightPx) / content.h) * 100;
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
        veil.kind === 'fog' ? 'bg-zinc-200/10' : 'bg-black/10',
        (selected || dragging) && 'ring-2 ring-amber-400',
        dragging && 'z-20',
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

interface EffectViewProps {
  effect: BattleEffect;
  content: { w: number; h: number };
  cellWidthPx: number;
  cellHeightPx: number;
  selected: boolean;
  dragging: boolean;
  draggable: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
}

/**
 * A geometric effect marker (D7, encounter-resume arc): a disc or square
 * zone whose fill renders at ~70% transparency (fill alpha 0x4d ≈ 30%,
 * border alpha 0xcc ≈ 80% — static values, never animated: selection reads
 * via outline + lift, the veil contract). Geometry is layout-anchored — the
 * span is `sizeCells` grid cells in the content frame, never screen pixels.
 * Board material: it renders in BOTH GM and player views (the showpiece is
 * FOR the table); the optional label carries no stat text, so the
 * player-safe DOM contract holds.
 */
function EffectView({
  effect,
  content,
  cellWidthPx,
  cellHeightPx,
  selected,
  dragging,
  draggable,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: EffectViewProps): JSX.Element | null {
  if (content.w === 0 || content.h === 0) return null;
  const widthPct = ((effect.sizeCells * cellWidthPx) / content.w) * 100;
  const heightPct = ((effect.sizeCells * cellHeightPx) / content.h) * 100;
  return (
    <div
      className={cn(
        'absolute -translate-x-1/2 -translate-y-1/2 touch-none border-2',
        effect.shape === 'disc' ? 'rounded-full' : 'rounded-sm',
        (selected || dragging) && 'ring-2 ring-amber-400',
        dragging && 'z-20',
        draggable ? 'cursor-grab' : 'cursor-default',
      )}
      style={{
        left: `${String(effect.x * 100)}%`,
        top: `${String(effect.y * 100)}%`,
        width: `${String(widthPct)}%`,
        height: `${String(heightPct)}%`,
        backgroundColor: `${effect.color}4d`,
        borderColor: `${effect.color}cc`,
      }}
      data-testid="battle-effect"
      data-effect-shape={effect.shape}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {effect.label.length > 0 && (
        <span className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-[10px] font-medium text-zinc-100 drop-shadow-[0_1px_1px_rgba(0,0,0,0.9)]">
          {effect.label}
        </span>
      )}
    </div>
  );
}

interface SelectionCardProps {
  token: BattleToken;
  artifact: AnyArtifact | undefined;
  stats: FighterStatsLookup;
  playerSafe: boolean;
}

/**
 * The selected-token card (M5-D token-tap contract): portrait art + label +
 * HP meter, rendered in BOTH modes — it shows only what the board already
 * shows (cover art, label, HP), so the player-safe DOM contract holds. The
 * full artifact card (statblock) is GM-only behind an explicit button and
 * never mounts in player-safe mode.
 */
function SelectionCard({ token, artifact, stats, playerSafe }: SelectionCardProps): JSX.Element {
  const [cardOpen, setCardOpen] = useState(false);
  // Same art path as TokenView/the artifact cards: useImageUrl over the
  // artifact's coverImageId — no new image plumbing.
  const coverImageId = artifact !== undefined && 'coverImageId' in artifact ? artifact.coverImageId : null;
  const url = useImageUrl(coverImageId);
  const resolved = combatHpForToken(token, stats);
  const hpRatio = resolved === null ? null : resolved.maxHp === 0 ? 0 : resolved.currentHp / resolved.maxHp;
  const initials = token.label
    .split(/\s+/u)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
  // Full card: NPC artifacts with a statblock (the shape NpcCard renders).
  // PC artifacts carry their stats in the roster, not on the table.
  const npc = artifact?.kind === 'npc' && artifact.data.statBlock !== null ? artifact : null;
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-white/10 bg-zinc-900 p-2" data-testid="selection-card">
      <div className="flex items-center gap-2">
        {url !== null ? (
          <img
            src={url}
            alt=""
            className="size-12 shrink-0 rounded-md object-cover"
            data-testid="selection-card-portrait"
            draggable={false}
          />
        ) : (
          <span
            className="flex size-12 shrink-0 items-center justify-center rounded-md bg-zinc-700 font-bold text-white"
            data-testid="selection-card-initials"
          >
            {initials}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{token.label}</p>
          {hpRatio !== null && (
            <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-zinc-700" data-testid="selection-card-hp">
              <div
                aria-hidden
                className="h-full bg-emerald-500"
                style={{ width: `${String(Math.min(hpRatio, 1) * 100)}%` }}
              />
            </div>
          )}
        </div>
      </div>
      {/* Mob treasure (owner-ratified): frozen GM-only checklist text from
          the seeding roster — never mounts in player view. */}
      {!playerSafe && token.treasure !== '' && (
        <div className="border-t border-white/10 pt-1" data-testid="token-treasure">
          <p className="text-xs font-medium text-amber-200">Treasure</p>
          <p className="whitespace-pre-line text-xs text-zinc-300">{token.treasure}</p>
        </div>
      )}
      {!playerSafe && npc !== null && (
        <Dialog open={cardOpen} onOpenChange={setCardOpen}>
          <Button
            size="sm"
            variant="outline"
            className="min-h-11"
            data-testid="open-token-card"
            onClick={() => {
              setCardOpen(true);
            }}
          >
            Open card
          </Button>
          <DialogContent>
            <DialogTitle>{npc.name}</DialogTitle>
            <DialogDescription className="sr-only">Full artifact card (GM only)</DialogDescription>
            <NpcCard npc={npc} />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

interface TokenControlsProps {
  token: BattleToken;
  stats: FighterStatsLookup;
  onApplyHp: (delta: number) => void;
  onRollHp: (kind: 'damage' | 'heal') => void;
  onToggleVisibility: () => void;
  onScale: (delta: -1 | 1) => void;
  onRemove: (() => void) | undefined;
}

/** Selected-token floats: HP steppers + dice rolls, visibility, scale,
 * remove. Tablet-first (M5-D amendment): every HP control is a ≥44px button
 * — the typed delta input is gone; arbitrary amounts go through the dice
 * roller's ± steppers. */
function TokenControls({
  token,
  stats,
  onApplyHp,
  onRollHp,
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
      <div className="grid grid-cols-3 gap-1" role="group" aria-label="Quick damage">
        {[10, 5, 1].map((amount) => (
          <Button
            key={`damage-${String(amount)}`}
            size="sm"
            variant="outline"
            className="min-h-11 text-destructive"
            data-testid={`damage-${String(amount)}`}
            aria-label={`Damage ${String(amount)}`}
            onClick={() => {
              onApplyHp(-amount);
            }}
          >
            −{String(amount)}
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-1" role="group" aria-label="Quick heal">
        {[1, 5, 10].map((amount) => (
          <Button
            key={`heal-${String(amount)}`}
            size="sm"
            variant="outline"
            className="min-h-11 text-emerald-400"
            data-testid={`heal-${String(amount)}`}
            aria-label={`Heal ${String(amount)}`}
            onClick={() => {
              onApplyHp(amount);
            }}
          >
            +{String(amount)}
          </Button>
        ))}
      </div>
      <div className="flex gap-1">
        <Button
          size="sm"
          variant="outline"
          className="min-h-11 flex-1"
          data-testid="roll-damage"
          onClick={() => {
            onRollHp('damage');
          }}
        >
          <DicesIcon aria-hidden data-icon="inline-start" />
          Damage
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="min-h-11 flex-1"
          data-testid="roll-heal"
          onClick={() => {
            onRollHp('heal');
          }}
        >
          <DicesIcon aria-hidden data-icon="inline-start" />
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
