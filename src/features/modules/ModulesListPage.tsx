import { useState } from 'react';
import type { JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { BookOpenIcon, PlusIcon, Trash2Icon } from 'lucide-react';

import { modulePath } from '@/app/routes';
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
import { deleteModule } from '@/db/moduleRepo';
import { useModules } from '@/features/modules/hooks';
import { NewModuleDialog } from '@/features/modules/new-module-dialog';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * Module list (08-MODULE-DESIGNER M4-B): the campaign's modules with status
 * and progress, plus the "New Module" entry point.
 */
export function ModulesListPage(): JSX.Element {
  const { campaignId = '' } = useParams<{ campaignId: string }>();
  const navigate = useNavigate();
  const modules = useModules(campaignId === '' ? undefined : campaignId);
  const campaign = useLiveQuery(
    async () => (campaignId === '' ? undefined : await getCampaign(campaignId)),
    [campaignId],
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Module | null>(null);

  if (modules === undefined || campaign === undefined) {
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="mx-auto max-w-3xl p-6" data-testid="modules-page">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="font-heading text-xl font-semibold">Modules</h1>
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
          generate it spine-first, part by part.
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
              The module document and its parts are deleted. Artifacts created from it stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = deleteTarget;
                if (target === null) return;
                setDeleteTarget(null);
                deleteModule(target.id)
                  .then(() => {
                    toastSuccess('Module deleted');
                  })
                  .catch((error: unknown) => {
                    toastError('Could not delete the module', error);
                  });
              }}
            >
              Delete
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
