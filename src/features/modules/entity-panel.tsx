import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import {
  ArrowDownAZIcon,
  ArrowDownUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ImageIcon,
  SparklesIcon,
  StarIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Artifact, Campaign, Id, Module } from '@/domain';
import { entityKindFor, moduleTagFor } from '@/domain';
import { artifactRepo } from '@/db';
import { removeImageFromArtifact } from '@/db/artifactRepo';
import { patchModule } from '@/db/moduleRepo';
import { listPersonas } from '@/db/personaRepo';
import { useEntityImageQueue } from '@/features/modules/entity-image-queue';
import { chainRunner } from '@/llm/chainRunner';
import type { ChainStepInput } from '@/llm/chainRunner';
import { runEngine } from '@/llm/runEngine';
import {
  alignEntityName,
  RUN_STEP_LABELS,
} from '@/features/modules/entity-detail';
import {
  buildEntityBrief,
  STUB_KINDS,
  STUB_PERSONA_SLUGS,
  type StubKind,
} from '@/features/modules/persona-request';
import {
  countOccurrences,
  extractWikiLinks,
  resolveWikiLink,
  sentenceAround,
  surroundingParagraphs,
} from '@/lib/wikilinks';
import { toastError, toastSuccess } from '@/lib/toast';
import { useProgressStore } from '@/lib/progress';
import { cn } from '@/lib/utils';

/**
 * Entity panel (08-MODULE-DESIGNER M4-C): the right sidebar of the module
 * reader. Two lists — FOCUSED entities on top (the ones the table cares
 * about right now), then everything else, separated by a divider — with a
 * star toggle per row to move between them (persisted on the module row),
 * a sort button (first mention / alphabetical), occurrence counts, the
 * "N mentioned · M detailed" progress line, and the batch action "Generate
 * all unresolved of kind…". A resolved row opens the entity card (peek
 * modal); an unresolved row opens the stub popover.
 *
 * IMAGES mode (M4-C, module-mode-as-play): the "Images" button swaps the row
 * stars for checkboxes — checked = the entity has an image, indeterminate =
 * queued for the background image queue, unchecked = none. Checking queues a
 * generation (one image per entity, attached as cover); unchecking a QUEUED
 * entity just removes it from the queue, while unchecking an entity WITH an
 * image asks for confirmation before deleting it.
 */

/** What the checkbox shows for an entity in images mode. */
type EntityImageState = 'has' | 'queued' | 'none';

export interface EntityPanelProps {
  module: Module;
  artifacts: readonly Artifact[];
  campaign: Campaign;
  /** Opens the stub popover for an unresolved name. */
  onStub: (name: string, anchor: { x: number; y: number }) => void;
  /** Opens the entity card (peek modal) for a resolved entity. */
  onOpenCard: (artifact: Artifact) => void;
}

/** Plural bucket label for the progress bar ("Generating 3 npcs"). */
const KIND_PLURALS: Record<StubKind, string> = {
  npc: 'npcs',
  location: 'locations',
  faction: 'factions',
  note: 'notes',
};

interface EntityEntry {
  name: string;
  resolved: boolean;
  ambiguous: boolean;
  artifact: Artifact | undefined;
  occurrences: { where: string; count: number }[];
  total: number;
  sentence: string;
}

export function useModuleEntities(
  module: Module,
  artifacts: readonly Artifact[],
): { entries: EntityEntry[]; documents: { where: string; markdown: string }[] } {
  return useMemo(() => {
    const documents = [
      { where: 'premise', markdown: module.spine?.premise ?? '' },
      ...module.parts
        .slice()
        .sort((a, b) => a.planIndex - b.planIndex)
        .map((part) => ({ where: `part-${String(part.planIndex)}`, markdown: part.markdown })),
    ];
    const names = extractWikiLinks(documents.map((document) => document.markdown).join('\n\n')).map(
      (link) => link.name,
    );
    const entries = names.map((name) => {
      const resolution = resolveWikiLink(name, artifacts);
      const occurrences = countOccurrences(name, documents);
      const firstDoc = documents.find((document) =>
        countOccurrences(name, [document]).length > 0,
      );
      return {
        name,
        resolved: resolution.artifact !== undefined,
        ambiguous: resolution.status === 'ambiguous',
        artifact: resolution.artifact,
        occurrences,
        total: occurrences.reduce((sum, occurrence) => sum + occurrence.count, 0),
        sentence: sentenceAround(firstDoc?.markdown ?? '', name),
      };
    });
    // First-mention order (premise first, then parts by plan index) — the
    // 'mention' sort mode; the panel re-sorts per `module.entitySort`.
    return { entries, documents };
  }, [module, artifacts]);
}

