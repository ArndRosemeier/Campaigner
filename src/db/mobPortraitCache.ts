import {
  imageBlob,
  mobPortraitCacheSchema,
  newId,
  stampNewEntity,
  type Id,
  type MobPortraitCacheEntry,
  type StoredImage,
} from '@/domain';
import { attachImagesToArtifact, getAnyArtifact } from '@/db/artifactRepo';
import { db } from '@/db/db';

/**
 * Global creature portrait cache repo (docs/11 D5 amendment, slice A;
 * re-keyed on creature IDENTITY by the owner-ratified core-mob arc, docs/11
 * D6): the Dexie side of the `mobPortraits` table (v20,
 * `id, &creatureKey`).
 *
 * The key is `domain/creature`'s `CreatureIdentity.key` and NOTHING else. No
 * artifact has to exist for a slot to be read or written — that is the whole
 * point of the tier (`createCreatureCover` has no artifact parameter at all),
 * and it is why a cited creature's portrait survives every campaign delete.
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

/** The cache record for one creature identity, when the slot is populated. */
export async function getMobPortraitCacheEntry(
  creatureKey: string,
): Promise<MobPortraitCacheEntry | undefined> {
  const row = await db.mobPortraits.where('creatureKey').equals(creatureKey).first();
  return row === undefined ? undefined : parseCacheRow(row);
}

/** Every cached image id — the prune-immunity set (D2). */
export async function cachedMobPortraitImageIds(): Promise<Set<Id>> {
  const rows = await db.mobPortraits.toArray();
  return new Set(rows.map((row) => parseCacheRow(row).imageId));
}

/** Whether an image row is the shared blob behind a cache record. */
export async function isMobPortraitCachedImage(imageId: Id): Promise<boolean> {
  // `imageId` carries no index (the table keys on `&creatureKey`); the table
  // holds one row per creature, so a filtered scan is the honest read.
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
 * `&creatureKey` index throws ConstraintError) is converged on, never
 * overwritten — the loser's prepared row was never stored (the put aborts
 * with the transaction), so no orphan is left behind.
 */
export async function storeCanonicalPortraitIfAbsent(
  creatureKey: string,
  prepared: StoredImage,
): Promise<PublishResult> {
  if (prepared.campaignId !== null) {
    throw new Error('creature portrait cache: only global-scope (campaignId null) images may be cached');
  }
  try {
    return await db.transaction('rw', [db.images, db.mobPortraits], async () => {
      const existing = await db.mobPortraits.where('creatureKey').equals(creatureKey).first();
      if (existing !== undefined) {
        return { imageId: parseCacheRow(existing).imageId, stored: false };
      }
      await db.images.put(prepared);
      const entry = parseCacheRow({
        ...stampNewEntity(),
        id: newId(),
        creatureKey,
        imageId: prepared.id,
      });
      await db.mobPortraits.put(entry);
      return { imageId: prepared.id, stored: true };
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'ConstraintError') {
      const winner = await getMobPortraitCacheEntry(creatureKey);
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
 * referenced by NOTHING — render-is-clone means every renderer carries its own
 * campaign-scoped row (the shared global row is never attached), campaign
 * prunes never scan global scope, and the slot now points at the fresh row
 * — so regen never leaks one global blob per regeneration. Other campaigns'
 * EXISTING covers keep their cloned bytes (independent rows); only FUTURE
 * clones render the new art.
 */
export async function replaceCanonicalPortrait(
  creatureKey: string,
  prepared: StoredImage,
): Promise<ReplaceResult> {
  if (prepared.campaignId !== null) {
    throw new Error('creature portrait cache: only global-scope (campaignId null) images may be cached');
  }
  try {
    return await db.transaction('rw', [db.images, db.mobPortraits], async () => {
      const existing = await db.mobPortraits.where('creatureKey').equals(creatureKey).first();
      await db.images.put(prepared);
      if (existing === undefined) {
        const entry = parseCacheRow({
          ...stampNewEntity(),
          id: newId(),
          creatureKey,
          imageId: prepared.id,
        });
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
      const winner = await getMobPortraitCacheEntry(creatureKey);
      if (winner !== undefined) return { imageId: winner.imageId, supersededImageId: null };
    }
    throw error;
  }
}

export type CloneOutcome = 'cloned' | 'skipped';

/**
 * RENDER, artifact flavour: clone a cached blob onto an ARTIFACT as its cover
 * — an authored NPC cast from a library creature (docs/11 D4) is the caller
 * that matters. A NEW campaign-scoped image row carries the bytes (the shared
 * global row is never attached) via the attach seam — one tx, cover set,
 * revisioned. Returns `skipped` when the artifact already carries an image
 * (skip-if-imaged wins the race, so an edited appearance is never overwritten)
 * or the cache slot is empty — never overwrites, never generates.
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
    throw new Error(
      'creature portrait: the artifact the portrait belongs on no longer exists — reopen it and generate again',
    );
  }
  if ((artifact.coverImageId !== null || artifact.imageIds.length > 0) && options.force !== true) {
    return 'skipped';
  }
  const cached = await db.images.get(options.imageId);
  if (cached === undefined) {
    throw new Error('creature portrait cache: the cached portrait image is gone — regenerate the portrait');
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
 * The ONE cover-clone mechanism (D4 render + D5 preservation), EXPORTED for
 * the presentation tier: a fresh campaign-scoped row carrying `source`'s bytes
 * is created and returned by id, so the caller can point either an ARTIFACT
 * (`attachImagesToArtifact` via `cloneCachedPortraitToArtifact`) or a
 * per-campaign presentation row (`db/creatureImages`) at it. Two renderers,
 * ONE way of getting the bytes.
 *
 * `supersededImageIds` (empty for first-time covers) leaves the gallery, is
 * scrubbed from this artifact's snapshots, and is refcount-pruned —
 * atomically with the new cover's commit, so the old art survives until the
 * replacement lands and a shared id pinned elsewhere is never freed. Returns
 * the new image id so a caller with no artifact gallery can record the pin
 * itself (the presentation row IS the pin).
 */
export async function createClonedCoverImage(options: {
  campaignId: Id;
  source: StoredImage;
}): Promise<Id> {
  return db.images.add({
    ...stampNewEntity(),
    id: newId(),
    campaignId: options.campaignId,
    bytes: options.source.bytes,
    mimeType: options.source.mimeType,
    width: options.source.width,
    height: options.source.height,
    prompt: options.source.prompt,
    model: options.source.model,
    role: 'artwork',
    source: 'generated',
  });
}

/**
 * The artifact-cover path of the ONE clone mechanism: creates the fresh
 * campaign-scoped row AND attaches it through the attach seam (gallery swap +
 * superseded-id scrub + refcount prune, all in that seam's transaction).
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