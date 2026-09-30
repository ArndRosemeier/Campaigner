import { useLiveQuery } from 'dexie-react-hooks';

import { getImage } from '@/db/imageRepo';
import type { Id } from '@/domain';

/**
 * PROVENANCE (docs/17 row 93): the model id recorded on an image row
 * (`storedImageSchema.model` — the image half of the owner's request already
 * existed; this exposes it to the display surfaces).
 *
 * `undefined` while loading, `''` when the row records nothing (an upload, or
 * a row written before recording) — `''` displays as NOTHING, exactly like
 * the text half. `useImageUrl` reads the same row through the same live query
 * boundary, so the two never disagree about which image is on screen.
 */
export function useImageModel(imageId: Id | null | undefined): string | undefined {
  const image = useLiveQuery(
    () => (imageId === undefined || imageId === null ? undefined : getImage(imageId)),
    [imageId],
  );
  return image === undefined ? undefined : image.model;
}
