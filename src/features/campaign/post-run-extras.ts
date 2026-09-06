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
 * - `mobPortraits` — the encounter roster's rulebook-cited creature kinds
 *   (enqueueMobPortraits, the encounter editor's batch action).
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
 */
import type { Id, PersonaRun } from '@/domain';
import { getAnyArtifact } from '@/db/artifactRepo';
import { getModule } from '@/db/moduleRepo';
import { getPersona } from '@/db/personaRepo';
import { getRun } from '@/db/runRepo';
import { runEngine } from '@/llm/runEngine';
import {
  enqueueArtifactPortrait,
  enqueueMobPortraits,
} from '@/features/campaign/mob-portrait-queue';
import {
  encounterNeedsMap,
  isEncounterMapPending,
  useEncounterMapQueue,
} from '@/features/modules/encounter-map-queue';
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
    if (persona.mode !== 'encounter') {
      await enqueueAutomaticBattlemap(run, artifact);
    }
  }

  if (run.runExtras == null || artifact === undefined) return;
  if (run.runExtras.image) {
    enqueueArtifactPortrait(artifact, run.campaignId);
  }
  if (run.runExtras.mobPortraits) {
    if (artifact.kind !== 'encounter') {
      throw new Error(`mob portraits need an encounter — "${artifact.name}" is a ${artifact.kind}`);
    }
    await enqueueMobPortraits(artifact, run.campaignId);
  }
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
