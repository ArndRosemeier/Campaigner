import type { AnyArtifact, Id } from '@/domain';
import { moduleCreationPool } from '@/domain';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { listArtifactsByCampaign, attachImagesToArtifact } from '@/db/artifactRepo';
import { getCampaign } from '@/db/campaignRepo';
import { getSettings } from '@/db/settingsRepo';
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
  workerCount: async () => {
    const settings = await getSettings();
    return Math.max(1, settings.maxParallelRequests);
  },
  process: processJob,
});

async function processJob(
  job: ImageQueueJob,
  ctx: { signal: AbortSignal },
): Promise<'done' | 'skipped'> {
  const settings = await getSettings();
  if (!settings.imagesEnabled) {
    throw new Error('Image generation is disabled — enable it in Settings');
  }
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
  // the editor, another queue run) — the checkbox is already satisfied.
  if (artifact.coverImageId !== null || artifact.imageIds.length > 0) {
    return 'skipped';
  }
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
        // The skip branch above guarantees the artifact had no image yet.
        asCover: true,
      },
    ],
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
