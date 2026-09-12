import type { Campaign, Id, ModuleAutomationIntent } from '@/domain';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { presentationArtOfCampaign } from '@/features/campaign/mob-portrait-participants';
import { getModule } from '@/db/moduleRepo';
import { classifyNewModuleEntityNames, normalizeModuleEntityNames } from '@/llm/moduleGen';
import { getStopEpoch, stoppedSince } from '@/lib/stopEpoch';
import { toastError, toastSuccess } from '@/lib/toast';
import {
  automationIntentDrift,
  deriveAutomationDeviation,
  deviationIsEmpty,
} from '@/features/modules/automation-deviation';
import { FULL_AUTOMATION_TARGET, runModulePostGeneration } from '@/features/modules/post-generation';

/**
 * "Resume automatic module creation" — the ONE user-invoked resume of what
 * creation was asked to automate (owner intent, verbatim: **"Resume automatic
 * module creation"**; mechanism, verbatim: **"this way this can also be used
 * after edits."**) — and, through the same seam, the entity sidebar's
 * "Generate everything" (owner request, verbatim: **"In the entities sidebar i
 * would like to have a button 'generate everything' that just fills all
 * generation gaps. All entity details, all images, encounters, maps in
 * encounters... everything thats missing. Same way as its triggered in module
 * generation."**, docs/17 row 80).
 *
 * ONE PIPELINE, TWO TARGETS. The target state is either the module row's
 * RECORDED `automationIntent` (the canvas control) or an EXPLICIT target the
 * caller supplies (the sidebar control passes `FULL_AUTOMATION_TARGET`: every
 * entity kind for details and images, battle maps and mob portraits on). The
 * deviation is DERIVED at entry from the live state against that same target
 * (`deriveAutomationDeviation`) — nothing about it is stored, so a hand-edited
 * artifact, a hand-deleted image or a hand-added name is simply part of what the
 * next resume sees.
 *
 * The two controls are one implementation on purpose: a second sweep would
 * duplicate the unit order, the gates and the additive guarantees, and the two
 * would drift. The only difference is where the target comes from — and,
 * consequently, which preconditions apply (see `runResume`).
 *
 * ADDITIVE BY CONSTRUCTION. The work itself is the existing sweep
 * (`runModulePostGeneration`), whose every step already targets only what is
 * missing: batches take unresolved names, the image queue skips entities that
 * already have an image, the map queue skips encounters that already carry one,
 * the portrait batch skips mobs that already have a portrait. This module never
 * re-generates, re-details or overwrites an existing artifact or image, and it
 * never touches the module's prose — the text half belongs to "Fix module
 * problems".
 *
 * NOT A SECOND PIPELINE. The two passes it may run first are the EXISTING ones
 * and they run for a concrete reason, not as ceremony:
 * - the incremental CLASSIFICATION pass, because names the text picked up after
 *   the last pass have no recorded kind and are therefore invisible to every
 *   batch (`unclassifiedModuleNames` observed them) — append-only records, the
 *   same machinery the entity panel's button uses;
 * - the NAME-NORMALIZATION pass, because `entityNamesNormalized: false` leaves
 *   the entity batches GATED, and a sweep called with the gate closed would
 *   silently generate nothing (a silent no-op is exactly what this repo
 *   forbids). If that pass still fails, the resume refuses LOUDLY and runs
 *   nothing rather than half-running.
 *
 * STOP EPOCH. A resume is a NEW user action, so it captures the epoch at entry
 * (`getStopEpoch`) and asks `stoppedSince` before each unit — classification,
 * normalization, then the sweep. "Stop all" during a resume therefore ends it:
 * a stopped orchestration must not start its next unit. The sweep keeps its own
 * entry capture too, so a stop landing mid-sweep stops the sweep's next kind or
 * enqueue block.
 *
 * User-invoked only: nothing here runs on render, on open, on a timer, or in the
 * background.
 */

