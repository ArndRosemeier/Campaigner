export interface AspectNormalizedImage {
  blob: Blob;
  width: number;
  height: number;
  action: 'none' | 'letterboxed';
}

/**
 * Forces an image to the layout's exact aspect without cropping structural
 * content. The visible guard action is persisted by the encounter run step.
 */
export async function normalizeImageAspect(
  blob: Blob,
  columns: number,
  rows: number,
  canvasFactory: () => HTMLCanvasElement = () => document.createElement('canvas'),
): Promise<AspectNormalizedImage> {
  if (!Number.isInteger(columns) || columns < 1 || !Number.isInteger(rows) || rows < 1) {
    throw new Error('Layout dimensions must be positive integers');
  }
  const bitmap = await createImageBitmap(blob);
  const targetRatio = columns / rows;
  const sourceRatio = bitmap.width / bitmap.height;
  if (Math.abs(sourceRatio - targetRatio) < 0.0001) {
    const result = { blob, width: bitmap.width, height: bitmap.height, action: 'none' as const };
    bitmap.close();
    return result;
  }

  const width = sourceRatio > targetRatio
    ? bitmap.width
    : Math.max(1, Math.round(bitmap.height * targetRatio));
  const height = sourceRatio > targetRatio
    ? Math.max(1, Math.round(bitmap.width / targetRatio))
    : bitmap.height;
  const canvas = canvasFactory();
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) {
    bitmap.close();
    throw new Error('Canvas 2D context is unavailable for aspect normalization');
  }
  context.fillStyle = '#111827';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, Math.floor((width - bitmap.width) / 2), Math.floor((height - bitmap.height) / 2));
  bitmap.close();
  const encoded = await canvasBlob(canvas);
  return { blob: encoded, width, height, action: 'letterboxed' };
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null || blob.size === 0) {
          reject(new Error('Aspect-normalization canvas produced no image'));
          return;
        }
        resolve(blob);
      },
      'image/webp',
      0.9,
    );
  });
}
