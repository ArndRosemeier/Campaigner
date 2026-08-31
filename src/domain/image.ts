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
  campaignId: z.uuid(),
  /** Binary payload, re-encoded at intake, ≤1600px long edge. */
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
});

export type StoredImage = z.infer<typeof storedImageSchema>;

/** Rebuilds a displayable Blob from a stored image row. */
export function imageBlob(image: StoredImage): Blob {
  return new Blob([image.bytes], { type: image.mimeType });
}

/** Long-edge cap applied on intake (07-MILESTONE-3 M3-A §Storage). */
export const IMAGE_MAX_LONG_EDGE = 1600;

/** Default image generation model (07-MILESTONE-3 M3-A §Settings). */
export const DEFAULT_IMAGE_MODEL = 'google/gemini-2.5-flash-image';
