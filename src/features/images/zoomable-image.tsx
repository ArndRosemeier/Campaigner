import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

import type { Id } from '@/domain';
import { cn } from '@/lib/utils';
import { LightboxImage } from '@/features/images/lightbox-image';

/**
 * Fullscreen image with touch gestures (05-UI.md §Tablet): pinch zoom, one-
 * finger pan while zoomed, double-tap (or double-click) to toggle 2.5×, and
 * wheel/trackpad zoom with a desktop pointer. At 1× a plain tap/click still
 * closes the viewer via `onCloseRequest` — but only after the double-tap
 * window, so the second tap can zoom instead of dismissing.
 *
 * Gesture engine notes: pointer events on the container plus window-level
 * move/up/cancel listeners (no pointer capture, so multi-pointer pinch needs
 * no element capture and degrades safely); `touch-none` stops the browser
 * from turning the gestures into scrolling; the pan is clamped so the image
 * cannot be dragged off-screen; zoom anchors on the gesture midpoint, so the
 * pinched content stays under the fingers.
 */

interface ZoomTransform {
  scale: number;
  x: number;
  y: number;
}

interface Point {
  x: number;
  y: number;
}

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;
/** Finger jitter below this is still a tap, not a drag. */
const TAP_SLOP_PX = 10;