/** What one resume did (and what it deliberately did not do). */
export interface ResumeReport {
  /** Nothing was missing (or no intent was recorded): no call, no write, no job. */
  empty: boolean;
  /** A concrete reason nothing ran — the caller surfaces it (loud, never silent). */
  refused: string | null;
  /** Names the classification pass recorded (empty when it was not needed). */
  classified: string[];
  /** The normalization pass ran (the gate was closed at entry). */
  normalized: boolean;
  /** The post-generation sweep ran (it never awaits its queues). */
  swept: boolean;
  /** A Stop all / cancel landed between units: the resume stopped where it was. */
  stopped: boolean;
}

/** The empty report (a resume that had nothing to do). */
function nothingToDo(): ResumeReport {
  return {
    empty: true,
    refused: null,
    classified: [],
    normalized: false,
    swept: false,
    stopped: false,
  };
}

/**
 * Runs the resume pipeline against one target: the classification pass when the
 * text carries unrecorded names, the normalization pass when the batch gate is
 * closed, then the sweep — the SAME units in the SAME order for both callers.
 *
 * Which preconditions apply depends on where the target came from, and each
 * difference is stated where it is decided:
 * - no explicit target (the canvas): the recorded intent is the target, so the
 *   legacy-row refusal and the drift refusal both apply exactly as before;
 * - an explicit target (the sidebar): neither applies. The legacy refusal is the
 *   dead end this control exists to close, and `automationIntentDrift` guards the
 *   OLD design — where the confirmation described the recorded intent while the
 *   sweep read the row's own fields, so a divergence meant running work the
 *   confirmation never described. With the target passed to the sweep itself,
 *   nothing depends on those row fields and there is nothing to drift from.
 *
 * The module's status gate is NOT parameterized: a module whose parts pass did
 * not finish has nothing to automate, whichever target is asked for.
 */
