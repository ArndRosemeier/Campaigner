import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDownIcon, ChevronRightIcon, PlusIcon, WaypointsIcon } from 'lucide-react';

import { graphPath, workspacePath } from '@/app/routes';
import { Link } from 'react-router-dom';
import { artifactRepo } from '@/db';
import {
  ARTIFACT_KINDS,
  ARTIFACT_KIND_LABELS,
  ARTIFACT_KIND_SINGULAR,
  type Artifact,
  type ArtifactKind,
  type Id,
} from '@/domain';
import { defaultArtifactName } from '@/domain';
import { exportSingleArtifact } from '@/features/campaign/components/export-dialog';
import { exportArtifactPdfFile } from '@/lib/pdfExport';
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
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { matchesFilter } from '@/features/campaign/filter';
import { toastError, toastSuccess } from '@/lib/toast';
import { cn } from '@/lib/utils';

export interface CampaignTreeProps {
  campaignId: Id;
  artifacts: readonly Artifact[];
  selectedArtifactId: Id | undefined;
  onSelectArtifact: (artifactId: Id) => void;
}

/**
 * Left pane (05-UI §Campaign tree): filter input, collapsible per-kind
 * sections with counts and `+` buttons, rows with summary tooltip and
 * Rename/Duplicate/Delete context menu.
 */
