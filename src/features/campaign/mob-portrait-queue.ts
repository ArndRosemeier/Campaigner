import type { AnyArtifact, Id } from '@/domain';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { getAnyArtifact, attachImagesToArtifact } from '@/db/artifactRepo';
import { getCampaign } from '@/db/campaignRepo';
import { getChunksByIds } from '@/db/chunkRepo';
import { getOrCreateMobArtifact } from '@/db/mobArtifacts';
import {
  canonicalCreatureName,
  cloneCachedPortraitToArtifact,
  isCanonicalCitation,
} from '@/db/mobPortraitCache';
import { getSettings } from '@/db/settingsRepo';
import { generateImages } from '@/llm/imageGen';
import { assembleImagePrompt, buildImagePrompt } from '@/llm/imagePromptDraft';
import type { ImagePromptDraft } from '@/llm/schemas';
import { createJobQueue } from '@/lib/jobQueue';
import { intakeImage } from '@/lib/imageIntake';
import { ensureCanonicalMobPortrait } from '@/features/campaign/mob-portrait-cache-queue';

/**
 * Mob portrait queue (owner-ratified mob-artifact arc): one click on the
 * encounter editor's "Generate mob portraits" enumerates the encounter's
 * rulebook-cited creature kinds and generates ONE portrait per mob artifact
 * (n=1), attached as its cover. Portraits then reach the battle tokens
 * through the existing `coverImageId` path — zero BattleSurface changes.
 *
 * A deliberate variant of the entity image queue (08 §M4-C) with the SAME
 * mechanics — pump with `maxParallelRequests` workers, intake, the shared
 * `buildImagePrompt` contract, attach-as-cover, skip-if-imaged, loud
 * per-mob toasts (EntityBatchFailure {name, message} style) — but keyed by
 * **artifactId**: the queue's wiki-link name resolution does not fit mob
 * artifacts, and prompt grounding is the creature chunk's stat-block text
 * (a fresh mob artifact has empty appearance/body — the chunk is the only
 * source; the artifact's own `appearance` shortcut still wins when the user
 * filled it). Never rides the persona run pipeline (the Illustrator's pick
 * step always pauses; an unattended batch cannot).
 *
 * The pump/dedupe/cancellation/failed-retry/dock-counter machinery is the
 * shared `createJobQueue` factory (F6) — this module is the config plus the
 * per-job body. Like every queue on the factory, it does NOT survive a
 * reload (in-memory by design; see createJobQueue's docs).
 *
 * Global portrait cache (docs/11 D5 amendment, slice A): canonical citations
 * (the citing entry used the chunk's canonical name) generate ONCE through
 * the cache worker (`mob-portrait-cache-queue`, cross-campaign single-flight)
 * and publish into the global slot; every later campaign clones the bytes
 * instead of generating. Flavored citations generate locally and never touch
 * the cache — neither read nor write.
 */

export interface MobPortraitJob {
  campaignId: Id;
  /** The encounter that owns the roster — groups the progress-dock job.
   * Undefined for the creation-dialog portrait extra (a single artifact,
   * grouped by the artifact itself). */
  encounterId?: Id;
  /** The mob artifact to illustrate (ONE per creature kind per campaign). */
  artifactId: Id;
  /** Display name (the roster creature name) for progress + failures. */
  name: string;
  /** The creature's stat-block chunk — grounds the prompt. Undefined for
   * the creation-dialog portrait extra, which grounds on the artifact's own
   * data (name/summary/body + the appearance shortcut). */
  chunkId?: Id;
}

export const useMobPortraitQueue = createJobQueue<MobPortraitJob>({
  name: 'mob-portrait-queue',
  key: (job) => `${job.campaignId}:${job.artifactId}`,
  dockGroup: (job) => ({ id: jobIdFor(job), label: 'Generating mob portraits' }),
  activeDetail: (job) => `Illustrating "${job.name}"…`,
  settledDetail: (job, outcome) =>
    outcome === 'done' ? `Illustrated "${job.name}"` : `Skipped "${job.name}"`,
  failureTitle: (job) => `Could not generate a portrait for "${job.name}"`,
  workerCount: async () => {
    const settings = await getSettings();
    return Math.max(1, settings.maxParallelRequests);
  },
  process: processJob,
});

function jobIdFor(job: MobPortraitJob): string {
  return job.encounterId === undefined
    ? `artifact-portrait-${job.artifactId}`
    : `encounter-mob-portraits-${job.encounterId}`;
}

