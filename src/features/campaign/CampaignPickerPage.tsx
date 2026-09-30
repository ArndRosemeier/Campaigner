import { useRef, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { EllipsisVerticalIcon, FileDownIcon, FileUpIcon, PencilIcon, PlusIcon } from 'lucide-react';

import { useLiveQuery } from 'dexie-react-hooks';

import { documentPath, workspacePath } from '@/app/routes';
import { campaignRepo } from '@/db';
import { GAME_SYSTEM_LABELS, type GameSystem } from '@/domain';
import { GameSystemSelect } from '@/components/game-system-select';
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
import { Badge } from '@/components/ui/badge';
import { HelpButton } from '@/help/HelpButton';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useCampaignSummaries, type CampaignSummary } from '@/features/campaign/hooks';
import { CampaignCoverArt, GenerateCampaignCoverButton } from '@/features/covers/cover-art';
import { useOnboardingStore } from '@/features/onboarding/onboardingStore';
import { readSettings } from '@/db/settingsRepo';
import { SparklesIcon } from 'lucide-react';
import { ExportCampaignDialog } from '@/features/campaign/components/export-dialog';
import { EditCampaignDialog } from '@/features/campaign/components/edit-campaign-dialog';
import { useCampaignImport } from '@/features/campaign/import-flow';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { useNavigate as useNav } from 'react-router-dom';
import { formatDate } from '@/lib/format';
import { toastError, toastSuccess } from '@/lib/toast';
import { Input } from '@/components/ui/input';
import {
  createCampaignAndChatPath,
  DEFAULT_CAMPAIGN_SYSTEM,
  NEW_CAMPAIGN_NAME,
} from '@/features/campaign/start-campaign-chat';

/**
 * Campaign picker (05-UI §Campaign picker): card grid of campaigns (name,
 * description snippet, system badge, artifact count, last updated) + "New
 * Campaign" dialog; deleting a campaign cascades via the repo and asks for
 * confirmation; the card menu also opens "Edit campaign…" (name +
 * description — the system is fixed).
 *
 * Import (07-MILESTONE-3 M3-E slice B) is parse-first, and since docs/17 row
 * 322 the whole flow is the ONE `useCampaignImport` hook: the file is parsed
 * and its dependency manifest analyzed BEFORE the import transaction opens.
 * A clean manifest keeps today's one-click path byte-identical; MISSING
 * statblock citations or unmet NPC refs open the dep-summary dialog instead —
 * Abort (default) never enters the transaction, "Import anyway" lands the
 * encounters with `missing ref` markers plus the campaign banner. A
 * `version-drift` citation (docs/17 row 261) is neither: the import proceeds
 * and the drift is toasted by count, so the one-click path never goes silent
 * over content that came from a different version of a book. This page imports
 * as a NEW campaign (the hook's absent-`targetCampaignId` mode, and the only
 * caller that navigates to the result).
 */
