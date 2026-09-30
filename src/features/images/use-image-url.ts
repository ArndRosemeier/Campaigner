import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { getImage } from '@/db/imageRepo';
import { imageBlob } from '@/domain';
import type { Id } from '@/domain';

/**
 * Image display hooks (07-MILESTONE-3 M3-A): resolve image ids to object URLs
 * that are revoked when the row changes or the consumer unmounts.
 */

/** Object URL for an image row's blob, or null while loading/missing. */
export function useImageUrl(imageId: Id | null | undefined): string | null {
  const image = useLiveQuery(
    () => (imageId === undefined || imageId === null ? undefined : getImage(imageId)),
    [imageId],
  );
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (image === undefined) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(imageBlob(image));
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [image]);
  return url;
}
