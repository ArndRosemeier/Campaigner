import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import type { GlobalArtifact, Id } from '@/domain';
import { adoptIntoCampaign, campaignsReferencingArtifact } from '@/db/artifactRepo';
import { listCampaigns } from '@/db/campaignRepo';
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
import { toastError, toastSuccess } from '@/lib/toast';

export interface AdoptDialogProps {
  artifact: GlobalArtifact | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Adopting adopts INTO a campaign, not into another module. */
  currentCampaignId?: Id | undefined;
  onAdopted?: ((campaignId: Id) => void) | undefined;
}

/**
 * Adopt-from-library confirm (10-MILESTONE-6 C): the global artifact moves
 * INTO one campaign with a loud list of the other campaigns that reference
 * it — their chips become unresolved, because D7 keeps exactly one artifact
 * that is always referenced, never copied.
 */
export function AdoptDialog({
  artifact,
  open,
  onOpenChange,
  onAdopted,
}: AdoptDialogProps): JSX.Element {
  const campaigns = useLiveQuery(async () => listCampaigns(), []);
  const [referencing, setReferencing] = useState<Id[]>([]);

  useEffect(() => {
    setReferencing([]);
    if (!open || artifact === undefined) return;
    let alive = true;
    campaignsReferencingArtifact(artifact.id)
      .then((ids) => {
        if (alive) setReferencing(ids);
      })
      .catch((error: unknown) => {
        toastError('Could not list the campaigns referencing this artifact', error);
      });
    return () => {
      alive = false;
    };
  }, [open, artifact]);

  const referencingNames = referencing
    .map((id) => campaigns?.find((campaign) => campaign.id === id)?.name ?? id)
    .filter((name, index, list) => list.indexOf(name) === index);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="adopt-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Adopt “{artifact?.name}” into a campaign?</AlertDialogTitle>
          <AlertDialogDescription>
            The artifact leaves the shared library and becomes campaign content.
            {referencingNames.length > 0 && (
              <>
                {' '}
                Campaigns currently referencing it — their links will resolve as unresolved chips
                afterwards: {referencingNames.join(', ')}.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex max-h-48 flex-col gap-1 overflow-y-auto" data-testid="adopt-campaigns">
          {(campaigns ?? []).map((campaign) => (
            <AlertDialogAction
              key={campaign.id}
              data-testid={`adopt-into-${campaign.id}`}
              onClick={() => {
                const target = artifact;
                onOpenChange(false);
                if (target === undefined) return;
                adoptIntoCampaign(target.id, campaign.id)
                  .then((adopted) => {
                    toastSuccess(`"${adopted.name}" is now owned by "${campaign.name}"`);
                    onAdopted?.(campaign.id);
                  })
                  .catch((error: unknown) => {
                    toastError('Could not adopt the artifact', error);
                  });
              }}
            >
              {campaign.name}
            </AlertDialogAction>
          ))}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
