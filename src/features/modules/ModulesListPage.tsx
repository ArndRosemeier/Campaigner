import { useState } from 'react';
import type { JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { BookOpenIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';

import { guidePath, modulePath } from '@/app/routes';
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
import { deleteModule } from '@/db/moduleRepo';
import { useModules } from '@/features/modules/hooks';
import { NewModuleDialog } from '@/features/modules/new-module-dialog';
import { EditCampaignDialog } from '@/features/campaign/components/edit-campaign-dialog';
import { useProgressStore } from '@/lib/progress';
import { toastError, toastSuccess } from '@/lib/toast';

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

  /** Runs one delete branch (10-MILESTONE-6 D5): the user picked what happens
   * to the owned artifacts; the module row always goes. */
  function runDelete(target: Module, ownedArtifacts: 'cascade' | 'keep'): void {
    setDeleteTarget(null);
    deleteModule(target.id, ownedArtifacts)
      .then(() => {
        toastSuccess('Module deleted');
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
              {ownedCount === null
                ? ' Counting the artifacts this module owns…'
                : ownedCount === 0
                  ? ' This module owns no artifacts.'
                  : ` This module owns ${String(ownedCount)} artifact${ownedCount === 1 ? '' : 's'}. Choose what happens to them:`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {ownedCount !== null && ownedCount !== undefined && ownedCount > 0 && (
              <AlertDialogAction
                data-testid="delete-module-keep"
                onClick={() => {
                  const target = deleteTarget;
                  if (target === null) return;
                  runDelete(target, 'keep');
                }}
              >
                Keep {String(ownedCount)} artifact{ownedCount === 1 ? '' : 's'}
              </AlertDialogAction>
            )}
            <AlertDialogAction
              className={
                ownedCount !== null && ownedCount !== undefined && ownedCount > 0
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
              {ownedCount !== null && ownedCount !== undefined && ownedCount > 0
                ? `Delete module and ${String(ownedCount)} artifact${ownedCount === 1 ? '' : 's'}`
                : 'Delete'}
            </AlertDialogAction>
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