export function CampaignTree({
  campaignId,
  artifacts,
  selectedArtifactId,
  onSelectArtifact,
}: CampaignTreeProps) {
  const [filter, setFilter] = useState('');
  const [closedKinds, setClosedKinds] = useState<ReadonlySet<ArtifactKind>>(new Set());
  const [renameTarget, setRenameTarget] = useState<Artifact | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Artifact | null>(null);
  const navigate = useNavigate();

  const filtered = useMemo(
    () => artifacts.filter((artifact) => matchesFilter(artifact, filter)),
    [artifacts, filter],
  );

  async function handleCreate(kind: ArtifactKind): Promise<void> {
    try {
      const created = await artifactRepo.createArtifact({
        campaignId,
        kind,
        name: defaultArtifactName(kind),
      });
      toastSuccess(`${ARTIFACT_KIND_SINGULAR[kind]} created`);
      onSelectArtifact(created.id);
    } catch (error) {
      toastError('Could not create artifact', error);
    }
  }

  async function handleDuplicate(artifact: Artifact): Promise<void> {
    try {
      const copy = await artifactRepo.duplicateArtifact(artifact.id);
      toastSuccess('Artifact duplicated');
      onSelectArtifact(copy.id);
    } catch (error) {
      toastError('Could not duplicate artifact', error);
    }
  }

  async function handleRename(): Promise<void> {
    const target = renameTarget;
    if (target === null) return;
    const name = renameValue.trim();
    setRenameTarget(null);
    if (name === '' || name === target.name) return; // never commit an empty name
    try {
      await artifactRepo.updateArtifact(target.id, { name });
      toastSuccess('Renamed');
    } catch (error) {
      toastError('Rename failed', error);
    }
  }

  async function handleDelete(): Promise<void> {
    const target = deleteTarget;
    if (target === null) return;
    setDeleteTarget(null);
    try {
      await artifactRepo.deleteArtifact(target.id);
      toastSuccess('Artifact deleted');
      if (target.id === selectedArtifactId) navigate(workspacePath(campaignId));
    } catch (error) {
      toastError('Delete failed', error);
    }
  }

  function toggleKind(kind: ArtifactKind, open: boolean): void {
    setClosedKinds((previous) => {
      const next = new Set(previous);
      if (open) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  return (
    <aside className="flex h-full flex-col overflow-hidden border-r" aria-label="Campaign tree">
      <div className="border-b p-2">
        <Input
          value={filter}
          placeholder="Filter by name or tag…"
          aria-label="Filter artifacts"
          className="h-7 bg-transparent text-sm"
          onChange={(event) => {
            setFilter(event.target.value);
          }}
        />
        <Button
          variant="outline"
          size="xs"
          className="mt-1.5 w-full"
          render={<Link to={graphPath(campaignId)} />}
        >
          <WaypointsIcon aria-hidden data-icon="inline-start" />
          Link graph
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {ARTIFACT_KINDS.map((kind) => {
          const items = filtered.filter((artifact) => artifact.kind === kind);
          const open = !closedKinds.has(kind);
          return (
            <Collapsible
              key={kind}
              open={open}
              onOpenChange={(nextOpen) => {
                toggleKind(kind, nextOpen);
              }}
              className="mb-1"
            >
              <div className="group flex items-center gap-0.5 rounded-md px-0.5 hover:bg-accent/50">
                <CollapsibleTrigger className="flex flex-1 items-center gap-1 py-0.5 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase outline-none hover:text-foreground">
                  {open ? (
                    <ChevronDownIcon aria-hidden className="size-3" />
                  ) : (
                    <ChevronRightIcon aria-hidden className="size-3" />
                  )}
                  {ARTIFACT_KIND_LABELS[kind]}
                  <Badge variant="secondary" className="ml-auto">
                    {items.length}
                  </Badge>
                </CollapsibleTrigger>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`New ${ARTIFACT_KIND_SINGULAR[kind]}`}
                  onClick={() => void handleCreate(kind)}
                >
                  <PlusIcon aria-hidden />
                </Button>
              </div>
              <CollapsibleContent>
                {items.length === 0 ? (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">
                    No {ARTIFACT_KIND_LABELS[kind]} yet — create one or ask a persona.
                  </p>
                ) : (
                  <ul className="mt-0.5">
                    {items.map((artifact) => (
                      <li key={artifact.id}>
                        <TreeRow
                          artifact={artifact}
                          selected={artifact.id === selectedArtifactId}
                          onSelect={() => {
                            onSelectArtifact(artifact.id);
                          }}
                          onRename={() => {
                            setRenameTarget(artifact);
                            setRenameValue(artifact.name);
                          }}
                          onDuplicate={() => void handleDuplicate(artifact)}
                          onDelete={() => {
                            setDeleteTarget(artifact);
                          }}
                          onExport={() => {
                            void exportSingleArtifact(artifact);
                          }}
                          onExportPdfGm={() => {
                            void exportArtifactPdfFile(artifact, 'gm');
                          }}
                          onExportPdfPlayer={() => {
                            void exportArtifactPdfFile(artifact, 'player');
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      >
        {renameTarget !== null && (
          <DialogContent>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleRename();
              }}
            >
              <DialogHeader>
                <DialogTitle>Rename artifact</DialogTitle>
                <DialogDescription>Names must not be empty.</DialogDescription>
              </DialogHeader>
              <Input
                value={renameValue}
                autoFocus
                aria-label="Artifact name"
                className="my-2"
                onChange={(event) => {
                  setRenameValue(event.target.value);
                }}
              />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setRenameTarget(null);
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={renameValue.trim() === ''}>
                  Rename
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        {deleteTarget !== null && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{deleteTarget.name}”?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently removes the artifact and its whole revision history.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void handleDelete()}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </aside>
  );
}

interface TreeRowProps {
  artifact: Artifact;
  selected: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onExport: () => void;
  onExportPdfGm: () => void;
  onExportPdfPlayer: () => void;
}

function TreeRow({
  artifact,
  selected,
  onSelect,
  onRename,
  onDuplicate,
  onDelete,
  onExport,
  onExportPdfGm,
  onExportPdfPlayer,
}: TreeRowProps) {
  return (
    <ContextMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <ContextMenuTrigger
              className={cn(
                'flex w-full cursor-default items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-accent',
                selected && 'bg-accent font-medium text-accent-foreground',
              )}
              onClick={onSelect}
            />
          }
        >
          <span className="truncate">{artifact.name}</span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-64">
          {artifact.summary === '' ? 'No summary yet.' : artifact.summary}
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <ContextMenuItem onClick={onRename}>Rename</ContextMenuItem>
        <ContextMenuItem
          onClick={() => {
            onDuplicate();
          }}
        >
          Duplicate
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onExport}>Export as JSON</ContextMenuItem>
        <ContextMenuItem onClick={onExportPdfGm}>Export PDF (GM notes)</ContextMenuItem>
        <ContextMenuItem onClick={onExportPdfPlayer}>Export PDF (player handout)</ContextMenuItem>
        <ContextMenuItem className="text-destructive" onClick={onDelete}>
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
