import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  PlusIcon,
  Trash2Icon,
  WaypointsIcon,
} from 'lucide-react';

import { useModules } from '@/features/modules/hooks';
import { useScopeToggles } from '@/features/campaign/hooks';
import { ScopeControl } from '@/features/campaign/components/scope-control';
import { AdoptDialog } from '@/features/campaign/components/adopt-dialog';
import { publishToLibrary } from '@/db/artifactRepo';
import { graphPath, workspacePath } from '@/app/routes';
import { Link } from 'react-router-dom';
import { artifactRepo } from '@/db';
import {
  ARTIFACT_KINDS,
  ARTIFACT_KIND_LABELS,
  ARTIFACT_KIND_SINGULAR,
  type AnyArtifact,
  type Artifact,
  type ArtifactKind,
  type GlobalArtifact,
  type Id,
  defaultScopeToggles,
  globalArtifactKindSchema,
} from '@/domain';
import { defaultArtifactName } from '@/domain';
import { exportSingleArtifact } from '@/features/campaign/components/export-dialog';
import { exportArtifactPdfFile } from '@/lib/pdfExport';
import { ImageThumb } from '@/features/images/image-thumb';
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
import { Checkbox } from '@/components/ui/checkbox';
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
import { HelpButton } from '@/help/HelpButton';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { matchesFilter } from '@/features/campaign/filter';
import { toastError, toastSuccess } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** Shared collapsible group shell for Library / module / kind sections. */
function TreeGroup({
  label,
  count,
  open,
  onToggle,
  children,
  actions,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: (group: string, open: boolean) => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
}): JSX.Element {
  return (
    <Collapsible
      open={open}
      onOpenChange={(nextOpen) => {
        onToggle(label, nextOpen);
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
          {label}
          <Badge variant="secondary" className="ml-auto">
            {count}
          </Badge>
        </CollapsibleTrigger>
        {actions}
      </div>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

export interface CampaignTreeProps {
  campaignId: Id;
  artifacts: readonly Artifact[];
  /** The global library rows (rendered in their own group, D3). */
  globals: readonly GlobalArtifact[];
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
  globals,
  selectedArtifactId,
  onSelectArtifact,
}: CampaignTreeProps) {
  const [filter, setFilter] = useState('');
  const [closedKinds, setClosedKinds] = useState<ReadonlySet<ArtifactKind>>(new Set());
  const [renameTarget, setRenameTarget] = useState<AnyArtifact | null>(null);
  const [renameValue, setRenameValue] = useState('');
  /** "Add old name as alias" (default on) so module wiki-links keep resolving. */
  const [renameKeepAlias, setRenameKeepAlias] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<AnyArtifact | null>(null);
  const [publishTarget, setPublishTarget] = useState<Artifact | null>(null);
  const [adoptTarget, setAdoptTarget] = useState<GlobalArtifact | null>(null);
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<string>>(new Set());
  function setGroupOpenState(group: string, open: boolean): void {
    setClosedGroups((previous) => {
      const next = new Set(previous);
      if (open) next.delete(group);
      else next.add(group);
      return next;
    });
  }
  const navigate = useNavigate();

  // Toggles load async from settings; render with the workspace defaults
  // until they arrive (the control flips to the stored value right after).
  const scopes = useScopeToggles('workspace') ?? defaultScopeToggles('workspace');
  const modules = useModules(campaignId);

  const filtered = useMemo(
    () => artifacts.filter((artifact) => matchesFilter(artifact, filter)),
    [artifacts, filter],
  );
  const filteredGlobals = useMemo(
    () => globals.filter((artifact) => matchesFilter(artifact, filter)),
    [globals, filter],
  );

  // Scope split (10-MILESTONE-6 D3): the library group, one group per owning
  // module, and the plain campaign rows in their kind groups. A module-owned
  // row whose module row is missing (external tampering — both delete paths
  // clean up ownership) falls back to the plain groups so it stays visible.
  const moduleTitleById = useMemo(
    () => new Map((modules ?? []).map((module) => [module.id, module.title])),
    [modules],
  );
  const moduleGroups = useMemo(() => {
    if (!scopes.module) return [];
    const byModule = new Map<Id, Artifact[]>();
    for (const artifact of filtered) {
      if (artifact.moduleId === null) continue;
      if (!moduleTitleById.has(artifact.moduleId)) continue;
      const rows = byModule.get(artifact.moduleId) ?? [];
      rows.push(artifact);
      byModule.set(artifact.moduleId, rows);
    }
    return [...byModule.entries()].map(([id, rows]) => ({
      id,
      title: moduleTitleById.get(id) ?? id,
      rows,
    }));
  }, [filtered, scopes.module, moduleTitleById]);
  const plainRows = useMemo(() => {
    const orphans = filtered.filter(
      (artifact) => artifact.moduleId !== null && !moduleTitleById.has(artifact.moduleId),
    );
    return scopes.campaign ? [...filtered.filter((artifact) => artifact.moduleId === null), ...orphans] : [];
  }, [filtered, scopes.campaign, moduleTitleById]);
  const libraryRows = scopes.global ? filteredGlobals : [];

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
      // Renaming (M4-A): offer keeping the old name as an alias so existing
      // module text keeps resolving — never rewrite the text itself. The new
      // name absorbs any alias that already spells it (no redundant alias).
      const withOldName =
        renameKeepAlias && !target.aliases.some((alias) => alias.toLowerCase() === target.name.toLowerCase())
          ? [...target.aliases, target.name]
          : target.aliases;
      const aliases = withOldName.filter((alias) => alias.toLowerCase() !== name.toLowerCase());
      await artifactRepo.updateArtifact(target.id, { name, aliases });
      toastSuccess('Renamed');
    } catch (error) {
      toastError('Rename failed', error);
    }
  }

  function runPublish(): void {
    const target = publishTarget;
    if (target === null) return;
    setPublishTarget(null);
    try {
      void publishToLibrary(target.id)
        .then((published) => {
          toastSuccess(`"${published.name}" is shared in the library`);
        })
        .catch((error: unknown) => {
          toastError('Could not publish the artifact', error);
        });
    } catch (error) {
      toastError('Could not publish the artifact', error);
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
        <ScopeControl surface="workspace" />
        <div className="mt-1.5 flex items-center gap-1">
          <Button
            variant="outline"
            size="xs"
            className="flex-1"
            render={<Link to={graphPath(campaignId)} />}
            nativeButton={false}
          >
            <WaypointsIcon aria-hidden data-icon="inline-start" />
            Relations graph
          </Button>
          <HelpButton topic="tree" label="artifact library" />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {libraryRows.length > 0 && (
          <TreeGroup
            label="Library"
            count={libraryRows.length}
            open={!closedGroups.has('library')}
            onToggle={setGroupOpenState}
          >
            <ul className="mt-0.5">
              {libraryRows.map((artifact) => (
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
                    onAdopt={() => {
                      setAdoptTarget(artifact);
                    }}
                    onDelete={() => {
                      setDeleteTarget(artifact);
                    }}
                  />
                </li>
              ))}
            </ul>
          </TreeGroup>
        )}
        {moduleGroups.map((group) => (
          <TreeGroup
            key={group.id}
            label={group.title}
            count={group.rows.length}
            open={!closedGroups.has(group.id)}
            onToggle={setGroupOpenState}
          >
            <ul className="mt-0.5">
              {group.rows.map((artifact) => (
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
                    onPublish={
                      globalArtifactKindSchema.safeParse(artifact.kind).success
                        ? () => {
                            setPublishTarget(artifact);
                          }
                        : undefined
                    }
                  />
                </li>
              ))}
            </ul>
          </TreeGroup>
        ))}
        {ARTIFACT_KINDS.map((kind) => {
          const items = plainRows.filter((artifact) => artifact.kind === kind);
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
                          onPublish={
                            globalArtifactKindSchema.safeParse(artifact.kind).success
                              ? () => {
                                  setPublishTarget(artifact);
                                }
                              : undefined
                          }
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

      <AdoptDialog
        artifact={adoptTarget ?? undefined}
        open={adoptTarget !== null}
        onOpenChange={(open) => {
          if (!open) setAdoptTarget(null);
        }}
      />

      <AlertDialog
        open={publishTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPublishTarget(null);
        }}
      >
        {publishTarget !== null && (
          <AlertDialogContent data-testid="publish-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>Publish “{publishTarget.name}” to the library?</AlertDialogTitle>
              <AlertDialogDescription>
                Shared content — visible and editable from every campaign. It stays one artifact
                that is always referenced, never copied, and its images move to the library with
                it.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction data-testid="publish-confirm" onClick={runPublish}>
                Publish
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>

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
              <label className="flex items-center gap-2 text-sm" data-testid="rename-alias">
                <Checkbox
                  checked={renameKeepAlias}
                  onCheckedChange={(checked) => {
                    setRenameKeepAlias(checked);
                  }}
                />
                Add “{renameTarget.name}” as alias (module links keep resolving)
              </label>
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
  artifact: AnyArtifact;
  selected: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDuplicate?: (() => void) | undefined;
  onDelete: () => void;
  onExport?: (() => void) | undefined;
  onExportPdfGm?: (() => void) | undefined;
  onExportPdfPlayer?: (() => void) | undefined;
  /** Owned library-kind rows only (D6): publish into the shared library. */
  onPublish?: (() => void) | undefined;
  /** Global rows only: adopt into a campaign (C). */
  onAdopt?: (() => void) | undefined;
}

/** 16px cover-image thumbnail, shown only when the artifact has one (M3-A). */
function CoverThumb({ artifact }: { artifact: AnyArtifact }): JSX.Element | null {
  if (artifact.coverImageId === null) return null;
  return (
    <ImageThumb
      imageId={artifact.coverImageId}
      alt={`Cover of ${artifact.name}`}
      size={16}
      rounded
    />
  );
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
  onPublish,
  onAdopt,
}: TreeRowProps) {
  return (
    <ContextMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <ContextMenuTrigger
              className={cn(
                'group/row flex w-full cursor-default items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-accent',
                selected && 'bg-accent font-medium text-accent-foreground',
              )}
              onClick={onSelect}
            />
          }
        >
          <CoverThumb artifact={artifact} />
          <span className="min-w-0 flex-1 truncate">{artifact.name}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${artifact.name}`}
            className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 pointer-coarse:opacity-100 hover:text-destructive focus-visible:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
          >
            <Trash2Icon aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-64">
          {artifact.summary === '' ? 'No summary yet.' : artifact.summary}
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <ContextMenuItem onClick={onRename}>Rename</ContextMenuItem>
        {onDuplicate !== undefined && (
          <ContextMenuItem
            onClick={() => {
              onDuplicate();
            }}
          >
            Duplicate
          </ContextMenuItem>
        )}
        {onPublish !== undefined && (
          <ContextMenuItem data-testid="tree-publish" onClick={onPublish}>
            Publish to library…
          </ContextMenuItem>
        )}
        {onAdopt !== undefined && (
          <ContextMenuItem data-testid="tree-adopt" onClick={onAdopt}>
            Adopt into campaign…
          </ContextMenuItem>
        )}
        {onExport !== undefined && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onExport}>Export as JSON</ContextMenuItem>
            <ContextMenuItem onClick={onExportPdfGm}>Export PDF (GM notes)</ContextMenuItem>
            <ContextMenuItem onClick={onExportPdfPlayer}>Export PDF (player handout)</ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem className="text-destructive" onClick={onDelete}>
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
