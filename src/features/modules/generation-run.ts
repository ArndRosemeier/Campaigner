import type { AnyArtifact, Campaign, EntityKind, Module } from '@/domain';
import { ENTITY_KINDS } from '@/domain';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import {
  enqueueEncounterPortraitFill,
  regenerateEncounterPortraits,
} from '@/features/campaign/mob-portrait-queue';
import { changeArtifact } from '@/features/modules/change-artifact';
import { useEncounterMapQueue } from '@/features/modules/encounter-map-queue';
import { useEntityImageQueue } from '@/features/modules/entity-image-queue';
import { entityGateNeeds, namesAwaitingGate, openEntityGate } from '@/features/modules/entity-gate';
import { getModule } from '@/db/moduleRepo';
import { loadChatDetailsPool } from '@/llm/canvasChat';
import { runEntityBatch } from '@/features/modules/entity-batch';
import {
  reportEntityBatchFailures,
  reportEntityBatchNotices,
} from '@/features/modules/entity-batch-report';
import {
  selectGenerationTargets,
  selectedNameResolves,
  type GenerationEncounterExtras,
  type GenerationKind,
  type GenerationLevelRange,
  type GenerationEncounterTarget,
  type GenerationOverwriteTarget,
  type GenerationSelection,
  type GenerationTarget,
} from '@/features/modules/generation-selection';
import { moduleGenLockName, withGenerationLock } from '@/lib/generationLocks';
import { errorMessage } from '@/lib/errors';
import { getStopEpoch, stoppedSince } from '@/lib/stopEpoch';
import { useProgressStore } from '@/lib/progress';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * ============================================================================
 * THE GENERATION DIALOG'S DISPATCHER (docs/23 §7, docs/17 row 394).
 *
 * THE ENGINE STAYS — the dialog drives it. This file owns NO generation itself:
 * it turns one `GenerationSelection` into the SAME calls the entity panel, the
 * image queue, the encounter-map queue and the encounter editor already make
 * (`runEntityBatch`, `useEntityImageQueue`, `useEncounterMapQueue`,
 * `enqueueEncounterPortraitFill`), in the domain's stable kind order (encounters
 * LAST — the fixed-cast pin, docs/11: an encounter's brief-time snapshot must
 * already hold the NPCs its brief pins as fixed cast).
 *
 * ONE SCOPE, ONE RUN. The selection is derived HERE, at the start, and every
 * unit works from that same announcement — so what the dialog announced is
 * exactly what runs, and a document edited between the announcement and the
 * press can only ever be generated as it was announced. The dialog's own count
 * and this run's plan are the same derivation (`selectGenerationTargets`).
 *
 * THE PLAN IS DERIVED TWICE, ON PURPOSE, AND ONLY THE SECOND ONE ENQUEUES
 * (docs/17 row 406). The first derivation is the PLAN the dialog announced; it
 * projects the images/maps/portraits this run's OWN detail pass will unlock
 * (`pendingImages`/`pendingEncounters`). Every image/map/portrait detector asks
 * what EXISTS, and before the detail pass nothing does — so the enqueue half
 * re-derives from a FRESH artifact read AFTER the batches and enqueues only the
 * actual, existing targets. That ordering is also the queues' contract: a job
 * resolves its artifact by name at run time and fails LOUDLY when it is
 * missing, so a name whose detail failed must be reported by the batch, never
 * re-reported by the queue.
 *
 * WITHOUT THE OVERWRITE BOX, EVERYTHING IS ADDITIVE AND IDEMPOTENT, because the
 * underlying seams already are: a batch targets only names with no authored
 * detail of their own, the image queue skips entities that already carry an
 * image, the map queue skips encounters that already carry a map, and the
 * portrait fill enumerates away kinds that already carry art. Re-running such a
 * selection can never double-generate and never overwrites an existing artifact.
 *
 * WITH IT (docs/17 row 422 — the owner's model evaluation: "all selected details
 * that were already there get removed and generated freshly"), the selection's
 * `overwrites` are regenerated through the SAME engines, never a second
 * generator: a detail IN PLACE (the change seam's own engine — `runEntityBatch`
 * with the row's `artifactId`, or `changeArtifact`'s repopulate for an
 * encounter: same id, fresh text, the previous text kept as a revision), and
 * the cover / battlemap / mob portraits DELETE-AFTER-REPLACE through each
 * queue's own `regen` job (the old art goes only once the fresh art landed).
 *
 * A STOP IS CONSULTED BETWEEN EVERY UNIT (the app-level stop epoch,
 * `lib/stopEpoch`): the whole point of "Stop all" is that a stop ends the NEXT
 * unit too, not just the one in flight.
 *
 * NOTHING HERE RUNS WITHOUT AN EXPLICIT CALL. There is no subscription, no
 * timer, no render-time effect and no automatic follow-up: the dialog is the
 * only caller, and every choice it carries (kinds, range, images, maps, mob
 * portraits) is a checkbox the owner ticked.
 * ============================================================================
 */

/**
 * The explicit encounter extras — OFF unless the dialog's checkboxes say so.
 * Declared on the selection seam (docs/17 row 406) because the announced
 * `totalCount` is the run's plan; re-exported here because this module's public
 * input type names it.
 */
export type EncounterExtras = GenerationEncounterExtras;

/** What the dialog asks a run to do. */
export interface GenerationRunInput {
  module: Module;
  campaign: Campaign;
  artifacts: readonly AnyArtifact[];
  kinds: readonly GenerationKind[];
  /** Selected kinds that ALSO get an image (row 397). */
  imageKinds: readonly EntityKind[];
  levelRange: GenerationLevelRange;
  encounterExtras: EncounterExtras;
  /** The dialog's overwrite box (docs/17 row 422); absent = off (additive). */
  overwrite?: boolean;
}

/** What one run did (the dialog reports it; the queues carry their own progress). */
export interface GenerationRunReport {
  /** The exact scope that ran (the dialog's own derivation). */
  selection: GenerationSelection;
  /** Entities the batches produced an artifact for. */
  generated: number;
  /** Existing details regenerated IN PLACE (the overwrite, docs/17 row 422). */
  regenerated: number;
  /** Image jobs enqueued. */
  imageJobs: number;
  /** Battlemap jobs enqueued. */
  mapJobs: number;
  /** Mob portraits enqueued. */
  portraitJobs: number;
  /** A concrete reason nothing (or nothing further) ran — already toasted. */
  refused: string | null;
  /** Names the classification pass recorded (empty when it did not run). */
  classified: string[];
  /** A Stop all landed between units. */
  stopped: boolean;
  /**
   * ONE line per TICKED kind that enqueued NOTHING, with the reason (docs/17
   * row 406) — appended to the run's summary, so a ticked kind can never end in
   * a silent "the dialog just finished". Empty when every ticked kind produced
   * work (or was not ticked).
   */
  notes: string[];
}

/** The kinds the batch half runs, in the domain's stable order (encounters last). */
function orderedDetailKinds(selection: GenerationSelection): EntityKind[] {
  const kinds = new Set(
    [...selection.detail, ...selection.overwrites.details].map((target) => target.kind),
  );
  return ENTITY_KINDS.filter((kind) => kinds.has(kind));
}

/** Names of one kind, in the selection's own order. */
function targetsOfKind(selection: GenerationSelection, kind: EntityKind): GenerationTarget[] {
  return selection.detail.filter((target) => target.kind === kind);
}

/**
 * The run's own progress-dock entry (docs/17 row 419). The dialog closes the
 * moment Generate is pressed, so the dock is where the run lives — and while
 * this entry exists a run is in progress for the module: the Generate button
 * and the dialog read it to stay disabled, and a second start is refused. ONE
 * fact, started and finished by the run itself.
 */
export function generationRunJobId(moduleId: string): string {
  return `generation-run:${moduleId}`;
}

/** Is a generation run in progress for this module (its dock entry exists)? */
export function generationRunActive(moduleId: string): boolean {
  const id = generationRunJobId(moduleId);
  return useProgressStore.getState().jobs.some((job) => job.id === id);
}

/**
 * Runs ONE level-scoped generation selection. The caller supplies the module,
 * the campaign and the page's artifact pool; nothing is read from a stored
 * automation intent.
 */
export async function runGenerationSelection(
  input: GenerationRunInput,
): Promise<GenerationRunReport> {
  const { module, artifacts, kinds, imageKinds, levelRange, encounterExtras } = input;
  const overwrite = input.overwrite === true;
  const selection = selectGenerationTargets({
    module,
    artifacts,
    kinds,
    imageKinds,
    levelRange,
    encounterExtras,
    overwrite,
  });
  const report: GenerationRunReport = {
    selection,
    generated: 0,
    regenerated: 0,
    imageJobs: 0,
    mapJobs: 0,
    portraitJobs: 0,
    refused: null,
    classified: [],
    stopped: false,
    notes: [],
  };
  // Names no batch can see yet (a chat-born module: every name) put the gate
  // FIRST — the selection is then derived from what the gate recorded
  // (docs/17 row 414). Without this the selection is empty and the dialog's
  // Generate did nothing, so a chat-born module was never normalized.
  const gateFirst = kinds.length > 0 && namesAwaitingGate(module, artifacts).length > 0;
  if (selection.totalCount === 0 && !gateFirst) return report;
  if (generationRunActive(module.id)) {
    // LOUD, never a second run racing the first on one module (the dialog
    // closes at once, so a reopened dialog could otherwise start one).
    report.refused = 'A generation run is already in progress for this module — its progress is in the box at the bottom.';
    toastError(report.refused);
    return report;
  }
  // Started in the SAME synchronous step as the check above, so two quick
  // starts cannot both pass it; finished when the run settles, however.
  const progress = useProgressStore.getState();
  const entry = generationRunJobId(module.id);
  progress.start(entry, 'Generate details', 'starting…');

  // The module's Web Lock is held for the whole run (docs/17 row 110): the
  // batches plus the enqueues are the app's longest-lived orchestration and a
  // held lock is one of Chromium's documented freeze opt-outs.
  return withGenerationLock(moduleGenLockName(module.id), () =>
    runSelectionUnlocked(input, selection, report, gateFirst),
  ).finally(() => {
    progress.finish(entry);
  });
}

/** Names the step the run is on, on its dock entry. */
function runStep(moduleId: string, detail: string): void {
  useProgressStore.getState().update(generationRunJobId(moduleId), { detail });
}

async function runSelectionUnlocked(
  input: GenerationRunInput,
  planned: GenerationSelection,
  report: GenerationRunReport,
  gateFirst: boolean,
): Promise<GenerationRunReport> {
  const { campaign, kinds, imageKinds, levelRange, encounterExtras } = input;
  const overwrite = input.overwrite === true;
  let { module } = input;
  let selection = planned;
  try {
    const epoch = getStopEpoch();

    // The gate FIRST, and only when the batch half has work (or names only the
    // gate can make visible): the two passes are model calls, and a selection
    // of images-only must not pay for them. The request is the ONE gate rule
    // (`entity-gate.entityGateNeeds`).
    if (selection.detail.length > 0 || selection.overwrites.details.length > 0 || gateFirst) {
      runStep(module.id, 'classifying and normalizing the linked names (a model call)…');
      const gate = await openEntityGate(module.id, epoch, entityGateNeeds(module, input.artifacts));
      report.classified = gate.classified;
      if (gate.stopped) {
        report.stopped = true;
        return report;
      }
      if (!gate.ok) {
        report.refused = gate.refused;
        return report;
      }
      if (gate.classified.length > 0) {
        toastSuccess(
          `${String(gate.classified.length)} new name${gate.classified.length === 1 ? '' : 's'} classified — now generating the selection.`,
        );
      }
      if (gate.normalized || gate.classified.length > 0) {
        // The passes WROTE the row (kinds, canonical link targets): the plan is
        // re-derived from what they recorded, never from the pre-gate snapshot
        // the dialog showed (docs/17 row 414).
        const fresh = await getModule(module.id);
        if (fresh === undefined) throw new Error('The module was deleted while its names were classified');
        module = fresh;
        selection = selectGenerationTargets({
          module,
          artifacts: await loadChatDetailsPool(campaign.id),
          kinds,
          imageKinds,
          levelRange,
          encounterExtras,
          overwrite,
        });
        report.selection = selection;
      }
    }

    // 1) Entity details, one batch per kind, in the domain's stable order.
    const detailCount = selection.detail.length + selection.overwrites.details.length;
    runStep(
      module.id,
      `generating ${String(detailCount)} detail${detailCount === 1 ? '' : 's'} — each batch has its own entry below`,
    );
    for (const kind of orderedDetailKinds(selection)) {
      if (stoppedSince(epoch)) {
        report.stopped = true;
        return report;
      }
      const overwrites = selection.overwrites.details.filter((target) => target.kind === kind);
      // THE OVERWRITE, IN PLACE (docs/17 row 422). A non-encounter row rides the
      // SAME batch as the kind's creations, aimed at its own row (`artifactId`):
      // that is the change seam's entity lane (`changeArtifact` → `runEntityBatch`)
      // without serializing a kind's rows through a one-artifact call. An
      // encounter goes through `changeArtifact` itself (below): its regeneration
      // is one of the encounter's own two operations, never the entity refill.
      const inPlace = kind === 'encounter' ? [] : overwrites;
      const targets = [
        ...targetsOfKind(selection, kind).map((target) => ({ name: target.name })),
        ...inPlace.map((target) => ({ name: target.name, artifactId: target.artifactId })),
      ];
      if (targets.length > 0) {
        const result = await runEntityBatch({ module, campaign, kind, targets });
        const inPlaceIds = new Set(inPlace.map((target) => target.artifactId));
        const regenerated = result.produced.filter((entry) => inPlaceIds.has(entry.artifactId)).length;
        report.generated += result.generated.length - regenerated;
        report.regenerated += regenerated;
        // ONE reporting seam for both surfaces (docs/18 §2.3): the console
        // payload and the toast are raised together, from the same count
        // sentence the entity panel's batch button uses.
        reportEntityBatchFailures({
          module,
          campaign,
          kind,
          total: targets.length,
          failures: result.failed,
        });
        reportEntityBatchNotices({
          module,
          campaign,
          kind,
          total: targets.length,
          notices: result.notices,
        });
      }
      if (kind === 'encounter' && overwrites.length > 0) {
        const outcome = await regenerateEncountersInPlace(overwrites, epoch);
        report.regenerated += outcome.regenerated;
        if (outcome.stopped) {
          report.stopped = true;
          return report;
        }
      }
    }

    // THE RE-DERIVATION (docs/17 row 406). Every image/map/portrait detector
    // asks what EXISTS, and the plan was derived before the detail pass wrote
    // anything — so on a first run (and on every level the chat just wrote)
    // those sets were empty and the enqueue half started nothing. Re-reading the
    // pool HERE is what makes the counts ACTUAL; it is also why the enqueue
    // comes after the batch and never before it (the queues resolve their
    // artifact by name at run time and fail loudly when it is missing, so a
    // name whose detail failed stays the batch's failure to report).
    runStep(module.id, 'queuing images, battlemaps and portraits…');
    const freshArtifacts = await listArtifactsByCampaign(module.campaignId);
    const actual = selectGenerationTargets({
      module,
      artifacts: freshArtifacts,
      kinds,
      imageKinds,
      levelRange,
      encounterExtras,
      overwrite,
    });
    const replacing = actual.overwrites;

    /** ONE line per ticked kind that produced nothing, with its reason. */
    const nameEmpty = (kind: string, reason: string): void => {
      report.notes.push(`${kind} were NOT queued — ${reason}`);
    };

    // A stop that landed during the LAST batch ends the enqueue half too — the
    // per-block checks below cover a stop during this half's own awaits.
    if (stoppedSince(epoch)) {
      report.stopped = true;
      return report;
    }

    // 2) Images — the ACTUAL image targets after the detail pass, plus the
    // covers an overwrite REPLACES (delete-after-replace `regen` jobs).
    if (imageKinds.length > 0) {
      if (actual.images.length === 0 && replacing.images.length === 0) {
        nameEmpty('images', 'no selected entity without an image exists after this run');
      } else {
        const queue = useEntityImageQueue.getState();
        const job = (target: GenerationTarget) => ({
          campaignId: module.campaignId,
          moduleId: module.id,
          name: target.name,
        });
        if (actual.images.length > 0) queue.enqueue(actual.images.map(job));
        if (replacing.images.length > 0) {
          queue.enqueueReplacing(replacing.images.map((target) => ({ ...job(target), regen: true })));
        }
        report.imageJobs = actual.images.length + replacing.images.length;
      }
    }

    // 3) Battlemaps — an EXPLICIT tick, never a side effect of generating an
    // encounter (the automatic trigger this row removes).
    if (encounterExtras.battlemaps) {
      if (actual.maps.length === 0 && replacing.maps.length === 0) {
        nameEmpty('battlemaps', 'no selected encounter needs one');
      } else {
        const queue = useEncounterMapQueue.getState();
        const job = (target: GenerationEncounterTarget) => ({
          campaignId: module.campaignId,
          moduleId: module.id,
          artifactId: target.artifactId,
          name: target.name,
        });
        if (actual.maps.length > 0) queue.enqueue(actual.maps.map(job));
        // An overwrite REDRAWS a mapped encounter: the Cartographer's finalize
        // swaps the map slot (the old map leaves with the fresh one's commit).
        if (replacing.maps.length > 0) {
          queue.enqueueReplacing(replacing.maps.map((target) => ({ ...job(target), regen: true })));
        }
        report.mapJobs = actual.maps.length + replacing.maps.length;
      }
    }

    // 4) Mob portraits — an EXPLICIT tick, BOTH lanes through the ONE seam all
    // three callers share (docs/17 row 96).
    if (encounterExtras.mobPortraits) {
      if (actual.mobPortraits.length === 0 && replacing.mobPortraits.length === 0) {
        nameEmpty('mob portraits', 'no selected encounter has a creature without a portrait');
      } else {
        const failures: string[] = [];
        const republished: string[] = [];
        // The fill for encounters with holes, then the overwrite's replace-all
        // (both lanes, the ONE encounter-level regen seam) for the rest.
        const work = [
          ...actual.mobPortraits.map((target) => ({ target, replace: false })),
          ...replacing.mobPortraits.map((target) => ({ target, replace: true })),
        ];
        for (const { target, replace } of work) {
          if (stoppedSince(epoch)) {
            report.stopped = true;
            break;
          }
          const encounter = selectedNameResolves(target.name, freshArtifacts, module.id);
          if (encounter?.kind !== 'encounter') {
            // The selection said this encounter still needs art, and the row it
            // attaches to cannot be read: a loud per-encounter failure, never a
            // silent skip (AGENTS rule 1).
            failures.push(`"${target.name}" — its encounter row could not be read`);
            continue;
          }
          try {
            if (replace) {
              const replaced = await regenerateEncounterPortraits(encounter, module.campaignId);
              report.portraitJobs += replaced.regenerated + replaced.filled;
              republished.push(...replaced.republishedCanonical);
            } else {
              report.portraitJobs += (
                await enqueueEncounterPortraitFill(encounter, module.campaignId)
              ).enqueued;
            }
          } catch (error) {
            failures.push(`"${target.name}" — ${errorMessage(error)}`);
          }
        }
        if (failures.length > 0) {
          toastError(
            `${String(failures.length)} of ${String(work.length)} encounters ` +
              `failed to enqueue mob portraits (${failures.join('; ')})`,
          );
        }
        if (republished.length > 0) {
          // The shared-slot consequence, said the way the encounter editor says it.
          toastSuccess(
            `Shared portrait republished for ${republished.map((name) => `"${name}"`).join(', ')} — future portraits in every campaign use the new art; existing covers elsewhere keep theirs`,
          );
        }
        // A stop mid-loop must not be reported as "nothing needed a portrait".
        if (report.stopped) return report;
        if (report.portraitJobs === 0) {
          nameEmpty(
            'mob portraits',
            'every creature in the selected encounters already has a portrait',
          );
        }
      }
    }

    const parts = [
      report.generated > 0
        ? `${String(report.generated)} artifact${report.generated === 1 ? '' : 's'} generated`
        : null,
      report.regenerated > 0
        ? `${String(report.regenerated)} detail${report.regenerated === 1 ? '' : 's'} regenerated in place`
        : null,
      report.imageJobs > 0
        ? `${String(report.imageJobs)} image${report.imageJobs === 1 ? '' : 's'} queued`
        : null,
      report.mapJobs > 0
        ? `${String(report.mapJobs)} battlemap${report.mapJobs === 1 ? '' : 's'} queued`
        : null,
      report.portraitJobs > 0
        ? `${String(report.portraitJobs)} mob portrait${report.portraitJobs === 1 ? '' : 's'} queued`
        : null,
    ].filter((part) => part !== null);
    // A ticked kind that produced nothing is NAMED with its reason (docs/17 row
    // 406), so "the dialog just finished" can never again mean "your tick did
    // nothing".
    if (parts.length > 0 || report.notes.length > 0) {
      toastSuccess(`Generation: ${[...parts, ...report.notes].join(', ')}`);
    }
    return report;
  } catch (error) {
    toastError('The generation run failed', error);
    report.refused = errorMessage(error);
    return report;
  }
}

/**
 * The ENCOUNTER half of a detail overwrite (docs/17 row 422): each existing
 * encounter is regenerated IN PLACE through THE change seam
 * (`changeArtifact`, docs/17 row 101) with the encounter's own REPOPULATE
 * operation — a new roster and fresh content on the SAME row, its name, links
 * and battlemap kept (the old content stays restorable from its revisions).
 *
 * WHY NOT "REGENERATE EVERYTHING": that operation also redraws the battlemap —
 * an image the owner did not tick (battlemaps are an explicit tick, docs/17 row
 * 406) — and on a multi-room encounter it leaves the old map in the gallery,
 * the opposite of the owner's "the old one is removed". A ticked battlemap is
 * redrawn by the map queue's own replace job instead. And `redesignProse` stays
 * OFF: it RENAMES the encounter, and the selection finds an encounter's map and
 * portrait work by its name, so a rename would silently detach it.
 *
 * Sequential, with the stop epoch consulted between encounters; a run the owner
 * stopped is withdrawn, never reported as a failure. Every other failure is
 * collected and raised as ONE loud toast (AGENTS rule 2).
 */
async function regenerateEncountersInPlace(
  targets: readonly GenerationOverwriteTarget[],
  epoch: number,
): Promise<{ regenerated: number; stopped: boolean }> {
  let regenerated = 0;
  const failures: string[] = [];
  for (const target of targets) {
    if (stoppedSince(epoch)) return { regenerated, stopped: true };
    try {
      const result = await changeArtifact({
        artifactId: target.artifactId,
        encounter: { operation: 'repopulate' },
      });
      if (result.status === 'changed') regenerated += 1;
      else failures.push(`"${target.name}" — ${result.reason}`);
    } catch (error) {
      if (stoppedSince(epoch)) return { regenerated, stopped: true };
      failures.push(`"${target.name}" — ${errorMessage(error)}`);
    }
  }
  if (failures.length > 0) {
    toastError(
      `${String(failures.length)} of ${String(targets.length)} encounters could not be regenerated (${failures.join('; ')})`,
    );
  }
  return { regenerated, stopped: false };
}
