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
  Trash2Icon,
} from 'lucide-react';

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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { AnyArtifact, Campaign, Id, Module } from '@/domain';
import { entityKindFor } from '@/domain';
import { adoptIntoCampaign } from '@/db/artifactRepo';
import { removeImageFromArtifact } from '@/db/artifactRepo';
import { getModule, patchModule } from '@/db/moduleRepo';
import { snapshotModuleVersion } from '@/db/moduleVersionRepo';
import {
  sweepOrphanedArtifacts,
  type OrphanSweepOutcome,
} from '@/db/orphanSweep';
import {
  useModuleOrphans,
  type ModuleOrphanRow,
} from '@/features/modules/entity-orphans';
import { promoteSecondModuleUses } from '@/db/artifactAutoPromote';
import {
  deriveAutomationDeviation,
  deviationLines,
  deviationWorkCount,
} from '@/features/modules/automation-deviation';
import { useEntityImageQueue } from '@/features/modules/entity-image-queue';
import { useEncounterMapQueue } from '@/features/modules/encounter-map-queue';
import { FULL_AUTOMATION_TARGET } from '@/features/modules/post-generation';
import { resumeEverything } from '@/features/modules/resume-automation';
import { KIND_PLURALS, runEntityBatch } from '@/features/modules/entity-batch';
import { classifyNewModuleEntityNames, normalizeModuleEntityNames } from '@/llm/moduleGen';
import { unclassifiedEntityNames } from '@/domain/entityNormalization';
import {
  STUB_KINDS,
  type StubKind,
} from '@/features/modules/persona-request';
import {
  useModuleEntities,
  type EntityEntry,
} from '@/features/modules/use-module-entities';
import { rewriteWikiLinkTargets } from '@/lib/wikilinks';
import { toastError, toastInfo, toastSuccess } from '@/lib/toast';
import { RunBattleButton } from '@/features/play/run-battle';
import { cn } from '@/lib/utils';

/** Every generator-authored text of a module, for post-save wikilink scans. */
function moduleTexts(module: Module): string[] {
  return [
    ...(module.spine?.premise === undefined || module.spine.premise === ''
      ? []
      : [module.spine.premise]),
    ...module.parts.map((part) => part.markdown).filter((markdown) => markdown !== ''),
  ];
}

/** Adopt handler shared by the entity rows and the orphan rows (08 §M4-C:
 * the orphan group keeps the Adopt affordance — one shared implementation). */
function adoptArtifact(artifact: AnyArtifact): void {
  adoptIntoCampaign(artifact.id)
    .then((moved) => {
      toastSuccess(`"${moved.name}" is owned by the campaign again`);
    })
    .catch((error: unknown) => {
      toastError('Could not adopt the artifact into the campaign', error);
    });
}

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
 * Names the text picked up LATER (08 §M4-C, docs/17 row 64): the buckets read
 * the RECORDS, so a name no pass has seen (a chat turn, a hand edit, a board
 * rewrite, a version restore) has no button. The fresh read of the module text
 * names those names and offers ONE "Classify N new names" action — the same
 * normalization pass as at creation, consent rule included — after which the
 * kind's batch button is back. The observation is what triggers the offer, so
 * every text-changing event is covered without per-event wiring.
 *
 * IMAGES mode (M4-C, module-mode-as-play): the "Images" button swaps the row
 * stars for checkboxes — checked = the entity has an image, indeterminate =
 * queued for the background image queue, unchecked = none. Checking queues a
 * generation (one image per entity, attached as cover); unchecking a QUEUED
 * entity just removes it from the queue, while unchecking an entity WITH an
 * image asks for confirmation before deleting it.
 *
 * "Generate everything" (docs/17 row 80): the toolbar's bulk fill, derived per
 * render against the FULL automation target (every entity kind for details and
 * images, battle maps and mob portraits) rather than the module's RECORDED
 * intent. It is the same pipeline, sweep and detectors as the canvas's "Resume
 * automatic module creation" — so a module created before `automationIntent`
 * existed, or one whose creation automated only some kinds, is finished here.
 * With nothing missing it renders a passive statement instead of a permanently
 * disabled button; while a run is in flight it is disabled with the reason in
 * `title`. It never rewrites the module text.
 */

/** What the checkbox shows for an entity in images mode. */
type EntityImageState = 'has' | 'queued' | 'none';

