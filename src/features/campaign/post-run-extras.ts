/**
 * Ratified: post-run post-create work — executed AFTER a run completes, in
 * the queue layer. A completed run is never reopened or failed by this
 * module: everything rides the shared unattended queues (mob-portrait queue,
 * encounter-map queue) whose failures toast loudly per artifact and never
 * touch the finished run row.
 *
 * Executed here:
 * - **Automatic battlemap** (owner request: "when automating encounters,
 *   battlemap creation should run automatically with defaults") — EVERY run
 *   that freshly CREATED an encounter artifact (Encounter Smith via the
 *   persona panel, the entity batch, module post-generation) gets its map
 *   enqueued on the unattended encounter-map queue, with the D10 preset
 *   resolved through the encounter's own locationKind chain. Skipped when
 *   the run was a REGENERATION (targetArtifactId — an existing map is
 *   preserved; a new map stays an explicit user action and regeneration
 *   replaces room keys, the ratified consequence), when the persona makes
 *   its own map in-run (Cartographer), when the encounter already carries a
 *   map or has a queued/active map job (the no-double-work guard), or when
 *   the owning module switched its "Generate encounter battlemaps" master
 *   switch off (the module dialog toggle is that switch; campaign-level
 *   encounters have no module to ask). Image generation disabled in
 *   Settings is NOT pre-checked here — the job runs and fails loudly per
 *   artifact through the queue (the mob-portrait precedent), never silently
 *   dropped.
 * - `image` — one artifact-keyed cover portrait (enqueueArtifactPortrait);
 * - `mobPortraits` — the encounter roster's creature kinds, BOTH lanes
 *   (`enqueueMobPortraits` for chunk-backed creatures + the shared bestiary
 *   portrait, `enqueueInventedCreaturePortraits` for every other participant
 *   incl. materialized `npc-ref` monsters), i.e. exactly what the encounter
 *   editor's own batch press does, through the ONE seam all three callers
 *   share (`mob-portrait-queue.enqueueEncounterPortraitFill`).
 * - **Automatic roster portraits** (docs/17 row 196, owner report) — EVERY
 *   completed run that LANDS a roster on an existing ENCOUNTER (its result
 *   artifact is an encounter and it carried a `targetArtifactId`: the
 *   creation-time Cartographer restock, "Repopulate", "Regenerate everything")
 *   re-reads the row it just wrote and runs the same two lanes over it. This
 *   is the missing trigger that produced the owner's report: the module sweep
 *   had illustrated the Encounter Smith's STUB roster and the Cartographer
 *   restock then REPLACED it, so the creatures that only exist afterwards were
 *   never enqueued — while the editor button, which reads the live row,
 *   worked. Gated by the owning module's "Generate mob encounter images"
 *   switch (a campaign-level encounter has no module switch and is left to the
 *   editor / the ticked extra) and by Settings' image generation through the
 *   existing loud-skip pattern; the shared enumeration decides what is
 *   missing, so a kind that already carries art is never re-enqueued and the
 *   regen paths are never touched (no portrait is ever replaced by this
 *   path).
 *
 * The `battlemap` extra is GONE — the automatic path above replaced it (the
 * extra was unticked-by-default and one-off, exactly the manual trigger the
 * owner asked to remove). The `statBlock` extra is NOT executed here — it
 * is verification-only and runs inside the engine's finalize (a persisted
 * finalize-step notice on statBlock === null; never a fabricated stat
 * block).
 *
 * This module subscribes to run completion ONCE (module scope, imported
 * from main.tsx — no component re-subscribes per run).
 *
 * A STOP wins over the subscription (owner report: "Stop all should stop all
 * generations, but it only stops the current type loop"): a run that was
 * ALREADY completing when the sweep snapshotted the engine registry still
 * lands here as `completed`, and enqueueing its battlemap/portraits after the
 * user pressed Stop all would start fresh queue work the stop supposedly
 * ended (a queue's `cancelAll` exits its pump, but any later `enqueue` starts
 * a new one). The epoch is captured when the completion arrives and consulted
 * before every enqueue, so post-stop completions enqueue nothing — the run
 * row itself is untouched and stays exactly as completed as the engine left
 * it.
 */
