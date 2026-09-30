import type { JSX } from 'react';

import type { Id } from '@/domain';
import { cn } from '@/lib/utils';
import { useImageUrl } from '@/features/images/use-image-url';

/** Fixed-size thumbnail for tree rows and gallery strips (M3-A). */
export function ImageThumb({
  imageId,
  alt,
  size = 20,
  rounded = false,
  className,
}: {
  imageId: Id | null | undefined;
  alt: string;
  size?: number;
  rounded?: boolean;
  className?: string;
}): JSX.Element | null {
  const url = useImageUrl(imageId);
  if (url === null) return null;
  return (
    <img
      src={url}
      alt={alt}
      width={size}
      height={size}
      className={cn('shrink-0 object-cover', rounded && 'rounded-sm', className)}
      style={{ width: size, height: size }}
      loading="lazy"
    />
  );
}
