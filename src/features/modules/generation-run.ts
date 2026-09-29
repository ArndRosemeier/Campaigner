import type { AnyArtifact, Campaign, EntityKind, Module } from '@/domain';
import { ENTITY_KINDS } from '@/domain';
import { getSettings } from '@/db/settingsRepo';
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
 * unit works from that same value — so what the dialog announced is exactly what
 * runs, and a document edited between the announcement and the press can only
 * ever be generated as it was announced. The dialog's own count and this run's
 * plan are the same derivation (`selectGenerationTargets`).
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

/** The explicit encounter extras — OFF unless the dialog's checkboxes say so. */
export interface EncounterExtras {
  battlemaps: boolean;
  mobPortraits: boolean;
}

/** What the dialog asks a run to do. */
export interface GenerationRunInput {
  module: Module;
  campaign: Campaign;
  artifacts: readonly AnyArtifact[];
  kinds: readonly GenerationKind[];
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
  const { module, artifacts, kinds, levelRange } = input;
  const selection = selectGenerationTargets({ module, artifacts, kinds, levelRange });
  const report: GenerationRunReport = {
    selection,
    generated: 0,
    imageJobs: 0,
    mapJobs: 0,
    portraitJobs: 0,
    refused: null,
    classified: [],
    stopped: false,
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
  const { module, campaign, artifacts, encounterExtras } = input;
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

    const settings = await getSettings();

    // 2) Images — the selection's own image targets (the queue's verdict).
    if (selection.images.length > 0) {
      if (stoppedSince(epoch)) {
        report.stopped = true;
        return report;
      }
      if (!settings.imagesEnabled) {
        toastError(
          'Images were not requested — image generation is disabled in Settings',
        );
      } else {
        useEntityImageQueue.getState().enqueue(
          selection.images.map((target) => ({
            campaignId: module.campaignId,
            moduleId: module.id,
            name: target.name,
          })),
        );
        report.imageJobs = selection.images.length;
      }
    }

    // 3) Battlemaps — an EXPLICIT tick, never a side effect of generating an
    // encounter (the automatic trigger this row removes).
    if (encounterExtras.battlemaps && selection.maps.length > 0) {
      if (stoppedSince(epoch)) {
        report.stopped = true;
        return report;
      }
      if (!settings.imagesEnabled) {
        toastError(
          'Battlemaps were not requested — image generation is disabled in Settings',
        );
      } else {
        useEncounterMapQueue.getState().enqueue(
          selection.maps.map((target) => ({
            campaignId: module.campaignId,
            moduleId: module.id,
            artifactId: target.artifactId,
            name: target.name,
          })),
        );
        report.mapJobs = selection.maps.length;
      }
    }

    // 4) Mob portraits — an EXPLICIT tick, BOTH lanes through the ONE seam all
    // three callers share (docs/17 row 96).
    if (encounterExtras.mobPortraits && selection.mobPortraits.length > 0) {
      const failures: string[] = [];
      for (const target of selection.mobPortraits) {
        if (stoppedSince(epoch)) {
          report.stopped = true;
          break;
        }
        const encounter = selectedNameResolves(target.name, artifacts, module.id);
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
          `${String(failures.length)} of ${String(selection.mobPortraits.length)} encounters ` +
            `failed to enqueue mob portraits (${failures.join('; ')})`,
        );
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
    if (parts.length > 0) {
      toastSuccess(`Generation: ${parts.join(', ')}`);
    }
    return report;
  } catch (error) {
    toastError('The generation run failed', error);
    report.refused = errorMessage(error);
    return report;
  }
}
