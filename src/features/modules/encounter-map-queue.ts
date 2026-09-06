import type { Id, PersonaRun } from '@/domain';
import { resolveEncounterPreset } from '@/domain';
import { getAnyArtifact } from '@/db/artifactRepo';
import { getCampaign } from '@/db/campaignRepo';
import { getSettings } from '@/db/settingsRepo';
import { listPersonas } from '@/db/personaRepo';
import { runEngine, waitForRunStatus } from '@/llm/runEngine';
import { createJobQueue } from '@/lib/jobQueue';

export interface EncounterMapJob {
  campaignId: Id;
  /** The owning module — groups the dock job and pins the ownership check.
   * Null for campaign-level encounters (a campaign-level encounter generated
   * via the same unattended Cartographer path). */
  moduleId: Id | null;
  artifactId: Id;
  name: string;
}

/**
 * No-double-work guard for the AUTOMATION paths (owner-ratified): an
 * encounter that already carries its battlemap — layout AND map image — is
 * never re-enqueued by automatic flows. Regenerating an existing map stays
 * an EXPLICIT user action (the entity panel's "Generate encounter maps" or
 * the encounter editor's Cartographer run; regeneration replaces room keys —
 * the ratified consequence). The queue's own processJob re-checks the same
 * condition as a second belt (state can change while a job waits).
 */
export function encounterNeedsMap(artifact: {
  data: { layout: unknown; mapImageId: unknown };
}): boolean {
  return artifact.data.layout === null || artifact.data.mapImageId === null;
}

/**
 * The other half of the automation guard: true while the queue holds this
 * artifact's map job (queued or actively running — a FAILED job is not
 * pending; the failure already toasted loudly and `retryFailed` is the
 * explicit re-entry). Automation callers check this before enqueueing so a
 * run/post-pass never double-books the same encounter.
 */
export function isEncounterMapPending(moduleId: Id | null, artifactId: Id): boolean {
  const state = useEncounterMapQueue.getState();
  const key = `${moduleId ?? ''}:${artifactId}`;
  return (
    state.active.some((job) => jobKey(job) === key) ||
    state.queued.some((job) => jobKey(job) === key)
  );
}

/**
 * The unattended Cartographer run queue — SERIAL by contract (one map run at
 * a time; the factory's default workerCount of 1). It inherits the shared
 * factory invariants (F6): enqueue dedupe vs queued+active, cancellation
 * (dequeue aborts the wait AND cancels the underlying run through
 * `runEngine.cancel` — a withdrawn map job can no longer materialize a map),
 * the failed list with `retryFailed(filter)`, loud per-encounter toasts and
 * per-module dock counters. It does NOT survive a reload (in-memory by
 * design; the interrupted run row itself reconciles through
 * `failRunningRuns` — see createJobQueue's docs).
 */
export const useEncounterMapQueue = createJobQueue<EncounterMapJob>({
  name: 'encounter-map-queue',
  key: jobKey,
  dockGroup: (job) => ({ id: progressId(job.moduleId), label: 'Generating encounter maps' }),
  activeDetail: (job) => `Mapping "${job.name}"…`,
  settledDetail: (job, outcome) =>
    outcome === 'failed' ? `Failed "${job.name}"` : `Mapped "${job.name}"`,
  failureTitle: (job) => `Could not generate a map for "${job.name}"`,
  process: processJob,
});

function jobKey(job: EncounterMapJob): string {
  return `${job.moduleId ?? ''}:${job.artifactId}`;
}

function progressId(moduleId: Id | null): string {
  return moduleId === null ? 'campaign-encounter-maps' : `module-encounter-maps-${moduleId}`;
}

async function processJob(
  job: EncounterMapJob,
  ctx: { signal: AbortSignal },
): Promise<'done' | 'skipped'> {
  const [campaign, artifact, personas, settings] = await Promise.all([
    getCampaign(job.campaignId),
    getAnyArtifact(job.artifactId),
    listPersonas(),
    getSettings(),
  ]);
  if (campaign === undefined) throw new Error('campaign no longer exists');
  if (artifact?.kind !== 'encounter') throw new Error('encounter no longer exists');
  if (job.moduleId !== null && artifact.moduleId !== job.moduleId) {
    throw new Error('encounter is no longer owned by this module');
  }
  // The skip-guard half of the no-double-work contract (see
  // encounterNeedsMap): the encounter may have gained its map while the
  // job sat queued — a completed map is never regenerated here.
  if (!encounterNeedsMap(artifact)) return 'skipped';
  const cartographer = personas.find((persona) => persona.slug === 'encounter-cartographer');
  if (cartographer === undefined) throw new Error('Encounter Cartographer persona is missing');
  const runId = await runEngine.startRun({
    campaign,
    persona: cartographer,
    autonomy: 'auto',
    brief: `Generate a room layout and battlemap for "${artifact.name}" using its existing roster and prose.`,
    pinnedChunkIds: [],
    targetArtifactId: artifact.id,
    encounterMapAspect: settings.encounterMapAspect,
    // Dungeon preset (docs/11 D10, amended): the unattended path makes no
    // explicit per-run choice — the encounter's own locationKind decides
    // the tier ('dungeon' → Dungeon, building/wilderness → Standard) with
    // the campaign's Settings preference backstopping unclassified rows.
    encounterPreset: resolveEncounterPreset(
      null,
      artifact.data.locationKind,
      settings.encounterPreset,
    ),
    unattended: true,
  });
  let run: PersonaRun;
  try {
    run = await waitForRunStatus(runId, { signal: ctx.signal });
  } catch (error) {
    if (ctx.signal.aborted) {
      // The queue withdrew the job — cancel the unattended run so no map
      // materializes after the user dropped it (the engine aborts the
      // in-flight request and marks the row cancelled). A cancel failure
      // surfaces as the rethrown error; the factory classifies the job
      // cancelled either way (the signal is aborted).
      await runEngine.cancel(runId);
    }
    throw error;
  }
  if (run.status !== 'completed') {
    throw new Error(run.errorMessage || `run ended ${run.status}`);
  }
  return 'done';
}