/**
 * True while a generation of THIS module's artifacts is in flight: the module's
 * own parts pass (`module.status === 'generating'`, checked by the caller), or
 * this module's queued/active entity-image or encounter-map jobs — the two
 * queues the post-generation sweep fills, read through the SAME store
 * subscriptions the panel's image checkboxes already use (no parallel
 * subscription). Queued AND active count: a job waiting its turn is work this
 * control would double-book.
 */
function useModuleQueuesBusy(moduleId: Id): boolean {
  const imageJobs = useEntityImageQueue(
    (state) =>
      state.queued.some((job) => job.moduleId === moduleId) ||
      state.active.some((job) => job.moduleId === moduleId),
  );
  const mapJobs = useEncounterMapQueue(
    (state) =>
      state.queued.some((job) => job.moduleId === moduleId) ||
      state.active.some((job) => job.moduleId === moduleId),
  );
  return imageJobs || mapJobs;
}

export interface EntityPanelProps {
  module: Module;
  artifacts: readonly AnyArtifact[];
  campaign: Campaign;
  /** Opens the stub popover for an unresolved name. */
  onStub: (name: string, anchor: { x: number; y: number }) => void;
  /** Opens the entity card (peek modal) for a resolved entity. */
  onOpenCard: (artifact: AnyArtifact) => void;
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
  /** Orphaned entities (08 §M4-C): module-owned rows this module's prose
   * never mentions, ambiguity-shadowed ones excluded. */
  const orphanRows = useModuleOrphans(module, artifacts);
  const orphans = useMemo(
    () => orphanRows.filter((orphan) => !orphan.ambiguous),
    [orphanRows],
  );
  /** The delete-all confirm dialog (the sweep re-counts at confirm). */
  const [orphanSweepOpen, setOrphanSweepOpen] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  /** Entity awaiting confirmation to delete its image (images mode). */
  const [pendingImageDelete, setPendingImageDelete] = useState<{
    name: string;
    artifact: AnyArtifact;
  } | null>(null);
  const queuedJobs = useEntityImageQueue((state) => state.queued);
  const activeJobs = useEntityImageQueue((state) => state.active);
  const enqueueEncounterMaps = useEncounterMapQueue((state) => state.enqueue);
  const retryFailedEncounterMaps = useEncounterMapQueue((state) => state.retryFailed);
  const allFailedEncounterMaps = useEncounterMapQueue((state) => state.failed);
  const failedEncounterMaps = allFailedEncounterMaps.filter((job) => job.moduleId === module.id);
  /** fix-01: the consent review dialog is open. */
  const [proposalsOpen, setProposalsOpen] = useState(false);
  /** fix-01: the normalization pass is running (Retry / manual run). */
  const [normalizing, setNormalizing] = useState(false);
  /** fix-01: the incremental classification of names the text picked up later. */
  const [classifying, setClassifying] = useState(false);
  /** "Generate everything" (docs/17 row 80): the confirmation / the run. */
  const [generateAllOpen, setGenerateAllOpen] = useState(false);
  const [generatingAll, setGeneratingAll] = useState(false);

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

  // Names the record gate cannot batch yet — the OBSERVATION POINT (08 §M4-C
  // "names the text picks up later", docs/17 row 64). It is a pure function of
  // the FRESH read of the module row's text (the same `useModuleEntities`
  // derivation the buckets above read), so EVERY event that changes module
  // text is covered by one wiring: a chat apply (editor or preview), a hand
  // edit, a board rewrite, a part generation/regeneration, a durable-version
  // restore. Nothing is dispatched from a render — the observed names only
  // gate the toolbar's "Classify N new names" affordance, and a re-render or a
  // tab switch can therefore never classify, duplicate a record or duplicate a
  // button.
  const unclassified = useMemo(
    () =>
      unclassifiedEntityNames({
        entityKinds: module.entityKinds,
        names: entries.map((entry) => entry.name),
        resolvedNames: entries.filter((entry) => entry.resolved).map((entry) => entry.name),
        proposals: module.entityRewriteProposals,
      }),
    [entries, module.entityKinds, module.entityRewriteProposals],
  );

