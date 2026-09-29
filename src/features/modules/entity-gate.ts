import type { AnyArtifact, Id, Module } from '@/domain';
import { moduleCreationPool } from '@/domain';
import { getModule } from '@/db/moduleRepo';
import {
  classifyNewModuleEntityNames,
  normalizeModuleEntityNames,
  unclassifiedModuleNames,
} from '@/llm/moduleGen';
import { stoppedSince } from '@/lib/stopEpoch';
import { toastError } from '@/lib/toast';

/**
 * ============================================================================
 * THE ENTITY-BATCH GATE — the two passes that must run before ANY entity batch
 * can start (docs/17 rows 71/107, fix-01), as ONE unit order (docs/17 row 394).
 *
 * `entityNamesNormalized: false` leaves every entity batch GATED, and a batch
 * called with the gate closed generates nothing — the silent no-op this repo
 * forbids. Two passes open it:
 *
 * 1. the INCREMENTAL CLASSIFICATION pass, because names the text picked up after
 *    the last pass have no recorded kind and are therefore invisible to every
 *    batch (`unclassifiedModuleNames` is the ONE rule for which names those
 *    are);
 * 2. the NAME-NORMALIZATION pass, whose success is the gate itself.
 *
 * The classification pass runs FIRST and only while the gate is open (it refuses
 * otherwise), and each pass is followed by a re-read of the gate — the passes
 * write the row, so a cached boolean would be a guess.
 *
 * WHY THIS IS ITS OWN FILE: three callers now need exactly this order — "Resume
 * automatic module creation" (`features/modules/resume-automation`), the entity
 * panel's own passes, and the level-scoped generation dialog
 * (`features/modules/generation-run`, docs/23 §7). A second copy of the order is
 * a bug waiting at the fourth caller (AGENTS rule 4), so the order lives here.
 * The caller supplies the REQUEST (`entityGateNeeds`), never the order.
 * ============================================================================
 */

/** Which passes the caller's observed state asks for. */
export interface EntityGateRequest {
  /** The text carries names with no recorded kind (the classification pass). */
  classification: boolean;
  /** The batch gate is closed for the current text (the normalization pass). */
  normalization: boolean;
}

/**
 * THE rule for what the gate needs, read from the live module and the artifact
 * pool the batches will use (the module-creation pool, docs/17 row 69). Every
 * caller asks THIS question, so the passes a run performs cannot differ from the
 * passes the surface announced.
 */
export function entityGateNeeds(
  module: Module,
  artifacts: readonly AnyArtifact[],
): EntityGateRequest {
  return {
    classification:
      unclassifiedModuleNames(module, moduleCreationPool(artifacts)).length > 0,
    normalization: !module.entityNamesNormalized,
  };
}

/** What opening the gate did (or why it did not open). */
export interface EntityGateOutcome {
  /** The gate is open: every entity batch may run. */
  ok: boolean;
  /** A concrete reason the gate could not be opened (already toasted). */
  refused: string | null;
  /** Names the classification pass recorded (empty when it did not run). */
  classified: string[];
  /** The normalization pass ran. */
  normalized: boolean;
  /** A Stop all / cancel landed between units: nothing further ran. */
  stopped: boolean;
}

/**
 * Runs the gate's units in the ONE order and re-reads the row after each. A
 * failure is toasted HERE (AGENTS rule 2) and returned as `refused`, so the
 * caller reports the same reason it just showed.
 */
export async function openEntityGate(
  moduleId: Id,
  epoch: number,
  request: EntityGateRequest,
): Promise<EntityGateOutcome> {
  const outcome: EntityGateOutcome = {
    ok: false,
    refused: null,
    classified: [],
    normalized: false,
    stopped: false,
  };
  let gateOpen = (await getModule(moduleId))?.entityNamesNormalized ?? false;

  // Unit 1 — names the text picked up with no recorded kind, so no batch can see
  // them yet. Skipped while the gate is closed: it would refuse, and the
  // normalization pass below records those names anyway.
  if (gateOpen && request.classification) {
    const classified = await classifyNewModuleEntityNames(moduleId);
    outcome.classified = classified.classified;
    if (classified.failed) {
      outcome.refused =
        'The new names in this module could not be classified, so nothing was generated — the entity work stays gated until normalization succeeds (retry it from the entity panel).';
      toastError(outcome.refused);
      return outcome;
    }
    if (stoppedSince(epoch)) {
      outcome.stopped = true;
      return outcome;
    }
    gateOpen = (await getModule(moduleId))?.entityNamesNormalized ?? false;
  }

  // Unit 2 — the gate itself. A pass that still leaves it closed refuses LOUDLY
  // and runs NOTHING: a half-run is the silent no-op this guard exists to
  // prevent.
  if (!gateOpen && request.normalization) {
    await normalizeModuleEntityNames(moduleId);
    outcome.normalized = true;
    gateOpen = (await getModule(moduleId))?.entityNamesNormalized ?? false;
    if (!gateOpen) {
      outcome.refused =
        'Entity name normalization failed, so the entity batches stay gated — nothing was generated. Retry normalization from the entity panel, then generate again.';
      toastError(outcome.refused);
      return outcome;
    }
    if (stoppedSince(epoch)) {
      outcome.stopped = true;
      return outcome;
    }
  }

  outcome.ok = gateOpen;
  return outcome;
}
