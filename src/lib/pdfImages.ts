import type { Id } from '@/domain';
import { getImage } from '@/db/imageRepo';
import { blobToScaledDataUrl } from '@/lib/imageIntake';

/**
 * PDF image pipeline (docs/17 row 108). THE one door through which an image
 * reaches a pdfmake document, and the reason it exists:
 *
 * - **pdfmake embeds exactly three of its auto-registered data-URL media
 *   types**: `jpeg`, `jpg` and `png` (`pdfmake/build/pdfmake.js` registers
 *   those at import time). Any other one — a WebP data URL above all, which
 *   is what the app's own intake produces where the canvas has no WebP
 *   encoder — makes pdfmake throw while it MEASURES the image, deep inside
 *   the layout pass, with a message that names neither the image nor the
 *   site. `assertPdfmakeImageDataUrl` therefore pins the boundary HERE, on
 *   the data URL itself, before it can become an `image` node: an unsupported
 *   format is a LOUD, NAMED failure, never a PDF with a missing or broken
 *   image (AGENTS rules 1–2).
 * - **Image measurement is synchronous and total.** pdfmake resolves every
 *   image while building the document, so a data URL that is not ready is not
 *   a slow image, it is a broken build. Every image is preloaded here as a
 *   data URL before a definition is built; nothing is fetched mid-layout.
 * - **A failed image is recorded, never swallowed.** The old loader caught
 *   decode failures to `null` and the renderer silently skipped an image it
 *   could not find — a build that lost the owner's art with no trace. Here
 *   every failure is a `PdfImageFailure` naming the image, the site it was
 *   wanted at, and the reason; the renderer prints a loud placeholder for it
 *   and the export surface reports the count (docs/17 row 108, C3).
 *
 * The decode/encode step is an INJECTABLE SEAM (`PdfImageCodec`) for one
 * measured reason: jsdom implements neither `createImageBitmap` nor a real
 * canvas, so the default codec cannot run in a test and NOTHING in this repo
 * could prove that a PDF carrying an image renders at all (gate hole D-i).
 * The default codec is the browser one and there is no silent fallback of any
 * kind: a codec that fails produces a recorded failure, never a substitute.
 */

/** Long-edge budget for an artifact/module COVER inside a PDF (unchanged). */
export const PDF_COVER_MAX_LONG_EDGE = 1024;

/**
 * Long-edge budget for a MAP PLATE. Intake keeps maps at
 * `MAP_IMAGE_MAX_LONG_EDGE` (4096) precisely because a full-table map at the
 * artwork cap is unreadable; the PDF loader downscaled everything to 1024,
 * which made every printed battlemap soft. A map now prints at its stored
 * resolution (the same 4096 ceiling intake enforces), while covers keep the
 * 1024 discipline measured for file size.
 */
export const PDF_MAP_MAX_LONG_EDGE = 4096;

/**
 * The data-URL media types pdfmake registers for image embedding. A
 * `data:image/webp;base64,…` THROWS inside pdfmake's image measurement.
 */
const PDFMAKE_IMAGE_MEDIA_TYPES: readonly string[] = ['image/jpeg', 'image/jpg', 'image/png'];

/** An image this pipeline refused or could not prepare — always loud. */
export class PdfImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfImageError';
  }
}

/**
 * Throws `PdfImageError` unless the data URL's own media type is one pdfmake
 * can embed. Returns the data URL so call sites read
 * `image: assertPdfmakeImageDataUrl(url, where)`.
 */
export function assertPdfmakeImageDataUrl(dataUrl: string, where: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  if (match === null) {
    throw new PdfImageError(
      `${where}: the image data URL has no media type — a PDF can only embed ${PDFMAKE_IMAGE_MEDIA_TYPES.join(', ')}`,
    );
  }
  const mediaType = (match[1] ?? '').toLowerCase();
  if (!PDFMAKE_IMAGE_MEDIA_TYPES.includes(mediaType)) {
    throw new PdfImageError(
      `${where}: ${mediaType} cannot be embedded in a PDF — pdfmake registers only ${PDFMAKE_IMAGE_MEDIA_TYPES.join(', ')} data URLs (a WebP image must be re-encoded first)`,
    );
  }
  return dataUrl;
}

