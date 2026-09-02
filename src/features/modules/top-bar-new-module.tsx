import { useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { BookOpenIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { Id } from '@/domain';
import { getCampaign } from '@/db/campaignRepo';
import { NewModuleDialog } from '@/features/modules/new-module-dialog';

/**
 * Top-bar "New Module" entry (08-MODULE-DESIGNER M4-B), sharing the
 * creation dialog used by the modules list.
 * Opens the same creation dialog as the list page.
 */
export function TopBarNewModuleButton({ campaignId }: { campaignId: Id }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const campaign = useLiveQuery(async () => await getCampaign(campaignId), [campaignId]);

  if (campaign === undefined) return null;

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        aria-label="New Module"
        onClick={() => {
          setOpen(true);
        }}
      >
        <BookOpenIcon aria-hidden data-icon="inline-start" />
        Module
      </Button>
      {open && (
        <NewModuleDialog
          campaign={campaign}
          open
          onOpenChange={(next) => {
            setOpen(next);
          }}
        />
      )}
    </>
  );
}
