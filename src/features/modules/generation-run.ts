import type { AnyArtifact, Campaign, EntityKind, Module } from '@/domain';
import { ENTITY_KINDS } from '@/domain';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { enqueueEncounterPortraitFill } from '@/features/campaign/mob-portrait-queue';
import { useEncounterMapQueue } from '@/features/modules/encounter-map-queue';
import { useEntityImageQueue } from '@/features/modules/entity-image-queue';
import { entityGateNeeds, openEntityGate } from '@/features/modules/entity-gate';
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
  type GenerationSelection,
  type GenerationTarget,
} from '@/features/modules/generation-selection';
import { moduleGenLockName, withGenerationLock } from '@/lib/generationLocks';
import { errorMessage } from '@/lib/errors';
import { getStopEpoch, stoppedSince } from '@/lib/stopEpoch';
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
 * EVERYTHING IS ADDITIVE AND IDEMPOTENT, because the underlying seams already
 * are: a batch targets only names with no authored detail of their own, the
 * image queue skips entities that already carry an image, the map queue skips
 * encounters that already carry a map, and the portrait fill enumerates away
 * kinds that already carry art. Re-running a selection can never double-generate
 * and never overwrites an existing artifact.
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
}

/** What one run did (the dialog reports it; the queues carry their own progress). */
export interface GenerationRunReport {
  /** The exact scope that ran (the dialog's own derivation). */
  selection: GenerationSelection;
  /** Entities the batches produced an artifact for. */
  generated: number;
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
  const kinds = new Set(selection.detail.map((target) => target.kind));
  return ENTITY_KINDS.filter((kind) => kinds.has(kind));
}

/** Names of one kind, in the selection's own order. */
function targetsOfKind(selection: GenerationSelection, kind: EntityKind): GenerationTarget[] {
  return selection.detail.filter((target) => target.kind === kind);
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
  const selection = selectGenerationTargets({
    module,
    artifacts,
    kinds,
    imageKinds,
    levelRange,
    encounterExtras,
  });
  const report: GenerationRunReport = {
    selection,
    generated: 0,
    imageJobs: 0,
    mapJobs: 0,
    portraitJobs: 0,
    refused: null,
    classified: [],
    stopped: false,
    notes: [],
  };
  if (selection.totalCount === 0) return report;

  // The module's Web Lock is held for the whole run (docs/17 row 110): the
  // batches plus the enqueues are the app's longest-lived orchestration and a
  // held lock is one of Chromium's documented freeze opt-outs.
  return withGenerationLock(moduleGenLockName(module.id), () =>
    runSelectionUnlocked(input, selection, report),
  );
}

async function runSelectionUnlocked(
  input: GenerationRunInput,
  selection: GenerationSelection,
  report: GenerationRunReport,
): Promise<GenerationRunReport> {
  const { module, campaign, artifacts, kinds, imageKinds, levelRange, encounterExtras } = input;
  try {
    const epoch = getStopEpoch();

    // The gate FIRST, and only when the batch half has work: the two passes are
    // model calls, and a selection of images-only must not pay for them. The
    // request is the ONE gate rule (`entity-gate.entityGateNeeds`).
    if (selection.detail.length > 0) {
      const gate = await openEntityGate(module.id, epoch, entityGateNeeds(module, artifacts));
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
    }

    // 1) Entity details, one batch per kind, in the domain's stable order.
    for (const kind of orderedDetailKinds(selection)) {
      if (stoppedSince(epoch)) {
        report.stopped = true;
        return report;
      }
      const targets = targetsOfKind(selection, kind);
      if (targets.length === 0) continue;
      const result = await runEntityBatch({
        module,
        campaign,
        kind,
        targets: targets.map((target) => ({ name: target.name })),
      });
      report.generated += result.generated.length;
      // ONE reporting seam for both surfaces (docs/18 §2.3): the console payload
      // and the toast are raised together, from the same count sentence the
      // entity panel's batch button uses.
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

    // THE RE-DERIVATION (docs/17 row 406). Every image/map/portrait detector
    // asks what EXISTS, and the plan was derived before the detail pass wrote
    // anything — so on a first run (and on every level the chat just wrote)
    // those sets were empty and the enqueue half started nothing. Re-reading the
    // pool HERE is what makes the counts ACTUAL; it is also why the enqueue
    // comes after the batch and never before it (the queues resolve their
    // artifact by name at run time and fail loudly when it is missing, so a
    // name whose detail failed stays the batch's failure to report).
    const freshArtifacts = await listArtifactsByCampaign(module.campaignId);
    const actual = selectGenerationTargets({
      module,
      artifacts: freshArtifacts,
      kinds,
      imageKinds,
      levelRange,
      encounterExtras,
    });

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

    // 2) Images — the ACTUAL image targets after the detail pass.
    if (imageKinds.length > 0) {
      if (actual.images.length === 0) {
        nameEmpty('images', 'no selected entity without an image exists after this run');
      } else {
        useEntityImageQueue.getState().enqueue(
          actual.images.map((target) => ({
            campaignId: module.campaignId,
            moduleId: module.id,
            name: target.name,
          })),
        );
        report.imageJobs = actual.images.length;
      }
    }

    // 3) Battlemaps — an EXPLICIT tick, never a side effect of generating an
    // encounter (the automatic trigger this row removes).
    if (encounterExtras.battlemaps) {
      if (actual.maps.length === 0) {
        nameEmpty('battlemaps', 'no selected encounter needs one');
      } else {
        useEncounterMapQueue.getState().enqueue(
          actual.maps.map((target) => ({
            campaignId: module.campaignId,
            moduleId: module.id,
            artifactId: target.artifactId,
            name: target.name,
          })),
        );
        report.mapJobs = actual.maps.length;
      }
    }

    // 4) Mob portraits — an EXPLICIT tick, BOTH lanes through the ONE seam all
    // three callers share (docs/17 row 96).
    if (encounterExtras.mobPortraits) {
      if (actual.mobPortraits.length === 0) {
        nameEmpty('mob portraits', 'no selected encounter has a creature without a portrait');
      } else {
        const failures: string[] = [];
        for (const target of actual.mobPortraits) {
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
            report.portraitJobs += (
              await enqueueEncounterPortraitFill(encounter, module.campaignId)
            ).enqueued;
          } catch (error) {
            failures.push(`"${target.name}" — ${errorMessage(error)}`);
          }
        }
        if (failures.length > 0) {
          toastError(
            `${String(failures.length)} of ${String(actual.mobPortraits.length)} encounters ` +
              `failed to enqueue mob portraits (${failures.join('; ')})`,
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
