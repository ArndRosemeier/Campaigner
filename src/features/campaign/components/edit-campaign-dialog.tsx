import { useEffect, useState } from 'react';
import type { JSX } from 'react';

import { Button } from '@/components/ui/button';
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
import { updateCampaign } from '@/db/campaignRepo';
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

  return (
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
  );
}
