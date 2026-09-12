import type { Id } from '@/domain';
import type { StoredImage } from '@/domain';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { getCampaign } from '@/db/campaignRepo';
import { getChunksByIds } from '@/db/chunkRepo';
import { buildStoredImage } from '@/db/imageRepo';
import {
  canonicalCreatureName,
  getMobPortraitCacheEntry,
  replaceCanonicalPortrait,
  storeCanonicalPortraitIfAbsent,
} from '@/db/mobPortraitCache';
import { getSettings } from '@/db/settingsRepo';
import { generateImages } from '@/llm/imageGen';
import {
  assembleImagePrompt,
  buildImagePrompt,
  MOB_PORTRAIT_TEXT_NEGATIVE,
  portraitGroundingForChunk,
  type PortraitGroundingChunk,
} from '@/llm/imagePromptDraft';
import { intakeImage } from '@/lib/imageIntake';

/**
 * Mob portrait cache worker (docs/11 D5 amendment, slice A): generate-once
 * for canonical portraits. `ensureCanonicalMobPortrait` returns the cache
 * slot's shared-blob imageId, generating (n=1) and publishing it when the
 * slot is empty.
 *
 * Cross-campaign locking is a single-flight pending map keyed by creature
 * identity (the same key the cache slot uses, docs/11 D6):
 * two campaigns citing one chunk concurrently join the SAME promise, so the
 * image model is called once and the Dexie publish converges on one record
 * (put-if-absent + unique `&creatureKey`, cross-tab ConstraintError included).
 * Callers then CLONE the bytes into their own presentation row or artifact
 * cover — the worker never attaches anywhere itself (one generation, N
 * renders).
 *
 * This is deliberately NOT a `createJobQueue` queue: a factory job has ONE
 * artifact owner, but a cache generation fans out to N awaiting requesters
 * (each with its own dock group and abort signal). Progress keys stay
 * artifactId-based on the mob-portrait queue; this worker reports nothing to
 * the dock. Like every queue body it does NOT survive a reload (in-memory
 * pending map by design — a reload simply re-generates on next request when
 * the slot is still empty).
 *
 * CANONICAL-ONLY (binding): the prompt grounds on the chunk's stat-exempt
 * portrait grounding (`portraitGroundingForChunk`) plus the chunk's
 * canonical creature name — never roster/artifact flavor. The ONLY
 * caller is the mob-portrait queue's canonical branch; flavored citations
 * never reach this module.
 */

export interface EnsureCanonicalPortrait {
  /** The creature IDENTITY (docs/11 D6) — the cache slot's key. */
  creatureKey: string;
  /** The citation's chunk — the prompt's grounding text. */
  chunkId: Id;
  campaignId: Id;
  signal?: AbortSignal | undefined;
}

export interface EnsuredPortrait {
  imageId: Id;
  /** false = the slot was already populated (or a concurrent writer won). */
  generated: boolean;
}

/** In-flight canonical generations by creature identity — the cross-campaign
 * lock. */
const pendingGenerations = new Map<string, Promise<EnsuredPortrait>>();

/** Test seam: drops un-settled pending entries (failed generations already
 * clear themselves; a settled entry never lingers past its `finally`). */
export function __clearPendingMobPortraitGenerationsForTests(): void {
  pendingGenerations.clear();
}

export async function ensureCanonicalMobPortrait(
  options: EnsureCanonicalPortrait,
): Promise<EnsuredPortrait> {
  const fastPath = await getMobPortraitCacheEntry(options.creatureKey);
  if (fastPath !== undefined) return { imageId: fastPath.imageId, generated: false };
  const pending = pendingGenerations.get(options.creatureKey);
  if (pending !== undefined) return joinPending(options, pending);
  const owned = generateAndPublish(options);
  pendingGenerations.set(options.creatureKey, owned);
  try {
    return await owned;
  } finally {
    if (pendingGenerations.get(options.creatureKey) === owned) {
      pendingGenerations.delete(options.creatureKey);
    }
  }
}

/**
 * A joiner awaits the shared generation but keeps its own cancellation: an
 * abort withdraws THIS caller (AbortError) without cancelling work other
 * campaigns are awaiting. The owner (who created the entry) drives the real
 * abort through `generateImages` instead.
 */
