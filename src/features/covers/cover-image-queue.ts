import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { moduleDocumentText, type Campaign, type Id, type Module, type StoredImage } from '@/domain';
import { getCampaign, updateCampaign } from '@/db/campaignRepo';
import { createImage, deleteImageIfUnreferenced } from '@/db/imageRepo';
import { getModule, patchModule } from '@/db/moduleRepo';
import { getSettings } from '@/db/settingsRepo';
import { buildImagePrompt } from '@/llm/imagePromptDraft';
import { generateOneImage } from '@/llm/oneImage';
import type { ImagePromptDraft } from '@/llm/schemas';
import { createJobQueue } from '@/lib/jobQueue';

/**
 * Module/campaign cover queue (cover-generation arc): unattended cover
 * generation for the module list thumb, the reader header hero, and the
 * campaign picker card. One image per slot (n=1), attached as the slot's
 * `coverImageId` while the user stays fully usable. Progress rides the
 * shared dock; failures are loud toasts and never stop the queue.
 *
 * This deliberately does NOT go through the persona run pipeline: the
 * Illustrator's pick step always pauses for a user decision, which an
 * unattended queue cannot do. The prompt-draft contract (the deterministic
 * `buildImagePrompt`) mirrors runEngine's runPromptDraft one-to-one — no
 * chat call here either.
 *
 * The pump/dedupe/cancellation/failed-retry/dock-counter machinery is the
 * shared `createJobQueue` factory (F6) — this module is the config plus the
 * per-job body. Like every queue on the factory, it does NOT survive a
 * reload (in-memory by design; see createJobQueue's docs).
 *
 * Regen semantics (the preservation slice's delete-after-replace rule): a
 * regen job (`regen: true`) generates FRESH bytes even though the slot is
 * imaged, swaps the cover, and frees ONLY the superseded blob AFTER the
 * fresh cover commits. A failed generation, a skipped job, or an in-memory
 * queue dropped on reload leaves the old cover — blob and slot — intact,
 * with a loud error surfacing on the queue's per-slot failure path. Detach-
 * first is outlawed: the slot is never cleared before its replacement lands.
 */

export interface CoverImageJob {
  /** Which slot this job fills. */
  kind: 'module' | 'campaign';
  /** Owner campaign — the image row's `campaignId` anchor (a module cover
   * anchors to its campaign; a campaign cover anchors to its own id). */
  campaignId: Id;
  /** Module target (kind 'module' only). */
  moduleId?: Id;
  /** Display name (the module title / campaign name) for progress + failures. */
  name: string;
  /** Delete-after-replace regen (see above): absent/false = skip-if-imaged. */
  regen?: boolean;
}

export const useCoverImageQueue = createJobQueue<CoverImageJob>({
  name: 'cover-image-queue',
  key: (job) => (job.kind === 'module' ? `module-cover:${job.moduleId ?? ''}` : `campaign-cover:${job.campaignId}`),
  dockGroup: (job) => ({
    id: job.kind === 'module' ? `module-cover-${job.moduleId ?? ''}` : `campaign-cover-${job.campaignId}`,
    label: job.kind === 'module' ? 'Generating module cover' : 'Generating campaign cover',
  }),
  activeDetail: (job) => `Illustrating "${job.name}"…`,
  settledDetail: (job, outcome) =>
    outcome === 'done' ? `Illustrated "${job.name}"` : `Skipped "${job.name}"`,
  failureTitle: (job) =>
    job.kind === 'module'
      ? `Could not generate a cover for module "${job.name}"`
      : `Could not generate a cover for campaign "${job.name}"`,
  workerCount: async () => {
    const settings = await getSettings();
    return Math.max(1, settings.maxParallelRequests);
  },
  process: processJob,
});

async function processJob(
  job: CoverImageJob,
  ctx: { signal: AbortSignal },
): Promise<'done' | 'skipped'> {
  const settings = await getSettings();
  if (!settings.imagesEnabled) {
    throw new Error('Image generation is disabled — enable it in Settings');
  }
  // Resolve + validate with NO side effects: a slot deleted while its job
  // sat in the queue fails loudly here, never with a dangling reference.
  const target = await resolveTarget(job);
  // A cover may have appeared while the job sat in the queue (upload,
  // another queue run) — no re-generation of imaged slots. Regen jobs
  // (`regen: true`) flow past this branch: they generate FRESH bytes and
  // swap delete-after-replace.
  if (target.coverImageId !== null && job.regen !== true) {
    return 'skipped';
  }
  const prompt = await draftPrompt(target);
  // ONE image, prepared for storage: the seam owns the prompt contract
  // assembly, the n=1 call (and why its candidate-count caps cannot fire),
  // the empty-result refusal and the EXIF-safe intake (docs/18 §2.2).
  const generated = await generateOneImage(prompt, {
    model: settings.imageModel,
    signal: ctx.signal,
  });
  const image = await createImage({
    campaignId: job.campaignId,
    ...generated,
    source: 'generated',
  });
  // Swap the slot, THEN free the superseded blob (regen only): the old
  // cover stays until the fresh one commits, and a failed swap leaves it
  // untouched. A row deleted between resolve and swap throws loudly here
  // (the writer's existence check) — the fresh blob stays an unreferenced
  // orphan until the next prune sweep, never a dangling slot.
  const previous = target.coverImageId;
  await attachCover(job, image);
  if (job.regen === true && previous !== null && previous !== image.id) {
    await deleteImageIfUnreferenced(previous);
  }
  return 'done';
}