async function processJob(
  job: MobPortraitJob,
  ctx: { signal: AbortSignal },
): Promise<'done' | 'skipped'> {
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
  const summary = artifact.summary;
  let body: string;
  if (job.chunkId !== undefined) {
    const chunk = (await getChunksByIds([job.chunkId]))[0];
    if (chunk === undefined) {
      throw new Error('the creature\u2019s stat-block chunk no longer exists');
    }
    if (chunk.text.trim() === '') {
      throw new Error('the creature\u2019s stat-block chunk has no text to ground the prompt');
    }
    // Canonical citation (docs/11 D5 amendment, slice A): the citing entry
    // used the chunk's canonical name, so the single normal generation
    // serves BOTH the cover and the global cache slot — generate once via
    // the cache worker (cross-campaign single-flight), then clone the bytes
    // into this artifact's cover. A flavored citation falls through to the
    // local-only path below: its flavored cover and NOTHING ELSE (no cache
    // write, no overwrite, no behind-the-back canonical generation).
    const canonical = canonicalCreatureName(chunk);
    if (canonical !== null && isCanonicalCitation(canonical, job.name)) {
      const ensured = await ensureCanonicalMobPortrait({
        chunkId: job.chunkId,
        campaignId: job.campaignId,
        signal: ctx.signal,
      });
      const outcome = await cloneCachedPortraitToArtifact({
        artifactId: artifact.id,
        campaignId: job.campaignId,
        imageId: ensured.imageId,
      });
      return outcome === 'cloned' ? 'done' : 'skipped';
    }
    // Grounding: the creature chunk's stat-block text — the only
    // description a fresh mob artifact has.
    body = chunk.text;
  } else {
    // Creation-dialog portrait extra: the artifact's own content grounds
    // the prompt (the appearance shortcut still wins inside the shared
    // contract). Empty summary AND body throw in buildImagePrompt —
    // a blank image of nothing is a placeholder, never a fallback.
    body = artifact.body;
  }
  const prompt = await draftPrompt(artifact, summary, body, job.campaignId);
  const finalPrompt = assembleImagePrompt(prompt);
  // n=1 (owner-ratified): one portrait per creature kind — candidate-count
  // caps (imageGen's n-retry, cappedToOne) cannot trigger on this path.
  const generated = await generateImages(finalPrompt, 1, {
    model: settings.imageModel,
    signal: ctx.signal,
  });
  const blob = generated.images[0];
  if (blob === undefined) throw new Error('the image API returned no image');
  const intake = await intakeImage(blob);
  // Store + attach (as cover) is ONE repo transaction — a crash between
  // the image write and the artifact update must not leak the blob as an
  // unreferenced orphan or leave the artifact pointing at nothing.
  await attachImagesToArtifact(artifact.id, {
    createImages: [
      {
        campaignId: job.campaignId,
        blob: intake.blob,
        mimeType: intake.mimeType,
        width: intake.width,
        height: intake.height,
        prompt: finalPrompt,
        model: generated.modelUsed,
        source: 'generated',
        // The skip branch above guarantees the artifact had no image yet.
        asCover: true,
      },
    ],
  });
  return 'done';
}

/** Prompt-draft for one mob artifact — the shared Illustrator prompt contract
 * (buildImagePrompt: appearance shortcut, body/summary/name grounding) with
 * the queue's wiring: no run row, the campaign's rule system for the style
 * hint, and the grounding text as the description (the creature chunk's
 * stat-block text, or — for the creation-dialog portrait extra — the
 * artifact's own content). Deterministic: no chat call, no repair retry. */
async function draftPrompt(
  artifact: AnyArtifact,
  summary: string,
  body: string,
  campaignId: Id,
): Promise<ImagePromptDraft> {
  let systemLabel = 'D&D 5e';
  const campaign = await getCampaign(campaignId);
  if (campaign !== undefined) {
    systemLabel = GAME_SYSTEM_LABELS[campaign.system];
  }
  return buildImagePrompt(
    {
      name: artifact.name,
      kind: artifact.kind,
      summary,
      body,
      data: artifact.data,
    },
    { systemLabel },
  );
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
 *
 * Cache-first (docs/11 D5 amendment, slice A): the get-or-create carries the
 * portrait read-through, so a canonical citation whose slot is already
 * populated arrives WITH its cloned cover and is enumerated away as
 * already-imaged — no job, no second generation. A cache miss enqueues
 * normally; the worker's canonical branch generates once and publishes.
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
      (await getOrCreateMobArtifact(campaignId, entry.source.chunkId, entry.name, undefined, undefined, {
        fillCoverFromCache: true,
      }));
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

/**
 * The creation-dialog "Generate a cover image" extra (ratified): ONE
 * artifact-keyed portrait job with the SAME mechanics as the batch —
 * attach-as-cover, skip-if-imaged, loud per-artifact toasts — grounded on
 * the artifact's own content. Works for every artifact kind.
 */
export function enqueueArtifactPortrait(artifact: AnyArtifact, campaignId: Id): void {
  useMobPortraitQueue.getState().enqueue([
    {
      campaignId,
      artifactId: artifact.id,
      name: artifact.name,
    },
  ]);
}
