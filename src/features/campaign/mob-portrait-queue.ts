import type { AnyArtifact, Id } from '@/domain';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { getAnyArtifact, attachImagesToArtifact, removeImageFromArtifact } from '@/db/artifactRepo';
import { getCampaign } from '@/db/campaignRepo';
import { getChunksByIds } from '@/db/chunkRepo';
import { getOrCreateMobArtifact, materializeInventedCreatureArtifact } from '@/db/mobArtifacts';
import {
  canonicalCreatureName,
  cloneCachedPortraitToArtifact,
  isCanonicalCitation,
} from '@/db/mobPortraitCache';
import { getSettings } from '@/db/settingsRepo';
import { generateImages } from '@/llm/imageGen';
import {
  assembleImagePrompt,
  buildImagePrompt,
  MOB_PORTRAIT_TEXT_NEGATIVE,
  portraitGroundingForChunk,
} from '@/llm/imagePromptDraft';
import type { ImagePromptDraft } from '@/llm/schemas';
import { createJobQueue } from '@/lib/jobQueue';
import { intakeImage } from '@/lib/imageIntake';
import { ensureCanonicalMobPortrait, regenerateCanonicalMobPortrait } from '@/features/campaign/mob-portrait-cache-queue';

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
 * artifacts, and prompt grounding is the creature chunk's stat-exempt portrait grounding (`portraitGroundingForChunk`)
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
 *
 * Single-mob entry points (battle surface selection card, docs/11 D5): the
 * same queue and the same regen phases for ONE already-resolved target
 * (`enqueueSingleMobPortrait` / `regenerateSingleMobPortrait`) — no second
 * pipeline, no second detach path.
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
  // Chunk-grounded jobs (rulebook citations) carry the text-render
  // negative; the creation-dialog extra grounds on user content and stays
  // out of that scope.
  let chunkGrounded: boolean;
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
    // Grounding: the creature chunk's STAT-EXEMPT portrait grounding
    // (portraitGroundingForChunk — size/type identity + traits/actions
    // prose, never raw stat numbers) — the only description a fresh mob
    // artifact has. The text-render negative rides along (belt and braces:
    // models must not letter stat text into the portrait).
    body = portraitGroundingForChunk(chunk);
    chunkGrounded = true;
  } else {
    // Creation-dialog portrait extra: the artifact's own content grounds
    // the prompt (the appearance shortcut still wins inside the shared
    // contract). Empty summary AND body throw in buildImagePrompt —
    // a blank image of nothing is a placeholder, never a fallback.
    body = artifact.body;
    chunkGrounded = false;
  }
  const prompt = await draftPrompt(artifact, summary, body, job.campaignId, {
    negative: chunkGrounded ? MOB_PORTRAIT_TEXT_NEGATIVE : undefined,
  });
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
 * hint, and the grounding text as the description (the chunk's stat-exempt
 * portrait grounding, or — for the creation-dialog portrait extra — the
 * artifact's own content, which stays OUT of the text-render-negative scope:
 * user content, not chunk context). Deterministic: no chat call, no repair
 * retry. */
async function draftPrompt(
  artifact: AnyArtifact,
  summary: string,
  body: string,
  campaignId: Id,
  opts?: { negative?: string | undefined },
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
    { systemLabel, negative: opts?.negative },
  );
}

export interface MobPortraitBatchResult {
  /** Cover-less mobs enqueued for generation (deduped by artifact). */
  enqueued: number;
  /** Creature names whose mob artifact already carries an image. */
  alreadyImaged: string[];
}

/**
 * Detaches every image (cover included) from one portrait artifact — the
 * regen primitive both batch flavors share. `removeImageFromArtifact`
 * detaches + scrubs the artifact's revision snapshots + deletes the blob
 * when nothing else references it (refcount-aware: a cover shared with
 * another artifact survives). The old cover is truly freed, never leaked;
 * history shows the entity without the removed cover (docs/11 D5).
 *
 * Between this detach and the fresh cover landing, tokens render initials
 * (the D5 fallback) — the accepted, dialog-stated regen window.
 */
