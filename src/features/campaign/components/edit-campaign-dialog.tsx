import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { Button } from '@/components/ui/button';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { GAME_SYSTEM_LABELS, type Campaign } from '@/domain';
import {
  describeGeneratedContent,
  removeAllGeneratedContent,
  updateCampaign,
  type RemovedContentCounts,
} from '@/db/campaignRepo';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * "Edit campaign" dialog: renames the campaign and edits its description —
 * the two mutable campaign fields. The game system is shown read-only on
 * purpose: stat blocks and battle setup depend on it, so switching it here
 * would silently corrupt the campaign (05-UI §Campaign picker).
 */
export interface EditCampaignDialogProps {
  campaign: Campaign;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditCampaignDialog({
  campaign,
  open,
  onOpenChange,
}: EditCampaignDialogProps): JSX.Element {
  const [name, setName] = useState(campaign.name);
  const [description, setDescription] = useState(campaign.description);
  const [saving, setSaving] = useState(false);
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wiping, setWiping] = useState(false);

  // Live census for the wipe confirm: re-derives while the confirm is open,
  // so the dialog lists what the campaign holds NOW, not what it held when
  // the confirm opened. The execute path re-lists once more inside its own
  // transaction — these numbers never decide what goes.
  const wipeSummary = useLiveQuery(async () => {
    if (!wipeOpen) return null;
    return describeGeneratedContent(campaign.id);
  }, [campaign.id, wipeOpen]);

  // Re-seed from the row every time the dialog opens, so a stale draft can
  // never overwrite newer data written while the dialog was closed.
  useEffect(() => {
    if (open) {
      setName(campaign.name);
      setDescription(campaign.description);
    }
  }, [open, campaign.name, campaign.description]);

  async function handleSave(): Promise<void> {
    const trimmedName = name.trim();
    if (trimmedName === '') return;
    setSaving(true);
    try {
      // An empty description is a valid state: clearing is allowed.
      await updateCampaign(campaign.id, {
        name: trimmedName,
        description: description.trim(),
      });
      toastSuccess('Campaign updated');
      onOpenChange(false);
    } catch (error) {
      toastError('Could not update the campaign', error);
    } finally {
      setSaving(false);
    }
  }

  async function handleWipe(): Promise<void> {
    setWiping(true);
    try {
      // Fresh recount + disposal happen inside the repo's transaction; the
      // returned counts describe what actually went. Any failure rejects —
      // no success toast on a half-applied (rolled-back) wipe.
      const removed = await removeAllGeneratedContent(campaign.id);
      setWipeOpen(false);
      toastSuccess(formatRemoved(removed));
    } catch (error) {
      toastError('Could not remove generated content', error);
    } finally {
      setWiping(false);
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="edit-campaign-dialog">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit campaign</DialogTitle>
            <DialogDescription>
              Rename the campaign or change its description. The game system is
              fixed — stat blocks and battles depend on it.
            </DialogDescription>
          </DialogHeader>
          <div className="my-3 flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Name
              <Input
                value={name}
                aria-label="Campaign name"
                className="pointer-coarse:text-base"
                autoCapitalize="words"
                autoCorrect="off"
                enterKeyHint="next"
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Description
              <Textarea
                value={description}
                placeholder="One or two sentences about the setting…"
                aria-label="Campaign description"
                className="min-h-[64px] text-sm pointer-coarse:text-base"
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Game system (fixed)
              <Input
                value={GAME_SYSTEM_LABELS[campaign.system]}
                disabled
                aria-label="Game system (fixed)"
              />
            </label>
          </div>
          {/* Danger zone: the fresh-generation wipe lives here — the campaign
              settings surface — never in the tree or another high-traffic
              spot. Opening the confirm is step one; the confirm itself is
              step two. */}
          <div className="mb-3 rounded-lg border border-destructive/30 p-3">
            <p className="text-xs font-semibold text-destructive">Danger zone</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Delete everything generation produced — artifacts (except the Party), modules,
              battles, runs and outlines — so generation can restart clean. The Party stays.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 text-destructive"
              data-testid="remove-all-generated"
              onClick={() => {
                setWipeOpen(true);
              }}
            >
              Remove all generated content…
            </Button>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving || name.trim() === ''} data-testid="save-campaign">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <AlertDialog
      open={wipeOpen}
      onOpenChange={(next) => {
        if (!next) setWipeOpen(false);
      }}
    >
      <AlertDialogContent data-testid="remove-all-confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Remove all generated content?</AlertDialogTitle>
          <AlertDialogDescription data-testid="remove-all-counts">
            {wipeSummary === null || wipeSummary === undefined
              ? 'Counting what generation produced…'
              : wipeSummary.removableArtifacts === 0 &&
                  wipeSummary.modules === 0 &&
                  wipeSummary.battles === 0 &&
                  wipeSummary.runs === 0 &&
                  wipeSummary.deliverables === 0
                ? 'This campaign holds no generated content — only the Party (which is kept) or nothing at all.'
                : `This permanently deletes ${formatCensus(wipeSummary)}. The Party (${String(wipeSummary.pcCount)} PC${wipeSummary.pcCount === 1 ? '' : 's'}) stays untouched, and the global library is never affected.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={wiping}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-testid="remove-all-confirm"
            disabled={wiping}
            onClick={() => {
              void handleWipe();
            }}
          >
            {wiping ? 'Removing…' : 'Remove everything'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}

function pluralize(count: number, singular: string, plural?: string): string {
  return `${String(count)} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/** Live census line for the confirm dialog (display only — the execute path
 * recounts inside its transaction). */
function formatCensus(summary: {
  byKind: { kind: string; count: number }[];
  removableArtifacts: number;
  modules: number;
  battles: number;
  runs: number;
  deliverables: number;
}): string {
  const parts: string[] = [];
  if (summary.removableArtifacts > 0) {
    const kinds = summary.byKind.map((entry) => pluralize(entry.count, entry.kind)).join(', ');
    parts.push(`${pluralize(summary.removableArtifacts, 'artifact')} (${kinds})`);
  }
  if (summary.modules > 0) parts.push(pluralize(summary.modules, 'module'));
  if (summary.battles > 0) parts.push(pluralize(summary.battles, 'battle'));
  if (summary.runs > 0) parts.push(pluralize(summary.runs, 'run'));
  if (summary.deliverables > 0) parts.push(pluralize(summary.deliverables, 'outline'));
  return parts.join(', ');
}

/** Success toast body: what the wipe actually removed (in-transaction
 * recount), plus what it kept. */
function formatRemoved(removed: RemovedContentCounts): string {
  const parts: string[] = [];
  if (removed.artifacts > 0) {
    const kinds = removed.byKind.map((entry) => pluralize(entry.count, entry.kind)).join(', ');
    parts.push(`${pluralize(removed.artifacts, 'artifact')} (${kinds})`);
  }
  parts.push(pluralize(removed.modules, 'module'));
  parts.push(pluralize(removed.battles, 'battle'));
  if (removed.runs > 0) parts.push(pluralize(removed.runs, 'run'));
  if (removed.deliverables > 0) parts.push(pluralize(removed.deliverables, 'outline'));
  const kept =
    removed.pcsKept > 0
      ? `${pluralize(removed.pcsKept, 'PC')} kept`
      : 'nothing to keep';
  if (parts.length === 0) return `Nothing to remove — ${kept}.`;
  return `Removed ${parts.join(', ')}; ${kept}.`;
}
