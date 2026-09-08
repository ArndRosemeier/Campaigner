/**
 * Unit pins for the ONE battle-surface gesture state machine
 * (`domain/battle/gestureMachine`): phase transitions, the second-pointer
 * discipline, pointerId-checked moves, and the recoverable-reset contract.
 * Surface-level regression coverage (cancel-abandons, capture-loss reset,
 * lock-evaluated-before-arm, cross-piece release) lives in
 * `tests/features/battle-surface.test.tsx` §one-gesture-machine.
 */
import { describe, expect, it } from 'vitest';

import type { BattleEffect } from '@/domain';
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
} from '@/domain/battle/gestureMachine';

const ORIGIN = { clientX: 100, clientY: 200 };

describe('gesture machine arming', () => {
  it('arms a move from idle with kind, owner, origin, and target', () => {
    const armed = armMoveGesture(idleGesture(), {
      kind: 'token',
      pointerId: 1,
      origin: ORIGIN,
      targetId: 'token-1',
    });
    expect(armed).not.toBeNull();
    expect(armed).toMatchObject({
      phase: 'armed',
      kind: 'token',
      pointerId: 1,
      startClientX: 100,
      startClientY: 200,
      movedPx: 0,
      targetId: 'token-1',
    });
    if (armed === null) throw new Error('arm failed');
    expect(isGestureActive(armed)).toBe(true);
    expect(isGestureOwner(armed, 1)).toBe(true);
    expect(isGestureOwner(armed, 2)).toBe(false);
  });

  it('ignores a second-pointer arm while busy — the live gesture is never overwritten (S2/R4)', () => {
    const first = armMoveGesture(idleGesture(), {
      kind: 'token',
      pointerId: 1,
      origin: ORIGIN,
      targetId: 'token-1',
    });
    if (first === null) throw new Error('first arm failed');
    // A second pointerdown on another piece returns null (ignored)…
    expect(
      armMoveGesture(first, { kind: 'veil', pointerId: 2, origin: { clientX: 9, clientY: 9 }, targetId: 'veil-9' }),
    ).toBeNull();
    expect(
      armPanGesture(first, { kind: 'pan', pointerId: 2, origin: ORIGIN, panOrigin: { x: 0, y: 0 } }),
    ).toBeNull();
    expect(
      armTapGesture(first, { kind: 'tap', pointerId: 2, origin: ORIGIN, targetId: 'token-2' }),
    ).toBeNull();
    // …and the live gesture is untouched (not overwritten).
    expect(first).toMatchObject({ phase: 'armed', kind: 'token', pointerId: 1, targetId: 'token-1' });
  });

  it('arms pan with its origin, tap with its target, resize with its snapshot', () => {
    const pan = armPanGesture(idleGesture(), {
      kind: 'pan',
      pointerId: 4,
      origin: ORIGIN,
      panOrigin: { x: 11, y: 22 },
    });
    expect(pan).toMatchObject({ phase: 'armed', kind: 'pan', pointerId: 4, panOrigin: { x: 11, y: 22 } });

    const tap = armTapGesture(idleGesture(), {
      kind: 'tap',
      pointerId: 5,
      origin: ORIGIN,
      targetId: 'token-7',
    });
    expect(tap).toMatchObject({ phase: 'armed', kind: 'tap', pointerId: 5, targetId: 'token-7' });

    const base = { id: 'fx-1', shape: 'disc', x: 0.3, y: 0.3, sizeCells: 1, color: '#ff0000', label: '' } as BattleEffect;
    const resize = armResizeGesture(idleGesture(), {
      kind: 'effectResize',
      pointerId: 6,
      origin: ORIGIN,
      edge: 'e',
      resizePiece: 'effect',
      resizeBase: base,
      fromSizeCells: 1,
    });
    expect(resize).toMatchObject({
      phase: 'armed',
      kind: 'effectResize',
      pointerId: 6,
      edge: 'e',
      resizePiece: 'effect',
      resizeBase: base,
      fromSizeCells: 1,
    });
  });

  it('never self-arms: tracking on idle returns the idle state untouched', () => {
    // Evaluation happens BEFORE arming (locks, player-safe): the machine
    // cannot arm itself — only an explicit arm call leaves idle.
    const idle = idleGesture();
    expect(trackGestureMove(idle, 1, 500, 500, { x: 0.5, y: 0.5 })).toBe(idle);
    expect(isGestureActive(idle)).toBe(false);
  });
});