async function runResume(
  moduleId: Id,
  campaign: Campaign,
  target: ModuleAutomationIntent | undefined,
): Promise<ResumeReport> {
  const module = await getModule(moduleId);
  if (module === undefined) throw new Error('The module no longer exists');
  if (target === undefined) {
    // The confirmation described the RECORDED intent; the sweep reads the row's
    // own automation fields. Nothing in the app writes them apart, so a
    // divergence means neither can be trusted as the owner's wish — refuse
    // loudly.
    const drift = automationIntentDrift(module);
    if (drift !== null) {
      toastError(drift);
      return { empty: false, refused: drift, classified: [], normalized: false, swept: false, stopped: false };
    }
    if (module.automationIntent === null) {
      // Legacy row (written before the field): intent may never be inferred from
      // what the engine did (docs/17 row 71), so there is nothing to resume. The
      // remedy is the entity sidebar's target-explicit control (docs/17 row 80),
      // which is a full fill rather than an inference.
      const reason =
        'This module has no recorded automation intent (it was created before the setting existed), so there is nothing to resume — use "Generate everything" in the entity sidebar to fill all generation gaps.';
      return { empty: true, refused: reason, classified: [], normalized: false, swept: false, stopped: false };
    }
  }

  const deviation = deriveAutomationDeviation(
    module,
    await listArtifactsByCampaign(campaign.id),
    target,
    // The async flow can read the presentation rows outright, so the resume
    // decision and the batch it triggers see the same portraits.
    await presentationArtOfCampaign(campaign.id),
  );
  // Nothing missing: no call, no write, no enqueue — a no-op with no side
  // effects (the control is hidden in this state anyway).
  if (deviationIsEmpty(deviation)) {
    return nothingToDo();
  }

  if (module.status !== 'ready') {
    const reason =
      module.status === 'failed'
        ? `This module's parts pass did not finish (status: failed — ${module.errorMessage === '' ? 'see the module row' : module.errorMessage}). Fix the text first ("Fix module problems" or a hand edit), then generate again.`
        : `This module is not ready to finish (status: ${module.status}) — its parts pass has not completed, so there is nothing to automate yet.`;
    toastError(reason);
    return { empty: false, refused: reason, classified: [], normalized: false, swept: false, stopped: false };
  }

  const epoch = getStopEpoch();
  const report: ResumeReport = {
    empty: false,
    refused: null,
    classified: [],
    normalized: false,
    swept: false,
    stopped: false,
  };
  let gateOpen = module.entityNamesNormalized;

  // Unit 1 — names the text picked up with no recorded kind, so no batch can see
  // them yet: the existing incremental classification pass (append-only records,
  // the same machinery the entity panel's button uses). It is skipped while the
  // gate is closed, because it would refuse — and the full pass below records
  // those names anyway.
  if (gateOpen && deviation.unclassified.length > 0) {
    const classified = await classifyNewModuleEntityNames(moduleId);
    report.classified = classified.classified;
    if (classified.failed) {
      const reason =
        'The new names in this module could not be classified, so nothing was generated — the entity work stays gated until normalization succeeds (retry it from the entity panel).';
      toastError(reason);
      report.refused = reason;
      return report;
    }
    if (stoppedSince(epoch)) {
      report.stopped = true;
      return report;
    }
    gateOpen = (await getModule(moduleId))?.entityNamesNormalized ?? false;
  }

  // Unit 2 — `entityNamesNormalized: false` leaves EVERY entity batch gated, and
  // a sweep called with the gate closed would quietly generate nothing. Run the
  // existing pass; if it still fails, refuse loudly and run NOTHING (a half-run
  // would be the silent no-op this guard exists to prevent).
  if (!gateOpen && deviation.normalizationPending) {
    await normalizeModuleEntityNames(moduleId);
    report.normalized = true;
    gateOpen = (await getModule(moduleId))?.entityNamesNormalized ?? false;
    if (!gateOpen) {
      const reason =
        'Entity name normalization failed, so the entity batches stay gated — nothing was generated. Retry normalization from the entity panel, then generate again.';
      toastError(reason);
      report.refused = reason;
      return report;
    }
    if (stoppedSince(epoch)) {
      report.stopped = true;
      return report;
    }
  }

  // Unit 3 — the sweep, with the SAME target the deviation was derived against
  // (the row's fields when the caller named no target — they are equal to the
  // recorded intent by the drift check above). It carries the progress dock, the
  // per-job loud failures and its own entry epoch (so a stop landing mid-sweep
  // ends its next kind or enqueue block). It never awaits the queues it fills.
  if (stoppedSince(epoch)) {
    report.stopped = true;
    return report;
  }
  if (report.classified.length > 0) {
    toastSuccess(
      `${String(report.classified.length)} new name${report.classified.length === 1 ? '' : 's'} classified — now generating only what is missing.`,
    );
  } else if (report.normalized) {
    toastSuccess('Entity names normalized — now generating only what is missing.');
  }
  await runModulePostGeneration(moduleId, campaign, target);
  report.swept = true;
  return report;
}

/**
 * Resumes automatic module creation for one module: generates ONLY what the
 * recorded intent asked for and the module does not have yet. Thin caller of the
 * shared pipeline — the recorded intent is the target, so the drift and
 * legacy-row preconditions apply exactly as they always have.
 */
export async function resumeModuleAutomation(
  moduleId: Id,
  campaign: Campaign,
): Promise<ResumeReport> {
  return runResume(moduleId, campaign, undefined);
}

/**
 * "Generate everything" (docs/17 row 80): fills EVERY generation gap of a
 * module — entity details for every kind, their images, encounter battle maps
 * and encounter mob portraits — through the SAME pipeline, the SAME sweep and
 * the SAME detectors as the resume above, with the FULL target instead of the
 * recorded intent. This is why a module created before `automationIntent`
 * existed (which the intent-bound resume refuses) is served fully here.
 *
 * The recorded intent and the row's own automation fields are never written:
 * they stay the record of what the owner asked creation to automate.
 *
 * The module's TEXT is never rewritten, no scene is added and no fight is
 * fabricated: this fills artifacts derived from text that already exists.
 */
export async function resumeEverything(moduleId: Id, campaign: Campaign): Promise<ResumeReport> {
  return runResume(moduleId, campaign, FULL_AUTOMATION_TARGET);
}
