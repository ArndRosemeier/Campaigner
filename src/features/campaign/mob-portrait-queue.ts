import { create } from 'zustand';

import type { AnyArtifact, Id, Persona, Settings } from '@/domain';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { getAnyArtifact, updateArtifact } from '@/db/artifactRepo';
import { getCampaign } from '@/db/campaignRepo';
import { getChunksByIds } from '@/db/chunkRepo';
import { createImage } from '@/db/imageRepo';
import { getOrCreateMobArtifact } from '@/db/mobArtifacts';
import { listPersonas } from '@/db/personaRepo';
import { getSettings } from '@/db/settingsRepo';
import { generateImages } from '@/llm/imageGen';
import { resolveChatModel } from '@/llm/modelFallback';
import { assembleImagePrompt, draftImagePrompt } from '@/llm/imagePromptDraft';
import type { ImagePromptDraft } from '@/llm/schemas';
import { intakeImage } from '@/lib/imageIntake';
import { debugLog } from '@/lib/debug';
import { useProgressStore } from '@/lib/progress';
import { toastError } from '@/lib/toast';

/**
 * Mob portrait queue (owner-ratified mob-artifact arc): one click on the
 * encounter editor's "Generate mob portraits" enumerates the encounter's
 * rulebook-cited creature kinds and generates ONE portrait per mob artifact
 * (n=1), attached as its cover. Portraits then reach the battle tokens
 * through the existing `coverImageId` path — zero BattleSurface changes.
 *
 * A deliberate variant of the entity image queue (08 §M4-C) with the SAME
 * mechanics — pump with `maxParallelRequests` workers, intake, the shared
 * `draftImagePrompt` contract, attach-as-cover, skip-if-imaged, loud
 * per-mob toasts (EntityBatchFailure {name, message} style) — but keyed by
 * **artifactId**: the queue's wiki-link name resolution does not fit mob
 * artifacts, and prompt grounding is the creature chunk's stat-block text
 * (a fresh mob artifact has empty appearance/body — the chunk is the only
 * source; the artifact's own `appearance` shortcut still wins when the user
 * filled it). Never rides the persona run pipeline (the Illustrator's pick
 * step always pauses; an unattended batch cannot).
 */

export interface MobPortraitJob {
  campaignId: Id;
  /** The encounter that owns the roster — groups the progress-dock job. */
  encounterId: Id;
  /** The mob artifact to illustrate (ONE per creature kind per campaign). */
  artifactId: Id;
  /** Display name (the roster creature name) for progress + failures. */
  name: string;
  /** The creature's stat-block chunk — grounds the prompt. */
  chunkId: Id;
}

interface MobPortraitQueueState {
  queued: MobPortraitJob[];
  /** Jobs whose generation is in flight right now (≤ maxParallelRequests). */
  activeJobs: MobPortraitJob[];
  enqueue: (jobs: MobPortraitJob[]) => void;
  /** Removes a pending (or aborts the in-flight) job for this artifact. */
  dequeue: (job: MobPortraitJob) => void;
}

export const useMobPortraitQueue = create<MobPortraitQueueState>((set) => ({
  queued: [],
  activeJobs: [],
  enqueue: (jobs) => {
    // One portrait per artifact: a creature kind cited by several encounters
    // (or twice in one roster) must not generate concurrently against
    // itself — duplicates within the batch and against known jobs are
    // dropped, the skip-if-imaged guard keeps the survivor honest.
    let kept: MobPortraitJob[] = [];
    set((state) => {
      const known = new Set(
        [...state.queued, ...state.activeJobs].map((job) => key(job)),
      );
      kept = jobs.filter((job) => {
        const jobKey = key(job);
        if (known.has(jobKey)) return false;
        known.add(jobKey);
        return true;
      });
      if (kept.length === 0) return state;
      return { queued: [...state.queued, ...kept] };
    });
    for (const job of kept) bumpTotal(job);
    void pump();
  },
  dequeue: (job) => {
    set((state) => ({
      queued: state.queued.filter((candidate) => key(candidate) !== key(job)),
      activeJobs: state.activeJobs.filter((candidate) => key(candidate) !== key(job)),
    }));
    controllers.get(key(job))?.abort();
    bumpRemoved(job);
  },
}));

function key(job: Pick<MobPortraitJob, 'campaignId' | 'artifactId'>): string {
  return `${job.campaignId}:${job.artifactId}`;
}

const controllers = new Map<string, AbortController>();

/** Per-encounter dock counters: done/total keep the bar monotonic. */
const counters = new Map<string, { total: number; done: number }>();

function jobIdFor(job: MobPortraitJob): string {
  return `encounter-mob-portraits-${job.encounterId}`;
}

function bumpTotal(job: MobPortraitJob): void {
  const jobId = jobIdFor(job);
  let counter = counters.get(jobId);
  if (counter === undefined) {
    counter = { total: 0, done: 0 };
    counters.set(jobId, counter);
    useProgressStore.getState().start(jobId, 'Generating mob portraits');
  }
  counter.total += 1;
  useProgressStore.getState().update(jobId, {
    progress: counter.done / counter.total,
  });
}

