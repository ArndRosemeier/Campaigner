import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import {
  ArrowDownAZIcon,
  ArrowDownUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderInputIcon,
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
import type { AnyArtifact, Campaign, Module } from '@/domain';
import { entityKindFor } from '@/domain';
import { adoptIntoCampaign } from '@/db/artifactRepo';
import { removeImageFromArtifact } from '@/db/artifactRepo';
import { getModule, patchModule } from '@/db/moduleRepo';
import { useEntityImageQueue } from '@/features/modules/entity-image-queue';
import { useEncounterMapQueue } from '@/features/modules/encounter-map-queue';
import { KIND_PLURALS, runEntityBatch } from '@/features/modules/entity-batch';
import { normalizeModuleEntityNames } from '@/llm/moduleGen';
import {
  STUB_KINDS,
  type StubKind,
} from '@/features/modules/persona-request';
import {
  countOccurrences,
  extractWikiLinks,
  resolveWikiLink,
  rewriteWikiLinkTargets,
  sentenceAround,
} from '@/lib/wikilinks';
import { toastError, toastSuccess } from '@/lib/toast';
import { RunBattleButton } from '@/features/play/run-battle';
import { cn } from '@/lib/utils';

/**
 * Entity panel (08-MODULE-DESIGNER M4-C; fix-01 state surfaces): the right
 * sidebar of the module reader. Two lists — FOCUSED entities on top (the
 * ones the table cares about right now), then everything else, separated by
 * a divider — with a star toggle per row to move between them (persisted on
 * the module row), a sort button (first mention / alphabetical), occurrence
 * counts, the "N mentioned · M detailed" progress line, and the batch action
 * "Generate all unresolved of kind…". A resolved row opens the entity card
 * (peek modal); an unresolved row opens the stub popover.
 *
 * fix-01 state: batch generation is GATED on the module's entity-name
 * normalization (`entityNamesNormalized`) — the visible guarantee that no
 * variant name becomes an artifact through the batch. A failed pass shows a
 * banner with the error and a Retry; stored rewrite proposals (hand-edited
 * text / premise) show a review banner whose confirm dialog applies the
 * rewrites to the documents' CURRENT text.
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
  artifacts: readonly AnyArtifact[];
  campaign: Campaign;
  /** Opens the stub popover for an unresolved name. */
  onStub: (name: string, anchor: { x: number; y: number }) => void;
  /** Opens the entity card (peek modal) for a resolved entity. */
  onOpenCard: (artifact: AnyArtifact) => void;
}

interface EntityEntry {
  name: string;
  resolved: boolean;
  ambiguous: boolean;
  artifact: AnyArtifact | undefined;
  occurrences: { where: string; count: number }[];
  total: number;
  sentence: string;
}

