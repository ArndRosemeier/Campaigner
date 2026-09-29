import { useState } from 'react';
import type { JSX } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { PencilIcon, PlusIcon } from 'lucide-react';

import { guidePath, modulePath } from '@/app/routes';
import { Button } from '@/components/ui/button';
import { getCampaign } from '@/db/campaignRepo';
import { useModules } from '@/features/modules/hooks';
import { NewModuleDialog } from '@/features/modules/new-module-dialog';
import { EditCampaignDialog } from '@/features/campaign/components/edit-campaign-dialog';

/**
 * THE CAMPAIGN'S ONE DOCUMENT (docs/23 §10 phase 2, docs/17 row 389).
 *
 * This route WAS the module list (`ModulesListPage`, `ROUTES.modules`). A
 * campaign owns exactly ONE module row — its one document, carrying the
 * premise (level 0) and the level sections — so there is no list to render:
 * the campaign LEADS to its document. The page has exactly two states:
 *
 * - the campaign already has a document → `Navigate` to its reader
 *   (`modulePath`), whose table of contents IS the derived level list. The
 *   campaign's document is the FIRST row in arc order (`hooks.useModules` /
 *   `domain/module.compareModulesByStartLevel`), so the landing is
 *   deterministic even for a legacy campaign that still carries more than one
 *   row.
 * - the campaign has NO document yet → the create state, which mounts the SAME
 *   `NewModuleDialog` the old list mounted. THIS IS THE ONLY MOUNT of that
 *   dialog in the app (the top-bar entry and the list's own button are gone):
 *   a second document cannot be created because the app offers creation only
 *   where none exists, and the write seam refuses anyway
 *   (`moduleRepo.createCampaignDocument`).
 *
 * A legacy campaign with extra rows is NOT hidden by the redirect: the
 * `LegacyModulesNotice` in the campaign bar (rendered on every campaign route)
 * names every extra row with a link to it.
 */
export function CampaignDocumentPage(): JSX.Element {
  const { campaignId = '' } = useParams<{ campaignId: string }>();
  const modules = useModules(campaignId === '' ? undefined : campaignId);
  const campaign = useLiveQuery(
    async () => (campaignId === '' ? undefined : await getCampaign(campaignId)),
    [campaignId],
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  if (modules === undefined || campaign === undefined) {
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  }

  // THE campaign's document: the first row in arc order (see `useModules`).
  const document = modules[0];
  if (document !== undefined) {
    return <Navigate to={modulePath(campaignId, document.id)} replace />;
  }

  return (
    <div className="mx-auto max-w-3xl p-6" data-testid="campaign-document-page">
      <div className="mb-4 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="font-heading text-xl font-semibold">Document</h1>
          {/* Campaign context line: the campaign this document belongs to,
              plus its description when one is set (quiet, clamped — context,
              not a banner). */}
          <p
            className="mt-0.5 line-clamp-2 text-sm text-muted-foreground"
            data-testid="campaign-landing-context"
          >
            <span className="font-medium text-foreground">{campaign.name}</span>
            {campaign.description !== '' ? ` — ${campaign.description}` : ''}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Edit campaign"
          onClick={() => {
            setEditOpen(true);
          }}
          data-testid="edit-campaign"
        >
          <PencilIcon aria-hidden data-icon="inline-start" />
          Edit
        </Button>
        <Button
          size="sm"
          onClick={() => {
            setDialogOpen(true);
          }}
          data-testid="new-module"
        >
          <PlusIcon aria-hidden data-icon="inline-start" />
          New document
        </Button>
      </div>

      <p
        className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground"
        data-testid="campaign-document-empty"
      >
        This campaign has no document yet. A campaign owns exactly ONE document — the premise plus
        its level sections, authored through the canvas chat. New to authoring?{' '}
        <a
          href={guidePath()}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
          data-testid="campaign-document-guide"
        >
          Open the first-module guide
        </a>{' '}
        — it walks the whole path in another tab.
      </p>

      <NewModuleDialog campaign={campaign} open={dialogOpen} onOpenChange={setDialogOpen} />

      <EditCampaignDialog campaign={campaign} open={editOpen} onOpenChange={setEditOpen} />
    </div>
  );
}