export function CampaignPickerPage(): JSX.Element {
  const summaries = useCampaignSummaries();
  const settings = useLiveQuery(() => readSettings(), []);
  const openWizard = useOnboardingStore((state) => state.openWizard);
  const [newName, setNewName] = useState('');
  const [newSystem, setNewSystem] = useState<GameSystem>(DEFAULT_CAMPAIGN_SYSTEM);
  async function handleCreate(): Promise<void> {
    try {
      navigate(await createCampaignAndChatPath(newName, newSystem));
    } catch (error) {
      toastError('Could not create campaign', error);
    }
  }
  const navigate = useNavigate();
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const importedNavigate = useNav();
  const importFlow = useCampaignImport({
    describeSuccess: (result) =>
      `Imported ${result.createdArtifacts} artifact(s) as a new campaign`,
    onImported: (result) => {
      importedNavigate(workspacePath(result.campaignId));
    },
  });

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Campaigns</h1>
            <p className="text-sm text-muted-foreground">
              Pick a campaign to open its modules, or start a new one.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <HelpButton topic="campaigns" label="campaigns" />
            {/* Re-open affordance for the first-run setup wizard: hidden only
                once the user finished it (05-UI.md §Onboarding). */}
            {settings !== undefined && settings.onboarding.status !== 'complete' && (
              <Button
                variant="outline"
                onClick={() => {
                  openWizard();
                }}
                data-testid="get-set-up"
              >
                <SparklesIcon aria-hidden data-icon="inline-start" />
                Get set up
              </Button>
            )}
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json,application/zip,.zip"
              className="hidden"
              data-testid="import-input"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) void importFlow.handleFile(file);
                event.target.value = '';
              }}
            />
            <Button
              variant="outline"
              onClick={() => {
                importInputRef.current?.click();
              }}
              data-testid="import-campaign"
            >
              <FileUpIcon aria-hidden data-icon="inline-start" />
              Import
            </Button>
            <Input
              value={newName}
              placeholder={NEW_CAMPAIGN_NAME}
              aria-label="New campaign name"
              data-testid="new-campaign-name"
              className="h-8 w-40"
              onChange={(event) => {
                setNewName(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleCreate();
              }}
            />
            {/* The system is fixed after creation, so it is chosen here (docs/17 row 416). */}
            <GameSystemSelect
              value={newSystem}
              onChange={setNewSystem}
              ariaLabel="New campaign game system"
              triggerClassName="h-8 w-40 text-sm"
              testId="new-campaign-system"
            />
            <Button
              onClick={() => {
                void handleCreate();
              }}
              data-testid="new-campaign"
            >
              <PlusIcon aria-hidden data-icon="inline-start" />
              New Campaign
            </Button>
          </div>
        </div>

        {summaries === undefined ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : summaries.length === 0 ? (
          <Card className="items-center py-10 text-center">
            <CardHeader>
              <CardTitle>No campaigns yet</CardTitle>
              <CardDescription>
                Create your first campaign to start building a world.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center justify-center gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  openWizard();
                }}
                data-testid="empty-set-up"
              >
                <SparklesIcon aria-hidden data-icon="inline-start" />
                Set up Campaigner
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  void handleCreate();
                }}
              >
                <PlusIcon aria-hidden data-icon="inline-start" />
                New Campaign
              </Button>
            </CardContent>
          </Card>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {summaries.map((summary) => (
              <li key={summary.campaign.id}>
                <CampaignCard
                  summary={summary}
                  onOpen={() => {
                    // Opening a campaign lands on its MODULES view — the
                    // central view the rest of the app feeds (owner-ratified).
                    navigate(documentPath(summary.campaign.id));
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      {importFlow.dialog}
    </div>
  );
}

interface CampaignCardProps {
  summary: CampaignSummary;
  onOpen: () => void;
}

function CampaignCard({ summary, onOpen }: CampaignCardProps) {
  const { campaign, artifactCount } = summary;
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const exportArtifacts = useLiveQuery(() => listArtifactsByCampaign(campaign.id), [campaign.id]);

  async function handleDelete(): Promise<void> {
    try {
      await campaignRepo.deleteCampaign(campaign.id);
      toastSuccess('Campaign deleted');
    } catch (error) {
      toastError('Could not delete campaign', error);
    }
    setDeleteOpen(false);
  }

  return (
    <>
      <Card className="h-full">
        <CardHeader>
          <CardTitle>
            <button
              type="button"
              className="text-left hover:underline"
              onClick={onOpen}
              data-testid={`open-campaign-${campaign.id}`}
            >
              {campaign.name}
            </button>
          </CardTitle>
          <CardDescription>Updated {formatDate(campaign.updatedAt)}</CardDescription>
          <CardAction>
            <DropdownMenu>
              <DropdownMenuTrigger
                className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
                aria-label={`Menu for ${campaign.name}`}
              >
                <EllipsisVerticalIcon aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => {
                    setEditOpen(true);
                  }}
                >
                  <PencilIcon aria-hidden data-icon="inline-start" />
                  Edit campaign…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setExportOpen(true);
                  }}
                >
                  <FileDownIcon aria-hidden data-icon="inline-start" />
                  Export campaign…
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => {
                    setDeleteOpen(true);
                  }}
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-xs text-muted-foreground">
          {/* Cover art (cover-generation arc): renders only when the
              campaign has cover art — the card shape never shifts for
              cover-less campaigns. */}
          <CampaignCoverArt campaign={campaign} />
          {/* Context snippet — quiet, clamped; only when the campaign has a
              description (creation leaves it blank). */}
          {campaign.description !== '' && (
            <p className="line-clamp-2" data-testid={`campaign-card-description-${campaign.id}`}>
              {campaign.description}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{GAME_SYSTEM_LABELS[campaign.system]}</Badge>
            <span>
              {artifactCount} artifact{artifactCount === 1 ? '' : 's'}
            </span>
            {/* Cover generation (GM control — the picker never renders in
                player-safe mode). */}
            <span className="ml-auto">
              <GenerateCampaignCoverButton campaign={campaign} />
            </span>
          </div>
        </CardContent>
      </Card>

      <EditCampaignDialog campaign={campaign} open={editOpen} onOpenChange={setEditOpen} />

      <ExportCampaignDialog
        campaignId={campaign.id}
        campaignName={campaign.name}
        artifacts={exportArtifacts ?? []}
        open={exportOpen}
        onOpenChange={setExportOpen}
      />

      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open) setDeleteOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{campaign.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the campaign with all of its artifacts, revisions and runs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDelete()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