export function useModuleEntities(
  module: Module,
  artifacts: readonly AnyArtifact[],
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
      const resolution = resolveWikiLink(name, artifacts, { moduleId: module.id });
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
  const { entries } = useModuleEntities(module, artifacts);
  const [collapsed, setCollapsed] = useState(false);
  const [batching, setBatching] = useState<StubKind | null>(null);
  const [imageMode, setImageMode] = useState(false);
  /** Entity awaiting confirmation to delete its image (images mode). */
  const [pendingImageDelete, setPendingImageDelete] = useState<{
    name: string;
    artifact: AnyArtifact;
  } | null>(null);
  const queuedJobs = useEntityImageQueue((state) => state.queued);
  const activeJobs = useEntityImageQueue((state) => state.activeJobs);
  const enqueueEncounterMaps = useEncounterMapQueue((state) => state.enqueue);
  const retryFailedEncounterMaps = useEncounterMapQueue((state) => state.retryFailed);
  const allFailedEncounterMaps = useEncounterMapQueue((state) => state.failed);
  const failedEncounterMaps = allFailedEncounterMaps.filter((job) => job.moduleId === module.id);
  /** fix-01: the consent review dialog is open. */
  const [proposalsOpen, setProposalsOpen] = useState(false);
  /** fix-01: the normalization pass is running (Retry / manual run). */
  const [normalizing, setNormalizing] = useState(false);

  /** fix-01: the batch gate — no batch generation before the pass succeeded. */
  const batchGateOpen = module.entityNamesNormalized;
  const batchGateReason = batchGateOpen
    ? undefined
    : module.entityNormalizationError !== ''
      ? 'Entity name normalization failed — retry it before batch generation.'
      : 'Entity names are not normalized yet — run the pass before batch generation.';

  const mentioned = entries.length;
  const detailed = entries.filter((entry) => entry.resolved).length;
  const unresolved = entries.filter((entry) => !entry.resolved);
  const encountersNeedingMaps = artifacts.filter(
    (artifact) =>
      artifact.kind === 'encounter' &&
      artifact.moduleId === module.id &&
      (artifact.data.layout === null || artifact.data.mapImageId === null),
  );
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

  /** fix-01: (Re-)runs the entity-name normalization pass. Failures are
   * recorded on the module row + toasted inside the pass — this only adds
   * the belt for unexpected throws. */
  async function runNormalization(): Promise<void> {
    setNormalizing(true);
    try {
      await normalizeModuleEntityNames(module.id);
    } catch (error) {
      toastError('Entity name normalization failed — retry from the entity panel', error);
    } finally {
      setNormalizing(false);
    }
  }

  /**
   * fix-01 consent: applies the stored rewrite proposals to the documents'
   * CURRENT text (fetched fresh, so hand edits made since the pass are
   * preserved), then clears the proposals. Tokens that no longer occur are
   * skipped naturally by the mechanical rewriter.
   */
  async function applyProposals(): Promise<void> {
    const proposals = module.entityRewriteProposals;
    if (proposals === null) return;
    try {
      const current = await getModule(module.id);
      if (current === undefined) throw new Error('the module row vanished');
      let spine = current.spine;
      let parts = current.parts;
      for (const proposal of proposals) {
        if (proposal.planIndex === -1) {
          if (spine !== null) {
            spine = { ...spine, premise: rewriteWikiLinkTargets(spine.premise, proposal.replacements) };
          }
          continue;
        }
        parts = parts.map((part) =>
          part.planIndex === proposal.planIndex
            ? { ...part, markdown: rewriteWikiLinkTargets(part.markdown, proposal.replacements) }
            : part,
        );
      }
      await patchModule(module.id, { spine, parts, entityRewriteProposals: null });
      toastSuccess('Normalization rewrites applied to the hand-edited text');
    } catch (error) {
      toastError('Could not apply the normalization rewrites', error);
    }
  }

  /** fix-01 consent: declines the proposals — nothing is rewritten, and the
   * panel keeps showing its variant rows. Either way the proposals clear. */
  async function declineProposals(): Promise<void> {
    try {
      await patchModule(module.id, { entityRewriteProposals: null });
    } catch (error) {
      toastError('Could not dismiss the rewrite proposals', error);
    }
  }

  /** Checkbox state for an entity in images mode. */
  function imageStateFor(entry: EntityEntry): EntityImageState {
    const artifact = entry.artifact;
    if (artifact !== undefined && (artifact.coverImageId !== null || artifact.imageIds.length > 0)) {
      return 'has';
    }
    if (
      activeJobs.some((job) => job.campaignId === campaign.id && job.name === entry.name) ||
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
    // fix-01 gate (belt behind the disabled buttons): no batch generation
    // before the normalization pass succeeded — this is the guarantee that
    // no variant name becomes an artifact through the batch.
    if (!module.entityNamesNormalized) {
      toastError('Entity names are not normalized yet — run the normalization pass first');
      return;
    }
    const targets = unresolvedByKind.get(kind) ?? [];
    if (targets.length === 0) return;
    setBatching(kind);
    try {
      const result = await runEntityBatch({ module, campaign, kind, targets });
      // Failed entities are loud: the bar finishing must not look like
      // success when some runs died (their detail lives in the Runs tab).
      // Ground truth = every target WITHOUT a produced artifact.
      if (result.failed.length > 0) {
        const summary = result.failed
          .map((failure) => `"${failure.name}" — ${failure.message}`)
          .join('; ');
        toastError(
          `${String(result.failed.length)} of ${String(targets.length)} ${KIND_PLURALS[kind]} failed to generate — ` +
            `see the Runs tab (${summary})`,
        );
      }
    } catch (error) {
      toastError('Batch generation failed', error);
    } finally {
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
          {module.entityRewriteProposals !== null && (
            <div
              className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
              data-testid="entity-proposals-banner"
            >
              <span className="min-w-0 flex-1">
                Normalization wants to update hand-edited text — review the proposed rewrites.
              </span>
              <Button
                variant="outline"
                size="xs"
                data-testid="entity-proposals-review"
                onClick={() => {
                  setProposalsOpen(true);
                }}
              >
                Review
              </Button>
            </div>
          )}
          {module.entityNormalizationError !== '' && (
            <div
              className="flex items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs"
              data-testid="entity-normalize-error"
            >
              <span className="min-w-0 flex-1" title={module.entityNormalizationError}>
                Name normalization failed: {module.entityNormalizationError}
              </span>
              <Button
                variant="outline"
                size="xs"
                disabled={normalizing}
                data-testid="entity-normalize-retry"
                onClick={() => {
                  void runNormalization();
                }}
              >
                {normalizing ? 'Normalizing…' : 'Retry'}
              </Button>
            </div>
          )}
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
            {encountersNeedingMaps.length > 0 && (
              <Button
                variant="outline"
                size="xs"
                data-testid="generate-encounter-maps"
                onClick={() => {
                  enqueueEncounterMaps(
                    encountersNeedingMaps.map((encounter) => ({
                      campaignId: module.campaignId,
                      moduleId: module.id,
                      artifactId: encounter.id,
                      name: encounter.name,
                    })),
                  );
                }}
              >
                <ImageIcon aria-hidden data-icon="inline-start" />
                Generate {encountersNeedingMaps.length} encounter map{encountersNeedingMaps.length === 1 ? '' : 's'}
              </Button>
            )}
            {failedEncounterMaps.length > 0 && (
              <Button
                variant="destructive"
                size="xs"
                data-testid="retry-encounter-maps"
                onClick={() => {
                  retryFailedEncounterMaps(module.id);
                }}
              >
                Retry {failedEncounterMaps.length} failed map{failedEncounterMaps.length === 1 ? '' : 's'}
              </Button>
            )}
            {STUB_KINDS.map((kind) => {
              const targets = unresolvedByKind.get(kind) ?? [];
              if (targets.length === 0) return null;
              return (
                <Button
                  key={kind}
                  variant="outline"
                  size="xs"
                  disabled={batching !== null || !batchGateOpen}
                  title={batchGateReason}
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
            {!batchGateOpen && (
              <Button
                variant="ghost"
                size="xs"
                disabled={normalizing}
                data-testid="entity-normalize"
                onClick={() => {
                  void runNormalization();
                }}
              >
                <SparklesIcon aria-hidden data-icon="inline-start" />
                {normalizing ? 'Normalizing…' : 'Normalize names'}
              </Button>
            )}
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
          {batchGateReason !== undefined && (
            <p className="border-b px-3 py-1.5 text-[11px] text-muted-foreground" data-testid="batch-gate-reason">
              {batchGateReason}
            </p>
          )}

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
      <Dialog
        open={proposalsOpen}
        onOpenChange={(open) => {
          if (!open) setProposalsOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-md" data-testid="entity-proposals-dialog">
          <DialogHeader>
            <DialogTitle>Apply the normalization rewrites?</DialogTitle>
            <DialogDescription>
              The pass wants to point variant wiki-links at their canonical
              entity in text you edited by hand. The display text you wrote
              stays exactly as it is — only the link target changes. Applying
              re-checks each document&apos;s <em>current</em> text; tokens you
              removed meanwhile are skipped.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-48 space-y-1 overflow-y-auto text-xs" data-testid="entity-proposals-list">
            {(module.entityRewriteProposals ?? []).map((proposal) => (
              <li key={String(proposal.planIndex)} className="rounded bg-muted px-2 py-1">
                <span className="font-medium">
                  {proposal.planIndex === -1
                    ? 'Premise'
                    : `Part ${String(proposal.planIndex + 1)}`}
                </span>
                {': '}
                {proposal.replacements.map((rewrite) => `[[${rewrite.from}]] → [[${rewrite.to}]]`).join(', ')}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              data-testid="entity-proposals-decline"
              onClick={() => {
                setProposalsOpen(false);
                void declineProposals();
              }}
            >
              Keep as written
            </Button>
            <Button
              size="sm"
              data-testid="entity-proposals-apply"
              onClick={() => {
                setProposalsOpen(false);
                void applyProposals();
              }}
            >
              Apply rewrites
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
  onOpenCard: (artifact: AnyArtifact) => void;
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
      {entry.artifact?.kind === 'encounter' && !imageMode && (
        <RunBattleButton
          campaignId={module.campaignId}
          moduleId={module.id}
          encounter={entry.artifact}
        />
      )}
      {entry.artifact !== undefined && !imageMode && entry.artifact.moduleId !== null && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground/40 hover:text-foreground"
          aria-label={`Adopt ${entry.name} into the campaign`}
          title="Adopt into campaign — moves the artifact out of this module's ownership (its links here stay)"
          data-testid="entity-adopt"
          data-name={entry.name}
          onClick={() => {
            const artifact = entry.artifact;
            if (artifact === undefined) return;
            adoptIntoCampaign(artifact.id)
              .then((moved) => {
                toastSuccess(`"${moved.name}" is owned by the campaign again`);
              })
              .catch((error: unknown) => {
                toastError('Could not adopt the artifact into the campaign', error);
              });
          }}
        >
          <FolderInputIcon aria-hidden className="size-4" />
        </Button>
      )}
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
