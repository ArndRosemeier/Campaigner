import type { Id } from '@/domain';
import { listArtifactsByModule } from '@/db/artifactRepo';
import { getModule } from '@/db/moduleRepo';
import { repopulateEncounter } from '@/features/campaign/encounterRegen';
import { claimModuleGeneration, releaseModuleGeneration } from '@/llm/canvasBusy';
import { errorMessage } from '@/lib/errors';
import { useProgressStore } from '@/lib/progress';
import { getStopEpoch, stoppedSince } from '@/lib/stopEpoch';
import { toastErrorPersistent, toastInfo, toastSuccess } from '@/lib/toast';
import { modulePath } from '@/app/routes';

/**
 * "Restock every encounter" — the module-level sweep (docs/17 row 195, owner
 * request, verbatim: *"Difficulty after creation... this could just use our
 * existing repopulate, right? Just add that difficulty selector from module
 * creation there and we are basically done?"*, scoped by him to *"the
 * difficulty selector beside Repopulate, PLUS a module-level action that
 * restocks every encounter at the new difficulty"*).
 *
 * WHY THIS FILE EXISTS AND WHAT IT DOES NOT DO. Difficulty lives on the module
 * row and the encounter run READS THAT ROW FRESH (`llm/runEngine` resolves the
 * owning module's `difficulty` at run start), so there is no engine path to
 * build here: changing the field and repopulating the encounter is the whole
 * mechanism. What did not exist was a WRITE PATH for the field after creation
 * and a way to apply it to EVERY encounter of a module. This module is that
 * second thing: ONE loop over the module's encounter artifacts that calls the
 * EXISTING orchestration seam (`features/campaign/encounterRegen.repopulateEncounter`,
 * whose header declares it the one orchestration seam and says nothing else
 * starts encounter regeneration runs automatically) once per encounter.
 *
 * THE POLICY, STATED. Repopulate is ROSTER-ONLY: rooms, layout and map are
 * preserved and the module's prose is NOT rewritten. The per-artifact "also
 * redesign name and prose" checkbox remains the one lever for words; the sweep
 * deliberately does not tick it, because difficulty's effect is the FIGHTS,
 * not the words (row 190) and a module-wide prose rewrite is not what
 * "restock" promises.
 *
 * SEQUENTIAL, ONE RUN AT A TIME. Each encounter's run is awaited before the
 * next begins — the loop is not a pool — and the sweep holds the module's
 * shared generation slot (`llm/canvasBusy.claimModuleGeneration`) for its whole
 * duration, so a chat turn, a refine, another change or a second sweep for the
 * same module is refused with the existing loud `ModuleBusyError` instead of
 * racing. That claim is also what makes this box's "one run at a time"
 * discipline structural rather than a comment.
 *
 * STOPPING USES THE EXISTING STOP. There is deliberately no second cancel
 * mechanism here: an in-flight run is stopped by the app's Stop all
 * (`features/progress/stop-all-generations` → `runEngine.cancelAllActive`),
 * which ALSO bumps the app-level stop epoch (`lib/stopEpoch`) before it
 * cancels anything. The sweep captures the epoch at entry and asks
 * `stoppedSince` before each encounter, and it reads the same answer after a
 * run throws — so a stop ends the sweep at the next boundary (or at the
 * cancelled run) and the report says so, while a genuine failure is recorded
 * by name. Exactly the orchestration rule the post-generation sweep, the
 * entity-batch pool and resume-automation follow.
 *
 * FAILURE POLICY: CONTINUE, THEN REPORT EVERY FAILURE BY NAME. One encounter
 * that fails (a transport error, a vanished row, a contract refusal) does not
 * abandon the rest of the module — the owner asked for a module-wide restock,
 * and stopping at the first bad encounter would leave most of it stale for no
 * reason. The price is that a partially restocked module must never LOOK
 * complete, so the end-of-sweep report is loud, persistent and enumerates
 * every failure with its reason (and the pasteable console record keeps the
 * same list past the toast). The alternative — stop on the first failure —
 * was rejected because it trades a recoverable, fully-reported partial result
 * for a guaranteed half-done module.
 *
 * User-invoked only: nothing here runs on render, on open, on a timer or in
 * the background.
 */

/** The stable, greppable prefix of the sweep's pasteable console record. */
export const MODULE_RESTOCK_CONSOLE_TAG = '[campaigner] module-restock summary';

export interface ModuleRestockFailure {
  artifactId: Id;
  /** The encounter's own name, so the report names WHICH one failed. */
  name: string;
  /** The thrown reason, verbatim (`errorMessage`). */
  reason: string;
}

/**
 * What one sweep did. Returned (never only toasted) so a caller — or a test —
 * can branch on the facts instead of parsing the sentence.
 */