export function EntityPanel({
  module,
  artifacts,
  campaign,
  onStub,
  onOpenCard,
}: EntityPanelProps): JSX.Element {
  const { entries, documents } = useModuleEntities(module, artifacts);
  const [collapsed, setCollapsed] = useState(false);
  const [batching, setBatching] = useState<StubKind | null>(null);
  const [imageMode, setImageMode] = useState(false);
  /** Entity awaiting confirmation to delete its image (images mode). */
  const [pendingImageDelete, setPendingImageDelete] = useState<{
    name: string;
    artifact: Artifact;
  } | null>(null);
  const progressStart = useProgressStore((state) => state.start);
  const progressUpdate = useProgressStore((state) => state.update);
  const progressFinish = useProgressStore((state) => state.finish);
  const queuedJobs = useEntityImageQueue((state) => state.queued);
  const activeJob = useEntityImageQueue((state) => state.active);

  const mentioned = entries.length;
  const detailed = entries.filter((entry) => entry.resolved).length;
  const unresolved = entries.filter((entry) => !entry.resolved);
  // Batch buckets use the kinds the GENERATOR recorded (08 §M4-C) — never a
  // client heuristic. Names without a record are not batchable; clicking
  // their row classifies/asks in the stub popover instead.
  const unresolvedByKind = new Map<StubKind, EntityEntry[]>();
  for (const entry of unresolved) {
    const kind = entityKindFor(module.entityKinds, entry.name);
    if (kind === undefined) continue;
    const list = unresolvedByKind.get(kind) ?? [];
    list.push(entry);
    unresolvedByKind.set(kind, list);
  }

  const moduleTag = moduleTagFor(module.title);

  /** Full module text for the brief context. */
  const moduleText = documents.map((document) => document.markdown).join('\n\n');

  // Focused / unfocused groups (08 §M4-C), each in the current sort order.
  // Focus matches are case-insensitive — wiki-links resolve that way.
  const sortedEntries = useMemo(() => {
    if (module.entitySort === 'alphabetical') {
      return [...entries].sort((a, b) => a.name.localeCompare(b.name));
    }
    return entries; // 'mention' = first-mention order, as extracted
  }, [entries, module.entitySort]);
  const isFocused = (name: string): boolean =>
    module.focusedEntities.some((focused) => focused.trim().toLowerCase() === name.toLowerCase());
  const focusedEntries = sortedEntries.filter((entry) => isFocused(entry.name));
  const unfocusedEntries = sortedEntries.filter((entry) => !isFocused(entry.name));

  /** Moves an entity between the focused and unfocused lists (persisted). */
  async function toggleFocus(name: string): Promise<void> {
    const next = isFocused(name)
      ? module.focusedEntities.filter(
          (focused) => focused.trim().toLowerCase() !== name.toLowerCase(),
        )
      : [...module.focusedEntities, name];
    try {
      await patchModule(module.id, { focusedEntities: next });
    } catch (error) {
      toastError(`Could not update the focus for "${name}"`, error);
    }
  }

  /** Cycles the entity sort mode (persisted). */
  async function toggleSort(): Promise<void> {
    try {
      await patchModule(module.id, {
        entitySort: module.entitySort === 'mention' ? 'alphabetical' : 'mention',
      });
    } catch (error) {
      toastError('Could not save the sort order', error);
    }
  }

  /** Checkbox state for an entity in images mode. */
  function imageStateFor(entry: EntityEntry): EntityImageState {
    const artifact = entry.artifact;
    if (artifact !== undefined && (artifact.coverImageId !== null || artifact.imageIds.length > 0)) {
      return 'has';
    }
    if (
      (activeJob !== null && activeJob.campaignId === campaign.id && activeJob.name === entry.name) ||
      queuedJobs.some((job) => job.campaignId === campaign.id && job.name === entry.name)
    ) {
      return 'queued';
    }
    return 'none';
  }

  /** Checkbox click in images mode: queue, unqueue, or confirm deletion. */
  function requestImageToggle(entry: EntityEntry): void {
    const artifact = entry.artifact;
    if (artifact === undefined) return; // disabled checkbox — nothing to attach to
    if (imageStateFor(entry) === 'has') {
      setPendingImageDelete({ name: entry.name, artifact });
      return;
    }
    const job = { campaignId: campaign.id, moduleId: module.id, name: entry.name };
    if (imageStateFor(entry) === 'queued') {
      useEntityImageQueue.getState().dequeue(job);
      return;
    }
    useEntityImageQueue.getState().enqueue([job]);
  }

  /** The confirmed deletion: detach (and scrub from this artifact's
   * revision snapshots), then drop the blob when nothing else wants it. */
  async function confirmImageDelete(): Promise<void> {
    const pending = pendingImageDelete;
    if (pending === null) return;
    setPendingImageDelete(null);
    const artifact = pending.artifact;
    const firstImageId = artifact.imageIds.at(0) ?? null;
    const imageId = artifact.coverImageId ?? firstImageId;
    if (imageId === null) return;
    try {
      await removeImageFromArtifact(artifact.id, imageId);
      toastSuccess(`Image for "${pending.name}" deleted`);
    } catch (error) {
      toastError(`Could not delete the image for "${pending.name}"`, error);
    }
  }

  async function generateBatch(kind: StubKind): Promise<void> {
    const targets = unresolvedByKind.get(kind) ?? [];
    if (targets.length === 0) return;
    setBatching(kind);
    const jobId = `module-entities-${module.id}-${kind}`;
    const total = targets.length;
    progressStart(jobId, `Generating ${String(total)} ${KIND_PLURALS[kind]}`);
    // Live detail for the dock: the chain runner names the entity currently
    // being detailed, the run engine names the step inside it ("drafting") —
    // multi-minute work must never look like a hang (00-OVERVIEW).
    let currentEntry = '';
    let currentRunId: Id | null = null;
    // Targets finished across chain invocations (the loop re-chains past
    // failed steps) — keeps the bar monotonic.
    let completed = 0;
    const unsubscribeChain = chainRunner.on((state) => {
      const step = state.steps[state.currentIndex];
      if (state.status === 'running' && step?.status === 'running' && step.runId !== null) {
        currentRunId = step.runId;
        if (step.title !== null) {
          currentEntry = step.title.replace(/^Detail: /u, '');
          progressUpdate(jobId, {
            detail: `Generating ${currentEntry}…`,
            progress: (completed + state.currentIndex) / total,
          });
        }
      }
    });
    const unsubscribeRun = runEngine.on((event) => {
      if (event.kind !== 'step' || event.runId !== currentRunId) return;
      if (event.status === 'running' && event.stepName !== undefined) {
        const label = RUN_STEP_LABELS[event.stepName] ?? event.stepName;
        progressUpdate(jobId, { detail: `${currentEntry} — ${label}…` });
      }
    });
    try {
      const personas = await listPersonas();
      const persona =
        personas.find((candidate) => candidate.slug === STUB_PERSONA_SLUGS[kind]) ??
        personas.find((candidate) => candidate.producesKind === kind);
      if (persona === undefined) {
        toastError(`No persona available to detail ${kind}s — check Settings → Personas`);
        return;
      }
      let remaining: EntityEntry[] = targets;
      const producedIds: Id[] = [];
      const succeeded = new Set<string>();
      // One chain over all targets; chain semantics keep completed steps and
      // show failed runs in the Runs tab. On a failed step the batch
      // CONTINUES with the remaining names (fresh chain).
      while (remaining.length > 0) {
        const steps: ChainStepInput[] = remaining.map((entry) => ({
          personaId: persona.id,
          title: `Detail: ${entry.name}`,
          brief: buildEntityBrief(
            entry.name,
            surroundingParagraphs(moduleText, entry.name),
            module.spine?.premise ?? '',
          ),
          autonomy: 'auto' as const,
        }));
        const result = await chainRunner.run(campaign, personas, steps, 'auto', []);
        // Align produced artifacts with their entity (index-parallel): the
        // wiki-link resolves by EXACT name, so an artifact the model named
        // "Kael Ashbound…" would never link back to [[Kael]] — enforce the
        // entity name and keep the model's name as an alias.
        for (const [index, step] of result.steps.entries()) {
          const entry = remaining[index];
          if (entry === undefined) continue;
          if (step.status === 'completed' && step.artifactId !== null) {
            producedIds.push(step.artifactId);
            succeeded.add(entry.name);
            try {
              await alignEntityName(step.artifactId, entry.name);
            } catch (error) {
              toastError(`Could not align the artifact name for "${entry.name}"`, error);
            }
          }
          // Non-completed steps are NOT counted as failures here: the chain
          // stops at the first failure and reports the not-yet-run steps as
          // 'pending' — counting them double-counted every retry round ("12
          // of 9 failed"). Real failures are computed after the loop.
        }
        completed += result.steps.filter((step) => step.status === 'completed').length;
        progressUpdate(jobId, { progress: completed / total });
        const failedIndex = result.steps.findIndex((step) => step.status === 'failed');
        if (result.status === 'completed') break;
        if (result.status === 'cancelled') break;
        if (failedIndex === -1) break;
        // Skip everything up to and including the failed step, keep going.
        remaining = remaining.slice(failedIndex + 1);
      }
      // Stamp the produced artifacts with the module tag.
      for (const artifactId of producedIds) {
        try {
          const artifact = await artifactRepo.getArtifact(artifactId);
          if (artifact !== undefined && !artifact.tags.includes(moduleTag)) {
            await artifactRepo.updateArtifact(artifactId, {
              tags: [...artifact.tags, moduleTag],
            });
          }
        } catch (error) {
          toastError('Could not tag a produced artifact', error);
        }
      }
      // Failed entities are loud: the bar finishing must not look like
      // success when some runs died (their detail lives in the Runs tab).
      // Ground truth = every target WITHOUT a produced artifact.
      const failedEntities = targets.filter((target) => !succeeded.has(target.name));
      if (failedEntities.length > 0) {
        toastError(
          `${String(failedEntities.length)} of ${String(total)} ${KIND_PLURALS[kind]} failed to generate — ` +
            `see the Runs tab (${failedEntities.map((entry) => entry.name).join(', ')})`,
        );
      }
    } catch (error) {
      toastError('Batch generation failed', error);
    } finally {
      unsubscribeChain();
      unsubscribeRun();
      progressFinish(jobId);
      setBatching(null);
    }
  }

  return (
    <aside
      className="flex h-full flex-col border-l bg-card"
      data-testid="entity-panel"
      aria-label="Module entities"
    >
      <button
        type="button"
        className="flex items-center gap-2 border-b px-3 py-2 text-left text-sm font-medium hover:bg-accent"
        aria-expanded={!collapsed}
        onClick={() => {
          setCollapsed((value) => !value);
        }}
      >
        {collapsed ? (
          <ChevronRightIcon aria-hidden className="size-4" />
        ) : (
          <ChevronDownIcon aria-hidden className="size-4" />
        )}
        Entities
        <span className="ml-auto text-xs text-muted-foreground">
          {detailed} detailed · {mentioned} mentioned
        </span>
      </button>

      {!collapsed && (
        <>
          <div className="flex flex-wrap items-center gap-1 border-b px-3 py-2">
            <Button
              variant={imageMode ? 'secondary' : 'outline'}
              size="xs"
              aria-pressed={imageMode}
              data-testid="entity-images"
              onClick={() => {
                setImageMode((value) => !value);
              }}
            >
              <ImageIcon aria-hidden data-icon="inline-start" />
              Images
            </Button>
            {STUB_KINDS.map((kind) => {
              const targets = unresolvedByKind.get(kind) ?? [];
              if (targets.length === 0) return null;
              return (
                <Button
                  key={kind}
                  variant="outline"
                  size="xs"
                  disabled={batching !== null}
                  data-testid={`batch-${kind}`}
                  onClick={() => {
                    void generateBatch(kind);
                  }}
                >
                  <SparklesIcon aria-hidden data-icon="inline-start" />
                  {batching === kind ? 'Generating…' : `Generate ${targets.length} ${kind}`}
                </Button>
              );
            })}
            <Button
              variant="ghost"
              size="xs"
              className="ml-auto"
              data-testid="entity-sort"
              aria-label={
                module.entitySort === 'mention'
                  ? 'Sorted by first mention — sort alphabetically'
                  : 'Sorted alphabetically — sort by first mention'
              }
              onClick={() => {
                void toggleSort();
              }}
            >
              {module.entitySort === 'alphabetical' ? (
                <ArrowDownAZIcon aria-hidden data-icon="inline-start" />
              ) : (
                <ArrowDownUpIcon aria-hidden data-icon="inline-start" />
              )}
              {module.entitySort === 'alphabetical' ? 'A–Z' : 'First mention'}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 text-sm">
            {entries.length === 0 && (
              <p className="px-1 text-xs text-muted-foreground">
                No wiki-links yet. Write [[Names]] in the premise or parts.
              </p>
            )}
            {focusedEntries.length > 0 && (
              <section data-testid="focused-group" aria-label="Focused entities">
                <p className="px-1 pb-1 text-[11px] tracking-wide text-muted-foreground uppercase">
                  Focused · {focusedEntries.length}
                </p>
                <ul>
                  {focusedEntries.map((entry) => (
                    <EntityRow
                      key={entry.name}
                      entry={entry}
                      focused
                      module={module}
                      imageMode={imageMode}
                      imageState={imageStateFor(entry)}
                      onOpenCard={onOpenCard}
                      onStub={onStub}
                      onToggleFocus={() => {
                        void toggleFocus(entry.name);
                      }}
                      onImageToggle={() => {
                        requestImageToggle(entry);
                      }}
                    />
                  ))}
                </ul>
              </section>
            )}
            {focusedEntries.length > 0 && <hr className="my-2 border-border" />}
            <section
              data-testid="unfocused-group"
              aria-label={focusedEntries.length > 0 ? 'Other entities' : 'Entities'}
            >
              {focusedEntries.length > 0 && (
                <p className="px-1 pb-1 text-[11px] tracking-wide text-muted-foreground uppercase">
                  Unfocused · {unfocusedEntries.length}
                </p>
              )}
              <ul>
                {unfocusedEntries.map((entry) => (
                  <EntityRow
                    key={entry.name}
                    entry={entry}
                    focused={false}
                    module={module}
                    imageMode={imageMode}
                    imageState={imageStateFor(entry)}
                    onOpenCard={onOpenCard}
                    onStub={onStub}
                    onToggleFocus={() => {
                      void toggleFocus(entry.name);
                    }}
                    onImageToggle={() => {
                      requestImageToggle(entry);
                    }}
                  />
                ))}
              </ul>
            </section>
          </div>
        </>
      )}
      <Dialog
        open={pendingImageDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingImageDelete(null);
        }}
      >
        <DialogContent className="sm:max-w-sm" data-testid="image-delete-dialog">
          <DialogHeader>
            <DialogTitle>
              Delete the image for “{pendingImageDelete?.name}”?
            </DialogTitle>
            <DialogDescription>
              The image is removed from this entity and its files are deleted.
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setPendingImageDelete(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              data-testid="confirm-image-delete"
              onClick={() => {
                void confirmImageDelete();
              }}
            >
              Delete image
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

function EntityRow({
  entry,
  focused,
  module,
  imageMode,
  imageState,
  onOpenCard,
  onStub,
  onToggleFocus,
  onImageToggle,
}: {
  entry: EntityEntry;
  focused: boolean;
  module: Module;
  /** Images mode swaps the star for the image checkbox (M4-C). */
  imageMode: boolean;
  imageState: EntityImageState;
  onOpenCard: (artifact: Artifact) => void;
  onStub: (name: string, anchor: { x: number; y: number }) => void;
  onToggleFocus: () => void;
  onImageToggle: () => void;
}): JSX.Element {
  return (
    <li className="flex items-center">
      <button
        type="button"
        data-testid="entity-row"
        data-resolved={entry.resolved || undefined}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent',
          !entry.resolved && 'text-muted-foreground',
        )}
        onClick={(event) => {
          if (entry.resolved && entry.artifact !== undefined) {
            onOpenCard(entry.artifact);
          } else {
            onStub(entry.name, { x: event.clientX, y: event.clientY });
          }
        }}
      >
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {entry.ambiguous && (
          <span title="Multiple artifacts match this name" aria-hidden>
            ⚠
          </span>
        )}
        {entry.resolved ? (
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {entry.artifact?.kind}
          </Badge>
        ) : (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {entityKindFor(module.entityKinds, entry.name) ?? 'stub'}
          </Badge>
        )}
        <span className="shrink-0 text-xs text-muted-foreground">×{entry.total}</span>
      </button>
      {imageMode ? (
        <Checkbox
          className="mr-2 shrink-0"
          checked={imageState === 'has'}
          indeterminate={imageState === 'queued'}
          disabled={entry.artifact === undefined}
          title={
            entry.artifact === undefined
              ? 'Detail this entity first — images attach to its artifact'
              : undefined
          }
          aria-label={
            imageState === 'has'
              ? `${entry.name} has an image — uncheck to delete it`
              : imageState === 'queued'
                ? `${entry.name} is queued for an image — uncheck to cancel`
                : `Generate an image for ${entry.name}`
          }
          data-testid="entity-image-check"
          data-name={entry.name}
          onCheckedChange={() => {
            onImageToggle();
          }}
        />
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn('shrink-0', focused ? 'text-amber-500' : 'text-muted-foreground/40')}
          aria-label={focused ? `Unfocus ${entry.name}` : `Focus ${entry.name}`}
          aria-pressed={focused}
          data-testid="focus-toggle"
          data-name={entry.name}
          onClick={onToggleFocus}
        >
          <StarIcon aria-hidden className={cn('size-4', focused && 'fill-current')} />
        </Button>
      )}
    </li>
  );
}
