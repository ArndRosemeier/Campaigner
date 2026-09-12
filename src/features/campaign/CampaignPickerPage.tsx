import { useRef, useState } from 'react';
import type { JSX } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { EllipsisVerticalIcon, FileDownIcon, FileUpIcon, PencilIcon, PlusIcon } from 'lucide-react';

import { useLiveQuery } from 'dexie-react-hooks';

import { modulesPath, ROUTES, workspacePath } from '@/app/routes';
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
import { CampaignCoverArt, GenerateCampaignCoverButton } from '@/features/covers/cover-art';
import { useOnboardingStore } from '@/features/onboarding/onboardingStore';
import { readSettings } from '@/db/settingsRepo';
import { SparklesIcon } from 'lucide-react';
import { ExportCampaignDialog } from '@/features/campaign/components/export-dialog';
import { EditCampaignDialog } from '@/features/campaign/components/edit-campaign-dialog';
import {
  checkImportDependencies,
  importExport,
  importZip,
  MissingDependenciesError,
  parseExportTolerant,
  parseZipExport,
  withImportMitigation,
  type DependencyPolicy,
  formatRetiredTableRows,
} from '@/lib/exportImport';
import { groupCitationsByArtifact, type DependencyAnalysis } from '@/domain';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { useNavigate as useNav } from 'react-router-dom';
import { formatDate } from '@/lib/format';
import { toastError, toastInfo, toastSuccess } from '@/lib/toast';

/**
 * A file waiting on the dependency decision: the raw payload is stashed so
 * "Import anyway" can run the SAME bytes without re-reading the file.
 */
type PendingImport = { kind: 'json'; raw: unknown } | { kind: 'zip'; bytes: Uint8Array };

/**
 * Campaign picker (05-UI §Campaign picker): card grid of campaigns (name,
 * description snippet, system badge, artifact count, last updated) + "New
 * Campaign" dialog; deleting a campaign cascades via the repo and asks for
 * confirmation; the card menu also opens "Edit campaign…" (name +
 * description — the system is fixed).
 *
 * Import (07-MILESTONE-3 M3-E slice B) is parse-first: the file is parsed
 * and its dependency manifest analyzed BEFORE the import transaction opens.
 * A clean manifest keeps today's one-click path byte-identical; unmet
 * statblock citations or NPC refs open the dep-summary dialog instead —
 * Abort (default) never enters the transaction, "Import anyway" lands the
 * encounters with `missing ref` markers plus the campaign banner.
 */
