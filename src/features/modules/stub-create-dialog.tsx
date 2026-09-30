import { useState } from 'react';
import type { JSX } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import type { Campaign, EntityKind, Id } from '@/domain';
import { moduleCreationPool, sameAliasName } from '@/domain';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { classifyEntityName } from '@/llm/moduleGen';
import { generateSingleEntity } from '@/features/modules/entity-detail';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * THE ASK-FIRST DOOR of a not-yet-generated artifact (docs/17 row 395,
 * owner-directed: "A click on a not yet generated artifact also should bring up
 * a small dialog asking if this should get created").
 *
 * A click on an unresolved chip opens THIS small confirm. Decline (Cancel /
 * Escape) does nothing at all. Confirm generates through the EXISTING single-
 * entity path (`entity-detail.generateSingleEntity` -> `runEntityBatch`, the
 * seam the stub popover's Generate already used). The kind is the recorded one
 * when the generator knows it, otherwise the model's one-shot classification
 * (never a guess — a failed classification is a loud toast and nothing is
 * created). When the classification says the name is an ALIAS of an existing
 * artifact, or the owner wants the other actions (create a bare stub, link an
 * existing entity), `onMoreOptions` hands over to the full `StubPopover`.
 */
export interface StubCreateDialogProps {
  name: string;
  campaign: Campaign;
  moduleId: Id;
  contextParagraphs: string;
  premise: string;
  recordedKind?: EntityKind | undefined;
  onClose: () => void;
  onMoreOptions: () => void;
}

export function StubCreateDialog({
  name,
  campaign,
  moduleId,
  contextParagraphs,
  premise,
  recordedKind,
  onClose,
  onMoreOptions,
}: StubCreateDialogProps): JSX.Element {
  const [busy, setBusy] = useState(false);

  async function create(): Promise<void> {
    setBusy(true);
    try {
      let kind = recordedKind;
      if (kind === undefined) {
        const pool = moduleCreationPool(await listArtifactsByCampaign(campaign.id));
        const verdict = await classifyEntityName(
          name,
          contextParagraphs,
          premise,
          pool.map((artifact) => artifact.name),
        );
        if (pool.some((artifact) => sameAliasName(artifact.name, verdict.canonical))) {
          // The model says this name IS an existing entity: never a second one.
          onMoreOptions();
          return;
        }
        kind = verdict.kind;
      }
      const result = await generateSingleEntity({ campaign, kind, name, moduleId });
      if (!result.ok) {
        toastError(`Could not generate "${name}"`, result.error);
        return;
      }
      toastSuccess(`"${name}" created`);
      onClose();
    } catch (error) {
      toastError(`Could not create "${name}"`, error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialogContent data-testid="stub-create-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Create “{name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            This artifact has not been generated yet. Nothing is created unless you confirm.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onMoreOptions} data-testid="stub-create-more">
            More options…
          </Button>
          <AlertDialogCancel disabled={busy} data-testid="stub-create-decline">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            data-testid="stub-create-confirm"
            onClick={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            {busy ? 'Creating…' : 'Create'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
