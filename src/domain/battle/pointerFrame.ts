/**
 * Pointer → board-frame conversion (09-MILESTONE-5 M5-D). Tokens and veils
 * are positioned in fractions of the aspect-fitted CONTENT div, which sits
 * inside the pan/zoom-transformed background wrapper: the transform
 * (`translate(pan) scale(zoom)`, origin center) and the aspect-fit letterbox
 * both live BETWEEN the outer board container and that frame. Converting a
 * pointer against the outer container's rect therefore drifts by
 * `(s−c)(1−1/zoom) + pan/zoom` plus the letterbox offset.
 */

/** The subset of DOMRectReadOnly the conversion needs. */
export interface ClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Normalized point (fractions of `rect`) for a client-space pointer. Pass the
 * transformed content element's own `getBoundingClientRect()` — it already
 * bakes pan, zoom and letterbox in, so callers must NOT re-apply pan/zoom
 * (double-application). Throws on a degenerate rect: a silent center fallback
 * would teleport the dragged piece on release (AGENTS rule 1).
 */
export function pointInRect(
  clientX: number,
  clientY: number,
  rect: ClientRect,
): { x: number; y: number } {
  if (!(rect.width > 0) || !(rect.height > 0)) {
    throw new Error(
      `Cannot convert pointer coordinates: rect has non-positive size ${String(rect.width)}×${String(rect.height)}`,
    );
  }
  return {
    x: (clientX - rect.left) / rect.width,
    y: (clientY - rect.top) / rect.height,
  };
}