function bumpDone(job: MobPortraitJob, detail: string): void {
  const jobId = jobIdFor(job);
  const counter = counters.get(jobId);
  if (counter === undefined) return;
  counter.done += 1;
  useProgressStore.getState().update(jobId, {
    progress: counter.done / counter.total,
    detail,
  });
  if (counter.done >= counter.total) {
    useProgressStore.getState().finish(jobId);
    counters.delete(jobId);
  }
}

function bumpRemoved(job: MobPortraitJob): void {
  const jobId = jobIdFor(job);
  const counter = counters.get(jobId);
  if (counter === undefined) return;
  counter.total -= 1;
  if (counter.done >= counter.total) {
    useProgressStore.getState().finish(jobId);
    counters.delete(jobId);
  } else {
    useProgressStore.getState().update(jobId, { progress: counter.done / counter.total });
  }
}

let pumping = false;

/** Atomically moves the queue head into the active set. Returns null when
 * the queue is empty. (zustand's setState is synchronous, so no two workers
 * can take the same job.) */
function takeNext(): MobPortraitJob | null {
  let taken: MobPortraitJob | null = null;
  useMobPortraitQueue.setState((state) => {
    const job = state.queued[0];
    if (job === undefined) return state;
    taken = job;
    return {
      queued: state.queued.slice(1),
      activeJobs: [...state.activeJobs, job],
    };
  });
  return taken;
}

/** Removes a finished (or dequeued mid-flight) job from the active set. */
function releaseJob(job: MobPortraitJob): void {
  useMobPortraitQueue.setState((state) => ({
    activeJobs: state.activeJobs.filter((candidate) => key(candidate) !== key(job)),
  }));
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    do {
      // Portrait generation is independent per mob: run up to
      // maxParallelRequests at once (the workers share the queue).
      const settings = await getSettings();
      const limit = Math.max(1, settings.maxParallelRequests);
      const workers: Promise<void>[] = [];
      for (let worker = 0; worker < limit; worker += 1) {
        workers.push(pumpWorker());
      }
      await Promise.all(workers);
      // A job may have been enqueued while the last workers were exiting —
      // drain again instead of stranding it until the next enqueue.
    } while (useMobPortraitQueue.getState().queued.length > 0);
  } finally {
    pumping = false;
  }
}

async function pumpWorker(): Promise<void> {
  for (;;) {
    const job = takeNext();
    if (job === null) return;
    useProgressStore.getState().update(jobIdFor(job), {
      detail: `Illustrating "${job.name}"…`,
    });
    const outcome = await processJob(job);
    debugLog('mob-portrait-queue', `job for "${job.name}" finished`, { outcome });
    bumpDone(
      job,
      outcome === 'done' ? `Illustrated "${job.name}"` : `Skipped "${job.name}"`,
    );
    releaseJob(job);
  }
}

type JobOutcome = 'done' | 'skipped' | 'failed' | 'cancelled';

async function processJob(job: MobPortraitJob): Promise<JobOutcome> {
  const controller = new AbortController();
  controllers.set(key(job), controller);
  try {
    const settings = await getSettings();
    if (!settings.imagesEnabled) {
      throw new Error('Image generation is disabled — enable it in Settings');
    }
    const artifact = await getAnyArtifact(job.artifactId);
    if (artifact === undefined) {
      throw new Error('the mob artifact no longer exists — regenerate the encounter');
    }
    // A cover may have appeared while the job sat in the queue (editor
    // upload, another queue run) — no re-generation of imaged mobs.
    if (artifact.coverImageId !== null || artifact.imageIds.length > 0) {
      return 'skipped';
    }
    const chunk = (await getChunksByIds([job.chunkId]))[0];
    if (chunk === undefined) {
      throw new Error('the creature\u2019s stat-block chunk no longer exists');
    }
    if (chunk.text.trim() === '') {
      throw new Error('the creature\u2019s stat-block chunk has no text to ground the prompt');
    }
    const personas = await listPersonas();
    const illustrator = personas.find((candidate) => candidate.slug === 'illustrator');
    if (illustrator === undefined) {
      throw new Error('the Illustrator persona is missing — re-enable built-in personas');
    }
    const prompt = await draftPrompt(
      illustrator,
      artifact,
      chunk.text,
      resolveChatModel(settings, illustrator.model),
      controller.signal,
      settings,
      job.campaignId,
    );
    const finalPrompt = assembleImagePrompt(prompt);
    // n=1 (owner-ratified): one portrait per creature kind — candidate-count
    // caps (imageGen's n-retry, cappedToOne) cannot trigger on this path.
    const generated = await generateImages(finalPrompt, 1, {
      model: settings.imageModel,
      signal: controller.signal,
    });
    const blob = generated.images[0];
    if (blob === undefined) throw new Error('the image API returned no image');
    const intake = await intakeImage(blob);
    const stored = await createImage({
      campaignId: job.campaignId,
      blob: intake.blob,
      mimeType: intake.mimeType,
      width: intake.width,
      height: intake.height,
      prompt: finalPrompt,
      model: generated.modelUsed,
      source: 'generated',
    });
    await updateArtifact(artifact.id, {
      imageIds: [...artifact.imageIds, stored.id],
      // The skip branch above guarantees the artifact had no image yet.
      coverImageId: stored.id,
    });
    return 'done';
  } catch (error) {
    if (controller.signal.aborted) return 'cancelled';
    // Loud per-mob failure with the creature's name (AGENTS rule 2); the
    // queue continues with the remaining mobs.
    toastError(`Could not generate a portrait for "${job.name}"`, error);
    return 'failed';
  } finally {
    controllers.delete(key(job));
  }
}

