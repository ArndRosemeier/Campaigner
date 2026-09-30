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
  /**
   * What generating this image cost (docs/17 row 421): the price the image API
   * reported for the call that produced it, and how many images that call
   * returned (a run asks for several candidates in ONE call, so the price is
   * the call's, never divided by a guess). Absent or `null` = not recorded —
   * an upload, a provider that reported no cost, or an image stored before the
   * field.
   */
  generationCost: z
    .object({ usd: z.number().nonnegative(), images: z.number().int().positive() })
    .nullable()
    .optional(),
});

export type StoredImage = z.infer<typeof storedImageSchema>;
export type ImageGenerationCost = NonNullable<StoredImage['generationCost']>;

/**
 * The stored cost of the images ONE generation call produced (docs/17 row
 * 421): the price the image API reported for the call, and how many images it
 * returned. `null` when the API reported no cost. ONE conversion for every
 * image writer (the run engine's three and the one-image seam).
 */
export function generationCostOf(generated: {
  costUsd: number | null;
  images: readonly unknown[];
}): ImageGenerationCost | null {
  return generated.costUsd === null
    ? null
    : { usd: generated.costUsd, images: generated.images.length };
}

/**
 * The price line of an image's details (docs/17 row 421), or `null` for an
 * upload (nothing was generated). Up to four decimals, trailing zeros trimmed
 * to cents ("$0.04", "$0.0035"); a call that produced several candidates names
 * its count, because the price is the CALL's — never divided by a guess.
 */
export function imageGenerationCostLabel(
  image: Pick<StoredImage, 'source' | 'generationCost'>,
): string | null {
  if (image.source !== 'generated') return null;
  const cost = image.generationCost;
  if (cost === undefined || cost === null) return 'price not recorded';
  const [whole = '0', fraction = ''] = cost.usd.toFixed(4).split('.');
  const trimmed = fraction.replace(/0+$/, '').padEnd(2, '0');
  const price = `$${whole}.${trimmed}`;
  return cost.images === 1 ? price : `${price} for the call that made ${String(cost.images)} images`;
}

/**
 * THE provenance a copied image carries over (docs/17 row 421): the prompt,
 * the model and what generating it cost. The library adoption clone, the
 * portrait-cache clone and the cached-portrait reuse all copy through this ONE
 * function, so a provenance field added later cannot be dropped by one copy.
 */
export function imageProvenanceOf(
  image: Pick<StoredImage, 'prompt' | 'model' | 'generationCost'>,
): Pick<StoredImage, 'prompt' | 'model' | 'generationCost'> {
  return {
    prompt: image.prompt,
    model: image.model,
    ...(image.generationCost === undefined ? {} : { generationCost: image.generationCost }),
  };
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