  // "Generate everything" (owner request, verbatim: "In the entities sidebar i
  // would like to have a button 'generate everything' that just fills all
  // generation gaps. All entity details, all images, encounters, maps in
  // encounters... everything thats missing. Same way as its triggered in module
  // generation."; docs/17 row 80). The target is the FULL automation target —
  // every entity kind for details AND images, battle maps and mob portraits on —
  // NOT the module's recorded `automationIntent`: that record is what the owner
  // asked CREATION to automate, and a module created before the field existed
  // (or created with only some kinds ticked) must still be finished here.
  //
  // The work is the EXISTING sweep through the EXISTING detectors, so this
  // derivation is what the confirmation lists and exactly what the run does:
  // additive (never regenerate what exists), no text rewrite, no scene created.
  // The control's visibility is this derived answer — never a stored flag (it
  // would go stale on the first hand edit, which is the state this exists for)
  // and never a permanently disabled button: with nothing missing it renders a
  // passive statement instead.
  const fullTargetDeviation = useMemo(
    () => deriveAutomationDeviation(module, artifacts, FULL_AUTOMATION_TARGET),
    [module, artifacts],
  );
  const generateAllWork = deviationWorkCount(fullTargetDeviation);

  /** True while ANY generation of this module's artifacts is in flight: the
   * module's own parts pass, or this module's queued/active image or encounter
   * map jobs (the sweep's own queues). */
  const generateAllLive = useModuleQueuesBusy(module.id);

  /**
   * Why "Generate everything" is disabled right now (null = it is not) — the
   * `saveBlockedReason` / `derivedActionBlockedReason` house convention: a
   * disabled control states its honest reason in `title` instead of leaving the
   * owner to guess. A module whose parts pass has not finished is named here as
   * well, with the honest remedy (the text path) rather than a silent re-entry
   * that the seam would refuse anyway.
   */
  function generateAllBlockedReason(): string | null {
    if (generatingAll) return 'Generating…';
    if (module.status === 'generating') {
      return 'The module is generating right now — wait for it (or press Stop).';
    }
    if (generateAllLive) {
      return 'A generation for this module is already running — wait for it (or press Stop all in the progress dock).';
    }
    if (module.status === 'failed') {
      return `This module's parts pass did not finish (status: failed${module.errorMessage === '' ? '' : ` — ${module.errorMessage}`}) — fix the text first ("Fix module problems" or a hand edit); a module whose parts did not land has nothing to automate.`;
    }
    if (module.status !== 'ready') {
      return `This module is not ready to finish (status: ${module.status}) — its parts pass has not completed, so there is nothing to automate yet.`;
    }
    return null;
  }

  const generateAllBlocked = generateAllBlockedReason();

