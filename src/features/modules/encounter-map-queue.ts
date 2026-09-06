import { create } from 'zustand';

import type { Id } from '@/domain';
import { resolveEncounterPreset } from '@/domain';
import { getAnyArtifact } from '@/db/artifactRepo';
import { getCampaign } from '@/db/campaignRepo';
import { getSettings } from '@/db/settingsRepo';
import { listPersonas } from '@/db/personaRepo';
import { runEngine, waitForRunStatus } from '@/llm/runEngine';
import { useProgressStore } from '@/lib/progress';
import { toastError } from '@/lib/toast';

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
    (state.active !== null && jobKey(state.active) === key) ||
    state.queued.some((job) => jobKey(job) === key)
  );
}

interface EncounterMapQueueState {
  queued: EncounterMapJob[];
  active: EncounterMapJob | null;
  failed: EncounterMapJob[];
  enqueue: (jobs: EncounterMapJob[]) => void;
  retryFailed: (moduleId: Id | null) => void;
  reset: () => void;
}

export const useEncounterMapQueue = create<EncounterMapQueueState>((set, get) => ({
  queued: [],
  active: null,
  failed: [],
  enqueue: (jobs) => {
    const state = get();
    const known = new Set([
      ...state.queued.map(jobKey),
      ...(state.active === null ? [] : [jobKey(state.active)]),
    ]);
    const fresh = jobs.filter((job) => !known.has(jobKey(job)));
    if (fresh.length === 0) return;
    set((state) => ({
      queued: [...state.queued, ...fresh],
      failed: state.failed.filter((failed) => !fresh.some((job) => jobKey(job) === jobKey(failed))),
    }));
    for (const job of fresh) bumpTotal(job);
    void pump();
  },
  retryFailed: (moduleId) => {
    const jobs = get().failed.filter((job) => (job.moduleId ?? null) === moduleId);
    if (jobs.length === 0) return;
    set((state) => ({ failed: state.failed.filter((job) => job.moduleId !== moduleId) }));
    get().enqueue(jobs);
  },
  reset: () => {
    set({ queued: [], active: null, failed: [] });
    counters.clear();
    pumping = false;
  },
}));

const counters = new Map<Id | null, { total: number; done: number }>();
let pumping = false;

function jobKey(job: EncounterMapJob): string {
  return `${job.moduleId ?? ''}:${job.artifactId}`;
}

function progressId(moduleId: Id | null): string {
  return moduleId === null ? 'campaign-encounter-maps' : `module-encounter-maps-${moduleId}`;
}

function bumpTotal(job: EncounterMapJob): void {
  const counter = counters.get(job.moduleId) ?? { total: 0, done: 0 };
  counter.total += 1;
  counters.set(job.moduleId, counter);
  if (counter.total === 1) {
    useProgressStore.getState().start(progressId(job.moduleId), 'Generating encounter maps');
  }
  useProgressStore.getState().update(progressId(job.moduleId), {
    progress: counter.done / counter.total,
  });
}

function bumpDone(job: EncounterMapJob, detail: string): void {
  const counter = counters.get(job.moduleId);
  if (counter === undefined) return;
  counter.done += 1;
  useProgressStore.getState().update(progressId(job.moduleId), {
    progress: counter.done / counter.total,
    detail,
  });
  if (counter.done >= counter.total) {
    counters.delete(job.moduleId);
    useProgressStore.getState().finish(progressId(job.moduleId));
  }
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const state = useEncounterMapQueue.getState();
      const job = state.queued[0];
      if (job === undefined) break;
      useEncounterMapQueue.setState({ queued: state.queued.slice(1), active: job });
      useProgressStore.getState().update(progressId(job.moduleId), {
        detail: `Mapping "${job.name}"…`,
      });
      const error = await processJob(job);
      if (error === null) {
        bumpDone(job, `Mapped "${job.name}"`);
      } else {
        useEncounterMapQueue.setState((current) => ({
          failed: current.failed.some((failed) => jobKey(failed) === jobKey(job))
            ? current.failed
            : [...current.failed, job],
        }));
        bumpDone(job, `Failed "${job.name}"`);
        toastError(`Could not generate a map for "${job.name}"`, error);
      }
      useEncounterMapQueue.setState({ active: null });
    }
  } finally {
    pumping = false;
  }
}

async function processJob(job: EncounterMapJob): Promise<Error | null> {
  try {
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
    if (!encounterNeedsMap(artifact)) return null;
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
    const run = await waitForRunStatus(runId);
    if (run.status !== 'completed') {
      throw new Error(run.errorMessage || `run ended ${run.status}`);
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
