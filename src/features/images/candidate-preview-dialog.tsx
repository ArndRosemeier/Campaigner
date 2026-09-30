import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LayersIcon,
} from 'lucide-react';

import type { EncounterLayout, Id } from '@/domain';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ZoomableImage } from '@/features/images/zoomable-image';
import { EncounterLayoutPreview } from '@/features/campaign/components/encounter-layout-preview';

export interface CandidatePreviewDialogProps {
  candidates: readonly Id[];
  currentId: Id | null;
  onClose: () => void;
  onSelectCandidate?: ((id: Id) => void) | undefined;
  isSelected?: ((id: Id) => boolean) | undefined;
  title?: string | undefined;
  layout?: EncounterLayout | null | undefined;
}

export function CandidatePreviewDialog({
  candidates,
  currentId,
  onClose,
  onSelectCandidate,
  isSelected,
  title = 'Candidate preview',
  layout,
}: CandidatePreviewDialogProps): JSX.Element {
  const [activeId, setActiveId] = useState<Id | null>(currentId);
  const [showOverlay, setShowOverlay] = useState(true);

  useEffect(() => {
    setActiveId(currentId);
  }, [currentId]);

  const currentIndex = activeId !== null ? candidates.indexOf(activeId) : -1;
  const canPrev = currentIndex > 0;
  const canNext = currentIndex >= 0 && currentIndex < candidates.length - 1;

  const handlePrev = useCallback(() => {
    if (canPrev) {
      setActiveId(candidates[currentIndex - 1] ?? null);
    }
  }, [canPrev, candidates, currentIndex]);

  const handleNext = useCallback(() => {
    if (canNext) {
      setActiveId(candidates[currentIndex + 1] ?? null);
    }
  }, [canNext, candidates, currentIndex]);

  useEffect(() => {
    if (activeId === null) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        handlePrev();
      } else if (event.key === 'ArrowRight') {
        handleNext();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeId, handleNext, handlePrev]);

  const selected = activeId !== null && isSelected !== undefined ? isSelected(activeId) : false;

  return (
    <Dialog open={activeId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="flex max-h-[94vh] w-[95vw] max-w-5xl flex-col gap-3 p-4 sm:p-6"
        data-testid="candidate-preview-dialog"
      >
        <DialogHeader className="flex flex-row items-center justify-between border-b pb-3">
          <div className="flex flex-col gap-0.5">
            <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {candidates.length > 1 && currentIndex >= 0
                ? `Candidate ${String(currentIndex + 1)} of ${String(candidates.length)} · `
                : ''}
              Pinch or scroll to zoom · Drag to pan · Double-click to toggle 2.5×
            </DialogDescription>
          </div>

          <div className="flex items-center gap-1.5">
            {layout !== undefined && layout !== null && (
              <Button
                variant={showOverlay ? 'secondary' : 'outline'}
                size="sm"
                onClick={() => {
                  setShowOverlay((prev) => !prev);
                }}
                className="gap-1.5 text-xs"
                title={showOverlay ? 'Hide room layout overlay' : 'Show room layout overlay'}
                data-testid="toggle-room-overlay"
              >
                <LayersIcon className="size-3.5" aria-hidden />
                {showOverlay ? 'Hide overlay' : 'Show overlay'}
              </Button>
            )}

            {candidates.length > 1 && (
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={!canPrev}
                  onClick={handlePrev}
                  aria-label="Previous candidate"
                  title="Previous candidate (Left arrow)"
                  data-testid="preview-prev-btn"
                >
                  <ChevronLeftIcon className="size-4" aria-hidden />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={!canNext}
                  onClick={handleNext}
                  aria-label="Next candidate"
                  title="Next candidate (Right arrow)"
                  data-testid="preview-next-btn"
                >
                  <ChevronRightIcon className="size-4" aria-hidden />
                </Button>
              </div>
            )}
          </div>
        </DialogHeader>

        {activeId !== null && (
          <div
            className="relative flex h-[65vh] w-full items-center justify-center overflow-hidden rounded-md bg-black/90"
            data-testid="candidate-preview-container"
          >
            <ZoomableImage
              key={activeId}
              imageId={activeId}
              className="max-h-[63vh] max-w-full w-auto rounded border-0 object-contain shadow-2xl"
            >
              {layout !== undefined && layout !== null && showOverlay && (
                <div
                  className="pointer-events-none absolute inset-0 size-full"
                  style={{ aspectRatio: `${String(layout.gridW)} / ${String(layout.gridH)}` }}
                >
                  <EncounterLayoutPreview layout={layout} overlay />
                </div>
              )}
            </ZoomableImage>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t">
          <div className="text-xs text-muted-foreground">
            {candidates.length > 1 && currentIndex >= 0 && (
              <span>Candidate {String(currentIndex + 1)} of {String(candidates.length)}</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {onSelectCandidate !== undefined && activeId !== null && (
              <Button
                variant={selected ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  onSelectCandidate(activeId);
                }}
                data-testid="preview-select-btn"
              >
                <CheckIcon className="size-4" aria-hidden data-icon="inline-start" />
                {selected ? 'Selected' : 'Select this candidate'}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              data-testid="preview-close-btn"
            >
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
