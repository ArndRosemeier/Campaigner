import type { AnyArtifact, Id } from '@/domain';
import { moduleCreationPool } from '@/domain';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { listArtifactsByCampaign, attachImagesToArtifact } from '@/db/artifactRepo';
import { getCampaign } from '@/db/campaignRepo';
import { getSettings, maxParallelWorkers } from '@/db/settingsRepo';
import { buildImagePrompt } from '@/llm/imagePromptDraft';
import { generateOneImage } from '@/llm/oneImage';
import type { ImagePromptDraft } from '@/llm/schemas';
import { createJobQueue } from '@/lib/jobQueue';
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
 * which an unattended queue cannot do. The prompt-draft contract (the
 * deterministic `buildImagePrompt`) mirrors runEngine's runPromptDraft
 * one-to-one — no chat call here either.
 *
 * The pump/dedupe/cancellation/failed-retry/dock-counter machinery is the
 * shared `createJobQueue` factory (F6) — this module is the config plus the
 * per-job body. The inherited enqueue dedupe (keyed campaign:name) fixed the
 * queue's one real divergence: concurrent same-name checkbox ticks used to
 * enqueue twice (double image + silent cover overwrite). Like every queue
 * on the factory, it does NOT survive a reload (in-memory by design; see
 * createJobQueue's docs).
 */

export interface ImageQueueJob {
  campaignId: Id;
  moduleId: Id;
  /** The exact entity (wiki-link) name; resolves to its artifact. */
  name: string;
  /**
   * Delete-after-replace (the generation dialog's overwrite, docs/17 row 422):
   * the worker generates a FRESH image even though the entity has a cover,
   * lands it as the cover, and only THEN removes the previous cover (gallery
   * entry, revision pins and blob) in the same attach transaction — so a failed
   * generation leaves the old cover intact. Enqueued through the factory's
   * `enqueueReplacing`. Absent/false = the normal skip-if-imaged path.
   */
  regen?: boolean;
}

export const useEntityImageQueue = createJobQueue<ImageQueueJob>({
  name: 'image-queue',
  key: (job) => `${job.campaignId}:${job.name}`,
  dockGroup: (job) => ({
    id: `module-entity-images-${job.moduleId}`,
    label: 'Generating entity images',
  }),
  activeDetail: (job) => `Illustrating "${job.name}"…`,
  settledDetail: (job, outcome) =>
    outcome === 'done' ? `Illustrated "${job.name}"` : `Skipped "${job.name}"`,
  failureTitle: (job) => `Could not generate an image for "${job.name}"`,
  workerCount: maxParallelWorkers,
  process: processJob,
});

async function processJob(
  job: ImageQueueJob,
  ctx: { signal: AbortSignal },
): Promise<'done' | 'skipped'> {
  const settings = await getSettings();
  // Module creation never references the Party (docs/17 row 69): a job name
  // that matches only a `pc` row has no module entity to illustrate — it fails
  // loudly below instead of attaching a generated cover to a player character.
  const artifacts = moduleCreationPool(await listArtifactsByCampaign(job.campaignId));
  const artifact = resolveWikiLink(job.name, artifacts, {
    moduleId: job.moduleId,
  }).artifact;
  if (artifact === undefined) {
    throw new Error('no artifact exists for this entity yet — detail it first');
  }
  // An image may have appeared while the job sat in the queue (added in
  // the editor, another queue run) — the checkbox is already satisfied. A
  // replace job flows past: replacing an existing cover is its whole point.
  if (job.regen !== true && (artifact.coverImageId !== null || artifact.imageIds.length > 0)) {
    return 'skipped';
  }
  // What a replace supersedes: the previous COVER only. The rest of the gallery
  // is not this job's — an encounter's battlemap lives there, and a cover that
  // IS the battlemap is kept (removing it would strand `data.mapImageId`).
  const previous = artifact.coverImageId;
  const superseded =
    job.regen === true &&
    previous !== null &&
    !(artifact.kind === 'encounter' && artifact.data.mapImageId === previous)
      ? [previous]
      : [];
  const prompt = await draftPrompt(artifact, job.campaignId);
  // ONE image, prepared for storage: the seam owns the prompt contract
  // assembly, the n=1 call (and why its candidate-count caps cannot fire),
  // the empty-result refusal and the EXIF-safe intake (docs/18 §2.2).
  const generated = await generateOneImage(prompt, {
    model: settings.imageModel,
    signal: ctx.signal,
  });
  // Store + attach (as cover) is ONE repo transaction — a crash between
  // the image write and the artifact update must not leak the blob as an
  // unreferenced orphan or leave the artifact pointing at nothing.
  await attachImagesToArtifact(artifact.id, {
    createImages: [
      {
        campaignId: job.campaignId,
        ...generated,
        source: 'generated',
        // The fresh image IS the cover: the skip branch guarantees there was
        // none, or this is a replace that supersedes it.
        asCover: true,
      },
    ],
    // Delete-after-replace, atomically with the fresh cover's commit (the
    // mob-portrait queue's artifact-cover regen is the precedent): the old
    // cover leaves the gallery, its revision pins are released, and its blob
    // is freed when nothing else references it.
    ...(superseded.length === 0
      ? {}
      : {
          removeImageIds: superseded,
          scrubImageIds: superseded,
          pruneCandidates: { campaignId: job.campaignId, candidateIds: superseded },
        }),
  });
  return 'done';
}

/** Prompt-draft for one artifact — the shared Illustrator prompt contract
 * (buildImagePrompt: appearance shortcut, body/summary/name grounding) with
 * the queue's wiring: no run row, and the artifact's rule system resolved for
 * the style hint. Deterministic: no chat call, no repair retry. */
async function draftPrompt(
  artifact: AnyArtifact,
  campaignId?: Id,
): Promise<ImagePromptDraft> {
  let systemLabel = 'D&D 5e';
  if (campaignId !== undefined) {
    const campaign = await getCampaign(campaignId);
    if (campaign !== undefined) {
      systemLabel = GAME_SYSTEM_LABELS[campaign.system];
    }
  }
  return buildImagePrompt(
    {
      name: artifact.name,
      kind: artifact.kind,
      summary: artifact.summary,
      body: artifact.body,
      data: artifact.data,
    },
    { systemLabel },
  );
}
