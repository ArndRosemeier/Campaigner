/**
 * The ONE battle-surface gesture state machine (one-gesture-machine rebuild).
 *
 * Before this module the surface owned ~25 pointer handlers and ~15 gesture
 * state containers spread across the board container and every piece node
 * (token/veil/effect moves, effect edge-resize, player-safe tap tracking,
 * pan, pinch) plus module-level depth counters in `gestureGate.ts`. Pieces
 * consumed each other's finishes, second pointerdowns overwrote the live
 * drag, capture loss stranded gestures, and `pointercancel` committed in
 * some paths and abandoned in others. This module is the single ownership
 * truth every board-level stream consults:
 *
 * - ONE state object per surface mount (a single `useRef<GestureState>`):
 *   `{ phase, kind, pointerId, origin, current }` plus the in-flight
 *   move/resize snapshots. Pieces render `data-gesture-grab` /
 *   `data-gesture-resize` hit areas and never own a stream.
 * - `idle | armed | active`: a pointerdown ARMS (never commits, never
 *   overwrites a live gesture), the first owned move past the screen-space
 *   threshold ACTIVATES, release/cancel/capture-loss/blur/unmount returns to
 *   `idle`. A release below the threshold is a tap (select / portrait /
 *   deselect), never a commit.
 * - No counters, no throws: every transition is a total function. Arming
 *   while busy returns the state unchanged (second-pointerdown is IGNORED,
 *   never an overwrite); moves from a foreign pointerId are ignored
 *   (pointerId-checked moves); imbalance can only resolve to `idle`, never
 *   a crash. The module-level `gestureGate.ts` mirrors this with plain
 *   booleans for the initiative-reconcile early-return.
 *
 * Pure data + total functions — no React, no IO. The surface keeps React
 * state mirrors (live-drag position, resize previews) for rendering only;
 * this ref is what finishes, abandons, and balances against.
 */

import type { BattleEffect, BattleVeil } from '@/domain';

/** Screen-space (client px) tap window — zoom-invariant by contract. */
export const GESTURE_TAP_THRESHOLD_PX = 8;

export type GesturePhase = 'idle' | 'armed' | 'active';

/**
 * The single gesture vocabulary. `effectResize` is the ONE resize kind for
 * BOTH veil and effect handles (the `resizePiece` payload discriminates) —
 * drag, live preview, zero mid-gesture writes, a single release commit —
 * after the veil click-step path was deleted. `tap` is the player-safe
 * press (no move stream exists there); a GM press that releases below the
 * threshold is a tap by outcome, not by kind.
 */
export type GestureKind =
  | 'token'
  | 'veil'
  | 'effect'
  | 'effectResize'
  | 'pan'
  | 'pinch'
  | 'tap';

export interface GesturePoint {
  clientX: number;
  clientY: number;
}

export interface GestureState {
  phase: GesturePhase;
  kind: GestureKind | null;
  /** The owning pointer — every move/up/cancel not from this id is ignored. */
  pointerId: number | null;
  /** Pointerdown origin (client px) — the tap threshold anchors here. */
  startClientX: number;
  startClientY: number;
  /** Max screen-space distance seen from the origin (client px). */
  movedPx: number;
  /** Move target: the dragged piece id (token id, veil id, effect id). */
  targetId: string | null;
  /** Resize edge (`n`/`s`/`e`/`w`) for the `effectResize` kind. */
  edge: string | null;
  /** Which board object the `effectResize` kind resizes. */
  resizePiece: 'veil' | 'effect' | null;
  /** Geometry snapshot at resize-arm time — previews derive from this. */
  resizeBase: BattleVeil | BattleEffect | null;
  /** Effect cell count at resize-arm time (veils compare w/h instead). */
  fromSizeCells: number;
  /** Last owned board-frame point (for release-time recompute). */
  currentBoard: { x: number; y: number } | null;
  /** Pan origin in screen px at arm time (the `pan` state the drag offsets). */
  panOrigin: { x: number; y: number } | null;
}

const IDLE: GestureState = {
  phase: 'idle',
  kind: null,
  pointerId: null,
  startClientX: 0,
  startClientY: 0,
  movedPx: 0,
  targetId: null,
  edge: null,
  resizePiece: null,
  resizeBase: null,
  fromSizeCells: 0,
  currentBoard: null,
  panOrigin: null,
};

