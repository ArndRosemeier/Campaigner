import { describe, expect, it, vi } from 'vitest';

import { IMAGE_MAX_LONG_EDGE } from '@/domain';
import { scaleForLongEdge, intakeImage, blobToScaledDataUrl } from '@/lib/imageIntake';

/**
 * Image intake (07-MILESTONE-3 M3-A §Storage): pure scale math plus the
 * canvas pipeline with stubbed bitmap/canvas primitives (jsdom has neither).
 */

describe('scaleForLongEdge', () => {
  it('keeps images within the cap at scale 1 when already small', () => {
    expect(scaleForLongEdge(800, 600)).toBe(1);
    expect(scaleForLongEdge(IMAGE_MAX_LONG_EDGE, IMAGE_MAX_LONG_EDGE)).toBe(1);
  });

  it('scales the long edge down to the cap, preserving aspect', () => {
    const scale = scaleForLongEdge(3200, 1600, 1600);
    expect(scale).toBeCloseTo(0.5);
    expect(3200 * scale).toBeCloseTo(1600);
    expect(1600 * scale).toBeCloseTo(800);

    // Portrait orientation: the *height* is the long edge.
    const portrait = scaleForLongEdge(800, 3200, 1600);
    expect(portrait).toBeCloseTo(0.5);
    expect(3200 * portrait).toBeCloseTo(1600);
  });
});

describe('intakeImage', () => {
  it('decodes, downscales, and reports the actually encoded format', async () => {
    const drawImage = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() =>
        Promise.resolve({ width: 3200, height: 1600, close: vi.fn() }),
      ),
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    // No WebP encoder available: toBlob falls back to PNG — the reported
    // mimeType must be the browser's answer, not our request.
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
      (callback: BlobCallback | null) => {
        callback?.(new Blob(['png-bytes'], { type: 'image/png' }));
      },
    );

    try {
      const result = await intakeImage(new Blob(['original'], { type: 'image/jpeg' }));
      expect(drawImage).toHaveBeenCalled();
      expect(result.width).toBe(1600);
      expect(result.height).toBe(800);
      expect(result.mimeType).toBe('image/png');
      expect(result.blob.type).toBe('image/png');
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});

describe('blobToScaledDataUrl', () => {
  it('downscales to the PDF budget and returns a data URL', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve({ width: 2400, height: 1200, close: vi.fn() })),
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/jpeg;base64,ZmFrZQ==',
    );

    try {
      const result = await blobToScaledDataUrl(new Blob(['x'], { type: 'image/webp' }), 1024);
      expect(result.dataUrl).toBe('data:image/jpeg;base64,ZmFrZQ==');
      expect(result.width).toBe(1024);
      expect(result.height).toBe(512);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});
