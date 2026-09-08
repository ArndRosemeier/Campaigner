import {
  imageBlob,
  mobPortraitCacheSchema,
  newId,
  ruleChunkSchema,
  stampNewEntity,
  type Id,
  type MobPortraitCacheEntry,
  type MonsterSource,
  type StoredImage,
} from '@/domain';
import { attachImagesToArtifact, getAnyArtifact } from '@/db/artifactRepo';
import { db } from '@/db/db';

/**
 * Global mob portrait cache repo (docs/11 D5 amendment, slice A): the Dexie
 * side of the `mobPortraits` table (v18, `id, &chunkId`). Core/external
 * bestiary creatures ONLY — module-generated NPCs never reach this seam
 * (every entry point gates on `cacheKeyForMonsterSource` first).
 *
 * Layer note: chunk reads go through `db.chunks` directly (parse-on-read)
 * rather than `chunkRepo` — chunkRepo couples writes to the search keyword
 * index, and `src/db` must not import `src/search` (layer map, docs/18).
 */

/** Parse-on-read for cache rows (the ratified `parseBattleRow` template). */
function parseCacheRow(row: MobPortraitCacheEntry): MobPortraitCacheEntry {
  return mobPortraitCacheSchema.parse(row);
}

/**
 * The firewall gate (D7): ONLY a `rulebook` monster source with a defined
 * chunkId may touch the cache seam. npc-ref / inline / none sources — and a
 * rulebook source whose chunkId is missing at runtime — resolve to null, and
 * every cache entry point returns early on null. Module-NPC artifacts (npc
 * kind WITHOUT the `monsterChunkId` marker, imaged through the entity queue)
 * never present a rulebook source, so they can never produce a key.
 */
export function cacheKeyForMonsterSource(source: MonsterSource): Id | null {
  if (source.type !== 'rulebook') return null;
  const chunkId: unknown = (source as { chunkId?: unknown }).chunkId;
  return typeof chunkId === 'string' && chunkId !== '' ? chunkId : null;
}

/**
 * The chunk's canonical creature name: the LAST non-empty `headingPath`
 * element. Pack creature imports write `headingPath: [name]` and pack
 * section imports `[...categories, name]`; PDF chunker paths run general →
 * specific — in every lane the last element is the creature's own name.
 * Null when no usable heading exists (the caller treats the citation as
 * flavor-unknowable: local generation, never a cache write).
 */
export function canonicalCreatureName(chunk: { headingPath: readonly string[] }): string | null {
  for (let index = chunk.headingPath.length - 1; index >= 0; index -= 1) {
    const segment = chunk.headingPath[index]?.trim();
    if (segment !== undefined && segment !== '') return segment;
  }
  return null;
}

/** Canonical citation = the citing name matches the canonical name
 * (trimmed, case-insensitive). Anything else is flavor. */
export function isCanonicalCitation(canonicalName: string, citingName: string): boolean {
  return canonicalName.trim().toLowerCase() === citingName.trim().toLowerCase();
}

/** The cache record for one chunk, when the slot is populated. */
export async function getMobPortraitCacheEntry(
  chunkId: Id,
): Promise<MobPortraitCacheEntry | undefined> {
  const row = await db.mobPortraits.where('chunkId').equals(chunkId).first();
  return row === undefined ? undefined : parseCacheRow(row);
}

/** Every cached image id — the prune-immunity set (D2). */
export async function cachedMobPortraitImageIds(): Promise<Set<Id>> {
  const rows = await db.mobPortraits.toArray();
  return new Set(rows.map((row) => parseCacheRow(row).imageId));
}

/** Whether an image row is the shared blob behind a cache record. */
export async function isMobPortraitCachedImage(imageId: Id): Promise<boolean> {
  // `imageId` carries no index (the table keys on `&chunkId`); the table
  // holds one row per cited chunk, so a filtered scan is the honest read.
  const row = await db.mobPortraits.filter((entry) => entry.imageId === imageId).first();
  return row !== undefined;
}

export interface PublishResult {
  imageId: Id;
  /** false = another writer won the slot first; its record stands (no overwrite). */
  stored: boolean;
}

/**
 * Publishes a prepared global-scope (`campaignId: null`) image row into the
 * cache slot — put-if-absent in ONE transaction over images + mobPortraits.
 * The row MUST be prepared (bytes + schema parse) BEFORE this call: awaiting
 * `blob.arrayBuffer()` inside the scope would commit it early (the Dexie
 * async-transaction trap). A concurrent winner (cross-tab: the unique
 * `&chunkId` index throws ConstraintError) is converged on, never
 * overwritten — the loser's prepared row was never stored (the put aborts
 * with the transaction), so no orphan is left behind.
 */