/** Fresh idle state (never share the singleton — callers mutate via copy). */
export function idleGesture(): GestureState {
  return { ...IDLE };
}

/** Recoverable reset — the ONLY way back to idle (never throws). */
export function resetGesture(): GestureState {
  return { ...IDLE };
}

export function isGestureActive(state: GestureState): boolean {
  return state.phase !== 'idle';
}

export function isGestureOwner(state: GestureState, pointerId: number): boolean {
  return state.phase !== 'idle' && state.pointerId === pointerId;
}

/** Release outcome: below-threshold releases are taps, never commits. */
export function isGestureTap(state: GestureState): boolean {
  return state.movedPx < GESTURE_TAP_THRESHOLD_PX;
}

export interface ArmBase {
  kind: GestureKind;
  pointerId: number;
  origin: GesturePoint;
}

function armBase(state: GestureState, args: ArmBase): GestureState | null {
  // Second-pointerdown discipline (S2/R4): a live gesture is NEVER
  // overwritten — the newcomer is ignored (pinch promotion is the board's
  // decision, made from its own pointer set, not here).
  if (state.phase !== 'idle') return null;
  return {
    ...IDLE,
    phase: 'armed',
    kind: args.kind,
    pointerId: args.pointerId,
    startClientX: args.origin.clientX,
    startClientY: args.origin.clientY,
  };
}

/** Arm a piece move (token/veil/effect). Returns null when busy (ignored). */
export function armMoveGesture(
  state: GestureState,
  args: ArmBase & { targetId: string },
): GestureState | null {
  const armed = armBase(state, args);
  if (armed === null) return null;
  return { ...armed, targetId: args.targetId };
}

/** Arm the ONE resize gesture (veil or effect handle drag). */
export function armResizeGesture(
  state: GestureState,
  args: ArmBase & {
    edge: string;
    resizePiece: 'veil' | 'effect';
    resizeBase: BattleVeil | BattleEffect;
    fromSizeCells: number;
  },
): GestureState | null {
  const armed = armBase(state, { kind: 'effectResize', pointerId: args.pointerId, origin: args.origin });
  if (armed === null) return null;
  return {
    ...armed,
    edge: args.edge,
    resizePiece: args.resizePiece,
    resizeBase: args.resizeBase,
    fromSizeCells: args.fromSizeCells,
  };
}

/** Arm a background pan. */
export function armPanGesture(
  state: GestureState,
  args: ArmBase & { panOrigin: { x: number; y: number } },
): GestureState | null {
  const armed = armBase(state, { ...args, kind: 'pan' });
  if (armed === null) return null;
  return { ...armed, panOrigin: args.panOrigin };
}

/** Arm a player-safe press (no move stream — tap decided on release). */
export function armTapGesture(
  state: GestureState,
  args: ArmBase & { targetId: string },
): GestureState | null {
  const armed = armBase(state, { ...args, kind: 'tap' });
  if (armed === null) return null;
  return { ...armed, targetId: args.targetId };
}

/**
 * Promote to pinch. Unlike arming, promotion INTENTIONALLY replaces a live
 * gesture — but the replaced gesture is first abandoned by the caller (no
 * commit: no drop point was ever chosen), so this never overwrites-and-keeps.
 */
export function promoteToPinch(): GestureState {
  return { ...IDLE, phase: 'active', kind: 'pinch', pointerId: null };
}

/**
 * Fold an owned move into the gesture (pointerId-checked: foreign pointers
 * return the state unchanged — the R3 hole). Crossing the threshold flips
 * `armed` to `active`. Returns the same state object when nothing applies
 * so callers can skip mirror work.
 */
export function trackGestureMove(
  state: GestureState,
  pointerId: number,
  clientX: number,
  clientY: number,
  currentBoard: { x: number; y: number } | null,
): GestureState {
  if (!isGestureOwner(state, pointerId)) return state;
  const movedPx = Math.max(
    state.movedPx,
    Math.hypot(clientX - state.startClientX, clientY - state.startClientY),
  );
  const phase: GesturePhase = movedPx >= GESTURE_TAP_THRESHOLD_PX ? 'active' : state.phase;
  return { ...state, movedPx, phase, currentBoard: currentBoard ?? state.currentBoard };
}