export interface ModuleRestockReport {
  moduleId: Id;
  moduleTitle: string;
  /** Every encounter the module owned when the sweep started. */
  total: number;
  /** The ids restocked, in visit order. */
  restocked: Id[];
  /** Every failure, named, in visit order. */
  failed: ModuleRestockFailure[];
  /** A Stop all landed: the sweep ended early and the rest were not touched. */
  stopped: boolean;
}

/**
 * The end-of-sweep surface. It is raised from HERE, not from the button, so a
 * half-restocked module can never look complete even if a future caller
 * ignores the report: an all-green sweep is a success toast, a stop is an
 * honest info toast, and ANY failure is a persistent error naming every failed
 * encounter and its reason, backed by a pasteable console record.
 */
function reportModuleRestock(report: ModuleRestockReport): void {
  const count = (value: number): string => `${String(value)} encounter${value === 1 ? '' : 's'}`;
  if (report.failed.length > 0) {
    const payload = {
      moduleId: report.moduleId,
      module: report.moduleTitle,
      total: report.total,
      restocked: report.restocked.length,
      stopped: report.stopped,
      failed: report.failed,
    };
    // ONE string argument: a devtools-specific preview would land in whatever
    // gets copied (the entity-batch record's own rule).
    console.error(`${MODULE_RESTOCK_CONSOLE_TAG} ${JSON.stringify(payload)}`);
    const stopClause = report.stopped
      ? ` Stopped after ${count(report.restocked.length)}; the rest were not touched.`
      : '';
    toastErrorPersistent(
      `Restocked ${String(report.restocked.length)} of ${count(report.total)} in "${report.moduleTitle}" — ${String(report.failed.length)} failed.${stopClause}`,
      new Error(
        report.failed.map((failure) => `«${failure.name}»: ${failure.reason}`).join('; '),
      ),
    );
    return;
  }
  if (report.stopped) {
    toastInfo(
      `Stopped — restocked ${String(report.restocked.length)} of ${count(report.total)} in "${report.moduleTitle}"; the rest were not touched`,
    );
    return;
  }
  if (report.total === 0) {
    toastInfo(`"${report.moduleTitle}" has no encounters to restock`);
    return;
  }
  toastSuccess(`Restocked all ${count(report.total)} in "${report.moduleTitle}"`);
}

/**
 * Restocks EVERY encounter the module owns at the module's CURRENT recorded
 * difficulty — by repopulating each one, which makes the run read the module
 * row fresh and scale the room budget from it. See the module header for the
 * sequential/stop/failure contract.
 */
export async function restockModuleEncounters(moduleId: Id): Promise<ModuleRestockReport> {
  const module = await getModule(moduleId);
  if (module === undefined) throw new Error('The module no longer exists');
  const encounters = (await listArtifactsByModule(moduleId)).filter(
    (artifact) => artifact.kind === 'encounter',
  );
  const report: ModuleRestockReport = {
    moduleId,
    moduleTitle: module.title,
    total: encounters.length,
    restocked: [],
    failed: [],
    stopped: false,
  };
  if (encounters.length === 0) {
    reportModuleRestock(report);
    return report;
  }

  const job = `module-restock:${moduleId}`;
  const progress = useProgressStore.getState();
  const epoch = getStopEpoch();
  // The existing one-generation-per-module slot, held for the WHOLE sweep:
  // synchronous, before any await, so two sweeps cannot both pass the check.
  claimModuleGeneration(moduleId);
  progress.start(
    job,
    `Restocking ${module.title}`,
    `0 of ${String(encounters.length)}`,
    modulePath(module.campaignId, moduleId),
  );
  try {
    for (const [index, artifact] of encounters.entries()) {
      // "A stopped orchestration must not start its next unit" (lib/stopEpoch).
      if (stoppedSince(epoch)) {
        report.stopped = true;
        break;
      }
      progress.update(job, {
        detail: `${artifact.name} — ${String(index + 1)} of ${String(encounters.length)}`,
        progress: index / encounters.length,
      });
      try {
        // THE existing seam, one run at a time. Repopulate is roster-only and
        // never redesigns prose (the per-artifact checkbox owns words).
        await repopulateEncounter(artifact.id, { redesignProse: false });
        report.restocked.push(artifact.id);
      } catch (error) {
        // A cancelled run is the owner's Stop, not a failure (the epoch is the
        // authority — never string-matching the run's terminal status).
        if (stoppedSince(epoch)) {
          report.stopped = true;
          break;
        }
        report.failed.push({
          artifactId: artifact.id,
          name: artifact.name,
          reason: errorMessage(error),
        });
      }
    }
    progress.update(job, {
      detail: `${String(report.restocked.length)} of ${String(encounters.length)} restocked`,
      progress: 1,
    });
    reportModuleRestock(report);
    return report;
  } finally {
    releaseModuleGeneration(moduleId);
    progress.finish(job);
  }
}