export async function storeCanonicalPortraitIfAbsent(
  chunkId: Id,
  prepared: StoredImage,
): Promise<PublishResult> {
  if (prepared.campaignId !== null) {
    throw new Error('mob portrait cache: only global-scope (campaignId null) images may be cached');
  }
  try {
    return await db.transaction('rw', [db.images, db.mobPortraits], async () => {
      const existing = await db.mobPortraits.where('chunkId').equals(chunkId).first();
      if (existing !== undefined) return { imageId: parseCacheRow(existing).imageId, stored: false };
      await db.images.put(prepared);
      const entry = parseCacheRow({ ...stampNewEntity(), id: newId(), chunkId, imageId: prepared.id });
      await db.mobPortraits.put(entry);
      return { imageId: prepared.id, stored: true };
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'ConstraintError') {
      const winner = await getMobPortraitCacheEntry(chunkId);
      if (winner !== undefined) return { imageId: winner.imageId, stored: false };
    }
    throw error;
  }
}

export interface ReplaceResult {
  imageId: Id;
  /** The previous slot image, deleted in the same transaction — null when the slot was empty. */
  supersededImageId: Id | null;
}

/**
 * Republishes the canonical slot with FRESH bytes — the ONLY unconditional
 * slot writer (owner-ordered portrait regeneration, docs/11 D5 amendment).
 * `storeCanonicalPortraitIfAbsent` stays put-if-absent for first-time
 * generations; THIS function is the regen path and must never be called
 * outside an explicit user regenerate (a plain re-enqueue would clone
 * identical bytes — a no-op regen).
 *
 * The superseded global row is deleted in the SAME transaction: it is
 * referenced by NOTHING — render-is-clone means covers carry their own
 * campaign-scoped rows (the shared global row is never attached), campaign
 * prunes never scan global scope, and the slot now points at the fresh row
 * — so regen never leaks one global blob per regeneration. Other
 * campaigns' EXISTING covers keep their cloned bytes (independent rows);
 * only FUTURE clones render the new art.
 */
export async function replaceCanonicalPortrait(
  chunkId: Id,
  prepared: StoredImage,
): Promise<ReplaceResult> {
  if (prepared.campaignId !== null) {
    throw new Error('mob portrait cache: only global-scope (campaignId null) images may be cached');
  }
  try {
    return await db.transaction('rw', [db.images, db.mobPortraits], async () => {
      const existing = await db.mobPortraits.where('chunkId').equals(chunkId).first();
      await db.images.put(prepared);
      if (existing === undefined) {
        const entry = parseCacheRow({ ...stampNewEntity(), id: newId(), chunkId, imageId: prepared.id });
        await db.mobPortraits.put(entry);
        return { imageId: prepared.id, supersededImageId: null };
      }
      const row = parseCacheRow(existing);
      const superseded = row.imageId;
      await db.mobPortraits.put({ ...row, imageId: prepared.id });
      if (superseded !== prepared.id) await db.images.delete(superseded);
      return { imageId: prepared.id, supersededImageId: superseded };
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'ConstraintError') {
      const winner = await getMobPortraitCacheEntry(chunkId);
      if (winner !== undefined) return { imageId: winner.imageId, supersededImageId: null };
    }
    throw error;
  }
}

export type CloneOutcome = 'cloned' | 'skipped';

/**
 * RENDER (D4): clone the cached blob into a mob artifact's `coverImageId`.
 * A NEW campaign-scoped image row carries the bytes (the shared global row
 * is never attached to an artifact) via the attach seam — one tx, cover set,
 * revisioned. Returns `skipped` when the artifact already carries an image
 * (skip-if-imaged wins the race) or the cache slot is empty — never
 * overwrites, never generates.
 *
 * `force` is the delete-after-replace regen flavor (docs/11 D5 preservation
 * rule): an imaged artifact gets fresh bytes ANYWAY — the clone commits as
 * the new cover FIRST (same attach-seam transaction swaps the gallery,
 * scrubs ONLY the superseded ids from this artifact's snapshots, and
 * refcount-prunes them), so the old cover survives until the replacement
 * lands. A failed clone leaves the old cover untouched (loud error, the
 * transaction never commits).
 */
export async function cloneCachedPortraitToArtifact(options: {
  artifactId: Id;
  campaignId: Id;
  imageId: Id;
  force?: boolean;
}): Promise<CloneOutcome> {
  const artifact = await getAnyArtifact(options.artifactId);
  if (artifact === undefined) {
    throw new Error('mob portrait cache: the mob artifact no longer exists — re-run the portrait batch');
  }
  if ((artifact.coverImageId !== null || artifact.imageIds.length > 0) && options.force !== true) {
    return 'skipped';
  }
  const cached = await db.images.get(options.imageId);
  if (cached === undefined) {
    throw new Error('mob portrait cache: the cached portrait image is gone — regenerate the portrait');
  }
  await attachClonedCover({
    artifact,
    campaignId: options.campaignId,
    source: cached,
    supersededImageIds: options.force === true ? supersededCoverIds(artifact) : [],
  });
  return 'cloned';
}

/** Every live image reference on an imaged artifact (cover + gallery) — the
 * delete-after-replace superseded set: the replacement's commit releases
 * exactly these pins, never anything else. */
export function supersededCoverIds(artifact: {
  coverImageId: Id | null;
  imageIds: readonly Id[];
}): Id[] {
  return [...new Set([...(artifact.coverImageId === null ? [] : [artifact.coverImageId]), ...artifact.imageIds])];
}

/**
 * The ONE cover-clone mechanism (D4 render + D5 preservation): a fresh
 * campaign-scoped row carrying `source`'s bytes lands as the artifact's
 * cover through the attach seam. `supersededImageIds` (empty for first-time
 * covers) leaves the gallery, is scrubbed from this artifact's snapshots,
 * and is refcount-pruned — atomically with the new cover's commit, so the
 * old art survives until the replacement lands and a shared id pinned
 * elsewhere is never freed.
 */
async function attachClonedCover(options: {
  artifact: { id: Id };
  campaignId: Id;
  source: StoredImage;
  supersededImageIds: readonly Id[];
}): Promise<void> {
  await attachImagesToArtifact(options.artifact.id, {
    createImages: [
      {
        campaignId: options.campaignId,
        blob: imageBlob(options.source),
        mimeType: options.source.mimeType,
        width: options.source.width,
        height: options.source.height,
        prompt: options.source.prompt,
        model: options.source.model,
        source: 'generated',
        asCover: true,
      },
    ],
    ...(options.supersededImageIds.length === 0
      ? {}
      : {
          removeImageIds: [...options.supersededImageIds],
          scrubImageIds: [...options.supersededImageIds],
          pruneCandidates: {
            campaignId: options.campaignId,
            candidateIds: [...options.supersededImageIds],
          },
        }),
  });
}

/**
 * Cover carry-forward (docs/11 D5 preservation rule): clone one artifact's
 * live cover onto a cover-less artifact of the same campaign — the SAME
 * `attachClonedCover` mechanism as the cache render above (fresh
 * campaign-scoped row, attach seam, revisioned), no second mechanism. The
 * source row is never attached or moved, so it stays intact; the target
 * keeps its own cover when it already has one (`skipped`).
 *
 * Best-effort by design: a vanished source artifact (or a source with no
 * cover) returns `skipped` instead of throwing — content regeneration must
 * not fail over a cosmetic carry, and the re-cite is then simply a fresh
 * cover-less citation in its normal state.
 */
export async function cloneArtifactCover(options: {
  fromArtifactId: Id;
  toArtifactId: Id;
  campaignId: Id;
}): Promise<CloneOutcome> {
  const [from, to] = await Promise.all([
    getAnyArtifact(options.fromArtifactId),
    getAnyArtifact(options.toArtifactId),
  ]);
  if (from === undefined || to === undefined) return 'skipped';
  if (to.coverImageId !== null || to.imageIds.length > 0) return 'skipped';
  if (from.coverImageId === null) return 'skipped';
  const cover = await db.images.get(from.coverImageId);
  if (cover === undefined) return 'skipped';
  await attachClonedCover({
    artifact: to,
    campaignId: options.campaignId,
    source: cover,
    supersededImageIds: [],
  });
  return 'cloned';
}

/**
 * The read-through (D3/D4): clone the cached canonical cover into a
 * cover-less mob artifact, gated on ALL of: a cache-eligible source, a
 * readable chunk, a derivable canonical name, a canonical citation, and a
 * populated slot. Anything else returns `skipped` — notably a missing chunk
 * (the portrait worker fails loud later; enqueue must not throw here and
 * steal its error) and a flavored citation (local cover only, invariant).
 */
export async function fillCoverFromCache(options: {
  artifactId: Id;
  campaignId: Id;
  source: MonsterSource;
  citingName: string;
}): Promise<CloneOutcome> {
  const chunkId = cacheKeyForMonsterSource(options.source);
  if (chunkId === null) return 'skipped';
  const artifact = await getAnyArtifact(options.artifactId);
  if (artifact === undefined) {
    throw new Error('mob portrait cache: the mob artifact no longer exists — re-run the portrait batch');
  }
  if (artifact.coverImageId !== null || artifact.imageIds.length > 0) return 'skipped';
  const chunkRow = await db.chunks.get(chunkId);
  if (chunkRow === undefined) return 'skipped';
  const chunk = ruleChunkSchema.parse(chunkRow);
  const canonical = canonicalCreatureName(chunk);
  if (canonical === null) return 'skipped';
  if (!isCanonicalCitation(canonical, options.citingName)) return 'skipped';
  const entry = await getMobPortraitCacheEntry(chunkId);
  if (entry === undefined) return 'skipped';
  return cloneCachedPortraitToArtifact({
    artifactId: options.artifactId,
    campaignId: options.campaignId,
    imageId: entry.imageId,
  });
}