import type { AnyArtifact, Id, PersonaRun } from '@/domain';
import { getAnyArtifact } from '@/db/artifactRepo';
import { getModule } from '@/db/moduleRepo';
import { getPersona } from '@/db/personaRepo';
import { getRun } from '@/db/runRepo';
import { getSettings } from '@/db/settingsRepo';
import { runEngine } from '@/llm/runEngine';
import {
  enqueueArtifactPortrait,
  enqueueEncounterPortraitFill,
} from '@/features/campaign/mob-portrait-queue';
import {
  encounterNeedsMap,
  isEncounterMapPending,
  useEncounterMapQueue,
} from '@/features/modules/encounter-map-queue';
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

async function runPostCreateExtras(runId: Id): Promise<void> {
  // The epoch of the completion we are reacting to. A stop that landed while
  // this run was finishing (or while the reads below were in flight) means
  // the user asked for no more generation — nothing here enqueues.
  const epoch = getStopEpoch();
  const run = await getRun(runId);
  if (run === undefined) return;
  const artifact = run.resultArtifactId === null
    ? undefined
    : await getAnyArtifact(run.resultArtifactId);

  // The automatic battlemap runs for EVERY fresh encounter creation —
  // ticked extras or not (entity-batch runs carry no runExtras at all).
  if (artifact?.kind === 'encounter' && run.targetArtifactId === null) {
    const persona = await getPersona(run.personaId);
    if (persona === undefined) {
      throw new Error(`the run's persona ${run.personaId} no longer exists`);
    }
    // Encounter-mode personas (Cartographer) produce the map inside their
    // own run — enqueuing would double-book the same encounter.
    if (persona.mode !== 'encounter' && !stoppedSince(epoch)) {
      await enqueueAutomaticBattlemap(run, artifact);
    }
  }

  if (artifact === undefined) return;

  // 1) The run's OWN ticked extras (the persona panel's press). A stop wins
  //    over the subscription exactly as it always has.
  if (run.runExtras !== null) {
    if (stoppedSince(epoch)) return;
    if (run.runExtras.image) {
      enqueueArtifactPortrait(artifact, run.campaignId);
    }
    if (run.runExtras.mobPortraits) {
      if (artifact.kind !== 'encounter') {
        throw new Error(`mob portraits need an encounter — "${artifact.name}" is a ${artifact.kind}`);
      }
      // BOTH lanes, exactly like the editor's batch (the same section press
      // the owner uses by hand): chunk-backed creature kinds share the
      // bestiary portrait, and every other roster participant — an inline
      // entry, or the `npc-ref` monster the assertion rule's collision path
      // materialized for a creature the prose staged (docs/17 row 90) — gets
      // its own local one. Enqueuing only the rulebook lane is what left a
      // freshly created encounter's materialized monsters permanently
      // cover-less. The run's own extra is the owner's explicit choice, so it
      // never consults the module's automation switch.
      await enqueueEncounterPortraitFill(artifact, run.campaignId);
      return;
    }
  }

  // 2) The MISSING TRIGGER (docs/17 row 196): every run that LANDS a roster on
  //    an EXISTING encounter — the creation-time Cartographer restock,
  //    "Repopulate" and "Regenerate everything" (all carry
  //    `targetArtifactId`) — re-reads the row it just wrote and fills its
  //    portraits. Without this, the automation illustrated the Encounter
  //    Smith's stub roster and the restock then replaced it, so the fresh
  //    creatures were never enqueued (the owner's report) while the editor
  //    button, which reads the live row, worked.
  if (artifact.kind === 'encounter' && run.targetArtifactId !== null) {
    await enqueueAutomaticRosterPortraits(run, artifact, epoch);
  }
}