/**
 * The decode/encode step of the image pipeline. The default implementation is
 * the browser canvas (`blobToScaledDataUrl`); tests inject a codec because
 * jsdom has no image decoder. A codec MUST produce a data URL pdfmake can
 * embed or THROW — `assertPdfmakeImageDataUrl` re-checks its output, so a
 * codec cannot smuggle an unsupported format past the boundary.
 */
export type PdfImageCodec = (
  bytes: Uint8Array,
  mimeType: string,
  maxLongEdge: number,
) => Promise<{ dataUrl: string; width: number; height: number }>;

/** The browser codec: EXIF-safe decode, downscale, JPEG re-encode. */
export const canvasPdfImageCodec: PdfImageCodec = async (bytes, mimeType, maxLongEdge) =>
  // A fresh view over a fresh ArrayBuffer: `StoredImage.bytes` is a
  // `Uint8Array<ArrayBufferLike>` (it may come back from another realm), which
  // `Blob`'s part type rejects.
  blobToScaledDataUrl(new Blob([new Uint8Array(bytes)], { type: mimeType }), maxLongEdge);

/** One image the document wants, with the site that wants it. */
export interface PdfImageRequest {
  id: Id;
  /** `PDF_COVER_MAX_LONG_EDGE` or `PDF_MAP_MAX_LONG_EDGE`. */
  maxLongEdge: number;
  /** The addressable site, e.g. `the map of “Pier Ambush”`. */
  where: string;
}

/** One image that could not be embedded, named with its site and reason. */
export interface PdfImageFailure {
  id: Id;
  where: string;
  reason: string;
}

/** The preloaded image set a definition is built from. */
export interface PdfImages {
  dataUrls: Readonly<Record<string, string>>;
  failures: readonly PdfImageFailure[];
}

/** No images at all — the honest empty set (every wanted image then fails). */
export const NO_PDF_IMAGES: PdfImages = { dataUrls: {}, failures: [] };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Loads every requested image as a pdfmake-ready data URL. Never throws for a
 * missing or undecodable image: each failure lands on `failures` with its
 * site and reason (the caller prints a placeholder AND reports it), so one
 * broken blob cannot cost the owner the whole document.
 */
export async function loadPdfImages(
  requests: readonly PdfImageRequest[],
  options: { codec?: PdfImageCodec } = {},
): Promise<PdfImages> {
  const codec = options.codec ?? canvasPdfImageCodec;
  const dataUrls: Record<string, string> = {};
  const failures: PdfImageFailure[] = [];
  // One load per image row (a blob referenced as a cover AND as a map is
  // prepared once, at the LARGER of the two budgets, so it is never the softer
  // of the two), with every site that wanted it named in the failure.
  const wanted = new Map<Id, { budget: number; wheres: string[] }>();
  for (const request of requests) {
    const entry = wanted.get(request.id);
    if (entry === undefined) {
      wanted.set(request.id, { budget: request.maxLongEdge, wheres: [request.where] });
    } else {
      entry.budget = Math.max(entry.budget, request.maxLongEdge);
      entry.wheres.push(request.where);
    }
  }
  for (const [id, entry] of wanted) {
    const where = entry.wheres.join(' and ');
    const stored = await getImage(id).catch((error: unknown) => {
      failures.push({
        id,
        where,
        reason: `reading the stored image failed: ${errorText(error)}`,
      });
      return undefined;
    });
    if (stored === undefined) {
      if (!failures.some((failure) => failure.id === id)) {
        failures.push({ id, where, reason: 'no stored image row exists for this id' });
      }
      continue;
    }
    try {
      const prepared = await codec(stored.bytes, stored.mimeType, entry.budget);
      dataUrls[id] = assertPdfmakeImageDataUrl(prepared.dataUrl, where);
    } catch (error) {
      failures.push({ id, where, reason: errorText(error) });
    }
  }
  return { dataUrls, failures };
}

/** The preloaded data URL for an image, or undefined (see `failureFor`). */
export function imageDataUrlFor(images: PdfImages, id: Id | null): string | undefined {
  if (id === null) return undefined;
  return images.dataUrls[id];
}

/** The recorded failure of an image, or undefined when it loaded. */
export function failureFor(images: PdfImages, id: Id): PdfImageFailure | undefined {
  return images.failures.find((entry) => entry.id === id);
}
