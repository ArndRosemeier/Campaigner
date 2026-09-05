import { describe, expect, it } from 'vitest';

import { pointInRect } from '@/domain/battle/pointerFrame';

/**
 * The pure content-frame pointer conversion (09-MILESTONE-5 M5-D fix). The
 * pan/zoom transform and the aspect-fit letterbox live between the outer
 * board container and the content div, so the conversion must run against the
 * content element's post-transform rect ALONE — never the container, and
 * never a second pan/zoom application on top.
 */

describe('pointInRect', () => {
  it('round-trips fractions through client coordinates', () => {
    const rect = { left: 40, top: -30, width: 640, height: 480 };
    for (const fx of [0, 0.25, 0.5, 0.75, 1]) {
      for (const fy of [0, 0.25, 0.5, 0.75, 1]) {
        const clientX = rect.left + fx * rect.width;
        const clientY = rect.top + fy * rect.height;
        expect(pointInRect(clientX, clientY, rect)).toEqual({ x: fx, y: fy });
      }
    }
  });

  it('is exact under zoom=2 / pan=(100,−50) on a letterboxed content rect', () => {
    // Container 800×600; content 800×450 (16:9) letterboxed 75px down; the
    // rect the browser reports for the transformed content element: scaled
    // about the container centre (400,300), then translated by the pan.
    const zoom = 2;
    const pan = { x: 100, y: -50 };
    const content = {
      left: 400 + (0 - 400) * zoom + pan.x,
      top: 300 + (75 - 300) * zoom + pan.y,
      width: 800 * zoom,
      height: 450 * zoom,
    };
    const clientX = content.left + 0.25 * content.width;
    const clientY = content.top + 0.75 * content.height;
    expect(pointInRect(clientX, clientY, content)).toEqual({ x: 0.25, y: 0.75 });
    // …and the same pointer through the OUTER container rect drifts — the bug
    // this helper replaces ((s−c)(1−1/zoom) + pan/zoom + letterbox offset).
    const container = { left: 0, top: 0, width: 800, height: 600 };
    expect(pointInRect(clientX, clientY, container)).not.toEqual({ x: 0.25, y: 0.75 });
  });

  it('throws loudly on a degenerate rect instead of silently returning centre', () => {
    expect(() => pointInRect(10, 10, { left: 0, top: 0, width: 0, height: 100 })).toThrow(
      /non-positive size/,
    );
    expect(() => pointInRect(10, 10, { left: 0, top: 0, width: 100, height: 0 })).toThrow(
      /non-positive size/,
    );
  });
});
