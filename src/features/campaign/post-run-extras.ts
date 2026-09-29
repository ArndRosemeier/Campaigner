/**
 * Post-run post-create work — executed AFTER a run completes, in the queue
 * layer. A completed run is never reopened or failed by this module: everything
 * rides the shared unattended queues (mob-portrait queue, encounter-map queue)
 * whose failures toast loudly per artifact and never touch the finished run row.
 *
 * WHAT RUNS HERE NOW, AND WHAT DELIBERATELY DOES NOT (docs/23 §8, docs/17 row
 * 394). This module used to be the app's SECOND automatic trigger: EVERY run
 * that freshly created an encounter got a battlemap enqueued, and EVERY run that
 * landed a roster on an existing encounter got its mob portraits filled — with
 * the entity batch and the module sweep feeding it, so a generation the owner
 * asked for could quietly start three more kinds of work.
 *
 * **"No automatism" is the owner's rule**, so those two automatic paths are
 * GONE. The battlemap and the portraits are now EXPLICIT choices in the
 * level-scoped generation dialog (`features/modules/generation-dialog`), which
 * states its scope before it runs. What remains here is the run's OWN ticked
 * extras — `run.runExtras.image` / `run.runExtras.mobPortraits`, the persona
 * panel's checkboxes for THIS run — which are a choice the owner made, not a
 * pass the app starts by itself.
 *
 * The `statBlock` extra is NOT executed here — it is verification-only and runs
 * inside the engine's finalize (a persisted finalize-step notice on statBlock
 * === null; never a fabricated stat block).
 *
 * This module subscribes to run completion ONCE (module scope, imported from
 * main.tsx — no component re-subscribes per run).
 *
 * A STOP still wins over the subscription (owner report: "Stop all should stop
 * all generations, but it only stops the current type loop"): a run that was
 * ALREADY completing when the sweep snapshotted the engine registry still lands
 * here as `completed`, and enqueueing its extras after the user pressed Stop all
 * would start fresh queue work the stop supposedly ended (a queue's `cancelAll`
 * exits its pump, but any later `enqueue` starts a new one). The epoch is
 * captured when the completion arrives and consulted before the enqueue, so a
 * post-stop completion enqueues nothing — the run row itself is untouched and
 * stays exactly as completed as the engine left it.
 */
import type { AnyArtifact, Id } from '@/domain';
import { getAnyArtifact } from '@/db/artifactRepo';
import { getRun } from '@/db/runRepo';
import { runEngine } from '@/llm/runEngine';
import {
  enqueueArtifactPortrait,
  enqueueEncounterPortraitFill,
} from '@/features/campaign/mob-portrait-queue';
import { getStopEpoch, stoppedSince } from '@/lib/stopEpoch';
import { toastError } from '@/lib/toast';

runEngine.on((event) => {
  if (event.kind !== 'run' || event.status !== 'completed') return;
  void runPostCreateExtras(event.runId).catch((error: unknown) => {
    // The run is already completed and must not be reopened — a loud toast
    // is the visible surface for an extras failure (AGENTS rule 2).
    toastError('Post-creation extras failed', error);
  });
});

/**
 * The run's OWN ticked extras, and nothing else. `runExtras` is what the persona
 * panel recorded for THIS run (docs/17 row 71's "an explicit choice" rule); a
 * run without extras — every entity-batch run — enqueues nothing at all.
 */
async function runPostCreateExtras(runId: Id): Promise<void> {
  // The epoch of the completion we are reacting to. A stop that landed while
  // this run was finishing (or while the reads below were in flight) means
  // the user asked for no more generation — nothing here enqueues.
  const epoch = getStopEpoch();
  const run = await getRun(runId);
  if (run === undefined) return;
  if (run.runExtras === null) return;
  const artifact: AnyArtifact | undefined =
    run.resultArtifactId === null ? undefined : await getAnyArtifact(run.resultArtifactId);
  if (artifact === undefined) return;
  if (stoppedSince(epoch)) return;
  if (run.runExtras.image) {
    enqueueArtifactPortrait(artifact, run.campaignId);
  }
  if (run.runExtras.mobPortraits) {
    if (artifact.kind !== 'encounter') {
      throw new Error(`mob portraits need an encounter — "${artifact.name}" is a ${artifact.kind}`);
    }
    // BOTH lanes, exactly like the encounter editor's batch press (the same
    // press the owner uses by hand): chunk-backed creature kinds share the
    // bestiary portrait, and every other roster participant — an inline entry,
    // or the `npc-ref` monster the assertion rule's collision path materialized
    // for a creature the prose staged (docs/17 row 90) — gets its own local
    // one. The run's own extra is the owner's explicit choice, so it never
    // consults any module switch (none exists any more).
    await enqueueEncounterPortraitFill(artifact, run.campaignId);
  }
}