/**
 * The automatic mob-portrait trigger for a roster that has just LANDED on an
 * existing encounter (docs/17 row 196) — the creation-time restock, Repopulate
 * and Regenerate everything.
 *
 * The artifact is re-READ here rather than trusted from the completion event's
 * snapshot: the whole defect was a stale roster, and a concurrent second
 * restock must be illustrated from what is on the row NOW. The owning module's
 * master switch ("Generate mob encounter images") gates the automatic path,
 * exactly like `autoGenerateBattlemaps` gates the map above; a vanished module
 * row falls back to ON, the same reason as the battlemap path (the encounter
 * exists either way).
 *
 * A CAMPAIGN-LEVEL encounter (moduleId null) is deliberately NOT auto-filled:
 * the automatic mob-portrait rule IS the module's switch, and with no owning
 * module there is no switch to read — its route stays the editor's own button
 * and the run's ticked extra. That is the deliberate half of the asymmetry
 * with the editor (which has no ownership filter because it is opened ON one
 * encounter); see docs/17 row 196.
 *
 * `settings.imagesEnabled` is the existing loud-skip pattern: when image
 * generation is off the automation says so once instead of enqueueing work
 * that can only fail per creature. An EMPTY roster is genuinely nothing to
 * illustrate, so it is not a skip to report (recorded as a named limitation,
 * docs/17 row 196) — the shared enumeration simply enqueues nothing.
 */
async function enqueueAutomaticRosterPortraits(
  run: PersonaRun,
  // Structural: the completion's own read of the encounter; the union's
  // variants all carry id/moduleId/data, which is all this needs.
  artifact: AnyArtifact & { kind: 'encounter' },
  epoch: number,
): Promise<void> {
  if (artifact.moduleId === null) return;
  const module = await getModule(artifact.moduleId);
  if (module !== undefined && !module.autoGenerateMobImages) return;
  // The reads above are awaits: a stop landing while they were in flight must
  // still keep the queue empty.
  if (stoppedSince(epoch)) return;
  const fresh = await getAnyArtifact(artifact.id);
  if (fresh?.kind !== 'encounter') return;
  const settings = await getSettings();
  if (!settings.imagesEnabled) {
    if (fresh.data.monsters.length > 0) {
      toastError(
        'Auto mob portrait generation skipped — image generation is disabled in Settings',
      );
    }
    return;
  }
  if (stoppedSince(epoch)) return;
  await enqueueEncounterPortraitFill(fresh, run.campaignId);
}

/**
 * Enqueues the unattended Cartographer run for a freshly created encounter —
 * module placement comes from the encounter's own `moduleId` (campaign level
 * when none); preset/aspect resolve in the queue from the encounter's data
 * and the campaign defaults.
 */
async function enqueueAutomaticBattlemap(
  run: PersonaRun,
  // Structural: getAnyArtifact's union carries campaign-scoped AND library
  // (global) variants — both carry id/name/moduleId/data, which is all the
  // enqueue needs.
  artifact: { id: Id; moduleId: Id | null; name: string; data: { layout: unknown; mapImageId: unknown } },
): Promise<void> {
  // The owning module's master switch (the module dialog's "Generate
  // encounter battlemaps") gates the automatic path for module-owned
  // encounters. A vanished module row falls back to ON: the encounter
  // exists either way and the queue re-checks ownership when the job runs.
  if (artifact.moduleId !== null) {
    const module = await getModule(artifact.moduleId);
    if (module !== undefined && !module.autoGenerateBattlemaps) return;
  }
  // No-double-work guard: a mapped encounter or an already-queued/active
  // map job is never re-enqueued by the automation path.
  if (!encounterNeedsMap(artifact)) return;
  if (isEncounterMapPending(artifact.moduleId, artifact.id)) return;
  useEncounterMapQueue.getState().enqueue([
    {
      campaignId: run.campaignId,
      moduleId: artifact.moduleId,
      artifactId: artifact.id,
      name: artifact.name,
    },
  ]);
}
