import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeftIcon, SquareArrowOutUpRightIcon, XIcon } from 'lucide-react';

import { artifactPath } from '@/app/routes';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import type { Artifact, Id } from '@/domain';
import { NpcCard, EncounterCard, Portrait } from '@/features/play/artifact-cards';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import { ZoomableImage } from '@/features/images/zoomable-image';
import { useImageUrl } from '@/features/images/use-image-url';

/**
 * Peek modal (08-MODULE-DESIGNER M4-A): renders the read-only artifact card
 * (the Session-Mode card components) for a wiki-link target, with the
 * entity's image banner (fullscreen on click, M4-C). Wiki-links inside the
 * pushed body push onto an in-modal breadcrumb stack — Back pops one level,
 * Esc pops one level first and only closes at the root; closing always
 * returns to the exact scroll position (the reader is untouched).
 */

export interface PeekModalProps {
  /** The artifact currently peeked (drives the stack root). */
  artifact: Artifact;
  artifacts: readonly Artifact[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaignId: Id;
}

export function PeekModal({
  artifact,
  artifacts,
  open,
  onOpenChange,
  campaignId,
}: PeekModalProps): JSX.Element {
  const navigate = useNavigate();
  const [stack, setStack] = useState<Id[]>([artifact.id]);
  const [fullscreenImageId, setFullscreenImageId] = useState<Id | null>(null);

  // A new peek from the document resets the breadcrumb stack.
  useEffect(() => {
    setStack([artifact.id]);
  }, [artifact.id]);

  const byId = new Map(artifacts.map((entry) => [entry.id, entry]));
  const currentId = stack[stack.length - 1] ?? artifact.id;
  const current = byId.get(currentId);
  const canGoBack = stack.length > 1;

  function push(id: Id): void {
    if (id === currentId) return;
    setStack((previous) => [...previous, id]);
  }

  function pop(): void {
    setStack((previous) => (previous.length > 1 ? previous.slice(0, -1) : previous));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen, details) => {
        if (nextOpen) return;
        // Esc pops one breadcrumb level first; only a root-level Esc (or
        // click-outside/close button) dismisses the modal.
        if (details.reason === 'escape-key' && canGoBack) {
          details.cancel();
          pop();
          return;
        }
        onOpenChange(false);
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-2 overflow-hidden sm:max-w-lg"
        data-testid="peek-modal"
      >
        <div className="flex items-center gap-2 pb-1">
          {canGoBack && (
            <Button
              variant="ghost"
              size="sm"
              aria-label="Back"
              onClick={pop}
              data-testid="peek-back"
            >
              <ArrowLeftIcon aria-hidden data-icon="inline-start" />
              Back
            </Button>
          )}
          <DialogTitle className="truncate">
            {current?.name ?? 'Artifact unavailable'}
          </DialogTitle>
        </div>
        <Separator />
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {current === undefined ? (
            <p className="text-sm text-muted-foreground">
              This artifact no longer exists (it may have been deleted).
            </p>
          ) : (
            <>
              <PeekImage
                artifact={current}
                onFullscreen={(imageId) => {
                  setFullscreenImageId(imageId);
                }}
              />
              <PeekBody
                artifact={current}
                artifacts={artifacts}
                onOpenArtifact={(next) => {
                  push(next.id);
                }}
              />
            </>
          )}
        </div>
        <Separator />
        {current !== undefined && (
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onOpenChange(false);
                navigate(artifactPath(campaignId, current.id));
              }}
              data-testid="peek-open-workspace"
            >
              <SquareArrowOutUpRightIcon aria-hidden data-icon="inline-start" />
              Open in workspace
            </Button>
          </div>
        )}
      </DialogContent>
      {fullscreenImageId !== null && (
        <Dialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setFullscreenImageId(null);
          }}
        >
          <DialogContent
            className="flex h-dvh w-dvw max-w-none items-center justify-center rounded-none border-0 bg-black p-0 sm:max-w-none"
            data-testid="peek-image-fullscreen"
          >
            <DialogTitle className="sr-only">Image full screen</DialogTitle>
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label="Close full screen image"
              className="absolute top-3 right-3 z-10"
              onClick={() => {
                setFullscreenImageId(null);
              }}
              data-testid="peek-image-fullscreen-close"
            >
              <XIcon aria-hidden />
            </Button>
            <ZoomableImage
              imageId={fullscreenImageId}
              className="max-h-full max-w-full border-0"
              onCloseRequest={() => {
                setFullscreenImageId(null);
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </Dialog>
  );
}

/**
 * The entity's image banner (M4-C): the cover image (or the first gallery
 * image) shown UNCROPPED — the full picture fitted into the card's width,
 * capped in height so tall images don't push the text out of view. Click
 * opens the true fullscreen viewer. Absent when the entity has no image.
 */
function PeekImage({
  artifact,
  onFullscreen,
}: {
  artifact: Artifact;
  onFullscreen: (imageId: Id) => void;
}): JSX.Element | null {
  const firstImageId = artifact.imageIds.at(0) ?? null;
  const imageId = artifact.coverImageId ?? firstImageId;
  const url = useImageUrl(imageId);
  if (imageId === null || url === null) return null;
  return (
    <button
      type="button"
      className="mb-2 block w-full cursor-zoom-in"
      aria-label={`Show ${artifact.name}'s image full screen`}
      data-testid="peek-image"
      onClick={() => {
        onFullscreen(imageId);
      }}
    >
      <img
        src={url}
        alt={`Image of ${artifact.name}`}
        className="max-h-72 w-full rounded-md border object-contain"
      />
    </button>
  );
}

/** The read-only artifact view inside the modal, per kind. */
function PeekBody({
  artifact,
  artifacts,
  onOpenArtifact,
}: {
  artifact: Artifact;
  artifacts: readonly Artifact[];
  onOpenArtifact: (artifact: Artifact) => void;
}): JSX.Element {
  if (artifact.kind === 'npc') {
    return <NpcCard npc={artifact} />;
  }
  if (artifact.kind === 'encounter') {
    return <EncounterCard encounter={artifact} />;
  }
  return (
    <div className="flex flex-col gap-2" data-testid="peek-body">
      <div className="flex items-start gap-3">
        <Portrait artifact={artifact} />
        {/* flex-1 + min-w-0 so the summary flows inside the card instead of
            stretching the row into a horizontal scrollbar (M4-C). */}
        <div className="min-w-0 flex-1">
          <p className="text-xs tracking-wide text-muted-foreground uppercase">
            {artifact.kind}
          </p>
          {artifact.summary !== '' && (
            <p className="text-sm break-words text-muted-foreground">{artifact.summary}</p>
          )}
        </div>
      </div>
      {artifact.body !== '' && (
        <div className="prose-sm text-sm leading-relaxed [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_p]:my-1.5">
          <WikiMarkdown value={artifact.body} artifacts={artifacts} onOpenArtifact={onOpenArtifact} />
        </div>
      )}
    </div>
  );
}
