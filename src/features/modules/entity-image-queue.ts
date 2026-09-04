import { create } from 'zustand';

import type { AnyArtifact, Id, Persona } from '@/domain';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { listArtifactsByCampaign, updateArtifact } from '@/db/artifactRepo';
import { getCampaign } from '@/db/campaignRepo';
import { createImage } from '@/db/imageRepo';
import { listPersonas } from '@/db/personaRepo';
import { getSettings } from '@/db/settingsRepo';
import { generateImages } from '@/llm/imageGen';
import { chat, type ChatMessage } from '@/llm/openrouter';
import { parseErrorSummary, parseJsonReply } from '@/llm/jsonReply';
import { repairModel, resolveChatModel } from '@/llm/modelFallback';
import { imagePromptDraftSchema, type ImagePromptDraft } from '@/llm/schemas';
import { intakeImage } from '@/lib/imageIntake';
import { debugLog } from '@/lib/debug';
import { useProgressStore } from '@/lib/progress';
import { toastError } from '@/lib/toast';
import { resolveWikiLink } from '@/lib/wikilinks';

/**
 * Entity image queue (08-MODULE-DESIGNER M4-C, module-mode-as-play): the
 * entity panel's image checkboxes enqueue entities; a background pump
 * generates one image per entity (prompt draft → image API → intake → attach
 * as cover) while the reader stays fully usable. Up to
 * `maxParallelRequests` images generate at once — image generation is
 * independent per entity. Progress rides the shared dock; failures are loud
 * toasts and never stop the queue.
 *
 * This deliberately does NOT go through the persona run pipeline: the
 * Illustrator's pick step always pauses for a user decision (07 §M3-A),
 * which an unattended queue cannot do. The prompt-draft contract and repair
 * retry mirror runEngine's runPromptDraft/runGenerate one-to-one.
 */

export interface ImageQueueJob {
  campaignId: Id;
  moduleId: Id;
  /** The exact entity (wiki-link) name; resolves to its artifact. */
  name: string;
}

interface EntityImageQueueState {
  queued: ImageQueueJob[];
  /** Jobs whose generation is in flight right now (≤ maxParallelRequests). */
  activeJobs: ImageQueueJob[];
  enqueue: (jobs: ImageQueueJob[]) => void;
  /** Removes a pending (or aborts the in-flight) job for this entity. */
  dequeue: (job: ImageQueueJob) => void;
}