export function CampaignPickerPage(): JSX.Element {
  const summaries = useCampaignSummaries();
  const settings = useLiveQuery(() => readSettings(), []);
  const openWizard = useOnboardingStore((state) => state.openWizard);
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const importedNavigate = useNav();
  const [pendingDeps, setPendingDeps] = useState<{
    analysis: DependencyAnalysis;
    payload: PendingImport;
  } | null>(null);
  const [depsWorking, setDepsWorking] = useState(false);

  async function attemptImport(payload: PendingImport, policy: DependencyPolicy): Promise<void> {
    const result =
      payload.kind === 'zip'
        ? await importZip(payload.bytes, { dependencyPolicy: policy })
        : await importExport(payload.raw, {}, { dependencyPolicy: policy });
    toastSuccess(`Imported ${result.createdArtifacts} artifact(s) as a new campaign`);
    // Retired tables (docs/17 row 108): an older file may still carry rows for
    // a table this build deleted. Skipped LOUDLY, with the count.
    const retiredNote = formatRetiredTableRows(result.retiredRows);
    if (retiredNote !== null) toastInfo(retiredNote);
    if (result.skippedRetired > 0) {
      // Retired-row tolerance (M2 import rules): the skip is never silent —
      // the count and the skipped record names ride alongside success.
      const names = result.skippedNames.length > 0 ? `: ${result.skippedNames.join(', ')}` : '';
      toastInfo(
        `Import skipped ${result.skippedRetired} retired session record(s) from an older version${names}`,
      );
    }
    importedNavigate(workspacePath(result.campaignId));
  }

  async function handleImportFile(file: File): Promise<void> {
    let payload: PendingImport;
    try {
      // Zip bundles carry image binaries next to the manifest (M3-A).
      const isZip = file.name.endsWith('.zip') || file.type === 'application/zip';
      payload = isZip
        ? { kind: 'zip', bytes: new Uint8Array(await file.arrayBuffer()) }
        : { kind: 'json', raw: JSON.parse(await file.text()) as unknown };
    } catch (error) {
      // Every import-failure toast carries MITIGATION, not just cause:
      // Zod-shaped failures ride through untouched (the toast seam
      // humanizes them and appends the version-skew mitigation); anything
      // else gets the mitigation appended by `withImportMitigation`.
      toastError('Import failed — is this a Campaigner export?', withImportMitigation(error));
      return;
    }
    let analysis: DependencyAnalysis;
    try {
      // Tolerant parse: legacy exports may carry retired session rows that
      // the strict boundary rejects — their citations leave with them, so
      // the dep check only ever sees landing content.
      const manifest =
        payload.kind === 'zip'
          ? parseExportTolerant(parseZipExport(payload.bytes).manifest).export.dependencies
          : parseExportTolerant(payload.raw).export.dependencies;
      analysis = await checkImportDependencies(manifest);
    } catch (error) {
      toastError('Import failed — is this a Campaigner export?', withImportMitigation(error));
      return;
    }
    if (!analysis.clean) {
      // Abort-by-default: the dialog, not a toast — nothing imported yet.
      setPendingDeps({ analysis, payload });
      return;
    }
    try {
      await attemptImport(payload, 'abort');
    } catch (error) {
      if (error instanceof MissingDependenciesError) {
        // The library changed between analysis and import — same dialog.
        setPendingDeps({ analysis: error.analysis, payload });
        return;
      }
      toastError('Import failed — is this a Campaigner export?', withImportMitigation(error));
    }
  }

  async function handleImportAnyway(): Promise<void> {
    const pending = pendingDeps;
    if (pending === null || depsWorking) return;
    setDepsWorking(true);
    try {
      await attemptImport(pending.payload, 'import-anyway');
      setPendingDeps(null);
    } catch (error) {
      toastError('Import failed — is this a Campaigner export?', withImportMitigation(error));
    } finally {
      setDepsWorking(false);
    }
  }

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
              Import
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
                    // Opening a campaign lands on its MODULES view — the
                    // central view the rest of the app feeds (owner-ratified).
                    navigate(modulesPath(summary.campaign.id));
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <CreateCampaignDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ImportDepsDialog
        pending={pendingDeps}
        working={depsWorking}
        onAbort={() => {
          setPendingDeps(null);
        }}
        onImportAnyway={() => {
          void handleImportAnyway();
        }}
      />
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
                items={GAME_SYSTEM_LABELS}
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

/**
 * Missing-dependency summary (07-MILESTONE-3 M3-E slice B): the abort-by-
 * default gate. Copies the backup-section AlertDialog abort/commit shape;
 * the per-book rows copy the PackImportReport badge/list grammar —
 * `{title, system, expectedChunks, matchLevel}` badges plus the citing
 * artifacts (`encounter → creature`) and the unmet NPC refs.
 *
 * Abort is the default (Cancel + Esc + backdrop — never enters the import
 * transaction, so there is nothing to roll back). "Import anyway" lands the
 * encounters with `missing ref` markers plus the campaign banner.
 */
function ImportDepsDialog({
  pending,
  working,
  onAbort,
  onImportAnyway,
}: {
  pending: { analysis: DependencyAnalysis; payload: PendingImport } | null;
  working: boolean;
  onAbort: () => void;
  onImportAnyway: () => void;
}): JSX.Element {
  const citing = pending === null ? [] : groupCitationsByArtifact(pending.analysis);
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onAbort();
      }}
    >
      <AlertDialogContent data-testid="import-deps-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Import needs missing rulebook content</AlertDialogTitle>
          <AlertDialogDescription>
            This export cites stat blocks and references that are not in this library — nothing
            has been imported yet. Install the listed book(s) in{' '}
            <Link to={ROUTES.rules} className="underline" data-testid="import-deps-rules-link">
              Rules
            </Link>{' '}
            (“Import bestiary pack”, or re-import the rulebook PDF), then import again — or
            import anyway and the encounters below will show 'missing ref' until then.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {pending !== null && (
          <div className="flex max-h-64 flex-col gap-2 overflow-y-auto text-xs">
            {pending.analysis.books.map((entry) => (
              <div
                key={`${entry.book.system}-${entry.book.title}`}
                className="rounded-md border p-2"
                data-testid="import-deps-book"
              >
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {entry.book.title} ({entry.book.system})
                  </span>
                  <Badge
                    variant={entry.matchLevel === 'L0' ? 'secondary' : entry.matchLevel === 'missing' ? 'destructive' : 'outline'}
                    data-testid="import-deps-match-level"
                  >
                    {entry.matchLevel === 'L0'
                      ? 'present'
                      : entry.matchLevel === 'L1'
                        ? 'version drift'
                        : entry.matchLevel === 'L2'
                          ? 'similar content'
                          : 'missing'}
                  </Badge>
                  <Badge variant="secondary" data-testid="import-deps-expected">
                    {String(entry.book.citedChunkIds.length)} cited
                  </Badge>
                </p>
                {entry.hint !== undefined && (
                  <p className="mt-1 text-muted-foreground">{entry.hint}</p>
                )}
              </div>
            ))}
            {citing.length > 0 && (
              <div className="rounded-md border p-2" data-testid="import-deps-citing">
                <p className="font-medium">Citing encounters</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {citing.map((group) => (
                    <li key={group.artifactName}>
                      <span className="font-medium">{group.artifactName}</span>
                      {' → '}
                      {group.monsters.map((monster) => (
                        <span key={monster.monsterName} className="mr-2">
                          {monster.monsterName}{' '}
                          <Badge
                            variant={monster.verdict === 'missing' ? 'destructive' : 'outline'}
                          >
                            {monster.verdict === 'missing' ? 'missing' : 'version drift'}
                          </Badge>
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {pending.analysis.unmetLibraryRefs.length > 0 && (
              <div className="rounded-md border p-2" data-testid="import-deps-unmet">
                <p className="font-medium">NPC references outside the export</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {pending.analysis.unmetLibraryRefs.map((ref) => (
                    <li key={`${ref.artifactId}-${ref.npcArtifactId}`}>
                      <span className="font-medium">{ref.artifactName}</span>
                      {' → '}
                      {ref.npcName ?? ref.npcArtifactId}{' '}
                      <Badge variant="destructive">{ref.status}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="import-deps-abort" disabled={working}>
            Abort
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="import-deps-import-anyway"
            disabled={working}
            onClick={() => {
              onImportAnyway();
            }}
          >
            {working ? 'Importing…' : 'Import anyway'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
