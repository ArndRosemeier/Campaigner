import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { ZoomableImage } from '@/features/images/zoomable-image';

/**
 * Fullscreen image gestures (05-UI.md §Tablet): pinch zoom anchored on the
 * gesture midpoint, one-finger pan while zoomed, double-tap toggle, wheel
 * zoom, and tap-to-close only at fit scale (deferred past the double-tap
 * window). Pointer events are dispatched against the gesture container; the
 * window-level move/up listeners receive them by bubbling.
 */

vi.mock('@/features/images/use-image-url', () => ({
  useImageUrl: vi.fn(() => 'blob:mock-image'),
}));

function renderViewer(onCloseRequest: Mock = vi.fn()): { onClose: Mock; transform: HTMLElement } {
  render(
    <ZoomableImage
      imageId="img-1"
      onCloseRequest={onCloseRequest}
      className="max-h-full max-w-full border-0"
    />,
  );
  return {
    onClose: onCloseRequest,
    transform: screen.getByTestId('zoomable-image-transform'),
  };
}

function tap(x: number, y: number, pointerId = 1): void {
  const container = screen.getByTestId('zoomable-image');
  fireEvent.pointerDown(container, { pointerId, clientX: x, clientY: y, isPrimary: true });
  fireEvent.pointerUp(container, { pointerId, clientX: x, clientY: y, isPrimary: true });
}

beforeEach(() => {
  // jsdom lays out nothing; the gesture clamp math needs a real viewport size.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ZoomableImage', () => {
  it('renders the image through the lightbox renderer', () => {
    renderViewer();

    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:mock-image');
  });

  it('closes on a single tap at fit scale, after the double-tap window', () => {
    const { onClose } = renderViewer();

    tap(400, 300);
    vi.advanceTimersByTime(100);
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('zooms to 2.5× on double tap and never closes', () => {
    const { onClose, transform } = renderViewer();

    tap(400, 300);
    vi.advanceTimersByTime(100);
    tap(402, 298);

    expect(transform.style.transform).toContain('scale(2.5)');
    vi.advanceTimersByTime(500);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('pinch zooms anchored on the gesture midpoint', () => {
    const { transform } = renderViewer();
    const container = screen.getByTestId('zoomable-image');

    fireEvent.pointerDown(container, { pointerId: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerDown(container, { pointerId: 2, clientX: 500, clientY: 300 });
    fireEvent.pointerMove(container, { pointerId: 1, clientX: 200, clientY: 300 });
    fireEvent.pointerMove(container, { pointerId: 2, clientX: 600, clientY: 300 });
    // 200px spread → 400px spread = 2× the distance, anchored at (400, 300):
    // the midpoint did not move, so the pan stays at zero.
    expect(transform.style.transform).toContain('scale(2)');
    expect(transform.style.transform).toContain('translate(0px');

    fireEvent.pointerUp(container, { pointerId: 1, clientX: 200, clientY: 300 });
    fireEvent.pointerUp(container, { pointerId: 2, clientX: 600, clientY: 300 });
    expect(transform.style.transform).toContain('scale(2)');
  });

  it('pans with one finger while zoomed and clamps to the image bounds', () => {
    const { transform } = renderViewer();
    const container = screen.getByTestId('zoomable-image');

    // Zoom to 2× via double tap, then drag 100px right.
    tap(400, 300);
    vi.advanceTimersByTime(100);
    tap(400, 300);
    fireEvent.pointerDown(container, { pointerId: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(container, { pointerId: 1, clientX: 400, clientY: 300 });
    fireEvent.pointerUp(container, { pointerId: 1, clientX: 400, clientY: 300 });

    expect(transform.style.transform).toContain('translate(100px');

    // A pan far past the scaled overflow clamps at ±((scale-1)·width/2) = 600.
    fireEvent.pointerDown(container, { pointerId: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(container, { pointerId: 1, clientX: 1200, clientY: 300 });
    expect(transform.style.transform).toContain('translate(600px');
    fireEvent.pointerUp(container, { pointerId: 1, clientX: 1200, clientY: 300 });
  });

  it('does not close on a tap while zoomed (double tap resets instead)', () => {
    const { onClose, transform } = renderViewer();

    // Double tap zooms in; the pending close from the first tap is canceled.
    tap(400, 300);
    tap(400, 300);
    vi.advanceTimersByTime(400);
    expect(onClose).not.toHaveBeenCalled();
    expect(transform.style.transform).toContain('scale(2.5)');

    // A single tap while zoomed neither closes nor resets...
    tap(500, 300);
    vi.advanceTimersByTime(400);
    expect(onClose).not.toHaveBeenCalled();
    expect(transform.style.transform).toContain('scale(2.5)');
    // ...and the second tap of another double tap resets to fit.
    tap(500, 300);
    expect(transform.style.transform).not.toContain('scale(2.5)');
  });

  it('zooms with the wheel toward the cursor', () => {
    const { transform } = renderViewer();

    fireEvent.wheel(screen.getByTestId('zoomable-image'), {
      deltaY: -240,
      clientX: 400,
      clientY: 300,
    });

    expect(transform.style.transform).toMatch(/scale\(1\.4/);
  });
});
