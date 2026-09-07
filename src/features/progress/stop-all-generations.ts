import { listCampaigns } from '@/db/campaignRepo';
import { listModulesByCampaign } from '@/db/moduleRepo';
import { chainRunner } from '@/llm/chainRunner';
import { cancelModuleGen } from '@/llm/moduleGen';
import { runEngine } from '@/llm/runEngine';
import { useMobPortraitQueue } from '@/features/campaign/mob-portrait-queue';
import { useEntityImageQueue } from '@/features/modules/entity-image-queue';
import { useEncounterMapQueue } from '@/features/modules/encounter-map-queue';
import { toastInfo, toastSuccess } from '@/lib/toast';

/**
 * Stop-all generations (owner request: "a button to stop all ongoing
 * generations") — the ONE sweep over every generation surface, wired to the
 * ProgressDock's "Stop all" button. Stopping is NOT destructive: queue jobs
 * settle 'cancelled' silently, runs are marked 'cancelled' (resumable, same
 * semantics as the per-run Stop), a cancelled spine-only module rewinds to
 * 'draft', a cancelled chain ends as 'cancelled' — nothing is deleted.
 *
 * It lives in features/progress (NOT lib) because the three job queues are
 * feature-level stores and the layer map forbids lib → features imports;
 * cross-feature imports are the established pattern (post-run-extras).
 *
 * What "all generations" covers, and what it deliberately does not:
 * - the three job queues (mob portraits, entity images, encounter maps) —
 *   cancelAll reuses the per-job dequeue semantics, so a withdrawn map job
 *   still cancels its unattended run through the queue's own
 *   `runEngine.cancel` wiring;
 * - every IN-FLIGHT run-engine run (solo runs, Writers'-Room chain steps,
 *   entity-batch runs) via the engine's controller registry — PAUSED runs
 *   (awaiting_user / needs_review) are not generating and are left alone;
 * - an active Writers' Room chain (the cancel flag ends it at the next step
 *   boundary; its in-flight step run is swept with the runs above);
 * - a module forge mid-spine/mid-parts (`cancelModuleGen` for every module
 *   row whose persisted status is 'generating').
 * NOT covered (not generations, no cancel seam): PDF builds and backup
 * jobs — their dock entries keep running.
 *
 * The returned count is the number of DISTINCT stopped units — a map job and
 * its underlying run count once (the queues are drained BEFORE the run sweep,
 * and `cancelAll` resolves only after the aborted jobs — and their abort
 * reactions — have settled, so the map runs are already out of the engine
 * registry when the sweep snapshots it).
 */
export async function stopAllGenerations(): Promise<{ stopped: number }> {
  // The chain flag goes down FIRST so the chain cannot start its next step
  // while the sweep below runs (its in-flight step run, if any, is swept by
  // the run-engine pass — the chain itself then only counts when no run of
  // its steps was stopped, e.g. a chain caught between steps).
  const chainState = chainRunner.getState();
  const chainRunIds = chainState.steps
    .map((step) => step.runId)
    .filter((id): id is NonNullable<typeof id> => id !== null);
  const chainWasRunning = chainState.status === 'running';
  if (chainWasRunning) chainRunner.cancel();

  // Queues first (see the count note above): aborting a job's signal makes
  // its body cancel its own run and settle silently — never a 'failed' toast
  // for a job the user just stopped.
  const [mobJobs, entityJobs, mapJobs] = await Promise.all([
    useMobPortraitQueue.getState().cancelAll(),
    useEntityImageQueue.getState().cancelAll(),
    useEncounterMapQueue.getState().cancelAll(),
  ]);

  const cancelledRunIds = await runEngine.cancelAllActive();

  // The module row's persisted status is the truth about a forge in flight
  // ('generating' from spine start until the pass settles); cancelModuleGen
  // is a no-op for a row without a live controller.
  let moduleForges = 0;
  for (const campaign of await listCampaigns()) {
    for (const module of await listModulesByCampaign(campaign.id)) {
      if (module.status !== 'generating') continue;
      cancelModuleGen(module.id);
      moduleForges += 1;
    }
  }

  const chainStopped =
    chainWasRunning && !chainRunIds.some((id) => cancelledRunIds.includes(id)) ? 1 : 0;

  const stopped = mobJobs + entityJobs + mapJobs + cancelledRunIds.length + moduleForges + chainStopped;
  if (stopped === 0) {
    toastInfo('Nothing was running');
  } else {
    toastSuccess(`Stopped ${String(stopped)} generation${stopped === 1 ? '' : 's'}`);
  }
  return { stopped };
}
