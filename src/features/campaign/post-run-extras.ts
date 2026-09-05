/**
 * Ratified: post-run post-create extras — the creation-dialog's ticked
 * extras, executed AFTER the run completes, in the queue layer. A completed
 * run is never reopened or failed by this module: extras ride the shared
 * unattended queues (mob-portrait queue, encounter-map queue) whose
 * failures toast loudly per artifact and never touch the finished run row.
 *
 * Extras executed here:
 * - `image` — one artifact-keyed cover portrait (enqueueArtifactPortrait);
 * - `mobPortraits` — the encounter roster's rulebook-cited creature kinds
 *   (enqueueMobPortraits, the encounter editor's batch action);
 * - `battlemap` — the unattended Cartographer path via the encounter-map
 *   queue (only offered for the content-only encounter persona, whose run
 *   produced no map of its own).
 *
 * The `statBlock` extra is NOT executed here — it is verification-only and
 * runs inside the engine's finalize (a persisted finalize-step notice on
 * statBlock === null; never a fabricated stat block).
 *
 * This module subscribes to run completion ONCE (module scope, imported
 * from main.tsx — no component re-subscribes per run).
 */
import type { Id } from '@/domain';
import { getAnyArtifact } from '@/db/artifactRepo';
import { getRun } from '@/db/runRepo';
import { runEngine } from '@/llm/runEngine';
import {
  enqueueArtifactPortrait,
  enqueueMobPortraits,
} from '@/features/campaign/mob-portrait-queue';
import { useEncounterMapQueue } from '@/features/modules/encounter-map-queue';
import { toastError } from '@/lib/toast';

runEngine.on((event) => {
  if (event.kind !== 'run' || event.status !== 'completed') return;
  void runPostCreateExtras(event.runId).catch((error: unknown) => {
    // The run is already completed and must not be reopened — a loud toast
    // is the visible surface for an extras failure (AGENTS rule 2).
    toastError('Post-creation extras failed', error);
  });
});

async function runPostCreateExtras(runId: Id): Promise<void> {
  const run = await getRun(runId);
  if (run?.runExtras == null || run.resultArtifactId === null) return;
  const artifact = await getAnyArtifact(run.resultArtifactId);
  if (artifact === undefined) {
    throw new Error(`the created artifact ${run.resultArtifactId} no longer exists`);
  }
  if (run.runExtras.image) {
    enqueueArtifactPortrait(artifact, run.campaignId);
  }
  if (run.runExtras.mobPortraits) {
    if (artifact.kind !== 'encounter') {
      throw new Error(`mob portraits need an encounter — "${artifact.name}" is a ${artifact.kind}`);
    }
    await enqueueMobPortraits(artifact, run.campaignId);
  }
  if (run.runExtras.battlemap) {
    if (artifact.kind !== 'encounter') {
      throw new Error(`a battlemap extra needs an encounter — "${artifact.name}" is a ${artifact.kind}`);
    }
    // The map queue's skip guard (layout+map already set) makes this a
    // no-op for an encounter whose run already produced a map.
    useEncounterMapQueue.getState().enqueue([
      {
        campaignId: run.campaignId,
        moduleId: artifact.moduleId,
        artifactId: artifact.id,
        name: artifact.name,
      },
    ]);
  }
}
