import type { JSX } from 'react';

import type { Id } from '@/domain';
import { cn } from '@/lib/utils';
import { useImageUrl } from '@/features/images/use-image-url';

/**
 * Large image view (07-MILESTONE-3 M3-A, shared with the entity card's
 * fullscreen preview since M4-C): resolves the image id to an object URL and
 * renders it as large as the container allows, never cropped. The default
 * carries no fixed size cap (`max-h-full` fills whatever encloses it) —
 * `className` overrides the size classes (tailwind-merge), so fullscreen
 * consumers pass viewport-filling ones: the module reader's peek viewer and
 * the editor's artifact lightbox do exactly that.
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
      className={cn('max-h-full w-auto self-center rounded-md border object-contain', className)}
    />
  );
}
