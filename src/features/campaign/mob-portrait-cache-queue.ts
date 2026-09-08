import type { Id } from '@/domain';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { getCampaign } from '@/db/campaignRepo';
import { getChunksByIds } from '@/db/chunkRepo';
import { buildStoredImage } from '@/db/imageRepo';
import {
  canonicalCreatureName,
  getMobPortraitCacheEntry,
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
 * Cross-campaign locking is a single-flight pending map keyed by chunkId:
 * two campaigns citing one chunk concurrently join the SAME promise, so the
 * image model is called once and the Dexie publish converges on one record
 * (put-if-absent + unique `&chunkId`, cross-tab ConstraintError included).
 * Callers then CLONE the bytes into their own artifact covers — the worker
 * never attaches to an artifact itself (one generation, N covers).
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
  chunkId: Id;
  campaignId: Id;
  signal?: AbortSignal | undefined;
}

export interface EnsuredPortrait {
  imageId: Id;
  /** false = the slot was already populated (or a concurrent writer won). */
  generated: boolean;
}

/** In-flight canonical generations by chunkId — the cross-campaign lock. */
const pendingGenerations = new Map<Id, Promise<EnsuredPortrait>>();

/** Test seam: drops un-settled pending entries (failed generations already
 * clear themselves; a settled entry never lingers past its `finally`). */
export function __clearPendingMobPortraitGenerationsForTests(): void {
  pendingGenerations.clear();
}

export async function ensureCanonicalMobPortrait(
  options: EnsureCanonicalPortrait,
): Promise<EnsuredPortrait> {
  const fastPath = await getMobPortraitCacheEntry(options.chunkId);
  if (fastPath !== undefined) return { imageId: fastPath.imageId, generated: false };
  const pending = pendingGenerations.get(options.chunkId);
  if (pending !== undefined) return joinPending(options, pending);
  const owned = generateAndPublish(options);
  pendingGenerations.set(options.chunkId, owned);
  try {
    return await owned;
  } finally {
    if (pendingGenerations.get(options.chunkId) === owned) {
      pendingGenerations.delete(options.chunkId);
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
  // Double-checked read: a generation that overlapped this one's chunk load
  // may have published while the prompt inputs were read.
  const reread = await getMobPortraitCacheEntry(options.chunkId);
  if (reread !== undefined) return { imageId: reread.imageId, generated: false };
  const finalPrompt = assembleImagePrompt(await draftCanonicalPrompt(canonical, chunk, options.campaignId));
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
  // put-if-absent inside it.
  const prepared = await buildStoredImage({
    campaignId: null,
    blob: intake.blob,
    mimeType: intake.mimeType,
    width: intake.width,
    height: intake.height,
    prompt: finalPrompt,
    model: generated.modelUsed,
    source: 'generated',
  });
  const published = await storeCanonicalPortraitIfAbsent(options.chunkId, prepared);
  return { imageId: published.imageId, generated: published.stored };
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