async function detachArtifactCovers(artifactId: Id, displayName: string): Promise<void> {
  const artifact = await getAnyArtifact(artifactId);
  if (artifact === undefined) {
    throw new Error(
      `Regenerate mob portraits: the artifact for "${displayName}" no longer exists — re-run the encounter content to restore it`,
    );
  }
  const coverIds = artifact.coverImageId === null ? [] : [artifact.coverImageId];
  for (const imageId of new Set([...coverIds, ...artifact.imageIds])) {
    await removeImageFromArtifact(artifactId, imageId);
  }
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
 * Owner-ordered portrait regeneration for rulebook-cited mobs (docs/11 D5
 * amendment) — THE one way to regen a mob portrait (docs/18). Four phases:
 *
 * 1. Resolve + validate with NO side effects: unknown artifacts and
 *    unreadable chunks throw loud with every old cover still intact.
 * 2. Fresh canonical bytes FIRST: each canonically-cited chunk's global slot
 *    is republished (`regenerateCanonicalMobPortrait` — always generates;
 *    a plain re-enqueue would clone identical bytes, a no-op regen).
 *    Flavored citations skip the cache entirely (local-only invariant).
 * 3. Detach the imaged covers (`detachArtifactCovers`).
 * 4. Enqueue normally — cover-less artifacts flow through the standard skip
 *    branch, canonical jobs clone the NEW slot bytes, flavored generate
 *    locally. (Unstamped old rows may read-through-clone the fresh bytes
 *    synchronously instead of queueing — same fresh cover, no job.)
 */
export interface MobPortraitRegenResult {
  /** Imaged mob artifacts detached and re-covered (deduped by artifact). */
  regenerated: number;
  /** Citing names whose canonical global slot now carries fresh bytes. */
  republishedCanonical: string[];
}

export async function regenerateMobPortraits(
  encounter: AnyArtifact & { kind: 'encounter' },
  campaignId: Id,
): Promise<MobPortraitRegenResult> {
  const artifactIdByChunk = new Map<Id, Id>();
  const seenArtifacts = new Set<Id>();
  const imaged: { artifactId: Id; chunkId: Id; name: string }[] = [];
  for (const entry of encounter.data.monsters) {
    if (entry.source.type !== 'rulebook') continue;
    const known = artifactIdByChunk.get(entry.source.chunkId);
    const artifactId =
      known ??
      entry.source.mobArtifactId ??
      // Pure resolve (NO read-through: cloning here would defeat the detach).
      (await getOrCreateMobArtifact(campaignId, entry.source.chunkId, entry.name));
    artifactIdByChunk.set(entry.source.chunkId, artifactId);
    // One portrait per creature kind, not per roster entry.
    if (seenArtifacts.has(artifactId)) continue;
    seenArtifacts.add(artifactId);
    const artifact = await getAnyArtifact(artifactId);
    if (artifact === undefined) {
      throw new Error(
        `Regenerate mob portraits: the artifact for "${entry.name}" no longer exists — re-run the encounter content to restore it`,
      );
    }
    if (artifact.coverImageId === null && artifact.imageIds.length === 0) continue;
    imaged.push({ artifactId, chunkId: entry.source.chunkId, name: entry.name });
  }
  const republishedCanonical: string[] = [];
  const republishedChunks = new Set<Id>();
  for (const target of imaged) {
    const chunk = (await getChunksByIds([target.chunkId]))[0];
    if (chunk === undefined) {
      throw new Error(
        `Regenerate mob portraits: the stat-block chunk for "${target.name}" no longer exists — kept the existing cover`,
      );
    }
    const canonical = canonicalCreatureName(chunk);
    if (
      canonical !== null &&
      isCanonicalCitation(canonical, target.name) &&
      !republishedChunks.has(target.chunkId)
    ) {
      republishedChunks.add(target.chunkId);
      await regenerateCanonicalMobPortrait({ chunkId: target.chunkId, campaignId });
      republishedCanonical.push(target.name);
    }
  }
  for (const target of imaged) {
    await detachArtifactCovers(target.artifactId, target.name);
  }
  await enqueueMobPortraits(encounter, campaignId);
  return { regenerated: imaged.length, republishedCanonical };
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

/**
 * A single rulebook-cited mob, resolved by a caller that already holds the
 * identity (the battle surface's selection card resolves its token →
 * mob artifact via `data.monsterChunkId`, preferring the provenance
 * encounter's roster entry name for the canonical-vs-flavor citation and
 * falling back to the artifact name).
 */
export interface SingleMobPortraitTarget {
  campaignId: Id;
  /** The mob artifact to illustrate (npc with a `monsterChunkId` marker). */
  artifactId: Id;
  /** The cited stat-block chunk — grounds the prompt, stat-exempt. */
  chunkId: Id;
  /** The citing name (roster entry or artifact name) for the
   * canonical-vs-flavor citation check the worker performs. */
  name: string;
}

/**
 * The battle-card "Generate portrait" action: ONE chunk-grounded job through
 * the SAME queue as the editor batch — same dock group shape, same
 * artifact-keyed dedupe, same skip-if-imaged worker branch, same loud
 * per-mob failure path. Silent at enqueue time exactly like the batch (the
 * app-wide progress dock carries the feedback).
 */
export function enqueueSingleMobPortrait(target: SingleMobPortraitTarget): void {
  const name = target.name.trim();
  if (name === '') {
    throw new Error('mob portrait: the citing name is empty — name the creature before generating');
  }
  useMobPortraitQueue.getState().enqueue([
    {
      campaignId: target.campaignId,
      artifactId: target.artifactId,
      name,
      chunkId: target.chunkId,
    },
  ]);
}

export interface SingleMobPortraitRegenResult {
  /** False when the cover landed elsewhere between the card read and Confirm
   * (the worker's skip branch would no-op) — the caller replays the
   * already-generated toast instead of detaching nothing. */
  regenerated: boolean;
  /** True when the citation is canonical and the global slot now carries
   * fresh bytes (the caller owes the loud shared-consequence toast). */
  republishedCanonical: boolean;
}

/**
 * The battle-card "Regenerate portrait" action — the single-mob flavor of
 * `regenerateMobPortraits` (docs/18: detach-then-enqueue is the one way).
 * Same four phases on ONE target: resolve + validate with NO side effects
 * (unknown artifact / unreadable chunk throw loud with the old cover
 * intact), republish the canonical slot with FRESH bytes first for canonical
 * citations (flavored citations stay local-only), detach the imaged covers,
 * then enqueue normally (canonical clones the NEW slot bytes, flavored
 * generates locally).
 */
export async function regenerateSingleMobPortrait(
  target: SingleMobPortraitTarget,
): Promise<SingleMobPortraitRegenResult> {
  const name = target.name.trim();
  if (name === '') {
    throw new Error('mob portrait: the citing name is empty — name the creature before regenerating');
  }
  const artifact = await getAnyArtifact(target.artifactId);
  if (artifact === undefined) {
    throw new Error(
      `Regenerate mob portrait: the artifact for "${name}" no longer exists — re-run the encounter content to restore it`,
    );
  }
  if (artifact.coverImageId === null && artifact.imageIds.length === 0) {
    return { regenerated: false, republishedCanonical: false };
  }
  const chunk = (await getChunksByIds([target.chunkId]))[0];
  if (chunk === undefined) {
    throw new Error(
      `Regenerate mob portrait: the stat-block chunk for "${name}" no longer exists — kept the existing cover`,
    );
  }
  const canonical = canonicalCreatureName(chunk);
  const isCanonical = canonical !== null && isCanonicalCitation(canonical, name);
  if (isCanonical) {
    await regenerateCanonicalMobPortrait({ chunkId: target.chunkId, campaignId: target.campaignId });
  }
  await detachArtifactCovers(target.artifactId, name);
  useMobPortraitQueue.getState().enqueue([
    {
      campaignId: target.campaignId,
      artifactId: target.artifactId,
      name,
      chunkId: target.chunkId,
    },
  ]);
  return { regenerated: true, republishedCanonical: isCanonical };
}

export interface InventedCreatureBatchResult {
  /** On-demand npc artifacts materialized (created or reused) for uncited entries. */
  created: number;
  /** Cover-less invented creatures enqueued for local generation. */
  enqueued: number;
  /** Creature names whose invented artifact already carries an image. */
  alreadyImaged: string[];
}

/**
 * The on-demand invented-creature batch (docs/11 D5 amendment): for the
 * encounter's uncited roster entries (`inline` / `none` — model-invented
 * mobs with no bestiary citation), materializes ONE npc artifact per entry
 * name and enqueues a LOCAL portrait job per cover-less creature.
 *
 * Local-only by construction: the job carries NO chunkId, so the worker
 * grounds the prompt on the artifact's own content (appearance seeded from
 * the entry's notes/treasure) and can never reach the global `mobPortraits`
 * cache — neither read nor write (the canonical-cache firewall,
 * `db/mobPortraitCache`). A failed materialize throws loudly (no silent
 * skip, no placeholder); a failed generation lands on the queue's loud
 * per-mob failure path like every other job.
 *
 * Pass `entryIndexes` for the per-entry action (a single roster row);
 * omit it for batch-all. npc-ref entries already have artifacts and
 * rulebook entries belong to `enqueueMobPortraits` — both are skipped.
 */
export async function enqueueInventedCreaturePortraits(
  encounter: AnyArtifact & { kind: 'encounter' },
  campaignId: Id,
  entryIndexes?: readonly number[],
): Promise<InventedCreatureBatchResult> {
  const only = entryIndexes === undefined ? undefined : new Set(entryIndexes);
  const materialized = new Map<string, Id>();
  const seenArtifacts = new Set<Id>();
  const jobs: MobPortraitJob[] = [];
  const alreadyImaged: string[] = [];
  let created = 0;
  for (const [index, entry] of encounter.data.monsters.entries()) {
    if (only !== undefined && !only.has(index)) continue;
    if (entry.source.type !== 'inline' && entry.source.type !== 'none') continue;
    const artifactId = await materializeInventedCreatureArtifact({
      campaignId,
      encounterId: encounter.id,
      encounterName: encounter.name,
      moduleId: encounter.moduleId,
      name: entry.name,
      notes: entry.notes,
      treasure: entry.treasure,
      statBlock: entry.source.type === 'inline' ? entry.source.statBlock : null,
      cache: materialized,
    });
    created += 1;
    // One portrait per creature kind, not per roster entry.
    if (seenArtifacts.has(artifactId)) continue;
    seenArtifacts.add(artifactId);
    const artifact = await getAnyArtifact(artifactId);
    if (artifact === undefined) {
      throw new Error(
        `Create creature portraits: the artifact for "${entry.name}" no longer exists — re-run the action to restore it`,
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
    });
  }
  useMobPortraitQueue.getState().enqueue(jobs);
  return { created, enqueued: jobs.length, alreadyImaged };
}

export interface InventedCreatureRegenResult {
  /** On-demand npc artifacts materialized (created or reused) for the selection. */
  created: number;
  /** Imaged invented creatures detached and re-enqueued (deduped by artifact). */
  regenerated: number;
}

/**
 * Owner-ordered portrait regeneration for uncited (invented) roster entries
 * (docs/11 D5 amendment) — THE one way to regen an invented cover (docs/18).
 * Materializes (reuses) the selection's npc artifacts, detaches the imaged
 * covers, then enqueues normally as chunk-less local-only jobs (the
 * canonical-cache firewall holds: invented covers never read, populate, or
 * overwrite the global cache — regen included).
 *
 * Pass `entryIndexes` for the per-entry action; omit it for batch-all.
 */
export async function regenerateInventedCreaturePortraits(
  encounter: AnyArtifact & { kind: 'encounter' },
  campaignId: Id,
  entryIndexes?: readonly number[],
): Promise<InventedCreatureRegenResult> {
  const only = entryIndexes === undefined ? undefined : new Set(entryIndexes);
  const materialized = new Map<string, Id>();
  const seenArtifacts = new Set<Id>();
  const imaged: { artifactId: Id; name: string }[] = [];
  let created = 0;
  for (const [index, entry] of encounter.data.monsters.entries()) {
    if (only !== undefined && !only.has(index)) continue;
    if (entry.source.type !== 'inline' && entry.source.type !== 'none') continue;
    const artifactId = await materializeInventedCreatureArtifact({
      campaignId,
      encounterId: encounter.id,
      encounterName: encounter.name,
      moduleId: encounter.moduleId,
      name: entry.name,
      notes: entry.notes,
      treasure: entry.treasure,
      statBlock: entry.source.type === 'inline' ? entry.source.statBlock : null,
      cache: materialized,
    });
    created += 1;
    // One portrait per creature kind, not per roster entry.
    if (seenArtifacts.has(artifactId)) continue;
    seenArtifacts.add(artifactId);
    const artifact = await getAnyArtifact(artifactId);
    if (artifact === undefined) {
      throw new Error(
        `Regenerate creature portraits: the artifact for "${entry.name}" no longer exists — re-run the action to restore it`,
      );
    }
    if (artifact.coverImageId === null && artifact.imageIds.length === 0) continue;
    imaged.push({ artifactId, name: entry.name });
  }
  for (const target of imaged) {
    await detachArtifactCovers(target.artifactId, target.name);
  }
  await enqueueInventedCreaturePortraits(encounter, campaignId, entryIndexes);
  return { created, regenerated: imaged.length };
}
