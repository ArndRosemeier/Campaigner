import { useRef, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { EllipsisVerticalIcon, FileDownIcon, FileUpIcon, PlusIcon } from 'lucide-react';

import { useLiveQuery } from 'dexie-react-hooks';

import { workspacePath } from '@/app/routes';
import { campaignRepo } from '@/db';
import { GAME_SYSTEMS, GAME_SYSTEM_LABELS, type GameSystem } from '@/domain';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useCampaignSummaries, type CampaignSummary } from '@/features/campaign/hooks';
import { ExportCampaignDialog } from '@/features/campaign/components/export-dialog';
import {
  downloadBlob,
  buildCampaignExport,
  exportFileName,
  importExport,
} from '@/lib/exportImport';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { useNavigate as useNav } from 'react-router-dom';
import { formatDate } from '@/lib/format';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * Campaign picker (05-UI §Campaign picker): card grid of campaigns (name,
 * system badge, artifact count, last updated) + "New Campaign" dialog;
 * deleting a campaign cascades via the repo and asks for confirmation.
 */
export function CampaignPickerPage(): JSX.Element {
  const summaries = useCampaignSummaries();
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const importedNavigate = useNav();

  async function handleImportFile(file: File): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const result = await importExport(parsed);
      toastSuccess(`Imported ${result.createdArtifacts} artifact(s) as a new campaign`);
      importedNavigate(workspacePath(result.campaignId));
    } catch (error) {
      toastError('Import failed — is this a Campaigner export?', error);
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Campaigns</h1>
            <p className="text-sm text-muted-foreground">
              Pick a campaign to open its workspace, or start a new one.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <HelpButton topic="campaigns" label="campaigns" />
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              data-testid="import-input"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) void handleImportFile(file);
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
              Import JSON
            </Button>
            <Button
              onClick={() => {
                setCreateOpen(true);
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
            <CardContent>
              <Button
                variant="outline"
                onClick={() => {
                  setCreateOpen(true);
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
                    navigate(workspacePath(summary.campaign.id));
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <CreateCampaignDialog open={createOpen} onOpenChange={setCreateOpen} />
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
  const exportArtifacts = useLiveQuery(() => listArtifactsByCampaign(campaign.id), [campaign.id]);

  async function handleExportCampaign(): Promise<void> {
    try {
      const exported = await buildCampaignExport(campaign.id);
      downloadBlob(
        new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }),
        exportFileName(exported),
      );
      toastSuccess('Campaign exported');
    } catch (error) {
      toastError('Export failed', error);
    }
  }

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
                    void handleExportCampaign();
                  }}
                >
                  <FileDownIcon aria-hidden data-icon="inline-start" />
                  Export whole campaign (JSON)
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
        <CardContent className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary">{GAME_SYSTEM_LABELS[campaign.system]}</Badge>
          <span>
            {artifactCount} artifact{artifactCount === 1 ? '' : 's'}
          </span>
        </CardContent>
      </Card>

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

const DEFAULT_CAMPAIGN_SYSTEM: GameSystem = 'generic-d20';

interface CreateCampaignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function CreateCampaignDialog({ open, onOpenChange }: CreateCampaignDialogProps) {
  const [name, setName] = useState('');
  const [system, setSystem] = useState<GameSystem>(DEFAULT_CAMPAIGN_SYSTEM);
  const [description, setDescription] = useState('');

  async function handleCreate(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === '') return;
    try {
      await campaignRepo.createCampaign({
        name: trimmed,
        description: description.trim(),
        system,
      });
      toastSuccess('Campaign created');
      onOpenChange(false);
      setName('');
      setSystem(DEFAULT_CAMPAIGN_SYSTEM);
      setDescription('');
    } catch (error) {
      toastError('Could not create campaign', error);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
        >
          <DialogHeader>
            <DialogTitle>New campaign</DialogTitle>
            <DialogDescription>
              Name the campaign and pick its game system. You can add a description later.
            </DialogDescription>
          </DialogHeader>
          <div className="my-3 flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Name
              <Input
                value={name}
                autoFocus
                placeholder="e.g. The Sunless Sea"
                aria-label="Campaign name"
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              System
              <Select
                value={system}
                onValueChange={(value) => {
                  if (value !== null) setSystem(value);
                }}
              >
                <SelectTrigger className="w-full" aria-label="Game system">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GAME_SYSTEMS.map((gameSystem) => (
                    <SelectItem key={gameSystem} value={gameSystem}>
                      {GAME_SYSTEM_LABELS[gameSystem]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Description (optional)
              <Textarea
                value={description}
                placeholder="One or two sentences about the setting…"
                aria-label="Campaign description"
                className="min-h-[64px] text-sm"
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
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
            <Button type="submit" disabled={name.trim() === ''}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