type CoverTarget = { kind: 'module'; row: Module; coverImageId: Id | null } | { kind: 'campaign'; row: Campaign; coverImageId: Id | null };

async function resolveTarget(job: CoverImageJob): Promise<CoverTarget> {
  if (job.kind === 'module') {
    if (job.moduleId === undefined) {
      throw new Error('cover generation: the module job carries no module id');
    }
    const module = await getModule(job.moduleId);
    if (module === undefined) {
      throw new Error(
        `cover generation: module "${job.name}" no longer exists — it was deleted while its cover was still queued`,
      );
    }
    return { kind: 'module', row: module, coverImageId: module.coverImageId };
  }
  const campaign = await getCampaign(job.campaignId);
  if (campaign === undefined) {
    throw new Error(
      `cover generation: campaign "${job.name}" no longer exists — it was deleted while its cover was still queued`,
    );
  }
  return { kind: 'campaign', row: campaign, coverImageId: campaign.coverImageId };
}

/**
 * The cover writer: points the slot at an already-stored image row. The
 * loud existence check (AGENTS rule 1) refuses a row deleted mid-flight —
 * a dangling `coverImageId` pointing at a removed row is impossible to
 * create through this pathway (`patchModule`/`updateCampaign` throw
 * NotFoundError on a missing row).
 */
export async function attachCover(job: CoverImageJob, image: StoredImage): Promise<void> {
  if (job.kind === 'module') {
    if (job.moduleId === undefined) {
      throw new Error('cover generation: the module job carries no module id');
    }
    await patchModule(job.moduleId, { coverImageId: image.id });
    return;
  }
  await updateCampaign(job.campaignId, { coverImageId: image.id });
}

/** Prompt-draft for one cover slot — the shared Illustrator prompt contract
 * (buildImagePrompt: appearance shortcut, body/summary/name grounding) with
 * the queue's wiring: no run row, and the owning campaign's rule system for
 * the style hint. Deterministic: no chat call, no repair retry.
 *
 * Prompt fill: a module grounds on its title + concept (summary) + the full
 * document text (premise + parts via `moduleDocumentText`); a campaign
 * grounds on its name + description. Empty grounding throws in
 * buildImagePrompt — a blank image of nothing is a placeholder, never a
 * fallback (AGENTS rule 1: describe the slot first). */
async function draftPrompt(target: CoverTarget): Promise<ImagePromptDraft> {
  if (target.kind === 'module') {
    const campaign = await getCampaign(target.row.campaignId);
    const systemLabel =
      campaign === undefined ? 'D&D 5e' : GAME_SYSTEM_LABELS[campaign.system];
    return buildImagePrompt(
      {
        name: target.row.title,
        kind: 'module',
        summary: target.row.concept,
        body: moduleDocumentText(target.row),
        data: {},
      },
      { systemLabel },
    );
  }
  return buildImagePrompt(
    {
      name: target.row.name,
      kind: 'campaign',
      summary: target.row.description,
      body: '',
      data: {},
    },
    { systemLabel: GAME_SYSTEM_LABELS[target.row.system] },
  );
}

/**
 * Enqueues delete-after-replace regen jobs, upgrading any stale queued or
 * in-flight normal job for the same slot FIRST. The queue dedupes by slot
 * key: a regen dropped against a stale normal job would strand the regen
 * as a silent no-op (the normal job skips on the still-imaged slot and
 * drains). The stale job is withdrawn before the regen is enqueued — it
 * never committed cover work over an imaged slot (the skip branch), so
 * withdrawing it destroys nothing. State is probed first so the dock
 * counters move only when a real job is withdrawn.
 */
function enqueueRegenJobs(jobs: CoverImageJob[]): void {
  const state = useCoverImageQueue.getState();
  const keys = new Set(jobs.map((job) => coverJobKey(job)));
  const stale = [...state.queued, ...state.active].filter((queued) =>
    keys.has(coverJobKey(queued)),
  );
  for (const job of stale) state.dequeue(job);
  state.enqueue(jobs.map((job) => ({ ...job, regen: true })));
}

function coverJobKey(job: CoverImageJob): string {
  return job.kind === 'module' ? `module-cover:${job.moduleId ?? ''}` : `campaign-cover:${job.campaignId}`;
}

/** Enqueues a module cover generation (skip-if-imaged at work time). */
export function enqueueModuleCover(moduleId: Id, campaignId: Id, name: string): void {
  useCoverImageQueue.getState().enqueue([{ kind: 'module', campaignId, moduleId, name }]);
}

/** Enqueues a module cover REGENERATION (delete-after-replace). */
export function regenerateModuleCover(moduleId: Id, campaignId: Id, name: string): void {
  enqueueRegenJobs([{ kind: 'module', campaignId, moduleId, name }]);
}

/** Enqueues a campaign cover generation (skip-if-imaged at work time). */
export function enqueueCampaignCover(campaignId: Id, name: string): void {
  useCoverImageQueue.getState().enqueue([{ kind: 'campaign', campaignId, name }]);
}

/** Enqueues a campaign cover REGENERATION (delete-after-replace). */
export function regenerateCampaignCover(campaignId: Id, name: string): void {
  enqueueRegenJobs([{ kind: 'campaign', campaignId, name }]);
}
