import { useState } from 'react';
import type { JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { BookOpenIcon, MessageSquareTextIcon, NetworkIcon, PencilIcon, PlusIcon, SquarePenIcon, Trash2Icon } from 'lucide-react';

import { boardPath, canvasChatPath, canvasPath, guidePath, modulePath } from '@/app/routes';
import { Badge } from '@/components/ui/badge';
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
import { MODULE_SIZE_LABELS, type Module } from '@/domain';
import { getCampaign } from '@/db/campaignRepo';
import { listArtifactsByModule } from '@/db/artifactRepo';
import { modulesReferencingOwnedArtifacts, type ReferencedOwnedArtifact } from '@/db/artifactAutoPromote';
import { deleteModule } from '@/db/moduleRepo';
import { countMobArtifactsCitedByModule, type ModuleMobCitations } from '@/db/mobArtifacts';
import { useModules } from '@/features/modules/hooks';
import { GenerateModuleCoverButton, ModuleCoverThumb } from '@/features/covers/cover-art';
import { NewModuleDialog } from '@/features/modules/new-module-dialog';
import { EditCampaignDialog } from '@/features/campaign/components/edit-campaign-dialog';
import { useProgressStore } from '@/lib/progress';
import { toastError, toastSuccess } from '@/lib/toast';

/** Reference kinds the delete scan reports, in the dialog's own words. A
 * total map (not a ternary chain): every new `ReferenceVia` member must state
 * its user-facing wording instead of silently rendering as "a battle". */
const REFERENCE_VIA_LABELS: Readonly<Record<ReferencedOwnedArtifact['via'], string>> = {
  link: 'a wiki-link',
  relation: 'an artifact relation',
  roster: 'an encounter roster',
  battle: 'a battle',
  outline: 'a deliverable outline',
};

/**
 * Module list (08-MODULE-DESIGNER M4-B): the campaign's modules with status
 * and progress, plus the "New Module" entry point. A module that is being
 * forged right now shows the live dock detail ("Writing part 2 of 5: …") on
 * its row — generation stays visible wherever the user is, not only in the
 * workspace. The header carries a compact campaign context line (name +
 * description, when set) with the "Edit campaign" affordance.
 */
export function ModulesListPage(): JSX.Element {
  const { campaignId = '' } = useParams<{ campaignId: string }>();
  const navigate = useNavigate();
  const modules = useModules(campaignId === '' ? undefined : campaignId);
  const jobs = useProgressStore((state) => state.jobs);
  const campaign = useLiveQuery(
    async () => (campaignId === '' ? undefined : await getCampaign(campaignId)),
    [campaignId],
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Module | null>(null);
  /**
   * Artifacts owned by the delete target (10-MILESTONE-6 D5), LIVE: the
   * count re-derives while the dialog is open, so the user reads what the
   * module owns NOW, not what it owned when the dialog opened. undefined =
   * still counting (or no target); the confirm handler recounts once more
   * before choosing the branch.
   */
  const ownedCount = useLiveQuery(async () => {
    if (deleteTarget === null) return null;
    return (await listArtifactsByModule(deleteTarget.id)).length;
  }, [deleteTarget]);
  /**
   * Shared mob artifacts the target's encounters CITE (rulebook-cited
   * creatures: ONE campaign-scoped row per cited chunk, docs/11 D5). A
   * REFERENCE, never ownership — the cascade does not touch them and must
   * not: they outlive the module by design. Counted so the dialog states the
   * blast radius before the click.
   */
  const citedMobs = useLiveQuery(async () => {
    if (deleteTarget === null) return null;
    if ((await listArtifactsByModule(deleteTarget.id)).length === 0) return null;
    return countMobArtifactsCitedByModule(deleteTarget.id);
  }, [deleteTarget]);
  /**
   * Owned artifacts referenced from OUTSIDE the delete target (auto-promote
   * reference scan: wikilinks, rosters, battle tokens), LIVE like the count.
   * Non-empty switches the dialog to its third state: promote-and-keep the
   * referenced rows vs force-delete everything. null = still scanning.
   */
  const referenced = useLiveQuery(async () => {
    if (deleteTarget === null) return null;
    if ((await listArtifactsByModule(deleteTarget.id)).length === 0) return [];
    return modulesReferencingOwnedArtifacts(deleteTarget.id);
  }, [deleteTarget]);
  // useLiveQuery is undefined until the first run — normalize to null so
  // the dialog branches below stay total.
  const owned: number | null = ownedCount ?? null;
  const refs: ReferencedOwnedArtifact[] | null = referenced ?? null;
  const cited: ModuleMobCitations | null = citedMobs ?? null;

  /** Runs one delete branch (10-MILESTONE-6 D5): the user picked what happens
   * to the owned artifacts; the module row always goes. */
  function runDelete(target: Module, ownedArtifacts: 'cascade' | 'keep' | 'promote-referenced'): void {
    setDeleteTarget(null);
    deleteModule(target.id, ownedArtifacts)
      .then(() => {
        toastSuccess(
          ownedArtifacts === 'promote-referenced'
            ? 'Module deleted — referenced artifacts are now shared across the campaign'
            : 'Module deleted',
        );
      })
      .catch((error: unknown) => {
        toastError('Could not delete the module', error);
      });
  }

  /** The plain "Delete" button's branch: derived from a FRESH count at
   * confirm time, never from the count that was live when the dialog opened
   * (an artifact that lands in between must be cascaded, not released —
   * deleteModule re-lists the rows inside its transaction either way). */
  async function confirmDelete(target: Module): Promise<void> {
    let freshCount: number;
    try {
      freshCount = (await listArtifactsByModule(target.id)).length;
    } catch (error) {
      toastError('Could not recount the artifacts owned by the module', error);
      return;
    }
    runDelete(target, freshCount > 0 ? 'cascade' : 'keep');
  }

  if (modules === undefined || campaign === undefined) {
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  }

  function forgeJobFor(moduleId: string): string | null {
    const job = jobs.find(
      (entry) => entry.id === `module-spine-${moduleId}` || entry.id === `module-parts-${moduleId}`,
    );
    return job === undefined ? null : (job.detail === '' ? job.label : job.detail);
  }

  return (
    <div className="mx-auto max-w-3xl p-6" data-testid="modules-page">
      <div className="mb-4 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="font-heading text-xl font-semibold">Modules</h1>
          {/* Campaign context line: the campaign this list belongs to, plus
              its description when one is set (quiet, clamped — context, not
              a banner). */}
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
          New Module
        </Button>
      </div>

      {modules.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No modules yet — a Module is a markdown adventure document with wiki-linked entities;
          generate it spine-first, part by part. New to authoring?{' '}
          <a
            href={guidePath()}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
            data-testid="modules-empty-guide"
          >
            Open the first-module guide
          </a>{' '}
          — it walks the whole path in another tab.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {modules.map((module) => (
            <li key={module.id}>
              <div className="flex items-center gap-3 rounded-lg border p-3 hover:bg-accent/40">
                <BookOpenIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                {/* Cover thumb (cover-generation arc): renders only when the
                    module has cover art — the row shape never shifts for
                    cover-less modules. */}
                <ModuleCoverThumb module={module} />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    navigate(modulePath(campaignId, module.id));
                  }}
                >
                  <span className="block truncate font-medium">{module.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {module.concept}
                  </span>
                  {forgeJobFor(module.id) !== null && (
                    <span
                      className="block truncate text-xs text-sky-500 dark:text-sky-400"
                      data-testid="module-forge-detail"
                    >
                      {forgeJobFor(module.id)}
                    </span>
                  )}
                </button>
                <Badge variant="outline">
                  {module.levelMin}–{module.levelMax}
                </Badge>
                <Badge variant="outline">{MODULE_SIZE_LABELS[module.sizeDial]}</Badge>
                <ProgressBadge module={module} />
                {/* Cover generation (compact: icon-only — the row stays one line). */}
                <GenerateModuleCoverButton module={module} compact />
                {/* Whole-module board (08 §Module board) — the module's
                    spatial overview: icon-only like the cover affordance,
                    the row stays one line. */}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Board: ${module.title}`}
                  className="shrink-0"
                  data-testid={`module-board-link-${module.id}`}
                  onClick={() => {
                    navigate(boardPath(campaignId, module.id));
                  }}
                >
                  <NetworkIcon aria-hidden />
                </Button>
                {/* Per-part document canvas (08 §Module canvas) — opens on
                    the module's first part. */}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Canvas: ${module.title}`}
                  className="shrink-0"
                  data-testid={`module-canvas-link-${module.id}`}
                  onClick={() => {
                    navigate(canvasPath(campaignId, module.id));
                  }}
                >
                  <SquarePenIcon aria-hidden />
                </Button>
                {/* Chat front door (08 §Module canvas chat, ledger 57) — one
                    click from the list to talking to the module: the canvas
                    with the chat sidebar forced open. */}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Chat: ${module.title}`}
                  className="shrink-0"
                  data-testid={`module-chat-link-${module.id}`}
                  onClick={() => {
                    navigate(canvasChatPath(campaignId, module.id));
                  }}
                >
                  <MessageSquareTextIcon aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${module.title}`}
                  className="shrink-0 hover:text-destructive"
                  onClick={() => {
                    setDeleteTarget(module);
                  }}
                >
                  <Trash2Icon aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <NewModuleDialog campaign={campaign} open={dialogOpen} onOpenChange={setDialogOpen} />

      <EditCampaignDialog campaign={campaign} open={editOpen} onOpenChange={setEditOpen} />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The module document and its parts are deleted.
              {owned === null || (owned > 0 && refs === null)
                ? ' Counting the artifacts this module owns…'
                : owned === 0
                  ? ' This module owns no artifacts.'
                  : refs !== null && refs.length > 0
                    ? ` ${String(refs.length)} owned artifact${refs.length === 1 ? ' is' : 's are'} still used outside this module — deleting would strand those references. Choose what happens:`
                    : ` This module owns ${String(owned)} artifact${owned === 1 ? '' : 's'}. Choose what happens to them:`}
            </AlertDialogDescription>
            {cited !== null && cited.artifacts.length > 0 && (
              <p className="text-sm text-muted-foreground" data-testid="delete-module-cited-mobs">
                Its encounters also cite {String(cited.artifacts.length)} shared creature
                {cited.artifacts.length === 1 ? '' : 's'} ({cited.artifacts
                  .slice(0, 3)
                  .map((artifact) => `“${artifact.name}”`)
                  .join(', ')}
                {cited.artifacts.length > 3 ? ` and ${String(cited.artifacts.length - 3)} more` : ''}).
                Those are campaign-level references, not part of this module — deleting it never
                removes them.
              </p>
            )}
          </AlertDialogHeader>
          {refs !== null && refs.length > 0 && (
            <ul className="max-h-40 overflow-y-auto rounded-md border px-3 py-2 text-sm" data-testid="delete-module-referenced-list">
              {refs.map((entry) => (
                <li key={entry.artifact.id} className="truncate">
                  “{entry.artifact.name}” ({entry.artifact.kind}) — used by{' '}
                  {REFERENCE_VIA_LABELS[entry.via]}
                </li>
              ))}
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {refs !== null && refs.length > 0 ? (
              <>
                <AlertDialogAction
                  data-testid="delete-module-promote-keep"
                  onClick={() => {
                    const target = deleteTarget;
                    if (target === null) return;
                    // deleteModule re-scans the references fresh inside the
                    // branch — rows referenced after the dialog opened are
                    // promoted too, never stranded.
                    runDelete(target, 'promote-referenced');
                  }}
                >
                  Promote & keep {String(refs.length)} referenced, delete the rest
                </AlertDialogAction>
                <AlertDialogAction
                  className="text-destructive"
                  data-testid="delete-module-confirm"
                  onClick={() => {
                    const target = deleteTarget;
                    if (target === null) return;
                    runDelete(target, 'cascade');
                  }}
                >
                  Force-delete all
                </AlertDialogAction>
              </>
            ) : (
              <>
                {owned !== null && owned > 0 && (
                  <AlertDialogAction
                    data-testid="delete-module-keep"
                    onClick={() => {
                      const target = deleteTarget;
                      if (target === null) return;
                      runDelete(target, 'keep');
                    }}
                  >
                    Keep {String(owned)} artifact{owned === 1 ? '' : 's'}
                  </AlertDialogAction>
                )}
                <AlertDialogAction
                  className={
                    owned !== null && owned > 0
                      ? 'text-destructive'
                      : undefined
                  }
                  data-testid="delete-module-confirm"
                  onClick={() => {
                    const target = deleteTarget;
                    if (target === null) return;
                    void confirmDelete(target);
                  }}
                >
                  {owned !== null && owned > 0
                    ? `Delete module and ${String(owned)} artifact${owned === 1 ? '' : 's'}`
                    : 'Delete'}
                </AlertDialogAction>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ProgressBadge({ module }: { module: Module }): JSX.Element {
  if (module.status === 'failed') {
    return <Badge variant="destructive">failed</Badge>;
  }
  if (module.status === 'generating') {
    return <Badge variant="secondary">generating…</Badge>;
  }
  if (module.spine === null) {
    return <Badge variant="outline">draft</Badge>;
  }
  const total = module.spine.partPlan.length;
  const done = module.spine.partPlan.filter((_, index) => {
    const part = module.parts.find((entry) => entry.planIndex === index);
    return part?.status === 'ready';
  }).length;
  return (
    <Badge variant="secondary" data-testid="module-progress">
      {done}/{total} parts
    </Badge>
  );
}
