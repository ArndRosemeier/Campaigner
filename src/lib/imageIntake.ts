import { IMAGE_MAX_LONG_EDGE, MAP_IMAGE_MAX_LONG_EDGE } from '@/domain';

/**
 * Image intake (07-MILESTONE-3 M3-A §Storage): every image that enters the
 * app — upload or generation — is decoded EXIF-safe, scaled to at most
 * `IMAGE_MAX_LONG_EDGE` on the long edge, and re-encoded as WebP (quality
 * 0.85). The *actually encoded* format is reported: `canvas.toBlob` silently
 * falls back (Safari has no WebP encoder), so `image/webp` is a target, not
 * a guarantee — callers must store the reported mime type.
 */

export interface IntakeResult {
  blob: Blob;
  width: number;
  height: number;
  mimeType: string;
}

/** Pure scale factor for fitting within a square max-edge budget. */
export function scaleForLongEdge(
  width: number,
  height: number,
  maxLongEdge: number = IMAGE_MAX_LONG_EDGE,
): number {
  const longest = Math.max(width, height);
  if (longest <= maxLongEdge) return 1;
  return maxLongEdge / longest;
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      resolve(blob);
    }, mimeType, quality);
  });
}

/**
 * Normalizes an image blob: EXIF-oriented decode, downscale, WebP re-encode.
 * Falls back to the original blob (with its own type) when the canvas
 * pipeline is unavailable or produces nothing.
 */
export async function intakeImage(
  source: Blob,
  opts: { maxLongEdge?: number; role?: 'artwork' | 'map' } = {},
): Promise<IntakeResult> {
  // Map-role images (M5-C) keep more resolution: a full-table map at the
  // artwork cap is unreadably blurry on a tablet.
  const maxLongEdge =
    opts.maxLongEdge ??
    (opts.role === 'map' ? MAP_IMAGE_MAX_LONG_EDGE : IMAGE_MAX_LONG_EDGE);
  const orientation = { imageOrientation: 'from-image' } as ImageBitmapOptions;
  const bitmap = await createImageBitmap(source, orientation);
  try {
    const scale = scaleForLongEdge(bitmap.width, bitmap.height, maxLongEdge);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('canvas 2d context unavailable');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const encoded = await canvasToBlob(canvas, 'image/webp', 0.85);
    if (encoded === null || encoded.size === 0) throw new Error('canvas encoding produced no data');
    return {
      blob: encoded,
      width: canvas.width,
      height: canvas.height,
      // The browser's answer, not our request: 'image/webp' or a fallback
      // (typically 'image/png' where WebP encoding is unsupported).
      mimeType: encoded.type === '' ? 'image/webp' : encoded.type,
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Scaled JPEG/PNG data URL for PDF embedding (pdfmake accepts data URLs);
 * downscales to `maxLongEdge` so exported PDFs stay small.
 */
export async function blobToScaledDataUrl(
  blob: Blob,
  maxLongEdge = 1024,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const scale = scaleForLongEdge(bitmap.width, bitmap.height, maxLongEdge);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('canvas 2d context unavailable');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return {
      dataUrl: canvas.toDataURL('image/jpeg', 0.85),
      width: canvas.width,
      height: canvas.height,
    };
  } finally {
    bitmap.close();
  }
}
