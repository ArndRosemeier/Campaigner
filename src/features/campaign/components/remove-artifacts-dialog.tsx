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
  deleteArtifactSelection,
  deleteArtifactsOfKind,
  describeArtifactKindRemoval,
  describeArtifactSelectionRemoval,
  type ArtifactKindRemovalCounts,
} from '@/db/artifactRepo';
import { useCampaign } from '@/features/campaign/hooks';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * THE removal confirm (05-UI §Left pane — Campaign tree; docs/18 §2.1), for
 * BOTH rungs of the destructive ladder that name campaign-level artifacts:
 * per-region "remove all" (one KIND) and the workspace's multi-select
 * SELECTION. Before docs/17 row 322 only the kind rung existed and lived in
 * `remove-kind-dialog.tsx`; the file was renamed with the generalization, and
 * the census, the cascade copy, the guard level and the toasts are ONE body
 * with a discriminated scope (AGENTS rule 4).
 *
 * The rungs are: per-item trash → SELECTION → per-region remove all →
 * "Remove all generated content" → "Clear workspace". It throws away the
 * named CAMPAIGN-LEVEL rows in ONE campaign with everything the cascade takes
 * (revision history, back-links, battle tokens, freed images) and nothing
 * else: the Party, module-owned rows and their documents, every other kind
 * and the global library survive.
 *
 * Honesty rules (docs/18 §2.1): the census below is re-derived WHILE the
 * dialog is open (`describeArtifactKindRemoval` /
 * `describeArtifactSelectionRemoval`), it names the surprising half of the
 * cascade (surviving artifacts lose links; encounter rosters fall back to
 * `missing ref`; boards can empty out and delete themselves; seeded boards can
 * lose their encounter), and it decides nothing — the execute path re-lists
 * inside its own transaction and the success toast reports what actually went.
 * There is NO undo for artifacts (the Versions menu's undo covers module
 * documents only), which the copy states in as many words.
 *
 * A census that REFUSES (a Party row, a module-owned row or a foreign id in a
 * selection) is rendered as the refusal, and the confirm is disabled: the
 * surface never offers a Remove that could only fail, and the refusal sentence
 * is the SEAM's own, not a second wording.
 *
 * Guard level: a plain confirm, deliberately. The typed-name guard is the
 * privilege of the two CROSS-CAMPAIGN hammers in the Edit-campaign danger
 * zone; these rungs are single-campaign, carry a live census and a dedicated
 * button in the region's or selection bar's own header (the count-gated
 * "Delete N orphans" precedent, docs/05).
 */

export interface RemoveArtifactsScope {
  kind?: ArtifactKind;
  ids?: readonly Id[];
}

export interface RemoveArtifactsDialogProps {
  campaignId: Id;
  /** Exactly one of `kind` (region rung) or `ids` (selection rung). */
  scope: RemoveArtifactsScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Runs after a pass that actually deleted rows (never on cancel or on a
   * refused census). The selection host uses it to drop a selection that now
   * names deleted rows.
   */
  onRemoved?: () => void;
}

/** The census as the live query can answer it: counts, or the seam's refusal. */
type RemovalCensus = { counts: ArtifactKindRemovalCounts } | { error: string };

export function RemoveArtifactsDialog({
  campaignId,
  scope,
  open,
  onOpenChange,
  onRemoved,
}: RemoveArtifactsDialogProps): JSX.Element {
  const [removing, setRemoving] = useState(false);
  const campaign = useCampaign(campaignId);
  const kind = scope.kind;
  // The selection rung passes a fresh array whenever the selection changes:
  // the live query keys on the joined id LIST, so a new array with the same
  // members cannot re-run it needlessly.
  const ids = scope.ids;
  const selectionKey = ids === undefined ? '' : [...ids].join(',');
  // Live census: re-derives while the confirm is open, so it lists what the
  // campaign holds NOW. A refusal (Party / module-owned / foreign) is caught
  // HERE rather than thrown into render, so the dialog can SAY it and disable
  // the confirm; the numbers never decide what goes — the seam re-lists once
  // more inside its own transaction.
  const census = useLiveQuery<RemovalCensus | null>(async () => {
    if (!open) return null;
    if (kind !== undefined && BULK_REMOVE_EXCLUDED_KINDS.includes(kind)) return null;
    try {
      const counts =
        kind !== undefined
          ? await describeArtifactKindRemoval(campaignId, kind)
          : await describeArtifactSelectionRemoval(campaignId, [...(ids ?? [])]);
      return { counts };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [campaignId, kind, selectionKey, open]);

  const label = kind === undefined ? 'artifacts' : ARTIFACT_KIND_LABELS[kind];
  const singular = kind === undefined ? 'artifact' : ARTIFACT_KIND_SINGULAR[kind];
  const campaignName = campaign?.name ?? '';
  const counts = census !== null && census !== undefined && 'counts' in census ? census.counts : undefined;
  const refusal = census !== null && census !== undefined && 'error' in census ? census.error : undefined;

  async function handleRemove(): Promise<void> {
    if (removing) return; // one pass at a time
    setRemoving(true);
    try {
      // Fresh recount + disposal happen inside the repo's transaction; the
      // returned counts describe what actually went. Any failure rejects —
      // there is no success toast on a rolled-back pass (AGENTS rule 1).
      const removed =
        kind !== undefined
          ? await deleteArtifactsOfKind(campaignId, kind)
          : await deleteArtifactSelection(campaignId, [...(ids ?? [])]);
      onOpenChange(false);
      toastSuccess(formatRemoved(singular, label, removed));
      onRemoved?.();
    } catch (error) {
      toastError(
        kind !== undefined ? `Could not remove all ${label}` : 'Could not remove the selection',
        error,
      );
    } finally {
      setRemoving(false);
    }
  }

  // The tree never opens the region rung for an excluded kind (and the seam
  // refuses it loudly): defense in depth, so a stray state can never render a
  // confirm that would offer to delete protected content.
  if (kind !== undefined && BULK_REMOVE_EXCLUDED_KINDS.includes(kind)) return <></>;

  const testId = kind !== undefined ? `remove-all-${kind}` : 'remove-selection';
  const selectedCount = counts?.artifacts ?? ids?.length ?? 0;
  const title =
    kind !== undefined
      ? `Remove all ${label}${campaignName === '' ? '' : ` from “${campaignName}”`}?`
      : `Remove ${String(selectedCount)} selected artifact(s)${
          campaignName === '' ? '' : ` from “${campaignName}”`
        }?`;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onOpenChange(false);
      }}
    >
      <AlertDialogContent data-testid={`${testId}-confirm`}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription data-testid={`${testId}-counts`}>
            {refusal ??
              (counts === undefined
                ? 'Counting what this selection holds…'
                : counts.artifacts === 0
                  ? `This campaign holds no removable ${label} — nothing to remove.`
                  : `This permanently deletes ${countWithLabel(counts.artifacts, singular, label)} in this campaign, and ${pluralize(counts.revisions, 'revision-history entry', 'revision-history entries')} go with them. There is no undo for artifacts — the Versions menu’s undo covers module documents only. ${describeCascade(counts)} Only this campaign’s own ${label} are removed: the Party, module-owned rows and the global library are never touched.`)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-testid={`${testId}-confirm-action`}
            disabled={removing || counts === undefined || counts.artifacts === 0}
            onClick={() => {
              void handleRemove();
            }}
          >
            {removing ? 'Removing…' : kind !== undefined ? `Remove ${label}` : 'Remove selected'}
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