export const useEntityImageQueue = create<EntityImageQueueState>((set) => ({
  queued: [],
  activeJobs: [],
  enqueue: (jobs) => {
    set((state) => ({ queued: [...state.queued, ...jobs] }));
    for (const job of jobs) bumpTotal(job);
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

function key(job: Pick<ImageQueueJob, 'campaignId' | 'name'>): string {
  return `${job.campaignId}:${job.name}`;
}

const controllers = new Map<string, AbortController>();

/** Per-module dock counters: done/total keep the bar monotonic. */
const counters = new Map<string, { total: number; done: number }>();

function jobIdFor(job: ImageQueueJob): string {
  return `module-entity-images-${job.moduleId}`;
}

function bumpTotal(job: ImageQueueJob): void {
  const jobId = jobIdFor(job);
  let counter = counters.get(jobId);
  if (counter === undefined) {
    counter = { total: 0, done: 0 };
    counters.set(jobId, counter);
    useProgressStore.getState().start(jobId, 'Generating entity images');
  }
  counter.total += 1;
  useProgressStore.getState().update(jobId, {
    progress: counter.done / counter.total,
  });
}

function bumpDone(job: ImageQueueJob, detail: string): void {
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

function bumpRemoved(job: ImageQueueJob): void {
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
function takeNext(): ImageQueueJob | null {
  let taken: ImageQueueJob | null = null;
  useEntityImageQueue.setState((state) => {
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
function releaseJob(job: ImageQueueJob): void {
  useEntityImageQueue.setState((state) => ({
    activeJobs: state.activeJobs.filter((candidate) => key(candidate) !== key(job)),
  }));
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    do {
      // Image generation is independent per entity: run up to
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
    } while (useEntityImageQueue.getState().queued.length > 0);
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
    debugLog('image-queue', `job for "${job.name}" finished`, { outcome });
    bumpDone(
      job,
      outcome === 'done' ? `Illustrated "${job.name}"` : `Skipped "${job.name}"`,
    );
    releaseJob(job);
  }
}

type JobOutcome = 'done' | 'skipped' | 'failed' | 'cancelled';

async function processJob(job: ImageQueueJob): Promise<JobOutcome> {
  const controller = new AbortController();
  controllers.set(key(job), controller);
  try {
    const settings = await getSettings();
    if (!settings.imagesEnabled) {
      throw new Error('Image generation is disabled — enable it in Settings');
    }
    const artifacts = await listArtifactsByCampaign(job.campaignId);
    const artifact = resolveWikiLink(job.name, artifacts, {
      moduleId: job.moduleId,
    }).artifact;
    if (artifact === undefined) {
      throw new Error('no artifact exists for this entity yet — detail it first');
    }
    // An image may have appeared while the job sat in the queue (added in
    // the editor, another queue run) — the checkbox is already satisfied.
    if (artifact.coverImageId !== null || artifact.imageIds.length > 0) {
      return 'skipped';
    }
    const personas = await listPersonas();
    const illustrator = personas.find((candidate) => candidate.slug === 'illustrator');
    if (illustrator === undefined) {
      throw new Error('the Illustrator persona is missing — re-enable built-in personas');
    }
    const prompt = await draftPrompt(
      illustrator,
      artifact,
      resolveChatModel(settings, illustrator.model),
      controller.signal,
      job.campaignId,
    );
    const finalPrompt = [
      prompt.prompt,
      prompt.styleNotes === '' ? null : `Style: ${prompt.styleNotes}`,
      prompt.negative === '' ? null : `Avoid: ${prompt.negative}`,
    ]
      .filter((part) => part !== null)
      .join('\n');
    // n=1: candidate-count caps (imageGen's n-retry, cappedToOne) cannot
    // trigger on this path — the queue only ever asks for one image.
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
    toastError(`Could not generate an image for "${job.name}"`, error);
    return 'failed';
  } finally {
    controllers.delete(key(job));
  }
}

/** Prompt-draft for one artifact — mirrors runEngine.runPromptDraft's
 * instruction and one-repair-retry policy (auto-attach queue variant).
 * `model` is the already-resolved first-try model. */
async function draftPrompt(
  illustrator: Persona,
  artifact: AnyArtifact,
  model: string,
  signal: AbortSignal,
  campaignId?: Id,
): Promise<ImagePromptDraft> {
  const data = artifact.data as Record<string, unknown> | null | undefined;
  const appearance =
    data !== null && typeof data === 'object' && typeof data.appearance === 'string'
      ? data.appearance.trim()
      : '';
  if (appearance !== '') {
    let systemLabel = 'D&D 5e';
    if (campaignId !== undefined) {
      const campaign = await getCampaign(campaignId);
      if (campaign !== undefined) {
        systemLabel = GAME_SYSTEM_LABELS[campaign.system];
      }
    }
    return {
      prompt: `${systemLabel}=>${appearance}`,
      negative: '',
      styleNotes: '',
    };
  }

  const instruction = [
    `Artifact: ${artifact.name} (${artifact.kind})`,
    artifact.summary === '' ? null : `Summary: ${artifact.summary}`,
    artifact.body === '' ? null : `Description (may be truncated):\n${artifact.body.slice(0, 800)}`,
    'Reply with ONLY a JSON object with exactly these fields: ["prompt", "negative", "styleNotes"] — `prompt` describes the image to generate for this artifact, `negative` lists what to avoid, `styleNotes` gives style guidance.',
  ]
    .filter((part) => part !== null)
    .join('\n\n');
  const messages: ChatMessage[] = [
    { role: 'system', content: illustrator.systemPrompt },
    { role: 'user', content: instruction },
  ];
  let lastError: unknown = new Error('no reply');
  // The contract-repair attempt escalates to the fallback model when one is
  // configured — same policy as runEngine.runDraft.
  const repairTarget = repairModel(model, await getSettings());
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { text: raw } = await chat(
      attempt === 0
        ? messages
        : [
            ...messages,
            {
              role: 'user' as const,
              content:
                'Your previous reply was invalid JSON for the schema. Reply with corrected JSON only.',
            },
          ],
      {
        model: attempt === 0 ? model : repairTarget,
        temperature: illustrator.temperature,
        reasoningEffort:
          illustrator.reasoningEffort !== 'default'
            ? illustrator.reasoningEffort
            : undefined,
        responseFormat: 'json',
        signal,
      },
    );
    try {
      return imagePromptDraftSchema.parse(parseJsonReply(raw));
    } catch (error) {
      lastError = new Error(parseErrorSummary(error));
    }
  }
  throw lastError;
}
