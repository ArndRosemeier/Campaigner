import { useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

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
import {
  ARTIFACT_KIND_LABELS,
  ARTIFACT_KIND_SINGULAR,
  BULK_REMOVE_EXCLUDED_KINDS,
  type ArtifactKind,
  type Id,
} from '@/domain';
import {
  deleteArtifactsOfKind,
  describeArtifactKindRemoval,
  type ArtifactKindRemovalCounts,
} from '@/db/artifactRepo';
import { useCampaign } from '@/features/campaign/hooks';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * Per-region "remove all" confirm (05-UI §Left pane — Campaign tree): the
 * middle rung of the destructive ladder — per-item trash → this → "Remove all
 * generated content" → "Clear workspace". It throws away ONE kind's
 * CAMPAIGN-LEVEL rows in ONE campaign with everything the cascade takes
 * (revision history, back-links, battle tokens, freed images) and nothing
 * else: the Party, module-owned rows and their documents, every other kind
 * and the global library survive.
 *
 * Honesty rules (docs/18 §2.1): the census below is re-derived WHILE the
 * dialog is open (`describeArtifactKindRemoval`), it names the surprising
 * half of the cascade (surviving artifacts lose links; encounter rosters fall
 * back to `missing ref`; boards can empty out and delete themselves; seeded
 * boards can lose their encounter), and it decides nothing — the execute path
 * re-lists inside its own transaction and the success toast reports what
 * actually went. There is NO undo for artifacts (the Versions menu's undo
 * covers module documents only), which the copy states in as many words.
 *
 * Guard level: a plain confirm, deliberately. The typed-name guard is the
 * privilege of the two CROSS-CAMPAIGN hammers in the Edit-campaign danger
 * zone; this one is single-campaign, single-kind, carries a live census and a
 * dedicated button in the region's own header (the count-gated "Delete N
 * orphans" precedent, docs/05).
 */
export interface RemoveKindDialogProps {
  campaignId: Id;
  kind: ArtifactKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RemoveKindDialog({
  campaignId,
  kind,
  open,
  onOpenChange,
}: RemoveKindDialogProps): JSX.Element {
  const [removing, setRemoving] = useState(false);
  const campaign = useCampaign(campaignId);
  // Live census: re-derives while the confirm is open, so it lists what the
  // campaign holds NOW. The numbers never decide what goes — the seam
  // re-lists once more inside its own transaction.
  const census = useLiveQuery(async () => {
    if (!open || BULK_REMOVE_EXCLUDED_KINDS.includes(kind)) return null;
    return describeArtifactKindRemoval(campaignId, kind);
  }, [campaignId, kind, open]);

  const label = ARTIFACT_KIND_LABELS[kind];
  const singular = ARTIFACT_KIND_SINGULAR[kind];
  const campaignName = campaign?.name ?? '';

  async function handleRemove(): Promise<void> {
    if (removing) return; // one pass at a time
    setRemoving(true);
    try {
      // Fresh recount + disposal happen inside the repo's transaction; the
      // returned counts describe what actually went. Any failure rejects —
      // there is no success toast on a rolled-back pass (AGENTS rule 1).
      const removed = await deleteArtifactsOfKind(campaignId, kind);
      onOpenChange(false);
      toastSuccess(formatRemoved(singular, label, removed));
    } catch (error) {
      toastError(`Could not remove all ${label}`, error);
    } finally {
      setRemoving(false);
    }
  }

  // The tree never opens this for an excluded kind (and the seam refuses it
  // loudly): defense in depth, so a stray state can never render a confirm
  // that would offer to delete protected content.
  if (BULK_REMOVE_EXCLUDED_KINDS.includes(kind)) return <></>;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onOpenChange(false);
      }}
    >
      <AlertDialogContent data-testid={`remove-all-${kind}-confirm`}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Remove all {label}
            {campaignName === '' ? '' : ` from “${campaignName}”`}?
          </AlertDialogTitle>
          <AlertDialogDescription data-testid={`remove-all-${kind}-counts`}>
            {census === null || census === undefined
              ? 'Counting what this region holds…'
              : census.artifacts === 0
                ? `This campaign holds no ${label} — nothing to remove.`
                : `This permanently deletes ${countWithLabel(census.artifacts, singular, label)} in this campaign, and ${pluralize(census.revisions, 'revision-history entry', 'revision-history entries')} go with them. There is no undo for artifacts — the Versions menu’s undo covers module documents only. ${describeCascade(census)} Only this campaign’s own ${label} are removed: the Party, module-owned rows and the global library are never touched.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-testid={`remove-all-${kind}-confirm-action`}
            disabled={removing || census === null || census === undefined || census.artifacts === 0}
            onClick={() => {
              void handleRemove();
            }}
          >
            {removing ? 'Removing…' : `Remove ${label}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function pluralize(count: number, singular: string, plural?: string): string {
  return `${String(count)} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/** "1 NPC" / "4 NPCs" — the region label carries the plural. */
function countWithLabel(count: number, singular: string, label: string): string {
  return `${String(count)} ${count === 1 ? singular : label}`;
}

/**
 * The cascade as it applies HERE, one sentence per non-zero consequence (a
 * delete that touches no battle says nothing about battles). Every number is
 * the live census the seam re-derives in its transaction.
 */
function describeCascade(counts: ArtifactKindRemovalCounts): string {
  const sentences: string[] = [];
  if (counts.backLinkedArtifacts > 0) {
    sentences.push(
      counts.backLinkedArtifacts === 1
        ? '1 surviving artifact keeps working but loses a link pointing at them.'
        : `${String(counts.backLinkedArtifacts)} surviving artifacts keep working but lose a link pointing at them.`,
    );
  }
  if (counts.rosterRefsDangling > 0) {
    sentences.push(
      `${pluralize(counts.rosterRefsDangling, 'encounter roster entry', 'encounter roster entries')} fall back to the loud “missing ref” badge.`,
    );
  }
  if (counts.battleTokensScrubbed > 0) {
    const scrubbed = `${pluralize(counts.battleTokensScrubbed, 'battle token')} ${counts.battleTokensScrubbed === 1 ? 'is' : 'are'} scrubbed`;
    sentences.push(
      counts.battlesDeleted > 0
        ? `${scrubbed}, and ${pluralize(counts.battlesDeleted, 'battle')} delete${counts.battlesDeleted === 1 ? 's' : ''} itself empty.`
        : `${scrubbed}.`,
    );
  }
  if (counts.battleProvenancesLost > 0) {
    sentences.push(
      counts.battleProvenancesLost === 1
        ? '1 seeded board loses the encounter it was seeded from.'
        : `${String(counts.battleProvenancesLost)} seeded boards lose the encounter they were seeded from.`,
    );
  }
  if (counts.imagesPruned > 0) {
    sentences.push(`${pluralize(counts.imagesPruned, 'attached image')} ${counts.imagesPruned === 1 ? 'is' : 'are'} freed.`);
  }
  if (sentences.length === 0) return 'Nothing else references them, so nothing else changes.';
  return sentences.join(' ');
}

/** Success toast body: what the pass actually removed (in-transaction
 * recount), never the dialog's snapshot. */
function formatRemoved(
  singular: string,
  label: string,
  removed: ArtifactKindRemovalCounts,
): string {
  if (removed.artifacts === 0) return `No ${label} to remove — nothing was deleted.`;
  const parts = [countWithLabel(removed.artifacts, singular, label)];
  if (removed.revisions > 0) parts.push(pluralize(removed.revisions, 'revision'));
  if (removed.backLinkedArtifacts > 0) {
    parts.push(`${pluralize(removed.backLinkedArtifacts, 'back-link')} cleaned`);
  }
  if (removed.battleTokensScrubbed > 0) {
    parts.push(`${pluralize(removed.battleTokensScrubbed, 'token')} scrubbed`);
  }
  if (removed.battlesDeleted > 0) {
    parts.push(pluralize(removed.battlesDeleted, 'emptied battle', 'emptied battles'));
  }
  if (removed.imagesPruned > 0) {
    parts.push(`${pluralize(removed.imagesPruned, 'image')} freed`);
  }
  return `Removed ${parts.join(', ')}.`;
}
