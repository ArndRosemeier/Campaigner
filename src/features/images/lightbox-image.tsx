import type { JSX } from 'react';

import type { Id } from '@/domain';
import { useImageUrl } from '@/features/images/use-image-url';

/**
 * Full-size image view (07-MILESTONE-3 M3-A, shared with the entity card's
 * fullscreen preview since M4-C): resolves the image id to an object URL and
 * renders it as large as the container allows.
 */
export function LightboxImage({ imageId }: { imageId: Id }): JSX.Element | null {
  const url = useImageUrl(imageId);
  if (url === null) return null;
  return (
    <img
      src={url}
      alt="Artifact image, large view"
      className="max-h-96 w-auto self-center rounded-md border object-contain"
    />
  );
}
