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

import type { AnyArtifact, Battle, BattleEffect, BattleEffectShape, BattleToken, BattleTokenId, BattleVeil, FighterStatsLookup, Id, StatBlock } from '@/domain';
import { CANONICAL_ROOM_MARKERS } from '@/domain';
import { nextTokenScale, TOKEN_STAMP_COLORS, tokenSizeFittingGrid, EFFECT_MIN_CELLS, VEIL_DEFAULT_CELLS } from '@/domain/battle';
import { combatHpForToken } from '@/domain/battle/board';
import { resizeEffectFromEdge, type EffectEdge } from '@/domain/battle/effect';
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
import {
  armMoveGesture,
  armPanGesture,
  armResizeGesture,
  armTapGesture,
  GESTURE_TAP_THRESHOLD_PX,
  idleGesture,
  isGestureActive,
  isGestureOwner,
  isGestureTap,
  promoteToPinch,
  resetGesture,
  trackGestureMove,
  type GestureState,
} from '@/domain/battle/gestureMachine';
import { artifactRepo } from '@/db';
import {
  resetBattleToStage,
  saveBattleBoard,
  saveBattleStage,
} from '@/db/battleRepo';
import { getImage } from '@/db/imageRepo';
import { getAnyArtifact } from '@/db/artifactRepo';
import { getChunksByIds } from '@/db/chunkRepo';
import { useImageUrl } from '@/features/images/use-image-url';
import { runBattle } from '@/features/play/run-battle';
import { formatDateTime } from '@/lib/format';
import { NpcCard } from '../artifact-cards';
import { StatBlockCard } from '@/features/campaign/components/stat-block';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { DiceRoller } from '@/features/dice/DiceRoller';
import type { DiceRollResult, RollIntent } from '@/features/dice/types';
import { useBattleState } from './use-battle';
import { InitiativeSidebar } from './initiative-sidebar';
import { SpawnPicker } from './SpawnPicker';
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
 *   the GM view, never here); in player-safe (mob) view the tap also opens
 *   the fullscreen portrait lightbox (image + name only, Esc/tap-outside
 *   to close). GM taps stay select-only so the rail stays usable.
 *
 * Interactions (one-gesture-machine): ONE gesture ref
 * (`domain/battle/gestureMachine`: idle|armed|active ×
 * token|veil|effect|effectResize|pan|pinch|tap) plus ONE set of board-level
 * pointer handlers as the sole capture owner — pieces render
 * `data-gesture-grab` / `data-gesture-resize` hit areas and never own a
 * stream. Token/veil/effect moves share one start path; veil and effect
 * handles share the ONE resize gesture (drag, live preview, zero
 * mid-gesture writes, a single release commit); the rail Grow/Shrink
 * buttons stay as the discrete-step path. Drags commit with a local live
 * position + a single repo commit on release (8px SCREEN-space tap
 * threshold — client px, so the tap window does not scale with zoom);
 * player-safe presses fold into the machine as taps (release below the
 * threshold opens the portrait); pan from the letterbox, the map image, or
 * the content frame; wheel/button/pinch pan-zoom; stage set/reset; gated
 * initiative reconcile (the gate is a boolean the machine drives — no
 * counters, no throwing ends); HP floats writing to the token (NPC) or the
 * pc artifact (PC). Native HTML5 dragstart is suppressed on the board (the
 * ghost source of the native forbidden cursor) and an active grab always
 * carries cursor-grabbing.
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
// The tap/drag threshold lives in the gesture machine (single source) —
const DRAG_THRESHOLD_PX = GESTURE_TAP_THRESHOLD_PX;

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
  // Live-drag frame throttle (iPad batch H): pointermove streams run hotter
  // than the display, and every setLiveDrag re-renders the whole surface
  // (audit #22). Moves queue the latest position into pendingDragRef and
  // commit to state at most once per animation frame; release paths flush
  // the queue synchronously (exactly one commit, exact final position) and
  // abort paths cancel the frame (no stale lift after release).
  const pendingDragRef = useRef<LiveDrag | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  // Resize previews are RENDER mirrors only — ownership truth (base snapshot,
  // edge, owning pointer) lives in the gesture machine, so a release finds
  // the snapshot synchronously even when state still reads stale. Zero Dexie
  // writes until the single release commit, for veils exactly like effects.
  const [effectResizePreview, setEffectResizePreview] = useState<{
    effectId: BattleEffect['id'];
    sizeCells: number;
  } | null>(null);
  const [veilResizePreview, setVeilResizePreview] = useState<{
    veilId: BattleVeil['id'];
    x: number;
    y: number;
    widthCells: number;
    heightCells: number;
  } | null>(null);
  const [selectedTokenId, setSelectedTokenId] = useState<BattleTokenId | null>(null);
  const [selectedVeilId, setSelectedVeilId] = useState<BattleVeil['id'] | null>(null);
  const [selectedEffectId, setSelectedEffectId] = useState<BattleEffect['id'] | null>(null);
  // Fullscreen token portrait (image + name only): opened by a player-safe
  // token tap or by the sidebar selection-card portrait button (both modes),
  // closed by Esc/tap-outside/the close button. GM board taps stay
  // select-only so the rail stays usable.
  const [lightboxTokenId, setLightboxTokenId] = useState<BattleTokenId | null>(null);
  // GM-only room-key marker selection (owner-ratified room-keys/treasure
  // arc): the layout-room id whose key card shows in the rail.
  const [selectedKeyRoomId, setSelectedKeyRoomId] = useState<string | null>(null);
  const [playerSafe, setPlayerSafe] = useState(false);
  const [stageArmed, setStageArmed] = useState(false);
  const [reseedArmed, setReseedArmed] = useState(false);
  // Mid-fight spawn picker (spawn-picker arc): ONE Spawn button opens the
  // dialog — the per-roster-entry buttons are gone, the roster readout stays.
  const [spawnPickerOpen, setSpawnPickerOpen] = useState(false);
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
  // THE gesture machine (one-gesture-machine rebuild): the single ownership
  // truth for every pointer stream on this board — phase/kind/owning
  // pointerId/origin plus the in-flight move/resize snapshots. Pieces render
  // `data-gesture-grab` / `data-gesture-resize` hit areas and never own a
  // stream; the board-level handlers below (+ capture loss, blur, unmount)
  // are the sole capture owner. Replaces the old liveDrag/effectResizeRef/
  // playerTapRef/panRef containers and the gestureGate depth counters.
  const gestureRef = useRef<GestureState>(idleGesture());
  // Every board-seen pointer id — pinch pairing counts THESE, never the
  // machine (the machine holds at most one owner; pinch is multi-pointer).
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

  // A coalesced drag frame must never fire after unmount (stale setState on
  // an unmounted surface) — and a gesture in flight at blur/unmount time
  // resets to idle with the module gate balanced (an unmounted surface must
  // never strand reconcile suppression). Cancel-abandon semantics: no commit.
  useEffect(() => {
    const resetInFlightGesture = (): void => {
      if (dragFrameRef.current !== null) {
        cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }
      pendingDragRef.current = null;
      gestureRef.current = resetGesture();
      setLiveDrag(null);
      setEffectResizePreview(null);
      setVeilResizePreview(null);
      pinchRef.current.clear();
      pinchBaseRef.current = null;
      endBoardGesture();
    };
    window.addEventListener('blur', resetInFlightGesture);
    return () => {
      window.removeEventListener('blur', resetInFlightGesture);
      resetInFlightGesture();
    };
  }, []);

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
  // pointer in local state (persisted exactly once on release). An active
  // handle-drag previews its cell-quantized geometry instead — the two
  // gestures never co-occur (one machine, one owner).
  const displayedVeils = useMemo(() => {
    if (battle === undefined) return [];
    const drag = liveDrag;
    if (drag?.tokenId.startsWith('veil:') === true) {
      const veilId = drag.tokenId.slice('veil:'.length);
      return battle.board.veils.map((veil) =>
        veil.id === veilId ? { ...veil, x: drag.x, y: drag.y } : veil,
      );
    }
    if (veilResizePreview !== null) {
      return battle.board.veils.map((veil) =>
        veil.id === veilResizePreview.veilId
          ? {
            ...veil,
            x: veilResizePreview.x,
            y: veilResizePreview.y,
            widthCells: veilResizePreview.widthCells,
            heightCells: veilResizePreview.heightCells,
          }
          : veil,
      );
    }
    return battle.board.veils;
  }, [battle, liveDrag, veilResizePreview]);

  // Effect markers (D7): the same live-render contract — and NO player-safe
  // filter: effects are showpieces, board material in BOTH views. An active
  // edge-resize previews its cell-quantized size locally (persisted exactly
  // once on release); a move-drag previews position instead — the two
  // gestures never co-occur (both begin a board gesture; handles stop
  // propagation so a resize never starts a move).
  const displayedEffects = useMemo(() => {
    if (battle === undefined) return [];
    const drag = liveDrag;
    if (drag?.tokenId.startsWith('effect:') === true) {
      const effectId = drag.tokenId.slice('effect:'.length);
      return battle.board.effects.map((effect) =>
        effect.id === effectId ? { ...effect, x: drag.x, y: drag.y } : effect,
      );
    }
    if (effectResizePreview !== null) {
      return battle.board.effects.map((effect) =>
        effect.id === effectResizePreview.effectId ? { ...effect, sizeCells: effectResizePreview.sizeCells } : effect,
      );
    }
    return battle.board.effects;
  }, [battle, liveDrag, effectResizePreview]);

  const artifactById = useMemo(() => new Map(artifacts.map((entry) => [entry.id, entry])), [artifacts]);
  const lightboxToken = displayedTokens.find((token) => token.id === lightboxTokenId) ?? null;
  const lightboxArtifact = lightboxToken?.artifactId === null || lightboxToken === null
    ? undefined
    : artifactById.get(lightboxToken.artifactId);
  const selectedToken = displayedTokens.find((token) => token.id === selectedTokenId) ?? null;
  const selectedArtifact = selectedToken?.artifactId === null || selectedToken === null
    ? undefined
    : artifactById.get(selectedToken.artifactId);
  const selectedMobChunkId = selectedArtifact?.kind === 'npc'
    ? selectedArtifact.data.monsterChunkId ?? null
    : null;
  const selectedMobChunk = useLiveQuery(
    async () => {
      if (selectedMobChunkId === null) return undefined;
      return (await getChunksByIds([selectedMobChunkId]))[0];
    },
    [selectedMobChunkId],
    undefined,
  );
  const selectedStatBlock: StatBlock | null = !playerSafe && selectedToken !== null
    ? selectedArtifact?.kind === 'npc' && selectedArtifact.data.statBlock !== null
      ? selectedArtifact.data.statBlock
      : selectedMobChunk?.chunkType === 'statblock'
        ? selectedMobChunk.statBlock
        : null
    : null;
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

  // --- Live-drag frame queue -------------------------------------------------
  // Coalesces pointermove → state commits to one render per animation frame.
  // Trailing edge wins: the queued position IS the drop, so the final spot
  // is exact and desktop feel is unchanged (same positions, fewer renders).

  function queueLiveDrag(next: LiveDrag): void {
    pendingDragRef.current = next;
    if (dragFrameRef.current !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      // No frame scheduler (non-visual engines): apply synchronously — same
      // positions and commits, just unthrottled. Production browsers always
      // schedule below; this branch exists so the gesture never strands.
      pendingDragRef.current = null;
      setLiveDrag(next);
      return;
    }
    dragFrameRef.current = requestAnimationFrame(() => {
      dragFrameRef.current = null;
      const pending = pendingDragRef.current;
      pendingDragRef.current = null;
      if (pending !== null) setLiveDrag(pending);
    });
  }

  /** Release paths: consume the coalesced position (or the rendered one when
   * nothing is queued) so the single commit's drop is exact even mid-frame.
   * Cancels the scheduled frame — it must never re-lift after release. */
  function takePendingDrag(): LiveDrag | null {
    if (dragFrameRef.current !== null) {
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    const pending = pendingDragRef.current;
    pendingDragRef.current = null;
    return pending ?? liveDrag;
  }

  /** Abort paths: drop the queue and any scheduled frame, then unlift — no
   * commit, and no trailing frame may resurrect the drag. */
  function abandonLiveDrag(): void {
    if (dragFrameRef.current !== null) {
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    pendingDragRef.current = null;
    setLiveDrag(null);
  }

  // --- Pointer handling: ONE machine, board-owned streams -------------------
  // Pieces render hit areas (`data-gesture-grab` / `data-gesture-resize`)
  // and never own a stream; these board-level handlers (+ capture loss,
  // blur, unmount) are the sole capture owner. Every transition consults
  // gestureRef: arming while busy is ignored (never an overwrite),
  // moves/ups/cancels from a foreign pointerId are ignored
  // (pointerId-checked), and every terminal path resets to idle with an
  // idempotent gate end — imbalance resolves to a reset, never a throw, so
  // cross-consuming finishes (S1/R1) cannot double-commit.

  /** Board-level capture for the owning pointer — loud abort when it fails. */
  function acquireBoardCapture(pointerId: number): boolean {
    const element = boardRef.current;
    if (element === null || typeof element.setPointerCapture !== 'function') return true;
    try {
      element.setPointerCapture(pointerId);
      return true;
    } catch (error) {
      // Capture failure at birth (S5): without the stream a release never
      // arrives — start no gesture rather than strand one. No live state,
      // no commit, gate balanced (the arming caller opened it).
      gestureRef.current = resetGesture();
      endBoardGesture();
      toastError('Could not grab the piece — the pointer stream was lost', error);
      return false;
    }
  }

  /** Total reset: abandon everything in flight with ZERO commits. */
  function abandonGesture(): void {
    abandonLiveDrag();
    setEffectResizePreview(null);
    setVeilResizePreview(null);
    gestureRef.current = resetGesture();
    pinchRef.current.clear();
    pinchBaseRef.current = null;
    // Idempotent by contract — safe even when this gesture opened no gate
    // (pan/tap), which is exactly what makes cancel-vs-release races and
    // cross-consumed finishes unthrowable.
    endBoardGesture();
  }

  /** Second-finger promotion: pinch takes over, the piece stream dies. */
  function promotePinchFromPiece(): void {
    // The piece's pointer stream is dead and its release will never arrive:
    // abandon with NO commit (no drop point was chosen) and close the gate
    // so reconcile resumes — otherwise the piece strands lifted.
    abandonLiveDrag();
    setEffectResizePreview(null);
    setVeilResizePreview(null);
    gestureRef.current = promoteToPinch();
    endBoardGesture();
    pinchBaseRef.current = null;
  }

  function onBoardPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    const pointerId = event.pointerId;
    pinchRef.current.set(pointerId, { x: event.clientX, y: event.clientY });
    // A live gesture is NEVER overwritten (S2/R4): a second pointerdown only
    // ever promotes to pinch — and only from the background (a second grab
    // on a piece is ignored entirely, never an overwrite). The owner's
    // stream keeps running untouched either way.
    if (isGestureActive(gestureRef.current)) {
      if (gestureRef.current.pointerId === pointerId) return;
      const busyTarget = event.target instanceof Element ? event.target : null;
      const onBackground =
        event.target === event.currentTarget ||
        (busyTarget instanceof HTMLElement &&
          (busyTarget.dataset.boardBackground === 'true' || busyTarget.dataset.boardContent === 'true'));
      if (!onBackground) {
        // Second grab mid-gesture: ignored AND dropped from pinch tracking
        // so it can never promote or finish anything later.
        pinchRef.current.delete(pointerId);
      } else if (gestureRef.current.kind !== 'pinch' && pinchRef.current.size >= 2) {
        promotePinchFromPiece();
      }
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const resizeHandle = target?.closest('[data-gesture-resize]') ?? null;
    if (resizeHandle !== null) {
      const spec = resizeHandle.getAttribute('data-gesture-resize') ?? '';
      const [piece, id, edge] = spec.split(':');
      if ((piece === 'veil' || piece === 'effect') && id !== undefined && id !== '' && edge !== undefined && edge !== '') {
        startResizeGesture(piece, id, edge, event);
        return;
      }
      throw new Error('Malformed gesture resize target — the handle is missing its piece id or edge');
    }
    const grabNode = target?.closest('[data-gesture-grab]') ?? null;
    if (grabNode !== null) {
      const spec = grabNode.getAttribute('data-gesture-grab') ?? '';
      const [piece, id] = spec.split(':');
      if ((piece === 'token' || piece === 'veil' || piece === 'effect') && id !== undefined && id !== '') {
        startMoveGesture(piece, id, event);
        return;
      }
      throw new Error('Malformed gesture grab target — the piece is missing its kind or id');
    }
    // Background → pan: the letterbox, the map image, or the content frame
    // (a drag on the map pans exactly like the letterbox — M5-D amendment).
    if (
      event.target === event.currentTarget ||
      (target instanceof HTMLElement &&
        (target.dataset.boardBackground === 'true' || target.dataset.boardContent === 'true'))
    ) {
      const armed = armPanGesture(gestureRef.current, {
        kind: 'pan',
        pointerId,
        origin: { clientX: event.clientX, clientY: event.clientY },
        panOrigin: { x: pan.x, y: pan.y },
      });
      if (armed === null) return;
      gestureRef.current = armed;
      acquireBoardCapture(pointerId);
      return;
    }
    // Unknown node inside the board div: un-armable — drop it from pinch
    // tracking so it can never promote a pinch by itself.
    pinchRef.current.delete(pointerId);
  }

  function onBoardPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (pinchRef.current.has(event.pointerId)) {
      pinchRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (pinchRef.current.size >= 2) {
      // Two fingers: pinch owns the stream now. A live piece gesture dies
      // here exactly like the down-path promotion (no commit, gate closed).
      if (isGestureActive(gestureRef.current) && gestureRef.current.kind !== 'pinch') {
        promotePinchFromPiece();
      } else if (!isGestureActive(gestureRef.current)) {
        gestureRef.current = promoteToPinch();
        pinchBaseRef.current = null;
      }
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
    // PointerId-checked moves (R3): only the owner's stream advances the
    // machine — every other pointer is ignored, never folded in.
    const owned = gestureRef.current;
    if (!isGestureOwner(owned, event.pointerId)) return;
    const at = boardPointFromEvent(event);
    const next = trackGestureMove(owned, event.pointerId, event.clientX, event.clientY, at);
    gestureRef.current = next;
    if (next.kind === 'pan') {
      const origin = next.panOrigin;
      if (origin !== null) {
        setPan({ x: origin.x + (event.clientX - next.startClientX), y: origin.y + (event.clientY - next.startClientY) });
      }
      return;
    }
    if (next.kind === 'tap' || next.kind === 'pinch') return;
    if (next.kind === 'effectResize') {
      previewResizeGesture(next, at);
      return;
    }
    followMoveDrag(next, at);
  }

  /** Mirror the owned move into the coalesced live-drag frame. */
  function followMoveDrag(gesture: GestureState, at: { x: number; y: number }): void {
    const targetId = gesture.targetId;
    if (gesture.kind !== 'token' && gesture.kind !== 'veil' && gesture.kind !== 'effect') return;
    if (targetId === null) return;
    const dragKey = gesture.kind === 'token' ? targetId : `${gesture.kind}:${targetId}`;
    // Race-proof anchor: the queued frame wins, then rendered state, then
    // the machine's arm-time snapshot — a move landing before the arm's
    // setLiveDrag renders must still track, never strand on stale state.
    const queued = pendingDragRef.current ?? liveDrag;
    const anchor =
      queued !== null && queued.tokenId === dragKey
        ? queued
        : {
          tokenId: dragKey,
          x: gesture.currentBoard?.x ?? at.x,
          y: gesture.currentBoard?.y ?? at.y,
          movedPx: gesture.movedPx,
          startClientX: gesture.startClientX,
          startClientY: gesture.startClientY,
        };
    queueLiveDrag({ ...anchor, x: at.x, y: at.y, movedPx: gesture.movedPx });
  }

  /** Mirror the owned resize into its preview state — ZERO Dexie writes. */
  function previewResizeGesture(gesture: GestureState, at: { x: number; y: number }): void {
    const base = gesture.resizeBase;
    const edge = gesture.edge;
    const piece = gesture.resizePiece;
    if (base === null || edge === null || piece === null) return;
    try {
      if (piece === 'effect' && 'sizeCells' in base) {
        const resized = resizeEffectFromEdge(
          base,
          edge as EffectEdge,
          at,
          contentSize.w,
          contentSize.h,
          cellWidthPx,
          cellHeightPx,
        );
        setEffectResizePreview({ effectId: base.id, sizeCells: resized.sizeCells });
      } else if (piece === 'veil' && !('sizeCells' in base)) {
        const resized = resizeVeilFromEdge(
          base,
          edge as VeilEdge,
          at,
          contentSize.w,
          contentSize.h,
          cellWidthPx,
          cellHeightPx,
        );
        setVeilResizePreview({
          veilId: base.id,
          x: resized.x,
          y: resized.y,
          widthCells: resized.widthCells,
          heightCells: resized.heightCells,
        });
      }
    } catch (error) {
      // Loud, then unwind: a mid-gesture geometry failure must never leave a
      // half-open gesture suppressing reconcile — abandon with no commit.
      abandonGesture();
      toastError('Could not resize the piece', error);
    }
  }

  function onBoardPointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    const pointerId = event.pointerId;
    pinchRef.current.delete(pointerId);
    if (pinchRef.current.size < 2) pinchBaseRef.current = null;
    const gesture = gestureRef.current;
    // Pinch bookkeeping: when the second-to-last finger lifts, the pinch is
    // over. The abandoned piece pointer's own release lands here too —
    // consumed, never a commit.
    if (gesture.kind === 'pinch') {
      if (pinchRef.current.size < 2) gestureRef.current = resetGesture();
      return;
    }
    // Only the owner finishes (S1/R1): a release the machine does not own —
    // a second pointer, a stray release, or an already-finished gesture —
    // is ignored, so one release commits exactly once and the gate ends once.
    if (!isGestureOwner(gesture, pointerId)) return;
    if (gesture.kind === 'pan') {
      gestureRef.current = resetGesture();
      // Background tap (down→up within the screen-space threshold) clears
      // the selection — tapping empty board is a deselect, not a pan. Pan
      // gestures (≥ threshold) keep it.
      if (Math.hypot(event.clientX - gesture.startClientX, event.clientY - gesture.startClientY) < DRAG_THRESHOLD_PX) {
        setSelectedTokenId(null);
        setSelectedVeilId(null);
        setSelectedEffectId(null);
        setSelectedKeyRoomId(null);
      }
      return;
    }
    if (gesture.kind === 'tap') {
      const targetId = gesture.targetId;
      gestureRef.current = resetGesture();
      // Player-safe release (no gate was opened): below the tap threshold it
      // opens the fullscreen portrait (image + name only); a drag never does.
      if (targetId !== null && isGestureTap(gesture)) {
        setSelectedTokenId(targetId);
        setSelectedVeilId(null);
        setLightboxTokenId(targetId);
      }
      return;
    }
    if (gesture.kind === 'effectResize') {
      finishResizeGesture(gesture);
      return;
    }
    finishMoveGesture(gesture);
  }

  function onBoardPointerCancel(event: React.PointerEvent<HTMLDivElement>): void {
    const pointerId = event.pointerId;
    pinchRef.current.delete(pointerId);
    if (pinchRef.current.size < 2) pinchBaseRef.current = null;
    if (gestureRef.current.kind === 'pinch') {
      if (pinchRef.current.size < 2) gestureRef.current = resetGesture();
      return;
    }
    // Cancellation is NEVER a release (S7 — the old incoherence, where veil/
    // effect cancels committed while token cancels abandoned): the pointer
    // stream died — the OS stole it, a rotation gesture took over — so there
    // is no drop point and no tap. Abandon with NO commit everywhere (moves
    // AND resizes alike), and the gate balances idempotently.
    if (!isGestureOwner(gestureRef.current, pointerId)) return;
    abandonGesture();
  }

  function onBoardLostPointerCapture(event: React.PointerEvent<HTMLDivElement>): void {
    // Capture loss without this reset stranded gestures (S4): the owned
    // stream is gone, so abandon with no commit — same as cancel.
    if (!isGestureActive(gestureRef.current)) return;
    if (gestureRef.current.kind === 'pinch') {
      gestureRef.current = resetGesture();
      return;
    }
    if (gestureRef.current.pointerId !== null && event.pointerId !== gestureRef.current.pointerId) return;
    abandonGesture();
  }

  // --- Unified move gestures (token/veil/effect share ONE path) ----------------
  // One startMoveDrag for every piece kind: gate checks run BEFORE arming
  // (a forbidden grab never arms and never degrades into a pan), then the
  // machine arms, the gate opens, capture is acquired loudly, and the live
  // position mirrors into the coalesced frame. Tap = release below the
  // screen-space threshold (select / portrait, never a commit).

  function startMoveGesture(
    piece: 'token' | 'veil' | 'effect',
    id: string,
    event: React.PointerEvent<HTMLDivElement>,
  ): void {
    if (battle === undefined) return;
    // Gates BEFORE arming (S6): a forbidden grab never arms — and never
    // falls through to pan either (a grab must not silently become a pan).
    const sceneryLocked = battle.board.sceneryMovementLocked;
    if (piece === 'token' && playerSafe) {
      // Player-safe tap (the M5-D token-tap contract): selection + portrait
      // threshold tracking, folded into the machine as the `tap` kind — no
      // capture, no gate, no commit: moving pieces stays GM-only.
      const token = battle.board.tokens.find((entry) => entry.id === id);
      if (token === undefined) {
        toastError('Could not select the token — it left the board');
        return;
      }
      const armed = armTapGesture(gestureRef.current, {
        kind: 'tap',
        pointerId: event.pointerId,
        origin: { clientX: event.clientX, clientY: event.clientY },
        targetId: id,
      });
      if (armed === null) return;
      gestureRef.current = armed;
      setSelectedTokenId(id);
      setSelectedVeilId(null);
      return;
    }
    if (piece !== 'token' && (playerSafe || sceneryLocked)) {
      // Player view: affordances are hidden (visibly disabled) — silent.
      // GM + scenery lock: LOUD no-op so the lock reads as the reason.
      if (!playerSafe && sceneryLocked) {
        toastError('Scenery is locked — unlock it to move pieces');
      }
      return;
    }
    const position =
      piece === 'token'
        ? battle.board.tokens.find((entry) => entry.id === id)
        : piece === 'veil'
          ? battle.board.veils.find((entry) => entry.id === id)
          : battle.board.effects.find((entry) => entry.id === id);
    if (position === undefined) {
      toastError('Could not grab the piece — it left the board');
      return;
    }
    // Pointer capture keeps the move/up stream on the BOARD even when the
    // DOM under the cursor changes mid-drag (a live Dexie emission replacing
    // the piece node, or the cursor crossing an overlay edge). The gesture
    // opens BEFORE the capture attempt so a failed capture unwinds it loudly
    // instead of dragging without a stream.
    const armed = armMoveGesture(gestureRef.current, {
      kind: piece,
      pointerId: event.pointerId,
      origin: { clientX: event.clientX, clientY: event.clientY },
      targetId: id,
    });
    if (armed === null) return;
    gestureRef.current = { ...armed, currentBoard: { x: position.x, y: position.y } };
    beginBoardGesture();
    if (!acquireBoardCapture(event.pointerId)) return;
    const dragKey = piece === 'token' ? id : `${piece}:${id}`;
    setLiveDrag({
      tokenId: dragKey,
      x: position.x,
      y: position.y,
      movedPx: 0,
      startClientX: event.clientX,
      startClientY: event.clientY,
    });
    // Veil/effect taps select at arm (their finish only commits past the
    // threshold); token taps select at release.
    if (piece === 'veil') {
      setSelectedVeilId(id);
      setSelectedTokenId(null);
    } else if (piece === 'effect') {
      setSelectedEffectId(id);
      setSelectedTokenId(null);
      setSelectedVeilId(null);
    }
  }

  /** Owner release of a piece move: tap selects, drag commits exactly once. */
  function finishMoveGesture(gesture: GestureState): void {
    const kind = gesture.kind;
    const targetId = gesture.targetId;
    const drag = takePendingDrag();
    // Reset FIRST: the machine is idle before any commit/select work, so a
    // re-entrant release finds idle and no-ops instead of double-committing.
    gestureRef.current = resetGesture();
    setLiveDrag(null);
    endBoardGesture();
    if (kind !== 'token' && kind !== 'veil' && kind !== 'effect') return;
    if (targetId === null || drag === null) return;
    if (isGestureTap(gesture)) {
      // Tap: select. GM taps stay select-only (the rail must stay usable);
      // veil/effect selection already happened at arm.
      if (kind === 'token') {
        setSelectedTokenId(targetId);
        setSelectedVeilId(null);
      }
      return;
    }
    commitMoveDrop(kind, targetId, drag);
  }

  /** The single release commit for a dragged piece (cell-snap by span). */
  function commitMoveDrop(kind: 'token' | 'veil' | 'effect', targetId: string, drag: LiveDrag): void {
    if (battle === undefined) return;
    if (kind === 'token') {
      const span = tokenSpanCells(
        battle.board.tokens.find((entry) => entry.id === targetId)?.scale ?? 1,
      );
      const snapped = snapPoint(drag.x, drag.y, { x: span, y: span });
      void commit((board) => ({
        ...board,
        tokens: board.tokens.map((token) => (token.id === targetId ? { ...token, x: snapped.x, y: snapped.y } : token)),
      }));
      return;
    }
    if (kind === 'veil') {
      // VEIL/TOKEN PARITY (pinned by test): veils snap on drop exactly like
      // tokens — the center quantizes to a widthCells×heightCells grid block,
      // which lands the veil's EDGES on cell boundaries and matches the
      // cell-quantized resize math. An unsnapped commit was the
      // inconsistency, not a choice.
      const veil = battle.board.veils.find((entry) => entry.id === targetId);
      const snapped = snapPoint(drag.x, drag.y, {
        x: veil?.widthCells ?? 1,
        y: veil?.heightCells ?? 1,
      });
      void commit((board) => ({
        ...board,
        veils: board.veils.map((entry) => (entry.id === targetId ? { ...entry, x: snapped.x, y: snapped.y } : entry)),
      }));
      return;
    }
    // Same drop rule as veils/tokens: the center quantizes to the effect's
    // own sizeCells span, so its edges land on cell boundaries (geometry is
    // layout-anchored, never screen pixels).
    const effect = battle.board.effects.find((entry) => entry.id === targetId);
    const snapped = snapPoint(drag.x, drag.y, { x: effect?.sizeCells ?? 1, y: effect?.sizeCells ?? 1 });
    void commit((board) => ({
      ...board,
      effects: board.effects.map((entry) =>
        entry.id === targetId ? { ...entry, x: snapped.x, y: snapped.y } : entry,
      ),
    }));
  }

  // --- The ONE resize gesture (veil + effect handles share it) -----------------
  // Drag, live preview, zero mid-gesture writes, a single release commit —
  // the effect-resize semantics won, and the veil click-step onClick path is
  // deleted (the discrete-step replacement for effects is the rail
  // Grow/Shrink buttons). Scenery lock + player-safe gate before arming
  // exactly like moves: the handles never mount there, and the start path
  // re-checks so a stale node cannot resize.

  function startResizeGesture(
    piece: 'veil' | 'effect',
    id: string,
    edge: string,
    event: React.PointerEvent<HTMLDivElement>,
  ): void {
    if (battle === undefined) return;
    // Same before-arm gating as moves (S6): handles never mount while
    // locked or in player view — a stale node no-ops instead of arming.
    const sceneryLocked = battle.board.sceneryMovementLocked;
    if (playerSafe || sceneryLocked) {
      if (!playerSafe && sceneryLocked) {
        toastError('Scenery is locked — unlock it to resize pieces');
      }
      return;
    }
    const base =
      piece === 'veil'
        ? battle.board.veils.find((entry) => entry.id === id)
        : battle.board.effects.find((entry) => entry.id === id);
    if (base === undefined) {
      toastError('Could not resize the piece — it left the board');
      return;
    }
    const armed = armResizeGesture(gestureRef.current, {
      kind: 'effectResize',
      pointerId: event.pointerId,
      origin: { clientX: event.clientX, clientY: event.clientY },
      edge,
      resizePiece: piece,
      resizeBase: base,
      fromSizeCells: piece === 'effect' && 'sizeCells' in base ? base.sizeCells : 0,
    });
    if (armed === null) return;
    gestureRef.current = armed;
    beginBoardGesture();
    if (!acquireBoardCapture(event.pointerId)) return;
    if (piece === 'effect' && 'sizeCells' in base) {
      setEffectResizePreview({ effectId: id, sizeCells: base.sizeCells });
      setSelectedEffectId(id);
      setSelectedVeilId(null);
    } else if (piece === 'veil' && !('sizeCells' in base)) {
      setVeilResizePreview({
        veilId: id,
        x: base.x,
        y: base.y,
        widthCells: base.widthCells,
        heightCells: base.heightCells,
      });
      setSelectedVeilId(id);
    }
    setSelectedTokenId(null);
  }

  /** Owner release of the ONE resize gesture: a single commit, or nothing. */
  function finishResizeGesture(gesture: GestureState): void {
    const base = gesture.resizeBase;
    const edge = gesture.edge;
    const resizeTarget = gesture.resizePiece;
    const at = gesture.currentBoard;
    gestureRef.current = resetGesture();
    setEffectResizePreview(null);
    setVeilResizePreview(null);
    endBoardGesture();
    if (base === null || edge === null || resizeTarget === null) return;
    // A tap or a drag that never reached the threshold commits nothing; the
    // rail Grow/Shrink buttons own discrete steps.
    if (at === null || isGestureTap(gesture)) return;
    try {
      if (resizeTarget === 'effect' && 'sizeCells' in base) {
        const resized = resizeEffectFromEdge(
          base,
          edge as EffectEdge,
          at,
          contentSize.w,
          contentSize.h,
          cellWidthPx,
          cellHeightPx,
        );
        if (resized.sizeCells === gesture.fromSizeCells) return;
        const finalSize = resized.sizeCells;
        const effectId = base.id;
        void commit((board) => ({
          ...board,
          effects: board.effects.map((entry) =>
            entry.id === effectId ? { ...entry, sizeCells: finalSize } : entry,
          ),
        }));
      } else if (resizeTarget === 'veil' && !('sizeCells' in base)) {
        const resized = resizeVeilFromEdge(
          base,
          edge as VeilEdge,
          at,
          contentSize.w,
          contentSize.h,
          cellWidthPx,
          cellHeightPx,
        );
        if (
          resized.x === base.x && resized.y === base.y &&
          resized.widthCells === base.widthCells && resized.heightCells === base.heightCells
        ) return;
        const finalVeil = resized;
        const veilId = base.id;
        void commit((board) => ({
          ...board,
          veils: board.veils.map((entry) => (entry.id === veilId ? finalVeil : entry)),
        }));
      }
    } catch (error) {
      toastError('Could not resize the piece', error);
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
          ? { ...effect, sizeCells: Math.max(EFFECT_MIN_CELLS, effect.sizeCells + delta) }
          : effect,
      ),
    }));
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
  // Room-aware (a seeded room carries one veil per spawn group — docs/11
  // D4): the rail resolves per ROOM via `veil.roomId` as well as `veil.id`
  // (the primary group keeps id = room id, secondaries resolve via roomId),
  // so a room reads veiled until EVERY group veil lifts — never "revealed"
  // with its mobs still covered and no rail path left.
  const veiledRoomIds = useMemo(
    () => new Set((battle?.board.veils ?? []).flatMap((veil) => veil.roomId === undefined ? [veil.id] : [veil.id, veil.roomId])),
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
          <Button size="icon-sm" variant="ghost" aria-label="Zoom out" className="min-h-11 min-w-11" onClick={() => {
            setZoom((current) => clampZoom(current / 1.25));
          }}>
            <MinusIcon aria-hidden className="size-4" />
          </Button>
          <span className="w-10 text-center text-xs text-zinc-400">{Math.round(zoom * 100)}%</span>
          <Button size="icon-sm" variant="ghost" aria-label="Zoom in" className="min-h-11 min-w-11" onClick={() => {
            setZoom((current) => clampZoom(current * 1.25));
          }}>
            <PlusIcon aria-hidden className="size-4" />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Reset view" className="min-h-11 min-w-11" onClick={() => {
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
          className="relative min-h-0 flex-1 touch-none overflow-hidden overscroll-none bg-zinc-900"
          data-testid="battle-board"
          onPointerDown={onBoardPointerDown}
          onPointerMove={onBoardPointerMove}
          onPointerUp={onBoardPointerUp}
          onPointerCancel={onBoardPointerCancel}
          onLostPointerCapture={onBoardLostPointerCapture}
          onDragStart={(event) => {
            // Forbidden-cursor fix: the browser-native HTML5 drag (from
            // selectable text or imageless drags) is the ghost source — it
            // fights pointer capture and paints the native forbidden cursor.
            // The board owns every stream via pointer events; native drags
            // never start here.
            event.preventDefault();
          }}
          style={liveDrag !== null || effectResizePreview !== null || veilResizePreview !== null ? { cursor: 'grabbing' } : undefined}
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
                  board center). They mount BEFORE veils/effects/tokens with
                  NO z-index, so DOM order paints them BELOW the veils and
                  tokens: a covered room hides its marker exactly like it
                  hides its mobs, and mob tokens + veil bodies win
                  hit-testing over the 44px marker pad wherever they overlap
                  (the old z-10 lifted markers above both, swallowing
                  token/veil pointerdowns). Key content is GM-only text and
                  never mounts in player view. */}
              {!playerSafe &&
                hasRealSize &&
                keyedRooms.map(({ room, letter, marker }) => (
                  <button
                    key={room.id}
                    type="button"
                    aria-label={`Room key ${letter} — ${room.name}`}
                    data-testid={`room-key-marker-${letter}`}
                    // The visible badge stays size-6, but the hit target is a
                    // 44px (size-11) transparent pad around it — the sanctioned
                    // veil-handle pattern: coarse pointers get a finger-size
                    // target with no visual change. No z-index: markers paint
                    // below veils/tokens by DOM order (see the block comment).
                    className="absolute flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
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
                    <span
                      aria-hidden
                      className="flex size-6 items-center justify-center rounded-full border border-amber-300/70 bg-amber-950/85 text-xs font-bold text-amber-200"
                    >
                      {letter}
                    </span>
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
                  dragging={liveDrag?.tokenId === `veil:${veil.id}` || veilResizePreview?.veilId === veil.id}
                  resizable={!playerSafe && !board.sceneryMovementLocked}
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
                  dragging={liveDrag?.tokenId === `effect:${effect.id}` || effectResizePreview?.effectId === effect.id}
                  draggable={!playerSafe && !board.sceneryMovementLocked}
                  resizable={!playerSafe && !board.sceneryMovementLocked}
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
                />
              ))}
            </div>
          </div>
          {!hasRealSize && <div className="absolute inset-0" />}
        </div>

        {/* Right rail: provenance + initiative + token controls */}
        <div
          className={cn(
            'flex flex-col gap-2 overflow-y-auto border-l border-white/10 bg-black/60 p-2 transition-[width]',
            selectedStatBlock !== null ? 'w-96' : 'w-60',
          )}
          data-testid="battle-right-rail"
        >
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
          {/* Free-roll dice button (GM-only): opens the roller with a generic
          intent and NO pending HP target, so the settled total lands in the
          roller's own log only — applyDiceRoll's null-pending path no-ops.
          Player-safe mode has no button (the roller never renders there). */}
          {!playerSafe && (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              data-testid="open-dice-roller"
              onClick={() => {
                pendingRollRef.current = null;
                setDiceIntent({ kind: 'generic' });
              }}
            >
              <DicesIcon aria-hidden data-icon="inline-start" />
              Roll dice
            </Button>
          )}
          <InitiativeSidebar
            battle={battle}
            canReorder={!playerSafe}
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
              statBlock={selectedStatBlock}
              playerSafe={playerSafe}
              onOpenPortrait={() => {
                setLightboxTokenId(selectedToken.id);
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
                  // Reveal-all: lift EVERY group veil mapped to the room
                  // (primary by id, secondaries by roomId) — revealing a room
                  // never leaves its mobs covered with no rail path.
                  void commit((current) => ({
                    ...current,
                    veils: current.veils.filter((veil) => veil.id !== roomId && veil.roomId !== roomId),
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
                <ul className="mb-2 space-y-0.5">
                  {spawnSource.data.monsters.map((entry, index) => (
                    <li
                      key={`${entry.name}:${String(index)}`}
                      className="truncate text-xs text-zinc-400"
                    >
                      {entry.name} ×{String(entry.count)}
                    </li>
                  ))}
                </ul>
              )}
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                data-testid="open-spawn-picker"
                onClick={() => {
                  setSpawnPickerOpen(true);
                }}
              >
                Spawn
              </Button>
              <SpawnPicker
                open={spawnPickerOpen}
                onOpenChange={setSpawnPickerOpen}
                battleId={battle.id}
                campaignId={campaignId}
                roster={spawnSource.data.monsters}
                encounterName={spawnSource.name}
                artifacts={artifacts}
              />
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
        {/* Fullscreen token portrait (mob token view): image + name only — a
        subset of the player-safe contract, so it mounts in both modes. At
        the surface root (never inside the board div) so its pointer stream
        stays out of the board's drag/pan gesture handling. */}
        {lightboxToken !== null && (
          <TokenLightbox
            token={lightboxToken}
            artifact={lightboxArtifact}
            onClose={() => {
              setLightboxTokenId(null);
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
}

/** One token: portrait art or deterministic initials, HP meter, downed
 * overlay, turn marker. NAME + IMAGE + HP ONLY — never stats. The HP meter
 * is a bottom-edge strip inside the circle (never a full-area wash); a
 * player-safe tap opens the fullscreen portrait lightbox (image + name
 * only), GM taps stay select-only. */
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
        // An active grab is always visually owned (forbidden-cursor fix);
        // exactly one cursor utility applies at a time.
        dragging ? 'cursor-grabbing' : undefined,
        !dragging && (playerSafe ? 'cursor-default' : 'cursor-grab'),
      )}
      style={{ left: `${String(token.x * 100)}%`, top: `${String(token.y * 100)}%`, width: `${String(widthPct)}%`, height: `${String(heightPct)}%` }}
      data-testid="battle-token"
      data-token-label={token.label}
      // Hit area only — the board owns the stream (one-gesture-machine).
      data-gesture-grab={`token:${token.id}`}
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
        {/* Bottom-edge HP strip: a thin bar inside the token circle whose
            fill width is the HP ratio — the old full-area fill washed the
            whole portrait green at high HP. */}
        {hpRatio !== null && (
          <div
            aria-hidden
            className="absolute inset-x-1 bottom-1 h-1.5 overflow-hidden rounded-full bg-black/60"
            data-testid="hp-meter"
          >
            <div
              className="h-full rounded-full bg-emerald-500"
              style={{ width: `${String(Math.min(Math.max(hpRatio, 0), 1) * 100)}%` }}
            />
          </div>
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
        dragging ? 'cursor-grabbing' : undefined,
        !dragging && !resizable && 'cursor-default',
      )}
      style={{
        left: `${String(veil.x * 100)}%`,
        top: `${String(veil.y * 100)}%`,
        width: `${String(widthPct)}%`,
        height: `${String(heightPct)}%`,
      }}
      data-testid="battle-veil"
      data-veil-kind={veil.kind}
      // Hit area only — the board owns the stream (one-gesture-machine).
      data-gesture-grab={`veil:${veil.id}`}
    >
      {resizable &&
        handles.map((handle) => (
          <button
            key={handle.edge}
            type="button"
            aria-label={`Resize veil ${handle.edge}`}
            // T2a: the visible dot stays 12px, but the hit target is a 44px
            // (size-11) transparent pad around it. DRAG-resize now (the old
            // click-to-resize committed mid-gesture per click): the handle
            // drag previews the cell-quantized geometry live with zero
            // writes and commits exactly once on release — the effect
            // semantics. Hit area only: the board owns the stream via
            // data-gesture-resize, this button carries no pointer handlers.
            className={cn(
              'absolute flex size-11 touch-none items-center justify-center',
              handle.className,
            )}
            data-testid={`veil-handle-${handle.edge}`}
            data-gesture-resize={`veil:${veil.id}:${handle.edge}`}
          >
            <span aria-hidden className="size-3 rounded-full border border-zinc-900 bg-amber-400" />
          </button>
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
  resizable: boolean;
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
 *
 * Edge handles (veil-parity arc): the same 4 n/s/e/w affordance as
 * `VeilView` — a 12px dot inside a 44px transparent hit pad — but DRAG, not
 * click-to-resize: the handle drag previews the symmetric cell-quantized
 * size locally (`resizeEffectFromEdge`: center fixed, every handle grows
 * the same span) and commits exactly once on release. The rail Grow/Shrink
 * buttons stay as the discrete-step (accessibility) path.
 */
function EffectView({
  effect,
  content,
  cellWidthPx,
  cellHeightPx,
  selected,
  dragging,
  draggable,
  resizable,
}: EffectViewProps): JSX.Element | null {
  if (content.w === 0 || content.h === 0) return null;
  const widthPct = ((effect.sizeCells * cellWidthPx) / content.w) * 100;
  const heightPct = ((effect.sizeCells * cellHeightPx) / content.h) * 100;
  const handles: { edge: EffectEdge; className: string }[] = [
    { edge: 'n', className: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2' },
    { edge: 's', className: 'left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2' },
    { edge: 'w', className: 'left-0 top-1/2 -translate-y-1/2 -translate-x-1/2' },
    { edge: 'e', className: 'right-0 top-1/2 -translate-y-1/2 translate-x-1/2' },
  ];
  return (
    <div
      className={cn(
        'absolute -translate-x-1/2 -translate-y-1/2 touch-none border-2',
        effect.shape === 'disc' ? 'rounded-full' : 'rounded-sm',
        (selected || dragging) && 'ring-2 ring-amber-400',
        dragging && 'z-20',
        dragging ? 'cursor-grabbing' : undefined,
        !dragging && (draggable ? 'cursor-grab' : 'cursor-default'),
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
      // Hit area only — the board owns the stream (one-gesture-machine).
      data-gesture-grab={`effect:${effect.id}`}
    >
      {effect.label.length > 0 && (
        <span className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-[10px] font-medium text-zinc-100 drop-shadow-[0_1px_1px_rgba(0,0,0,0.9)]">
          {effect.label}
        </span>
      )}
      {resizable &&
        handles.map((handle) => (
          <button
            key={handle.edge}
            type="button"
            aria-label={`Resize effect ${handle.edge}`}
            // The visible dot stays 12px, but the hit target is a 44px
            // (size-11) transparent pad around it — the sanctioned
            // veil-handle pattern: coarse pointers get a finger-size
            // target with no visual change. Hit area only: the board owns
            // the stream via data-gesture-resize, this button carries no
            // pointer handlers.
            className={cn(
              'absolute flex size-11 touch-none items-center justify-center',
              handle.className,
            )}
            data-testid={`effect-handle-${handle.edge}`}
            data-gesture-resize={`effect:${effect.id}:${handle.edge}`}
          >
            <span aria-hidden className="size-3 rounded-full border border-zinc-900 bg-amber-400" />
          </button>
        ))}
    </div>
  );
}

interface SelectionCardProps {
  token: BattleToken;
  artifact: AnyArtifact | undefined;
  stats: FighterStatsLookup;
  statBlock: StatBlock | null;
  playerSafe: boolean;
  /** Opens the fullscreen token portrait for this token (the TokenLightbox
   * at the surface root — image + name only, in both modes). The card
   * attaches it to the portrait image only; the initials fallback for
   * imageless entries stays non-clickable so there is no dead affordance. */
  onOpenPortrait: () => void;
  /** GM-only: opens the dice roller with a damage/heal intent for this
   * token (the pendingRollRef → applyDiceRoll path). Never rendered in
   * player-safe mode. */
  onRollHp: (kind: 'damage' | 'heal') => void;
  onToggleVisibility: () => void;
  onScale: (delta: -1 | 1) => void;
  onRemove: (() => void) | undefined;
}

/**
 * The selected-token card (M5-D token-tap contract): portrait art + label +
 * HP meter, rendered in BOTH modes — it shows only what the board already
 * shows (cover art, label, HP), so the player-safe DOM contract holds. The
 * full artifact card (statblock) is GM-only behind an explicit button and
 * never mounts in player-safe mode.
 *
 * The portrait image is a button opening the fullscreen token portrait
 * (the same TokenLightbox the board tokens use — image + name only, both
 * modes); the initials fallback for imageless entries is plain text, never
 * a dead button.
 *
 * GM-only, directly below the name (above the lengthy treasure/statblock
 * descriptions that would otherwise push them out of view): the HP readout,
 * Damage / Heal roller buttons, and the piece floats (scale, visibility,
 * remove). Constant ± steppers are gone — the dice roller's own ± modifier
 * steppers cover fixed amounts.
 */
function SelectionCard({
  token,
  artifact,
  stats,
  statBlock,
  playerSafe,
  onOpenPortrait,
  onRollHp,
  onToggleVisibility,
  onScale,
  onRemove,
}: SelectionCardProps): JSX.Element {
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
          <button
            type="button"
            aria-label={`Open fullscreen portrait of ${token.label}`}
            data-testid="selection-card-portrait-button"
            className="shrink-0 cursor-zoom-in rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            onClick={onOpenPortrait}
          >
            <img
              src={url}
              alt=""
              className="size-12 rounded-md object-cover"
              data-testid="selection-card-portrait"
              draggable={false}
            />
          </button>
        ) : (
          <span
            className="flex size-12 shrink-0 items-center justify-center rounded-md bg-zinc-700 font-bold text-white"
            data-testid="selection-card-initials"
          >
            {initials}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" data-testid="selection-card-name">{token.label}</p>
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
      {/* GM-only token controls: HP readout + Damage/Heal roller entries +
          piece floats, directly below the name so lengthy descriptions below
          never push them out of view. Never mounts in player-safe mode. */}
      {!playerSafe && (
        <div className="flex flex-col gap-1.5 border-t border-white/10 pt-1.5" data-testid="token-controls">
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
      )}
      {/* Mob treasure (owner-ratified): frozen GM-only checklist text from
          the seeding roster — never mounts in player view. */}
      {!playerSafe && token.treasure !== '' && (
        <div className="border-t border-white/10 pt-1" data-testid="token-treasure">
          <p className="text-xs font-medium text-amber-200">Treasure</p>
          <p className="whitespace-pre-line text-xs text-zinc-300">{token.treasure}</p>
        </div>
      )}
      {!playerSafe && statBlock !== null && (
        <div className="max-h-[min(60vh,42rem)] overflow-y-auto border-t border-white/10 pt-1" data-testid="selection-card-statblock">
          <StatBlockCard statBlock={statBlock} name={token.label} />
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

interface TokenLightboxProps {
  token: BattleToken;
  artifact: AnyArtifact | undefined;
  onClose: () => void;
}

/**
 * Fullscreen token portrait (mob token view): image + name ONLY — never
 * stats, so the player-safe DOM contract holds in both modes. Opens on a
 * player-safe token tap (pointer-up below DRAG_THRESHOLD_PX) or on the
 * sidebar selection-card portrait button (both modes); a drag never
 * opens it, and GM board taps stay select-only (the rail must stay usable).
 * Imageless tokens render their deterministic initials large, so no tap is
 * dead. Esc / tap-outside / the close button dismiss via the dialog
 * defaults; focus returns to the element that held it when the lightbox
 * opened.
 */
function TokenLightbox({ token, artifact, onClose }: TokenLightboxProps): JSX.Element {
  // Same art path as TokenView/the selection card: useImageUrl over the
  // artifact's coverImageId — no new image plumbing.
  const coverImageId = artifact !== undefined && 'coverImageId' in artifact ? artifact.coverImageId : null;
  const url = useImageUrl(coverImageId);
  const restoreFocusRef = useRef<Element | null>(null);
  useEffect(() => {
    restoreFocusRef.current = document.activeElement;
    return () => {
      const prev = restoreFocusRef.current;
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, []);
  const initials = token.label
    .split(/\s+/u)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="token-lightbox"
        className="flex max-h-[92dvh] w-auto max-w-[92dvw] flex-col items-center gap-3 sm:max-w-[92dvw]"
      >
        <DialogTitle data-testid="token-lightbox-name">{token.label}</DialogTitle>
        <DialogDescription className="sr-only">Fullscreen token portrait — image and name only</DialogDescription>
        {url !== null ? (
          <img
            src={url}
            alt=""
            className="max-h-[70dvh] w-auto max-w-full rounded-lg object-contain"
            data-testid="token-lightbox-portrait"
            draggable={false}
          />
        ) : (
          <span
            className="flex size-48 items-center justify-center rounded-full bg-zinc-700 text-5xl font-bold text-white"
            data-testid="token-lightbox-initials"
          >
            {initials}
          </span>
        )}
      </DialogContent>
    </Dialog>
  );
}

async function artifactImageById(imageId: Id) {
  return getImage(imageId);
}
