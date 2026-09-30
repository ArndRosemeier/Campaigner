import type { JSX } from 'react';

import type { Id } from '@/domain';
import { WriterModelId } from '@/components/writer-model-id';
import { cn } from '@/lib/utils';
import { useImageModel } from '@/features/images/use-image-model';
import { useImageUrl } from '@/features/images/use-image-url';

/**
 * Large image view (07-MILESTONE-3 M3-A, shared with the entity card's
 * fullscreen preview since M4-C): resolves the image id to an object URL and
 * renders it with `object-contain` — never cropped, never distorted.
 *
 * Fill-viewport contract: a fullscreen viewer (the editor's artifact
 * lightbox, the peek modal's fullscreen viewer) must hand the img the WHOLE
 * reserved box via viewport-filling size classes (`h-… w-full …` — tailwind-
 * merged over this default) so `object-contain` can fit the picture into it,
 * scaling UP past natural size included. CSS `max-*` constraints only ever
 * shrink, so capping with them renders a generated 1024×1024 image at half a
 * 2560px screen. The default here stays the bounded-embed fit
 * (`max-h-full w-auto`); the `className` overrides the size classes.
 *
 * PROVENANCE (docs/17 row 93): "a small id below images indicating the image
 * model". The caption is a SIBLING of the img, never a wrapper: the fill-
 * viewport contract above is about the img's own box, so wrapping it would
 * break every caller that hands in `h-[calc(100dvh-…)] w-full`. An upload —
 * or any row with no recorded model — renders NOTHING.
 */
export function LightboxImage({
  imageId,
  className,
}: {
  imageId: Id;
  className?: string;
}): JSX.Element | null {
  const url = useImageUrl(imageId);
  const imageModel = useImageModel(imageId);
  if (url === null) return null;
  return (
    <>
      <img
        src={url}
        alt="Artifact image, large view"
        className={cn('max-h-full w-auto self-center rounded-md border object-contain', className)}
      />
      <WriterModelId model={imageModel} testId="lightbox-image-model" label="Image model" />
    </>
  );
}