describe('gesture machine tracking', () => {
  it('ignores moves from a foreign pointerId — pointerId-checked moves (R3)', () => {
    const armed = armMoveGesture(idleGesture(), {
      kind: 'token',
      pointerId: 1,
      origin: ORIGIN,
      targetId: 'token-1',
    });
    if (armed === null) throw new Error('arm failed');
    // A second finger's moves never fold into the owner's stream.
    expect(trackGestureMove(armed, 2, 400, 400, { x: 0.4, y: 0.4 })).toBe(armed);
  });

  it('flips armed → active past the screen-space threshold and records the board point', () => {
    const armed = armMoveGesture(idleGesture(), {
      kind: 'veil',
      pointerId: 1,
      origin: ORIGIN,
      targetId: 'veil-1',
    });
    if (armed === null) throw new Error('arm failed');
    const below = trackGestureMove(armed, 1, ORIGIN.clientX + 3, ORIGIN.clientY, { x: 0.31, y: 0.3 });
    expect(below.phase).toBe('armed');
    expect(below.movedPx).toBe(3);
    expect(isGestureTap(below)).toBe(true);
    const past = trackGestureMove(below, 1, ORIGIN.clientX + 72, ORIGIN.clientY, { x: 0.39, y: 0.3 });
    expect(past.phase).toBe('active');
    expect(past.movedPx).toBe(72);
    expect(past.currentBoard).toEqual({ x: 0.39, y: 0.3 });
    expect(isGestureTap(past)).toBe(false);
  });

  it('treats exactly the threshold as a drag (tap window is sub-threshold)', () => {
    const armed = armMoveGesture(idleGesture(), {
      kind: 'token',
      pointerId: 1,
      origin: ORIGIN,
      targetId: 'token-1',
    });
    if (armed === null) throw new Error('arm failed');
    const edge = trackGestureMove(armed, 1, ORIGIN.clientX + GESTURE_TAP_THRESHOLD_PX, ORIGIN.clientY, null);
    expect(edge.phase).toBe('active');
    expect(isGestureTap(edge)).toBe(false);
  });

  it('keeps the max distance seen (threshold never un-crosses)', () => {
    const armed = armMoveGesture(idleGesture(), {
      kind: 'token',
      pointerId: 1,
      origin: ORIGIN,
      targetId: 'token-1',
    });
    if (armed === null) throw new Error('arm failed');
    const out = trackGestureMove(armed, 1, ORIGIN.clientX + 50, ORIGIN.clientY, null);
    const back = trackGestureMove(out, 1, ORIGIN.clientX + 1, ORIGIN.clientY, null);
    expect(back.movedPx).toBe(50);
    expect(back.phase).toBe('active');
  });
});

describe('gesture machine terminal paths', () => {
  it('resets to idle from any phase — cancel-abandons and capture-loss reset', () => {
    const armed = armMoveGesture(idleGesture(), {
      kind: 'token',
      pointerId: 1,
      origin: ORIGIN,
      targetId: 'token-1',
    });
    if (armed === null) throw new Error('arm failed');
    const active = trackGestureMove(armed, 1, ORIGIN.clientX + 50, ORIGIN.clientY, null);
    // pointercancel = abandon: reset, never a commit (commit lives on the
    // surface's release path, unreachable from here).
    const afterCancel = resetGesture();
    expect(afterCancel).toEqual(idleGesture());
    expect(isGestureActive(afterCancel)).toBe(false);
    // lostpointercapture / blur / unmount: the same total reset.
    expect(active.phase).toBe('active');
    const afterLoss = resetGesture();
    expect(isGestureActive(afterLoss)).toBe(false);
    expect(isGestureOwner(afterLoss, 1)).toBe(false);
  });

  it('promotes to pinch, replacing the live gesture without keeping it', () => {
    const armed = armMoveGesture(idleGesture(), {
      kind: 'token',
      pointerId: 1,
      origin: ORIGIN,
      targetId: 'token-1',
    });
    expect(armed?.phase).toBe('armed');
    // Promotion intentionally replaces (the caller abandons first, no
    // commit) — the only transition allowed to leave a live gesture.
    const pinch = promoteToPinch();
    expect(pinch).toMatchObject({ phase: 'active', kind: 'pinch', pointerId: null });
    expect(isGestureActive(pinch)).toBe(true);
    expect(isGestureOwner(pinch, 1)).toBe(false);
  });
});