/** Prompt-draft for one mob artifact — the shared Illustrator prompt contract
 * (draftImagePrompt: appearance shortcut, instruction text, one repair retry
 * on the repair model) with the queue's wiring: no run row, no streaming
 * surface, the campaign's rule system for the shortcut, and the creature
 * chunk's stat-block text as the description (chunk grounding). */
async function draftPrompt(
  illustrator: Persona,
  artifact: AnyArtifact,
  chunkText: string,
  model: string,
  signal: AbortSignal,
  settings: Pick<Settings, 'fallbackChatModel'>,
  campaignId: Id,
): Promise<ImagePromptDraft> {
  let systemLabel = 'D&D 5e';
  const campaign = await getCampaign(campaignId);
  if (campaign !== undefined) {
    systemLabel = GAME_SYSTEM_LABELS[campaign.system];
  }
  const result = await draftImagePrompt(
    {
      name: artifact.name,
      kind: artifact.kind,
      summary: artifact.summary,
      // Chunk grounding: the stat-block text is what the model drafts from —
      // the fresh mob artifact's own body is empty by design.
      body: chunkText,
      data: artifact.data,
    },
    {
      model,
      settings,
      systemPrompt: illustrator.systemPrompt,
      systemLabel,
      signal,
      chatOptions: (attemptModel) => ({
        model: attemptModel,
        temperature: illustrator.temperature,
        reasoningEffort:
          illustrator.reasoningEffort !== 'default' ? illustrator.reasoningEffort : undefined,
        responseFormat: 'json',
        signal,
      }),
    },
  );
  if (!result.ok) throw new Error(result.issues.join('; '));
  return result.draft;
}

export interface MobPortraitBatchResult {
  /** Cover-less mobs enqueued for generation (deduped by artifact). */
  enqueued: number;
  /** Creature names whose mob artifact already carries an image. */
  alreadyImaged: string[];
}

/**
 * The batch action (encounter editor): enumerates the encounter's
 * rulebook-cited entries, get-or-creates each mob artifact (lazy retro-fill
 * for encounters written before `mobArtifactId` — the same shared helper the
 * finalize and seed paths use), dedupes by artifact, skips imaged mobs and
 * enqueues the rest. A dangling stamped `mobArtifactId` (its artifact was
 * deleted) fails loudly instead of silently diverging identities.
 */
export async function enqueueMobPortraits(
  encounter: AnyArtifact & { kind: 'encounter' },
  campaignId: Id,
): Promise<MobPortraitBatchResult> {
  const artifactIdByChunk = new Map<Id, Id>();
  const seenArtifacts = new Set<Id>();
  const jobs: MobPortraitJob[] = [];
  const alreadyImaged: string[] = [];
  for (const entry of encounter.data.monsters) {
    if (entry.source.type !== 'rulebook') continue;
    const known = artifactIdByChunk.get(entry.source.chunkId);
    const artifactId =
      known ??
      entry.source.mobArtifactId ??
      (await getOrCreateMobArtifact(campaignId, entry.source.chunkId, entry.name));
    artifactIdByChunk.set(entry.source.chunkId, artifactId);
    // One portrait per creature kind, not per roster entry.
    if (seenArtifacts.has(artifactId)) continue;
    seenArtifacts.add(artifactId);
    const artifact = await getAnyArtifact(artifactId);
    if (artifact === undefined) {
      throw new Error(
        `Generate mob portraits: the artifact for "${entry.name}" no longer exists — re-run the encounter content to restore it`,
      );
    }
    if (artifact.coverImageId !== null || artifact.imageIds.length > 0) {
      alreadyImaged.push(entry.name);
      continue;
    }
    jobs.push({
      campaignId,
      encounterId: encounter.id,
      artifactId,
      name: entry.name,
      chunkId: entry.source.chunkId,
    });
  }
  useMobPortraitQueue.getState().enqueue(jobs);
  return { enqueued: jobs.length, alreadyImaged };
}
