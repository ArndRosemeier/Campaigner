import { useCallback, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileDownIcon,
  FileUpIcon,
  PlusIcon,
  Trash2Icon,
  WaypointsIcon,
  XIcon,
} from 'lucide-react';

import { useModules } from '@/features/modules/hooks';
import { useCampaign, useScopeToggles } from '@/features/campaign/hooks';
import { ScopeControl } from '@/features/campaign/components/scope-control';
import { AdoptDialog } from '@/features/campaign/components/adopt-dialog';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import { adoptIntoCampaign, publishToLibrary } from '@/db/artifactRepo';
import { graphPath, workspacePath } from '@/app/routes';
import { Link } from 'react-router-dom';
import { artifactRepo } from '@/db';
import {
  ARTIFACT_KINDS,
  ARTIFACT_KIND_LABELS,
  ARTIFACT_KIND_SINGULAR,
  BULK_REMOVE_EXCLUDED_KINDS,
  type AnyArtifact,
  type Artifact,
  type ArtifactKind,
  type GlobalArtifact,
  type Id,
  type Module,
  defaultScopeToggles,
  globalArtifactKindSchema,
} from '@/domain';
import { defaultArtifactName, mergeAliasNames, sameAliasName } from '@/domain';
import { exportSingleArtifact } from '@/features/campaign/components/export-single-artifact';
import { exportCampaignBundle } from '@/features/campaign/components/export-campaign-bundle';
import { useCampaignImport } from '@/features/campaign/import-flow';
import { RemoveArtifactsDialog } from '@/features/campaign/components/remove-artifacts-dialog';
import { PartyWizard } from '@/features/campaign/components/party-wizard';
import { exportArtifactPdfFile } from '@/lib/pdfExport';
import { ModulePdfButton } from '@/features/modules/module-pdf-button';
import { ModulePlanButton } from '@/features/modules/module-plan-dialog';
import { ModuleRestockButton } from '@/features/modules/module-restock-button';
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
import { HelpButton } from '@/help/HelpButton';import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { matchesFilter } from '@/features/campaign/filter';
import { toastError, toastSuccess } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * The module group's two document actions, in the OWNER's order (docs/17
 * rows 108/111): it resolves the row it was rendered for and defers to the
 * SAME two components the canvas header mounts — the ONE `ModulePdfButton`
 * and the ONE `ModulePlanButton` — so the two surfaces cannot drift into
 * different books or into a second way to decide one. A module row that has
 * gone missing between render and click renders NOTHING — never a button
 * that would print a ghost.
 *
 * Both controls get the SAME pool (the campaign's artifacts plus the shared
 * library, exactly as the canvas passes them) and the canvas's own defaults,
 * so "Document plan" in the tree reaches exactly what "Document plan" in the
 * canvas reaches (the owner's answer, verbatim: *"Yes, both places."*).
 */
function ModuleGroupActions({
  moduleId,
  modules,
  artifacts,
  globals,
}: {
  moduleId: Id;
  modules: readonly Module[] | undefined;
  artifacts: readonly Artifact[];
  globals: readonly GlobalArtifact[];
}): JSX.Element | null {
  const module = modules?.find((row) => row.id === moduleId);
  if (module === undefined) return null;
  const pool = [...artifacts, ...globals];
  return (
    <>
      <ModulePdfButton module={module} artifacts={pool} />
      <ModulePlanButton module={module} artifacts={pool} />
      {/*
        The module-level restock (docs/17 row 195): the SAME component the
        canvas header mounts, so both module surfaces offer the same action at
        the same recorded difficulty.
      */}
      <ModuleRestockButton module={module} />
    </>
  );
}

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
 *
 * MULTI-SELECT (owner request, 2026-09-22; docs/17 rows 322/327): every row of
 * THIS campaign carries a checkbox — the campaign-level kind sections AND a
 * module's own group, because a module-owned NPC or location is exactly what
 * gets reused in another campaign — and a small action bar above the tree
 * offers Export selected (json|zip, selection-only), Remove selected (the ONE
 * shared confirm, live census) and Import… (into THIS campaign). Library rows
 * carry no checkbox (a library row is not this campaign's asset) and neither
 * does the Orphaned group (a dangling module reference is not module ownership
 * in the reuse sense; docs/17 row 327). Removal stays campaign-level: the seam
 * REFUSES a module-owned row by name (deleting one belongs to the module's own
 * guarded surface), the Party IS selectable (players must be exportable
 * between campaigns) but can never be removed, and the bar says BOTH in as many
 * words; pressing Remove then shows the seam's own refusal with the confirm
 * disabled.
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
  const [removeKind, setRemoveKind] = useState<ArtifactKind | null>(null);
  const [publishTarget, setPublishTarget] = useState<Artifact | null>(null);
  const [adoptTarget, setAdoptTarget] = useState<GlobalArtifact | null>(null);
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<string>>(new Set());
  /** The multi-select set (every row of THIS campaign — see the doc above). */
  const [selection, setSelection] = useState<ReadonlySet<Id>>(new Set());
  const [removeSelectionOpen, setRemoveSelectionOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
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
  // The export's suggested filename is derived from the campaign's own name
  // (the ONE `exportSuggestedName` seam); '' falls back to the documented
  // `artifact` stem for a symbol-only name.
  const campaign = useCampaign(campaignId);

  const filtered = useMemo(
    () => artifacts.filter((artifact) => matchesFilter(artifact, filter)),
    [artifacts, filter],
  );
  const filteredGlobals = useMemo(
    () => globals.filter((artifact) => matchesFilter(artifact, filter)),
    [globals, filter],
  );

  // The pool a row's summary-tooltip wiki chips resolve against (docs/17 row
  // 217) — the campaign rows plus the shared library, exactly as the module
  // group controls pass them (see `ModuleGroupActions`). The open callback is
  // the tree's own selection, so a chip in the tooltip lands where clicking the
  // row lands.
  const wikiPool = useMemo<readonly AnyArtifact[]>(
    () => [...artifacts, ...globals],
    [artifacts, globals],
  );
  const openWikiArtifact = useCallback(
    (artifact: AnyArtifact) => {
      onSelectArtifact(artifact.id);
    },
    [onSelectArtifact],
  );

  // Scope split (10-MILESTONE-6 D3): the library group, one group per owning
  // module, the plain campaign rows in their kind groups — and an explicit
  // "Orphaned" group for module-owned rows whose module row is missing
  // (external tampering or a pre-integrity-fix dangling write). Orphans are
  // NOT blended into the kind groups: they stay visible AS orphans, each
  // with a one-click "Re-anchor to campaign" (moveScope) instead of a silent
  // scope change.
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
  const orphanRows = useMemo(
    () =>
      scopes.campaign
        ? filtered.filter(
            (artifact) => artifact.moduleId !== null && !moduleTitleById.has(artifact.moduleId),
          )
        : [],
    [filtered, scopes.campaign, moduleTitleById],
  );
  const plainRows = useMemo(
    () => (scopes.campaign ? filtered.filter((artifact) => artifact.moduleId === null) : []),
    [filtered, scopes.campaign],
  );
  const libraryRows = scopes.global ? filteredGlobals : [];

  // Presence rule for the per-region "remove all" below: the region's own row
  // SOURCE — campaign-level rows, scope toggle respected — counted WITHOUT
  // the text filter, because the action is not filter-scoped (it removes
  // every campaign-level row of that kind, and the confirm names how many).
  // A filtered region whose rows are hidden still offers it; a region with no
  // rows at all never does.
  const plainKindCounts = useMemo(() => {
    const counts = new Map<ArtifactKind, number>();
    if (!scopes.campaign) return counts;
    for (const artifact of artifacts) {
      if (artifact.moduleId !== null) continue;
      counts.set(artifact.kind, (counts.get(artifact.kind) ?? 0) + 1);
    }
    return counts;
  }, [artifacts, scopes.campaign]);

  // THE multi-select set, resolved against the LIVE campaign rows: a row that
  // was deleted (here or in another tab) drops out of the selection by itself,
  // so the count, the export and the removal can never name a row that is not
  // there. EVERY row of this campaign is selectable (docs/17 row 327 — the
  // checkboxes are rendered on the campaign-level kind sections and on a
  // module's own group alike), and the Party is among them on purpose. The
  // removal side still REFUSES a module-owned row by name
  // (`deleteArtifactSelection`), which the bar states while one is selected.
  const selectedArtifacts = useMemo(
    () => artifacts.filter((artifact) => selection.has(artifact.id)),
    [artifacts, selection],
  );
  const selectedIds = useMemo(
    () => selectedArtifacts.map((artifact) => artifact.id),
    [selectedArtifacts],
  );
  const partySelected = selectedArtifacts.some((artifact) =>
    BULK_REMOVE_EXCLUDED_KINDS.includes(artifact.kind),
  );
  // Module-owned rows are exportable (that is how a good NPC crosses campaigns)
  // but NEVER bulk-removable: the seam refuses them by name, so the bar says so
  // while one is selected (docs/17 row 327). The check mirrors the seam's own
  // rule (`moduleId !== null`), so the notice and the refusal cannot disagree.
  const moduleSelected = selectedArtifacts.some((artifact) => artifact.moduleId !== null);

  function beginRename(artifact: Artifact): void {
    setRenameTarget(artifact);
    setRenameValue(artifact.name);
  }

  function beginDuplicate(artifact: Artifact): void {
    void handleDuplicate(artifact);
  }

  function beginDelete(artifact: Artifact): void {
    setDeleteTarget(artifact);
  }

  function beginPublish(artifact: Artifact): void {
    setPublishTarget(artifact);
  }

  function toggleSelection(id: Id, checked: boolean): void {
    setSelection((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // The workspace's selection import (owner request, 2026-09-22): the SAME
  // picker read path, the SAME dependency gate, the SAME toasts — into THIS
  // campaign instead of a new one (docs/17 row 322).
  const importFlow = useCampaignImport({
    targetCampaignId: campaignId,
    describeSuccess: (result) => `Imported ${result.createdArtifacts} artifact(s) into this campaign`,
  });

  async function runSelectionExport(format: 'json' | 'zip'): Promise<void> {
    await exportCampaignBundle({
      campaignId,
      campaignName: campaign?.name ?? '',
      artifactIds: selectedIds,
      format,
      // The selection's point is moving rows BETWEEN campaigns, portraits
      // included: the JSON arm inlines the binaries rather than dropping them.
      images: true,
      selectionOnly: true,
    });
  }

  async function handleReanchor(artifact: Artifact): Promise<void> {
    try {
      await adoptIntoCampaign(artifact.id);
      toastSuccess(`"${artifact.name}" re-anchored to the campaign`);
    } catch (error) {
      toastError('Could not re-anchor the artifact', error);
    }
  }

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
      // BOTH halves are the SEAM's rule (`domain/artifactAlias`, docs/17 row
      // 121), never a local comparison: TRIMMED and case-insensitive on both
      // sides, so a pool already carrying the old name under different
      // surrounding whitespace does not get it written a second time, and the
      // new name is passed as `artifactName` so an alias equal to it is never
      // stored (it could never resolve — the resolver matches the name first).
      const kept = target.aliases.filter((alias) => !sameAliasName(alias, name));
      const aliases = renameKeepAlias ? mergeAliasNames(kept, [target.name], name) : kept;
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
            Wiki-link graph
          </Button>
          <HelpButton topic="tree" label="artifact library" />
        </div>
        {/*
          The multi-select action bar (owner request, 2026-09-22; docs/17 row
          322). Import… is always offered — it is how a file lands in THIS
          campaign; the two selection actions need a selection. The Party and
          module-owned rows are each called out in as many words while selected
          (docs/17 row 327): both are exportable but never bulk-removable here,
          and the confirm refuses each by name.
        */}
        <div
          className="mt-1.5 flex flex-wrap items-center gap-1"
          data-testid="tree-selection-bar"
        >
          {partySelected && (
            <p
              className="w-full text-xs text-amber-600 dark:text-amber-400"
              data-testid="party-not-removable"
            >
              The Party is exportable, but never removable in bulk — take Party rows out of
              the selection to use Remove selected.
            </p>
          )}
          {moduleSelected && (
            <p
              className="w-full text-xs text-amber-600 dark:text-amber-400"
              data-testid="module-not-removable"
            >
              Module-owned rows are exportable, but never removable in bulk here — delete or
              release them from their own module first.
            </p>
          )}
          <span className="text-xs text-muted-foreground" data-testid="tree-selection-count">
            {selectedIds.length} selected
          </span>
          <Button
            variant="outline"
            size="xs"
            data-testid="export-selection-json"
            disabled={selectedIds.length === 0}
            onClick={() => {
              void runSelectionExport('json');
            }}
          >
            <FileDownIcon aria-hidden data-icon="inline-start" />
            Export JSON
          </Button>
          <Button
            variant="outline"
            size="xs"
            data-testid="export-selection-zip"
            disabled={selectedIds.length === 0}
            onClick={() => {
              void runSelectionExport('zip');
            }}
          >
            <FileDownIcon aria-hidden data-icon="inline-start" />
            Export ZIP
          </Button>
          <Button
            variant="outline"
            size="xs"
            data-testid="remove-selection"
            disabled={selectedIds.length === 0}
            onClick={() => {
              setRemoveSelectionOpen(true);
            }}
          >
            <Trash2Icon aria-hidden data-icon="inline-start" />
            Remove selected
          </Button>
          {selectedIds.length > 0 && (
            <Button
              variant="ghost"
              size="xs"
              data-testid="clear-selection"
              onClick={() => {
                setSelection(new Set());
              }}
            >
              <XIcon aria-hidden data-icon="inline-start" />
              Clear
            </Button>
          )}
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json,application/zip,.zip"
            className="hidden"
            data-testid="workspace-import-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void importFlow.handleFile(file);
              event.target.value = '';
            }}
          />
          <Button
            variant="outline"
            size="xs"
            className="ml-auto"
            data-testid="workspace-import"
            onClick={() => {
              importInputRef.current?.click();
            }}
          >
            <FileUpIcon aria-hidden data-icon="inline-start" />
            Import…
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain p-2">
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
                    artifacts={wikiPool}
                    onOpenArtifact={openWikiArtifact}
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
            /*
             * The group IS a module, so its header offers the module's own
             * document (docs/17 row 108) — the SAME control the canvas header
             * mounts, so the two can never print different books. Its
             * artifacts are the campaign pool plus the shared library, exactly
             * as the canvas passes them; the renderer scopes them itself.
             *
             * Next to it, "Document plan" (docs/17 row 111): the owner asked
             * whether the plan surface belongs here as well as on the canvas
             * and answered *"Yes, both places."* — so the header mounts the
             * SAME `ModulePlanButton`, with the same pool, and there is still
             * exactly ONE plan dialog and ONE way to regenerate a plan.
             */
            actions={
              <ModuleGroupActions
                moduleId={group.id}
                modules={modules}
                artifacts={artifacts}
                globals={globals}
              />
            }
          >
            <ul className="mt-0.5">
              {group.rows.map((artifact) => (
                <ArtifactTreeRow
                  key={artifact.id}
                  artifact={artifact}
                  artifacts={wikiPool}
                  selected={artifact.id === selectedArtifactId}
                  onSelectArtifact={onSelectArtifact}
                  onOpenArtifact={openWikiArtifact}
                  onRename={beginRename}
                  onDuplicate={beginDuplicate}
                  onDelete={beginDelete}
                  onPublish={beginPublish}
                  selection={selection}
                  onToggleSelection={toggleSelection}
                />
              ))}
            </ul>
          </TreeGroup>
        ))}
        {orphanRows.length > 0 && (
          <TreeGroup
            label="Orphaned"
            count={orphanRows.length}
            open={!closedGroups.has('orphaned')}
            onToggle={setGroupOpenState}
          >
            <p className="px-2 py-1 text-xs text-muted-foreground">
              These artifacts point at a module that no longer exists. Re-anchor them to keep the
              tree honest.
            </p>
            <ul className="mt-0.5">
              {orphanRows.map((artifact) => (
                <li key={artifact.id}>
                  <TreeRow
                    artifact={artifact}
                    orphaned
                    artifacts={wikiPool}
                    onOpenArtifact={openWikiArtifact}
                    selected={artifact.id === selectedArtifactId}
                    onSelect={() => {
                      onSelectArtifact(artifact.id);
                    }}
                    onRename={() => {
                      setRenameTarget(artifact);
                      setRenameValue(artifact.name);
                    }}
                    onDelete={() => {
                      setDeleteTarget(artifact);
                    }}
                    onReanchor={() => {
                      void handleReanchor(artifact);
                    }}
                  />
                </li>
              ))}
            </ul>
          </TreeGroup>
        )}
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
                {/*
                  THE party wizard (docs/17 row 334): the Party region's own
                  visible control — an iPad has no hover, so it is rendered
                  always and never behind a context menu. It sits beside this
                  region's per-kind `+` and owns its own dialog; the other kind
                  regions are unaffected.
                */}
                {kind === 'pc' && <PartyWizard campaignId={campaignId} />}
                {/* Per-region "remove all" (05-UI §Left pane — Campaign tree):
                    the middle rung of the destructive ladder. Presence rules:
                    a kind with campaign-level rows of its own offers it (the
                    count ignores the text FILTER — the action is not
                    filter-scoped, and the confirm names the true total); the
                    Party never does (`BULK_REMOVE_EXCLUDED_KINDS` — the seam
                    refuses it too); the Library group (separate,
                    `campaignId === null` rows) never does. */}
                {!BULK_REMOVE_EXCLUDED_KINDS.includes(kind) &&
                  (plainKindCounts.get(kind) ?? 0) > 0 && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground hover:text-destructive"
                      data-testid={`remove-all-${kind}`}
                      aria-label={`Remove all ${ARTIFACT_KIND_LABELS[kind]}`}
                      onClick={() => {
                        setRemoveKind(kind);
                      }}
                    >
                      <Trash2Icon aria-hidden />
                    </Button>
                  )}
              </div>
              <CollapsibleContent>
                {items.length === 0 ? (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">
                    No {ARTIFACT_KIND_LABELS[kind]} yet — create one or ask a persona.
                  </p>
                ) : (
                  <ul className="mt-0.5">
                    {items.map((artifact) => (
                      <ArtifactTreeRow
                        key={artifact.id}
                        artifact={artifact}
                        artifacts={wikiPool}
                        selected={artifact.id === selectedArtifactId}
                        onSelectArtifact={onSelectArtifact}
                        onOpenArtifact={openWikiArtifact}
                        onRename={beginRename}
                        onDuplicate={beginDuplicate}
                        onDelete={beginDelete}
                        onPublish={beginPublish}
                        selection={selection}
                        onToggleSelection={toggleSelection}
                      />
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
                autoCapitalize="words"
                autoCorrect="off"
                enterKeyHint="done"
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
      >        {deleteTarget !== null && (
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

      {removeKind !== null && (
        <RemoveArtifactsDialog
          campaignId={campaignId}
          scope={{ kind: removeKind }}
          open
          onOpenChange={(open) => {
            if (!open) setRemoveKind(null);
          }}
        />
      )}

      {removeSelectionOpen && (
        <RemoveArtifactsDialog
          campaignId={campaignId}
          scope={{ ids: selectedIds }}
          open
          onOpenChange={(open) => {
            if (!open) setRemoveSelectionOpen(false);
          }}
          onRemoved={() => {
            // The rows are gone: the selection that named them is stale, and
            // an empty bar is the honest state.
            setSelection(new Set());
          }}
        />
      )}

      {importFlow.dialog}
    </aside>
  );
}

interface ArtifactTreeRowProps {
  artifact: Artifact;
  /** Wiki-chip pool for the summary tooltip (docs/17 row 217). */
  artifacts: readonly AnyArtifact[];
  selected: boolean;
  onSelectArtifact: (artifactId: Id) => void;
  onOpenArtifact: (artifact: AnyArtifact) => void;
  onRename: (artifact: Artifact) => void;
  onDuplicate: (artifact: Artifact) => void;
  onDelete: (artifact: Artifact) => void;
  onPublish: (artifact: Artifact) => void;
  /** THE multi-select set — every row of THIS campaign is selectable (row 327). */
  selection: ReadonlySet<Id>;
  onToggleSelection: (id: Id, checked: boolean) => void;
}

/**
 * THE one way a SELECTABLE campaign row is rendered (AGENTS rule 4, docs/17 row
 * 327): the campaign-level kind sections and a module's own group both mount
 * THIS, so the checkbox, its accessible name ("Select <name>"), the
 * stop-propagation that keeps a tick from navigating the editor, the
 * context-menu actions and the publish arm cannot drift between the two
 * surfaces. The Library group and the Orphaned group render `TreeRow` directly
 * instead: a library row is not this campaign's asset, and a dangling module
 * reference is not module ownership in the reuse sense, so neither gets a
 * checkbox.
 */
function ArtifactTreeRow({
  artifact,
  artifacts,
  selected,
  onSelectArtifact,
  onOpenArtifact,
  onRename,
  onDuplicate,
  onDelete,
  onPublish,
  selection,
  onToggleSelection,
}: ArtifactTreeRowProps): JSX.Element {
  return (
    <li>
      <TreeRow
        artifact={artifact}
        artifacts={artifacts}
        onOpenArtifact={onOpenArtifact}
        selected={selected}
        onSelect={() => {
          onSelectArtifact(artifact.id);
        }}
        onRename={() => {
          onRename(artifact);
        }}
        onDuplicate={() => {
          onDuplicate(artifact);
        }}
        onDelete={() => {
          onDelete(artifact);
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
                onPublish(artifact);
              }
            : undefined
        }
        selectable
        checked={selection.has(artifact.id)}
        onCheckedChange={(next) => {
          onToggleSelection(artifact.id, next);
        }}
      />
    </li>
  );
}

interface TreeRowProps {
  artifact: AnyArtifact;
  selected: boolean;
  onSelect: () => void;
  /** Wiki-chip pool for the summary tooltip (docs/17 row 217). */
  artifacts: readonly AnyArtifact[];
  /** Resolved wiki-chip click — the tree's own selection. */
  onOpenArtifact: (artifact: AnyArtifact) => void;
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
  /** Orphan rows only: one-click re-anchor into the campaign (moveScope). */
  onReanchor?: (() => void) | undefined;
  /** Orphan rows render an explicit "orphaned" badge (never silent). */
  orphaned?: boolean | undefined;
  /** Every row of THIS campaign (module-owned included, docs/17 row 327); the Library and Orphaned groups never pass it. */
  selectable?: boolean | undefined;
  checked?: boolean | undefined;
  onCheckedChange?: ((checked: boolean) => void) | undefined;
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
  artifacts,
  onOpenArtifact,
  onRename,
  onDuplicate,
  onDelete,
  onExport,
  onExportPdfGm,
  onExportPdfPlayer,
  onPublish,
  onAdopt,
  onReanchor,
  orphaned,
  selectable,
  checked,
  onCheckedChange,
}: TreeRowProps) {
  return (
    <ContextMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <ContextMenuTrigger
              className={cn(
                'group/row flex w-full cursor-default items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-accent pointer-coarse:min-h-11',
                selected && 'bg-accent font-medium text-accent-foreground',
              )}
              onClick={onSelect}
            />
          }
        >
          {selectable === true && (
            // The checkbox is the multi-select leaf, not a second row click:
            // both pointer events stop here so ticking a row never navigates
            // the editor to it.
            <span
              className="flex shrink-0 items-center"
              onClick={(event) => {
                event.stopPropagation();
              }}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
            >
              <Checkbox
                aria-label={`Select ${artifact.name}`}
                checked={checked === true}
                onCheckedChange={(next) => {
                  if (typeof next === 'boolean') onCheckedChange?.(next);
                }}
              />
            </span>
          )}
          <CoverThumb artifact={artifact} />
          <span className="min-w-0 flex-1 truncate">{artifact.name}</span>
          {orphaned === true && (
            <Badge
              variant="outline"
              className="shrink-0 border-amber-500/60 px-1 text-[10px] font-medium text-amber-600 dark:text-amber-400"
            >
              orphaned
            </Badge>
          )}
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
          {artifact.summary === '' ? (
            'No summary yet.'
          ) : (
            <WikiMarkdown
              value={artifact.summary}
              artifacts={artifacts}
              onOpenArtifact={onOpenArtifact}
            />
          )}
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <ContextMenuItem onClick={onRename}>Rename</ContextMenuItem>
        {onReanchor !== undefined && (
          <ContextMenuItem data-testid="tree-reanchor" onClick={onReanchor}>
            Re-anchor to campaign
          </ContextMenuItem>
        )}
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