  /**
   * The confirmed "Generate everything": the SAME pipeline as "Resume automatic
   * module creation", with the full target instead of the recorded intent
   * (`resumeEverything`) — the classification pass and the normalization pass
   * first where the text needs them, then the sweep. Every refusal is toasted by
   * the seam itself; this wrapper only reports the outcome, so a run is never
   * silent. The module ROW's automation fields are never written, and the text
   * is never touched.
   */
  async function runGenerateEverything(): Promise<void> {
    if (generatingAll) return;
    setGenerateAllOpen(false);
    setGeneratingAll(true);
    try {
      const report = await resumeEverything(module.id, campaign);
      if (report.stopped) {
        toastInfo(
          'Generation stopped — everything that was already generated is kept; run it again to fill what is left.',
        );
      } else if (report.empty && report.refused === null) {
        toastInfo('Nothing is missing any more — the module already has every artifact, image and map.');
      }
    } catch (error) {
      toastError('Could not generate everything for this module', error);
    } finally {
      setGeneratingAll(false);
    }
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

  /** Moves an entity between the focused and unfocused lists (persisted).
   * The focus change re-resolves names against the campaign pool, so the
   * module's texts are re-scanned for second-module uses (LINKS hook). */
  async function toggleFocus(name: string): Promise<void> {
    const next = isFocused(name)
      ? module.focusedEntities.filter(
          (focused) => focused.trim().toLowerCase() !== name.toLowerCase(),
        )
      : [...module.focusedEntities, name];
    try {
      await patchModule(module.id, { focusedEntities: next });
      await promoteSecondModuleUses(module.id, moduleTexts(module));
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
   * fix-01 records for names the text picked up later (08 §M4-C): sends ONLY
   * the observed unrecorded names through the SAME normalization machinery the
   * creation-time pass uses — never a client heuristic — so their records
   * appear and the kind's batch button comes back. Failures are recorded on
   * the module row (gate closed) + toasted inside the pass; a throw here is
   * the belt for pre-flight refusals.
   */
  async function classifyNewNames(): Promise<void> {
    setClassifying(true);
    try {
      const result = await classifyNewModuleEntityNames(module.id);
      if (result.failed) return; // recorded + toasted by the pass
      toastSuccess(
        result.classified.length === 0
          ? 'No new entity names to classify'
          : `Classified ${String(result.classified.length)} new entity name${
              result.classified.length === 1 ? '' : 's'
            }`,
      );
    } catch (error) {
      toastError('Could not classify the new entity names', error);
    } finally {
      setClassifying(false);
    }
  }

  /**
   * fix-01 consent: applies the stored rewrite proposals to the documents'
   * CURRENT text (fetched fresh, so hand edits made since the pass are
   * preserved), then clears the proposals. Tokens that no longer occur are
   * skipped naturally by the mechanical rewriter. The rewrite targets are
   * AI-authored, so the write takes the durable pre-change snapshot first
   * (docs/18 §2.3 simple undo) — the consent click is what lands it, but the
   * change is the model's, and the module's text must stay undoable.
   */
  async function applyProposals(): Promise<void> {
    const proposals = module.entityRewriteProposals;
    if (proposals === null) return;
    try {
      const current = await getModule(module.id);
      if (current === undefined) throw new Error('the module row vanished');
      await snapshotModuleVersion(
        module.id,
        'normalization',
        'Apply name-normalization rewrites',
      );
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
      // The rewritten text may now link another module's entities under
      // their canonical spellings — scan for second-module uses (LINKS hook).
      await promoteSecondModuleUses(
        module.id,
        moduleTexts({ ...module, spine, parts }),
      );
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

  /** The sweep's per-artifact outcomes as ONE loud toast (failed[] convention,
   * 08 §M4-C): deleted N / kept M with the kept names + reasons — never silent. */
  function toastSweepOutcome(outcome: OrphanSweepOutcome): void {
    if (outcome.kept.length === 0) {
      if (outcome.deleted.length === 0) {
        toastSuccess('No orphaned entities remain — nothing to delete');
        return;
      }
      toastSuccess(
        `Deleted ${String(outcome.deleted.length)} orphaned ${
          outcome.deleted.length === 1 ? 'entity' : 'entities'
        }`,
      );
      return;
    }
    const keptText = outcome.kept
      .map((row) => `"${row.name}" — ${row.reason}`)
      .join('; ');
    toastError(
      `Deleted ${String(outcome.deleted.length)} of ${String(
        outcome.deleted.length + outcome.kept.length,
      )} orphans — kept ${String(outcome.kept.length)}: ${keptText}`,
    );
  }

  /** Toolbar delete-all: the sweep re-derives orphans + guards inside its
   * transaction (recount) — the dialog's list never decides what goes. */
  async function runOrphanSweep(): Promise<void> {
    setSweeping(true);
    try {
      const outcome = await sweepOrphanedArtifacts(module.id);
      toastSweepOutcome(outcome);
      setOrphanSweepOpen(false);
    } catch (error) {
      toastError('Could not delete the orphaned entities', error);
    } finally {
      setSweeping(false);
    }
  }

  /** Per-row single delete: the same sweep surface + guard set — a refusal
   * names its reason instead of deleting. */
  async function deleteOrphan(orphan: ModuleOrphanRow): Promise<void> {
    try {
      const outcome = await sweepOrphanedArtifacts(module.id, { onlyId: orphan.artifact.id });
      if (outcome.deleted.length > 0) {
        toastSuccess(`Deleted orphaned entity "${orphan.artifact.name}"`);
        return;
      }
      const keptRow = outcome.kept[0];
      if (keptRow !== undefined) {
        toastError(`Kept "${orphan.artifact.name}" — ${keptRow.reason}`);
      }
    } catch (error) {
      toastError(`Could not delete "${orphan.artifact.name}"`, error);
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
      // Bounded rail: the batch toolbar holds one nowrap button per stub
      // kind, so an unbounded flex item would size by its widest button
      // (flex min-width:auto) and invade the document. w-80 fits a
      // name + kind badge + ×count row; shrink-0 keeps the DOCUMENT as
      // the flexing pane; min-w-0 lets toolbar labels wrap inside.
      className="flex h-full w-80 min-w-0 shrink-0 flex-col border-l bg-card"
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
            {generateAllWork > 0 ? (
              <Button
                variant="outline"
                size="xs"
                disabled={generateAllBlocked !== null}
                title={
                  generateAllBlocked ??
                  'Fill every generation gap of this module: entity details, images, encounter battle maps and mob portraits. Only what is missing is generated — the module text is never rewritten.'
                }
                data-testid="generate-everything"
                onClick={() => {
                  setGenerateAllOpen(true);
                }}
              >
                <SparklesIcon aria-hidden data-icon="inline-start" />
                {generatingAll
                  ? 'Generating…'
                  : `Generate everything (${String(generateAllWork)})`}
              </Button>
            ) : (
              // Never a permanently disabled button (docs/17: a control that can
              // never light up is indistinguishable from a broken one) — with
              // nothing missing the control's place shows the state instead.
              <span
                className="text-[11px] text-muted-foreground"
                title="Generate everything — this module has no artifact, image or map gap right now"
                data-testid="generate-everything-none"
              >
                Nothing missing
              </span>
            )}
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
                  retryFailedEncounterMaps((job) => job.moduleId === module.id);
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
            {batchGateOpen && unclassified.length > 0 && (
              <Button
                variant="outline"
                size="xs"
                disabled={classifying || normalizing || module.status === 'generating'}
                title={
                  module.status === 'generating'
                    ? 'The module is generating — its own normalization pass records the names when the parts land.'
                    : 'Classify the names this text picked up since the last pass (one model call, the same pass as at creation) — their batch buttons then appear.'
                }
                data-testid="entity-classify-new"
                onClick={() => {
                  void classifyNewNames();
                }}
              >
                <SparklesIcon aria-hidden data-icon="inline-start" />
                {classifying
                  ? 'Classifying…'
                  : `Classify ${String(unclassified.length)} new name${unclassified.length === 1 ? '' : 's'}`}
              </Button>
            )}
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
            {orphans.length > 0 && (
              <Button
                variant="destructive"
                size="xs"
                disabled={sweeping}
                data-testid="orphan-delete-all"
                onClick={() => {
                  setOrphanSweepOpen(true);
                }}
              >
                <Trash2Icon aria-hidden data-icon="inline-start" />
                {sweeping ? 'Deleting…' : `Delete ${String(orphans.length)} orphan${orphans.length === 1 ? '' : 's'}`}
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
          {batchGateOpen && unclassified.length > 0 && (
            <p
              className="border-b px-3 py-1.5 text-[11px] text-muted-foreground"
              data-testid="entity-classify-hint"
            >
              {String(unclassified.length)} unresolved name
              {unclassified.length === 1 ? ' has' : 's have'} no recorded type yet — classify them to
              get their batch buttons.
            </p>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2 text-sm">
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
            {orphans.length > 0 && (
              <>
                <hr className="my-2 border-border" />
                {/* Third list (08 §M4-C "Orphaned entities"): module-owned
                 * rows this module's prose never mentions — the
                 * disambiguated term for the tree's module-less "Orphaned"
                 * group (00-OVERVIEW). */}
                <section data-testid="orphaned-group" aria-label="Orphaned entities">
                  <p className="px-1 pb-1 text-[11px] tracking-wide text-muted-foreground uppercase">
                    Orphaned (unmentioned) · {String(orphans.length)}
                  </p>
                  <ul>
                    {orphans.map((orphan) => (
                      <OrphanRow
                        key={orphan.artifact.id}
                        orphan={orphan}
                        onOpenCard={onOpenCard}
                        onDelete={() => {
                          void deleteOrphan(orphan);
                        }}
                      />
                    ))}
                  </ul>
                </section>
              </>
            )}
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
          <ul className="max-h-48 space-y-1 overflow-y-auto overscroll-contain text-xs" data-testid="entity-proposals-list">
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
      <AlertDialog
        open={orphanSweepOpen}
        onOpenChange={(open) => {
          if (!open) setOrphanSweepOpen(false);
        }}
      >
        <AlertDialogContent data-testid="orphan-sweep-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="orphan-sweep-title">
              Delete {String(orphans.length)} orphaned{' '}
              {orphans.length === 1 ? 'entity' : 'entities'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              These module-owned entities have zero wiki-link mentions anywhere
              in the campaign. Deleting removes their revision history, scrubs
              relations pointing at them, and prunes images only they
              referenced. Entities still referenced by a battle, an encounter
              roster, a deliverable outline, or another module&apos;s prose are
              kept and named in the result.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul
            className="max-h-48 space-y-1 overflow-y-auto overscroll-contain text-xs"
            data-testid="orphan-sweep-list"
          >
            {orphans.map((orphan) => (
              <li key={orphan.artifact.id} className="rounded bg-muted px-2 py-1">
                {orphan.artifact.name}
                <span className="text-muted-foreground"> · {orphan.artifact.kind}</span>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="sm"
              disabled={sweeping || orphans.length === 0}
              data-testid="orphan-sweep-confirm"
              onClick={() => {
                void runOrphanSweep();
              }}
            >
              {sweeping ? 'Deleting…' : 'Delete orphans'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* "Generate everything" (docs/17 row 80): the confirmation names what is
          MISSING — exactly the work the sweep would do, from the sweep's own
          detectors — and states the boundary honestly: this fills artifacts
          derived from text that already exists and never rewrites the text, so a
          scene the prose stages without an encounter never becomes a fight
          scene here (that is "Fix module problems" on the canvas, which repairs
          the text). */}
      <AlertDialog open={generateAllOpen} onOpenChange={setGenerateAllOpen}>
        <AlertDialogContent data-testid="generate-everything-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Generate everything that is missing?</AlertDialogTitle>
            <AlertDialogDescription>
              Only what is missing is generated, additively — nothing that already exists is
              re-generated, re-detailed or overwritten. Entity details for every kind are batched
              first, then images, encounter battle maps and mob portraits; the jobs run in the
              background and appear in the progress dock, where Stop all ends them. The module TEXT
              is never rewritten and no scene is created: a fight the prose stages without an
              encounter of its own is the canvas&apos;s &quot;Fix module problems&quot; territory, not
              this control.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul
            className="list-disc space-y-1 pl-5 text-sm"
            data-testid="generate-everything-list"
          >
            {deviationLines(fullTargetDeviation).map((line) => (
              <li key={line} data-testid="generate-everything-line">
                {line}
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="generate-everything-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="generate-everything-confirm"
              onClick={() => {
                void runGenerateEverything();
              }}
            >
              Generate everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
          <>
            <span title="Multiple artifacts match this name" aria-hidden>
              ⚠
            </span>
            {/* Touch + screen-reader mirror of the hover-only title above. */}
            <span className="sr-only">Multiple artifacts match this name</span>
          </>
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
          aria-label={`Adopt ${entry.name} into the campaign — moves it out of this module's ownership`}
          title="Adopt into campaign — moves the artifact out of this module's ownership (its relations here stay)"
          data-testid="entity-adopt"
          data-name={entry.name}
          onClick={() => {
            const artifact = entry.artifact;
            if (artifact === undefined) return;
            adoptArtifact(artifact);
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
            entry.artifact === undefined
              ? `Detail ${entry.name} first — images attach to its artifact`
              : imageState === 'has'
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

/**
 * One row of the "Orphaned (unmentioned)" group (08 §M4-C): kind badge in
 * the amber family (campaign-tree's orphaned-badge convention), the
 * "no mentions" tag, a trash button for the guarded single delete, and
 * Adopt — the row is still module-owned and adoptable. Clicking the name
 * opens the entity card like every resolved row.
 */
function OrphanRow({
  orphan,
  onOpenCard,
  onDelete,
}: {
  orphan: ModuleOrphanRow;
  onOpenCard: (artifact: AnyArtifact) => void;
  onDelete: () => void;
}): JSX.Element {
  const artifact = orphan.artifact;
  return (
    <li className="flex items-center">
      <button
        type="button"
        data-testid="orphan-row"
        data-name={artifact.name}
        data-kind={artifact.kind}
        className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
        onClick={() => {
          onOpenCard(artifact);
        }}
      >
        <span className="min-w-0 flex-1 truncate">{artifact.name}</span>
        <Badge
          variant="outline"
          className="shrink-0 border-amber-500/60 px-1 text-[10px] font-medium text-amber-600 dark:text-amber-400"
        >
          {artifact.kind}
        </Badge>
        <span className="shrink-0 text-xs text-muted-foreground">no mentions</span>
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-muted-foreground/40 hover:text-destructive"
        aria-label={`Delete orphaned entity ${artifact.name}`}
        title="Delete this orphaned entity (guards keep it with a reason)"
        data-testid="orphan-delete"
        data-name={artifact.name}
        onClick={onDelete}
      >
        <Trash2Icon aria-hidden className="size-4" />
      </Button>
      {artifact.moduleId !== null && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground/40 hover:text-foreground"
          aria-label={`Adopt ${artifact.name} into the campaign — moves it out of this module's ownership`}
          title="Adopt into campaign — moves the artifact out of this module's ownership (its relations here stay)"
          data-testid="entity-adopt"
          data-name={artifact.name}
          onClick={() => {
            adoptArtifact(artifact);
          }}
        >
          <FolderInputIcon aria-hidden className="size-4" />
        </Button>
      )}
    </li>
  );
}
