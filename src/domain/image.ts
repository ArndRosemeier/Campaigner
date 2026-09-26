import { z } from 'zod';

import { BaseEntitySchema } from '@/domain/entity';

/**
 * Stored images (07-MILESTONE-3 M3-A): binary payloads live in their own
 * table — never inside artifact JSON, so artifacts (and their revision
 * snapshots) stay small and cheap to clone. Artifacts reference images by id
 * (`imageIds`/`coverImageId`); blobs are deleted when nothing references them
 * anymore (see imageRepo).
 *
 * Payloads are stored as `Uint8Array` bytes, not Blobs: structured clone
 * (IndexedDB and fake-indexeddb in tests) round-trips typed arrays reliably,
 * while Blob instances do not survive cloning. Consumers rebuild a Blob via
 * `imageBlob()` at the boundary.
 */
export const storedImageSchema = z.object({
  ...BaseEntitySchema.shape,
  /** `null` for library images (10-MILESTONE-6 D2): a published artifact's
   * images travel with it and leave the old campaign's prune scope. */
  campaignId: z.uuid().nullable(),
  /** Binary payload, re-encoded at intake, ≤1600px long edge (maps: ≤4096). */
  bytes: z.custom<Uint8Array<ArrayBuffer>>((value) => value instanceof Uint8Array),
  /** The *actually encoded* format — `image/webp` is the intake target, but
   * browsers without a WebP encoder fall back to PNG (07-MILESTONE-3 M3-A). */
  mimeType: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Generation prompt; '' for uploads. */
  prompt: z.string(),
  /** Image model id; '' for uploads. */
  model: z.string(),
  source: z.enum(['generated', 'uploaded']),
  /** M5-C: `map` images are battlemaps — bypass the 1600px re-encode and
   * are the only images map pickers offer. */
  role: z.enum(['artwork', 'map']).default('artwork'),
  /** The gallery's ONE field for favourites (owner request, docs/17 row 366):
   * non-null means favourited, and the VALUE — the moment it was favourited —
   * orders the favourites, newest above older. Deliberately ONE field, never a
   * boolean beside this timestamp: a second flag could disagree with the order
   * it carries. ADDITIVE and NULLISH like the rule-chunk payload slots
   * (docs/18 §2.1): Dexie reads are raw, so a row written before this field
   * genuinely lacks the key and answers `undefined`, which the ONE reading
   * below treats as NOT favourited. NO Dexie version, no index, no migration. */
  favouritedAt: z.number().int().nullish(),
});

export type StoredImage = z.infer<typeof storedImageSchema>;

/**
 * Is this gallery row a favourite? (docs/17 row 366)
 *
 * THE one reading of the flag, so the sort, the star's state and the toggle
 * cannot drift. `== null` is deliberate and covers BOTH `null` (a parsed row,
 * or an un-favourited one) and `undefined` (a stored row written before the
 * field existed — Dexie reads are raw, so no parse repairs it on the way out)
 * — both mean "not a favourite", never an error.
 */
export function isImageFavourite(image: StoredImage): boolean {
  return image.favouritedAt != null;
}

/**
 * The gallery's display order (owner request, docs/17 row 366): favourites
 * first, the newest favourite above the older ones, and every NON-favourite in
 * exactly the order it arrived in — the artifact's own `imageIds` order, which
 * is what the gallery rendered before this feature. Nothing else is re-sorted.
 *
 * With nothing favourited this returns the input order unchanged, which is the
 * slice's strongest pin: flag-off is byte-identical to the pre-change gallery.
 * `Array.prototype.sort` is STABLE (ES2019), so two favourites stamped in the
 * same millisecond keep the gallery's own relative order.
 */
export function sortGalleryImages(images: readonly StoredImage[]): StoredImage[] {
  const favourites = images.filter(isImageFavourite);
  const rest = images.filter((image) => !isImageFavourite(image));
  favourites.sort((a, b) => (b.favouritedAt ?? 0) - (a.favouritedAt ?? 0));
  return [...favourites, ...rest];
}

/** Rebuilds a displayable Blob from a stored image row. */
export function imageBlob(image: StoredImage): Blob {
  return new Blob([image.bytes], { type: image.mimeType });
}

/** Long-edge cap applied on intake (07-MILESTONE-3 M3-A §Storage). */
export const IMAGE_MAX_LONG_EDGE = 1600;

/** Long-edge cap for MAP-role images (09-MILESTONE-5 M5-C) — a full-table
 * map at 1600px is unreadably blurry on a tablet. */
export const MAP_IMAGE_MAX_LONG_EDGE = 4096;

/** Default image generation model (07-MILESTONE-3 M3-A §Settings). */
export const DEFAULT_IMAGE_MODEL = 'google/gemini-2.5-flash-image';