async function joinPending(
  options: EnsureCanonicalPortrait,
  pending: Promise<EnsuredPortrait>,
): Promise<EnsuredPortrait> {
  const signal = options.signal;
  if (signal === undefined) return pending;
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  let rejectAbort: ((reason: DOMException) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    rejectAbort?.(new DOMException('Aborted', 'AbortError'));
  };
  signal.addEventListener('abort', onAbort);
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function generateAndPublish(options: EnsureCanonicalPortrait): Promise<EnsuredPortrait> {
  const loaded = await loadCanonicalInputs(options);
  // Double-checked read: a generation that overlapped this one's chunk load
  // may have published while the prompt inputs were read.
  const reread = await getMobPortraitCacheEntry(options.creatureKey);
  if (reread !== undefined) return { imageId: reread.imageId, generated: false };
  const prepared = await generateFreshCanonicalImage(options, loaded);
  const published = await storeCanonicalPortraitIfAbsent(options.creatureKey, prepared);
  return { imageId: published.imageId, generated: published.stored };
}

/**
 * Owner-ordered portrait regeneration (docs/11 D5 amendment): generates
 * FRESH bytes for the chunk's canonical portrait and REPUBLISHES the global
 * slot via `replaceCanonicalPortrait` — the ONLY fresh-generation path, and
 * the only caller of the unconditional slot writer.
 *
 * No fast-path read and no put-if-absent: regen always spends one image
 * generation. Deliberately outside the `pendingGenerations` single-flight
 * (an explicit rare user action; the unconditional republish converges
 * last-writer-wins, and an overlapping normal generation converges on the
 * fresh row through its own put-if-absent). The caller's imaged covers are
 * REPLACED delete-after-replace by the regen jobs the entry enqueues
 * (force-cloned from the new slot) — never detached first, so a dropped
 * queue leaves every old portrait intact.
 */
export async function regenerateCanonicalMobPortrait(
  options: EnsureCanonicalPortrait,
): Promise<{ imageId: Id; supersededImageId: Id | null }> {
  // No fast-path read and no put-if-absent: regen always spends one image
  // generation on FRESH bytes (a plain re-enqueue would clone identical
  // bytes — a no-op regen) and unconditionally republishes the slot.
  const loaded = await loadCanonicalInputs(options);
  const prepared = await generateFreshCanonicalImage(options, loaded);
  return replaceCanonicalPortrait(options.creatureKey, prepared);
}

interface CanonicalInputs {
  canonical: string;
  chunk: PortraitGroundingChunk;
}

/** Shared input load: settings + chunk + canonical-name checks (no image
 * budget spent). Loud on every failure (AGENTS rule 1): regen validates
 * BEFORE enqueueing, so a throw here leaves the old covers intact. */
async function loadCanonicalInputs(options: EnsureCanonicalPortrait): Promise<CanonicalInputs> {
  const settings = await getSettings();
  if (!settings.imagesEnabled) {
    throw new Error('Image generation is disabled — enable it in Settings');
  }
  const chunk = (await getChunksByIds([options.chunkId]))[0];
  if (chunk === undefined) {
    throw new Error('the creature\u2019s stat-block chunk no longer exists');
  }
  if (chunk.text.trim() === '') {
    throw new Error('the creature\u2019s stat-block chunk has no text to ground the prompt');
  }
  const canonical = canonicalCreatureName(chunk);
  if (canonical === null) {
    throw new Error('the creature\u2019s stat-block chunk has no name to ground a canonical portrait');
  }
  return { canonical, chunk };
}

/** Shared fresh-byte generation: canonical prompt draft, n=1 generation,
 * intake, global-scope row preparation (bytes + parse BEFORE any publish
 * transaction opens — the Dexie async-transaction trap). */
async function generateFreshCanonicalImage(
  options: EnsureCanonicalPortrait,
  loaded: CanonicalInputs,
): Promise<StoredImage> {
  const settings = await getSettings();
  const finalPrompt = assembleImagePrompt(
    await draftCanonicalPrompt(loaded.canonical, loaded.chunk, options.campaignId),
  );
  // n=1 (owner-ratified): one portrait per creature kind.
  const generated = await generateImages(finalPrompt, 1, {
    model: settings.imageModel,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const blob = generated.images[0];
  if (blob === undefined) throw new Error('the image API returned no image');
  const intake = await intakeImage(blob);
  // Byte preparation is NOT Dexie work (the async-transaction trap) — it
  // happens before the publish transaction opens; the repo owns the
  // put/replace inside it.
  return buildStoredImage({
    campaignId: null,
    blob: intake.blob,
    mimeType: intake.mimeType,
    width: intake.width,
    height: intake.height,
    prompt: finalPrompt,
    model: generated.modelUsed,
    source: 'generated',
  });
}

/** Canonical prompt draft — the shared Illustrator contract grounded on the
 * chunk's STAT-EXEMPT portrait grounding (`portraitGroundingForChunk`: size +
 * type identity plus traits/actions prose, never raw stat numbers) under the
 * chunk's canonical creature name, with the text-render negative. Only an
 * unparsed chunk (null statBlock) falls back to raw `chunk.text` — the loud
 * residual render risk documented on the helper.
 * Deterministic: no chat call, no repair retry (owner amendment). */
async function draftCanonicalPrompt(
  canonicalName: string,
  chunk: PortraitGroundingChunk,
  campaignId: Id,
) {
  let systemLabel = 'D&D 5e';
  const campaign = await getCampaign(campaignId);
  if (campaign !== undefined) {
    systemLabel = GAME_SYSTEM_LABELS[campaign.system];
  }
  return buildImagePrompt(
    {
      name: canonicalName,
      kind: 'npc',
      summary: '',
      body: portraitGroundingForChunk(chunk),
      data: null,
    },
    { systemLabel, negative: MOB_PORTRAIT_TEXT_NEGATIVE },
  );
}