const IDENTITY: ZoomTransform = { scale: 1, x: 0, y: 0 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Keeps a zoomed image on-screen: the pan is bounded to the scaled overflow. */
function clamped(transform: ZoomTransform, width: number, height: number): ZoomTransform {
  if (transform.scale <= MIN_SCALE) return IDENTITY;
  const maxX = ((transform.scale - MIN_SCALE) * width) / 2;
  const maxY = ((transform.scale - MIN_SCALE) * height) / 2;
  return {
    scale: transform.scale,
    x: clamp(transform.x, -maxX, maxX),
    y: clamp(transform.y, -maxY, maxY),
  };
}

export function ZoomableImage({
  imageId,
  className,
  children,
  onCloseRequest,
}: {
  imageId: Id;
  className?: string | undefined;
  children?: React.ReactNode | undefined;
  onCloseRequest?: () => void;
}): JSX.Element | null {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [transform, setTransform] = useState<ZoomTransform>(IDENTITY);
  const [gesturing, setGesturing] = useState(false);
  const transformRef = useRef<ZoomTransform>(IDENTITY);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{
    /** Pinch anchor: the two-pointer geometry the scale is derived from. */
    anchor: { mid: Point; dist: number; scale: number; offset: Point } | null;
    /** Single-pointer pan anchor (only meaningful while scale > 1). */
    pan: { id: number; start: Point; offset: Point } | null;
    moved: boolean;
  }>({ anchor: null, pan: null, moved: false });
  const lastTap = useRef<{ time: number; point: Point } | null>(null);
  const closeTimer = useRef<number | null>(null);
  const onCloseRef = useRef(onCloseRequest);
  onCloseRef.current = onCloseRequest;

  function cancelScheduledClose(): void {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  // Reset when a different image opens; the viewer remounts per open, but a
  // gallery switching images in place must not inherit the old transform.
  useEffect(() => {
    transformRef.current = IDENTITY;
    setTransform(IDENTITY);
    gesture.current = { anchor: null, pan: null, moved: false };
    lastTap.current = null;
    cancelScheduledClose();
  }, [imageId]);

  useEffect(() => {
    return () => {
      cancelScheduledClose();
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    function containerSize(): Point {
      const element = containerRef.current;
      return { x: element?.clientWidth ?? 0, y: element?.clientHeight ?? 0 };
    }

    function apply(next: ZoomTransform): void {
      const element = containerRef.current;
      if (element === null) return;
      const nextClamped = clamped(next, element.clientWidth, element.clientHeight);
      transformRef.current = nextClamped;
      setTransform(nextClamped);
    }

    /** Zooms keeping the content point under `screen` pinned to that spot. */
    function zoomAt(screen: Point, nextScale: number): void {
      const element = containerRef.current;
      if (element === null) return;
      const current = transformRef.current;
      const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
      const cx = element.clientWidth / 2;
      const cy = element.clientHeight / 2;
      const pinned = {
        x: (screen.x - cx - current.x) / current.scale,
        y: (screen.y - cy - current.y) / current.scale,
      };
      apply({
        scale,
        x: screen.x - cx - pinned.x * scale,
        y: screen.y - cy - pinned.y * scale,
      });
    }

    function onPointerDown(event: PointerEvent): void {
      if (event.target instanceof Element && event.target.closest('button') !== null) return;
      cancelScheduledClose();
      const points = pointers.current;
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const state = gesture.current;
      setGesturing(true);
      if (points.size === 1) {
        state.pan = { id: event.pointerId, start: { x: event.clientX, y: event.clientY }, offset: { x: transformRef.current.x, y: transformRef.current.y } };
        state.moved = false;
      } else if (points.size === 2) {
        const [a, b] = [...points.values()];
        if (a === undefined || b === undefined) return;
        // Re-anchor from the identity offset so the anchor's math is exact.
        const current = transformRef.current;
        state.anchor = { mid: midpoint(a, b), dist: Math.max(distance(a, b), 1), scale: current.scale, offset: { x: current.x, y: current.y } };
        state.pan = null;
      }
    }

    function onPointerMove(event: PointerEvent): void {
      const points = pointers.current;
      if (!points.has(event.pointerId)) return;
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const state = gesture.current;
      const size = containerSize();

      if (points.size >= 2 && state.anchor !== null) {
        const [a, b] = [...points.values()];
        if (a === undefined || b === undefined) return;
        state.moved = true;
        state.pan = null;
        const mid = midpoint(a, b);
        const nextScale = clamp(
          (state.anchor.scale * distance(a, b)) / state.anchor.dist,
          MIN_SCALE,
          MAX_SCALE,
        );
        const cx = size.x / 2;
        const cy = size.y / 2;
        const pinned = {
          x: (state.anchor.mid.x - cx - state.anchor.offset.x) / state.anchor.scale,
          y: (state.anchor.mid.y - cy - state.anchor.offset.y) / state.anchor.scale,
        };
        apply({
          scale: nextScale,
          x: mid.x - cx - pinned.x * nextScale,
          y: mid.y - cy - pinned.y * nextScale,
        });
        return;
      }

      if (points.size === 1 && state.pan !== null) {
        if (state.pan.id !== event.pointerId) return;
        const dx = event.clientX - state.pan.start.x;
        const dy = event.clientY - state.pan.start.y;
        if (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > TAP_SLOP_PX) state.moved = true;
        const current = transformRef.current;
        if (current.scale > MIN_SCALE) {
          apply({ scale: current.scale, x: state.pan.offset.x + dx, y: state.pan.offset.y + dy });
        }
      }
    }

    function onPointerEnd(event: PointerEvent): void {
      const points = pointers.current;
      if (!points.has(event.pointerId)) return;
      points.delete(event.pointerId);
      const state = gesture.current;

      if (points.size === 1) {
        // Pinch → pan: re-anchor on the finger that remains.
        const remainingId = [...points.keys()][0];
        const remaining = [...points.values()][0];
        if (remainingId === undefined || remaining === undefined) return;
        const current = transformRef.current;
        state.anchor = null;
        state.pan = {
          id: remainingId,
          start: { x: remaining.x, y: remaining.y },
          offset: { x: current.x, y: current.y },
        };
        return;
      }

      if (points.size > 0) return;
      setGesturing(false);
      state.anchor = null;
      state.pan = null;
      const upPoint = { x: event.clientX, y: event.clientY };
      const previous = lastTap.current;
      lastTap.current = null;
      if (state.moved) return;

      const now = performance.now();
      if (previous !== null && now - previous.time <= DOUBLE_TAP_MS && distance(previous.point, upPoint) <= TAP_SLOP_PX * 2) {
        // Double tap/click: toggle between fit and 2.5× at the tapped point.
        cancelScheduledClose();
        if (transformRef.current.scale > MIN_SCALE) apply(IDENTITY);
        else zoomAt(upPoint, DOUBLE_TAP_SCALE);
        return;
      }
      lastTap.current = { time: now, point: upPoint };
      if (transformRef.current.scale === MIN_SCALE && onCloseRef.current !== undefined) {
        // Single tap at fit scale closes — deferred so a second tap can zoom.
        closeTimer.current = window.setTimeout(() => {
          closeTimer.current = null;
          onCloseRef.current?.();
        }, DOUBLE_TAP_MS);
      }
    }

    function onWheel(event: WheelEvent): void {
      // React's root wheel listener is passive; zooming must preventDefault,
      // so the wheel is bound here non-passively.
      event.preventDefault();
      cancelScheduledClose();
      const factor = Math.exp(-event.deltaY * 0.0015);
      zoomAt({ x: event.clientX, y: event.clientY }, transformRef.current.scale * factor);
    }

    function onDragStart(event: DragEvent): void {
      event.preventDefault();
    }

    container.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('dragstart', onDragStart);
    return () => {
      container.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('dragstart', onDragStart);
    };
  }, []);

  const zoomed = transform.scale > 1;

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex touch-none select-none items-center justify-center overflow-hidden',
        zoomed ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-out',
      )}
      data-testid="zoomable-image"
    >
      <div
        data-testid="zoomable-image-transform"
        className={cn('relative flex items-center justify-center', !gesturing && 'transition-transform duration-150')}
        style={{ transform: `translate(${String(transform.x)}px, ${String(transform.y)}px) scale(${String(transform.scale)})` }}
      >
        <LightboxImage
          imageId={imageId}
          {...(className !== undefined ? { className } : {})}
        />
        {children}
      </div>
    </div>
  );
}
