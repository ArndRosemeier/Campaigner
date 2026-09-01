import type { JSX } from 'react';

import type { Id } from '@/domain';
import { cn } from '@/lib/utils';
import { useImageUrl } from '@/features/images/use-image-url';

/**
 * Large image view (07-MILESTONE-3 M3-A, shared with the entity card's
 * fullscreen preview since M4-C): resolves the image id to an object URL and
 * renders it as large as the container allows, never cropped. `className`
 * overrides the size classes (the module reader's fullscreen viewer passes
 * viewport-filling ones).
 */
export function LightboxImage({
  imageId,
  className,
}: {
  imageId: Id;
  className?: string;
}): JSX.Element | null {
  const url = useImageUrl(imageId);
  if (url === null) return null;
  return (
    <img
      src={url}
      alt="Artifact image, large view"
      className={cn('max-h-96 w-auto self-center rounded-md border object-contain', className)}
    />
  );
}
