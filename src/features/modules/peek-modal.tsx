import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeftIcon, MapPinIcon, SquareArrowOutUpRightIcon } from 'lucide-react';

import { artifactPath, playPath } from '@/app/routes';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import type { Artifact, Id } from '@/domain';
import { NpcCard, EncounterCard, Portrait } from '@/features/play/artifact-cards';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import { usePlayStore } from '@/features/play/playStore';

/**
 * Peek modal (08-MODULE-DESIGNER M4-A): renders the read-only artifact card
 * (the Session-Mode card components) for a wiki-link target. Wiki-links
 * inside the pushed body push onto an in-modal breadcrumb stack — Back pops
 * one level, Esc pops one level first and only closes at the root; closing
 * always returns to the exact scroll position (the reader is untouched).
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
  const setFocus = usePlayStore((state) => state.setFocus);
  const [stack, setStack] = useState<Id[]>([artifact.id]);

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
            <PeekBody
              artifact={current}
              artifacts={artifacts}
              onOpenArtifact={(next) => {
                push(next.id);
              }}
            />
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
            <Button
              size="sm"
              onClick={() => {
                setFocus(campaignId, current.id);
                onOpenChange(false);
                navigate(playPath(campaignId));
              }}
              data-testid="peek-focus-play"
            >
              <MapPinIcon aria-hidden data-icon="inline-start" />
              Focus in Play
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
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
        <div className="min-w-0">
          <p className="text-xs tracking-wide text-muted-foreground uppercase">
            {artifact.kind}
          </p>
          {artifact.summary !== '' && (
            <p className="text-sm text-muted-foreground">{artifact.summary}</p>
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
