import { useRef, useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ImageIcon, MapIcon, PlusIcon, SparklesIcon, StarIcon, Trash2Icon } from 'lucide-react';

import { artifactRepo } from '@/db';
import { removeImageFromArtifact } from '@/db/artifactRepo';
import { createImage, listImagesByIds, setImageRole } from '@/db/imageRepo';
import type { AnyArtifact, Id, StoredImage } from '@/domain';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { toastError, toastSuccess } from '@/lib/toast';
import { intakeImage } from '@/lib/imageIntake';
import { useIllustrationRequest } from '@/features/campaign/illustrationRequest';
import { LightboxImage } from '@/features/images/lightbox-image';
import { useImageUrl } from '@/features/images/use-image-url';

/**
 * Editor Images section (07-MILESTONE-3 M3-A §UI): cover thumbnail, gallery
 * strip, upload, and the "Illustrate…" hand-off to the Assistant pane.
 * Image changes write straight to the artifact row (imageIds/coverImageId)
 * — they are not part of the markdown autosave draft.
 */
export function ImagesSection({ artifact }: { artifact: AnyArtifact }): JSX.Element {
  const images = useLiveQuery(
    () => listImagesByIds(artifact.imageIds),
    [artifact.imageIds.join(',')],
    [] as StoredImage[],
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [lightboxId, setLightboxId] = useState<Id | null>(null);
  const [busy, setBusy] = useState(false);
  const requestIllustration = useIllustrationRequest((state) => state.request);

  async function handleFiles(files: FileList | null): Promise<void> {
    if (files === null || files.length === 0) return;
    setBusy(true);
    try {
      const added: Id[] = [];
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) continue;
        const intake = await intakeImage(file);
        const stored = await createImage({
          campaignId: artifact.campaignId,
          blob: intake.blob,
          mimeType: intake.mimeType,
          width: intake.width,
          height: intake.height,
          source: 'uploaded',
        });
        added.push(stored.id);
      }
      if (added.length > 0) {
        const imageIds = [...artifact.imageIds, ...added];
        await artifactRepo.updateArtifact(artifact.id, {
          imageIds,
          coverImageId: artifact.coverImageId ?? (added[0] ?? null),
        });
        toastSuccess(`${added.length} image${added.length === 1 ? '' : 's'} added`);
      }
    } catch (error) {
      toastError('Image upload failed', error);
    } finally {
      setBusy(false);
      if (fileInputRef.current !== null) fileInputRef.current.value = '';
    }
  }

  async function setCover(imageId: Id): Promise<void> {
    try {
      await artifactRepo.updateArtifact(artifact.id, { coverImageId: imageId });
      toastSuccess('Cover image set');
    } catch (error) {
      toastError('Could not set cover image', error);
    }
  }

  const isEncounter = artifact.kind === 'encounter';
  const mapImageId = isEncounter && artifact.data.mapImageId !== null ? artifact.data.mapImageId : null;
  const mapUploadRef = useRef<HTMLInputElement | null>(null);

  /** Uploads a battlemap: intake keeps 4096px (role 'map'), then stamps the
   * encounter's `mapImageId` (M5-C). */
  async function handleMapFiles(files: FileList | null): Promise<void> {
    if (files === null || artifact.kind !== 'encounter') return;
    const file = Array.from(files).find((entry) => entry.type.startsWith('image/'));
    if (file === undefined) return;
    setBusy(true);
    try {
      const intake = await intakeImage(file, { role: 'map' });
      const stored = await createImage({
        campaignId: artifact.campaignId,
        blob: intake.blob,
        mimeType: intake.mimeType,
        width: intake.width,
        height: intake.height,
        source: 'uploaded',
        role: 'map',
      });
      await artifactRepo.updateArtifact(artifact.id, {
        imageIds: [...artifact.imageIds, stored.id],
        coverImageId: artifact.coverImageId ?? stored.id,
        data: { ...artifact.data, mapImageId: stored.id },
      });
      toastSuccess('Battlemap added');
    } catch (error) {
      toastError('Battlemap upload failed', error);
    } finally {
      setBusy(false);
      if (mapUploadRef.current !== null) mapUploadRef.current.value = '';
    }
  }

  async function setBattlemapNull(): Promise<void> {
    if (artifact.kind !== 'encounter') return;
    try {
      await artifactRepo.updateArtifact(artifact.id, {
        data: { ...artifact.data, mapImageId: null },
      });
    } catch (error) {
      toastError('Could not clear the battlemap', error);
    }
  }

  /** Uses an existing gallery image as the battlemap (promotes role 'map'). */
  async function setBattlemap(imageId: Id): Promise<void> {
    if (artifact.kind !== 'encounter') return;
    try {
      await setImageRole(imageId, 'map');
      await artifactRepo.updateArtifact(artifact.id, {
        data: { ...artifact.data, mapImageId: imageId },
      });
      toastSuccess('Battlemap set');
    } catch (error) {
      toastError('Could not set the battlemap', error);
    }
  }

  async function removeImage(imageId: Id): Promise<void> {
    try {
      // Shared contract with the module reader's image checkbox (M4-C):
      // detach + scrub this artifact's revision snapshots, then delete the
      // blob when nothing else references it.
      await removeImageFromArtifact(artifact.id, imageId);
      setLightboxId(null);
    } catch (error) {
      toastError('Could not remove image', error);
    }
  }

  const lightboxImage = images.find((image) => image.id === lightboxId);

  return (
    <section className="flex flex-col gap-2" data-testid="images-section">
      <h2 className="text-sm font-medium">Images</h2>
      <div className="flex flex-wrap items-center gap-2">
        {images.map((image) => (
          <button
            key={image.id}
            type="button"
            className="group relative overflow-hidden rounded-md border"
            aria-label={`Open image ${image.width}×${image.height}`}
            onClick={() => {
              setLightboxId(image.id);
            }}
          >
            <GalleryThumb imageId={image.id} />
            {artifact.coverImageId === image.id && (
              <span
                aria-label="Cover image"
                className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5"
              >
                <StarIcon aria-hidden className="size-3 text-amber-500" />
              </span>
            )}
          </button>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            fileInputRef.current?.click();
          }}
          disabled={busy}
          data-testid="upload-image"
        >
          <PlusIcon aria-hidden data-icon="inline-start" />
          Upload
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            requestIllustration(artifact.id);
          }}
          data-testid="illustrate"
        >
          <SparklesIcon aria-hidden data-icon="inline-start" />
          Illustrate…
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            void handleFiles(event.target.files);
          }}
        />
      </div>
      {images.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No images yet — upload one or ask the Illustrator.
        </p>
      )}

      {isEncounter && (
        <div className="flex flex-col gap-1.5 rounded-md border p-2" data-testid="battlemap-section">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium">Battlemap</h3>
            <div className="flex gap-1.5">
              <Button
                variant="outline"
                size="xs"
                onClick={() => {
                  mapUploadRef.current?.click();
                }}
                disabled={busy}
                data-testid="upload-battlemap"
              >
                <MapIcon aria-hidden data-icon="inline-start" />
                Upload battlemap
              </Button>
              {mapImageId !== null && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-destructive"
                  onClick={() => {
                    void setBattlemapNull();
                  }}
                  data-testid="clear-battlemap"
                >
                  Clear
                </Button>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Battlemaps come from the two generation actions above — Regenerate everything builds a
            new layout and map, Repopulate keeps the map. Nothing else generates one automatically;
            or upload one by hand. Clear removes the battlemap without touching the roster.
          </p>
          {mapImageId === null ? (
            <p className="text-xs text-muted-foreground">
              No battlemap — the battle runs on a viewport board until one is set.
            </p>
          ) : (
            <>
              {/* Owner-ratified room-keys consequence, stated where the map
                  lives: a fresh map brings fresh keys. */}
              <p className="text-xs text-muted-foreground" data-testid="regenerate-keys-note">
                Regenerate everything writes fresh room keys — edit them again in the encounter form afterwards.
              </p>
              <div className="flex items-center gap-2">
              <button
                type="button"
                className="overflow-hidden rounded-md border"
                aria-label="Open battlemap"
                onClick={() => {
                  setLightboxId(mapImageId);
                }}
              >
                <GalleryThumb imageId={mapImageId} />
              </button>
              <p className="text-xs text-muted-foreground">
                {artifact.data.preset === 'dungeon' ? 'Dungeon layout' : 'Battlemap'} on file —
                click to view. It seeds the table surface
                (map-role images keep up to 4096px)
                {artifact.data.layout !== null
                  ? ` together with the room layout (${artifact.data.layout.rooms.length} ${
                      artifact.data.layout.rooms.length === 1 ? 'room' : 'rooms'
                    }, one veil each).`
                  : '.'}
              </p>
              </div>
            </>
          )}
          <input
            ref={mapUploadRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              void handleMapFiles(event.target.files);
            }}
          />
        </div>
      )}

      {/* Owner request: the artifact lightbox fills the viewport — the old
          max-w-2xl dialog (plus the renderer's max-h-96) showed the image at
          a fraction of a big screen. The Dialog defaults (grid, w-full,
          max-w-[calc(100%-2rem)], sm:max-w-sm, p-4, gap-4, rounded-xl,
          bg-popover, ring-1) are all overridden via tailwind-merge; Esc and
          backdrop-close flow through the unchanged onOpenChange. Fill
          contract: the img owns the whole reserved box —
          `h-[calc(100dvh-6rem)] w-full` (the 6rem footer strip reservation),
          object-contain fits the picture inside, upscaling past natural size
          included; shrink-only max-* caps would render a 1024×1024 image at
          half a big screen. */}
      <Dialog
        open={lightboxId !== null}
        onOpenChange={(open) => {
          if (!open) setLightboxId(null);
        }}
      >
        <DialogContent
          className="flex h-dvh w-dvw max-w-none flex-col items-center justify-center gap-0 rounded-none border-0 bg-black/90 p-0 ring-0 sm:max-w-none"
          data-testid="artifact-image-lightbox"
        >
          {lightboxImage !== undefined && (
            <>
              <DialogTitle className="sr-only">Image</DialogTitle>
              <LightboxImage
                imageId={lightboxImage.id}
                className="h-[calc(100dvh-6rem)] w-full max-h-[100dvh] border-0"
              />
              <div
                className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-1.5 bg-black/80 p-2 text-center"
                data-testid="artifact-image-lightbox-footer"
              >
                <DialogDescription className="text-xs text-muted-foreground">
                  {lightboxImage.width}×{lightboxImage.height} · {lightboxImage.mimeType} ·{' '}
                  {lightboxImage.source === 'generated' ? `generated by ${lightboxImage.model}` : 'uploaded'}
                </DialogDescription>
                <div className="flex gap-2">
                  {artifact.coverImageId === lightboxImage.id ? (
                    <Badge
                      variant="secondary"
                      data-testid="artifact-image-cover-status"
                      className="h-8 gap-1.5 px-3 text-xs"
                    >
                      <StarIcon aria-hidden data-icon="inline-start" />
                      Cover image
                    </Badge>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void setCover(lightboxImage.id);
                      }}
                    >
                      <StarIcon aria-hidden data-icon="inline-start" />
                      Set as cover
                    </Button>
                  )}
                  {isEncounter && artifact.data.mapImageId !== lightboxImage.id && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void setBattlemap(lightboxImage.id);
                      }}
                    >
                      <MapIcon aria-hidden data-icon="inline-start" />
                      Set as battlemap
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    onClick={() => {
                      void removeImage(lightboxImage.id);
                    }}
                  >
                    <Trash2Icon aria-hidden data-icon="inline-start" />
                    Delete
                  </Button>
                </div>
                {lightboxImage.prompt !== '' && (
                  <p className="max-w-full text-xs text-muted-foreground">Prompt: {lightboxImage.prompt}</p>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function GalleryThumb({ imageId }: { imageId: Id }): JSX.Element | null {
  const url = useImageUrl(imageId);
  if (url === null) {
    return (
      <span className="flex size-16 items-center justify-center text-muted-foreground">
        <ImageIcon aria-hidden className="size-4" />
      </span>
    );
  }
  return <img src={url} alt="Artifact image" width={64} height={64} className="size-16 object-cover" />;
}


