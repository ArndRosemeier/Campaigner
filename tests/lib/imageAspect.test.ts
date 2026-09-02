import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeImageAspect } from '@/lib/imageAspect';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function bitmap(width: number, height: number): { value: ImageBitmap; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  return { value: { width, height, close }, close };
}

describe('normalizeImageAspect', () => {
  it('returns an already exact image without re-encoding', async () => {
    const source = new Blob(['map'], { type: 'image/webp' });
    const sourceBitmap = bitmap(1200, 900);
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve(sourceBitmap.value)));

    await expect(normalizeImageAspect(source, 4, 3)).resolves.toEqual({
      blob: source,
      width: 1200,
      height: 900,
      action: 'none',
    });
    expect(sourceBitmap.close).toHaveBeenCalled();
  });

  it('letterboxes to the exact requested aspect and records the action', async () => {
    const sourceBitmap = bitmap(1000, 1000);
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve(sourceBitmap.value)));
    const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(canvas, 'toBlob').mockImplementation((callback) => {
      callback(new Blob(['normalized'], { type: 'image/webp' }));
    });
    const result = await normalizeImageAspect(new Blob(['map']), 16, 9, () => canvas);
    expect(result.action).toBe('letterboxed');
    expect(result.width / result.height).toBeCloseTo(16 / 9, 3);
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, result.width, result.height);
    expect(context.drawImage).toHaveBeenCalled();
    expect(sourceBitmap.close).toHaveBeenCalled();
  });

  it('rejects invalid target dimensions loudly', async () => {
    await expect(normalizeImageAspect(new Blob(), 0, 3)).rejects.toThrow(/positive integers/);
  });
});
