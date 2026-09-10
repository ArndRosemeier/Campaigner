import {
  storedImageSchema,
  stampNewEntity,
  type Id,
  type StoredImage,
} from '@/domain';
import { db } from '@/db/db';
import { isMobPortraitCachedImage } from '@/db/mobPortraitCache';

/**
 * Image blob storage (07-MILESTONE-3 M3-A): CRUD for the `images` table plus
 * reference-counted deletion. Artifacts and revision snapshots reference
 * images by id (`imageIds`/`coverImageId`); a blob may only be deleted when
 * NOTHING in the campaign references it anymore.
 */

export interface NewStoredImage {
  /** `null` = library image (10-MILESTONE-6 D2 — travels with the global
   * artifact it belongs to). */
  campaignId: Id | null;
  /** Display payload; stored as clone-safe bytes. */
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  prompt?: string;
  model?: string;
  source: 'generated' | 'uploaded';
  /** M5-C: `map` images are battlemaps — bigger intake cap, map pickers only. */
  role?: 'artwork' | 'map';
}

/**
 * Non-Dexie image-row preparation: converts the blob to clone-safe bytes and
 * schema-parses the row. MUST run OUTSIDE any transaction scope —
 * `Blob.prototype.arrayBuffer()` resolves on a native (non-Dexie) promise,
 * and awaiting it inside a `db.transaction` scope breaks Dexie's PSD zone:
 * the IndexedDB transaction auto-commits at that gap and every later write in
 * the scope lands outside it ("Transaction committed too early" — the Dexie
 * async-transaction trap, http://bit.ly/2kdckMn). Helpers that must persist a
 * new image INSIDE a caller's transaction (attachImagesToArtifact) prepare
 * the row with this function BEFORE the tx opens and `db.images.put` the
 * parsed row inside.
 */
export async function buildStoredImage(input: NewStoredImage): Promise<StoredImage> {
  const bytes = new Uint8Array(await input.blob.arrayBuffer());
  return storedImageSchema.parse({
    ...stampNewEntity(),
    campaignId: input.campaignId,
    bytes,
    mimeType: input.mimeType,
    width: input.width,
    height: input.height,
    prompt: input.prompt ?? '',
    model: input.model ?? '',
    source: input.source,
    ...(input.role === undefined ? {} : { role: input.role }),
  });
}

/**
 * Stores one image row (its own implicit single-write transaction). Top-level
 * use only — inside a caller's transaction scope, prepare the row with
 * `buildStoredImage` BEFORE the tx opens and `db.images.put` it inside; an
 * awaited `blob.arrayBuffer()` in the scope would commit the transaction
 * early (see buildStoredImage).
 */
export async function createImage(input: NewStoredImage): Promise<StoredImage> {
  const image = await buildStoredImage(input);
  await db.images.put(image);
  return image;
}

/** Promotes/demotes an image's role (M5-C): setting an artwork image as a
 * battlemap promotes it so map pickers offer it. */
export async function setImageRole(id: Id, role: 'artwork' | 'map'): Promise<void> {
  await db.images.update(id, { role });
}

/** Re-anchor generated/uploaded images when their artifact crosses scope. */
export async function reanchorImages(ids: readonly Id[], campaignId: Id | null): Promise<void> {
  if (ids.length === 0) return;
  await db.images.where('id').anyOf([...new Set(ids)]).modify({ campaignId });
}

export async function getImage(id: Id): Promise<StoredImage | undefined> {
  return db.images.get(id);
}

/** Every image row of one campaign (deliverables gallery; no particular order). */
export async function listImagesByCampaign(campaignId: Id): Promise<StoredImage[]> {
  return db.images.where('campaignId').equals(campaignId).toArray();
}

/** bulkGet preserving no particular order; missing ids dropped. */
export async function listImagesByIds(ids: readonly Id[]): Promise<StoredImage[]> {
  if (ids.length === 0) return [];
  const rows = await db.images.bulkGet([...ids]);
  return rows.filter((row): row is StoredImage => row !== undefined);
}

/** Deletes one image row unconditionally (callers handle reference checks). */
export async function deleteImage(id: Id): Promise<void> {
  await db.images.delete(id);
}

/**
 * Deletes one image only when nothing references it anymore (artifacts and
 * revision snapshots of the image's campaign; a library image (campaignId
 * null, D2) is checked against ALL campaigns, since any of them may link
 * the artifact carrying it). Returns whether it was deleted.
 */
export async function deleteImageIfUnreferenced(imageId: Id): Promise<boolean> {
  const image = await db.images.get(imageId);
  if (image === undefined) return false;
  // NEVER-DELETE while a cache record exists (docs/11 D5 amendment, slice
  // A): the global mob-portrait slot's shared blob survives even when no
  // artifact references it — clones, not the cached row, hang off covers.
  if (await isMobPortraitCachedImage(imageId)) return false;
  const referenced =
    image.campaignId === null
      ? await referencedImageIdsGlobal()
      : await referencedImageIds(image.campaignId);
  if (referenced.has(imageId)) return false;
  await db.images.delete(imageId);
  return true;
}

/**
 * Reference set across every campaign — for library images whose owning
 * artifact was published (D2). Local data, full scan is fine.
 *
 * Single-map-slot coverage (owner decision, docs/11): encounter live maps
 * (`data.mapImageId`), their history (`snapshot.data.mapImageId`), and
 * frozen battle boards (`board.mapImageId`) all pin their blobs — deleting
 * an old gallery row must never destroy the blob under a live board.
 *
 * Cover-image coverage (module/campaign covers): every module's and every
 * campaign's `coverImageId` pins its blob — covers are image rows owned by
 * their campaign (`campaignId` = owner campaign; a campaign cover anchors to
 * its own id) referenced from outside the artifact tables, so the artifact
 * scan alone would GC them.
 */
async function referencedImageIdsGlobal(): Promise<Set<Id>> {
  const [artifacts, revisions, battles, modules, campaigns] = await Promise.all([
    db.artifacts.toArray(),
    db.revisions.toArray(),
    db.battles.toArray(),
    db.modules.toArray(),
    db.campaigns.toArray(),
  ]);
  const referenced = new Set<Id>();
  for (const artifact of artifacts) {
    for (const id of artifact.imageIds) referenced.add(id);
    if (artifact.coverImageId !== null) referenced.add(artifact.coverImageId);
    if (artifact.kind === 'encounter' && artifact.data.mapImageId !== null) {
      referenced.add(artifact.data.mapImageId);
    }
  }
  for (const module of modules) {
    if (module.coverImageId !== null) referenced.add(module.coverImageId);
  }
  for (const campaign of campaigns) {
    if (campaign.coverImageId !== null) referenced.add(campaign.coverImageId);
  }
  for (const revision of revisions) {
    const snapshot = revision.snapshot as {
      imageIds?: Id[];
      coverImageId?: Id | null;
      data?: { mapImageId?: Id | null };
    } | null;
    if (snapshot === null) continue;
    for (const id of snapshot.imageIds ?? []) referenced.add(id);
    const cover = snapshot.coverImageId;
    if (cover !== undefined && cover !== null) referenced.add(cover);
    const map = snapshot.data?.mapImageId;
    if (map !== undefined && map !== null) referenced.add(map);
  }
  for (const battle of battles) {
    if (battle.board.mapImageId !== null) referenced.add(battle.board.mapImageId);
  }
  return referenced;
}

/**
 * All image ids referenced anywhere in the campaign — by artifacts
 * (`imageIds`/`coverImageId`), by revision snapshots (restored history
 * must still render), by encounter live maps and their history, by frozen
 * battle boards (see above), by the campaign's modules (`coverImageId`),
 * and by the campaign row itself (`coverImageId`).
 *
 * SCOPE CONTRACT: reads `artifacts`, `revisions`, `battles`, `modules` and
 * `campaigns` — every caller transaction scope must include all five (a
 * read on a table the scope omits throws "object store not found").
 *
 * `excludeArtifactIds` is the PREDICTION switch, used by exactly one caller:
 * `artifactRepo.describeArtifactKindRemoval` renders the per-region
 * remove-all confirm, which must state how many blobs the cascade frees —
 * i.e. the reference set as it will be once those artifacts and their
 * revision snapshots are gone. The coverage rules stay HERE (one scan, never
 * a second copy tuned for a dialog): the exclusion only filters which rows
 * the scan sees. Display only — no delete path passes it, so what gets
 * pruned is still decided in-transaction by the unrouted scan.
 */
export async function referencedImageIds(
  campaignId: Id,
  excludeArtifactIds?: ReadonlySet<Id>,
): Promise<Set<Id>> {
  const [ownedRows, revisions, battles, modules, campaign] = await Promise.all([
    db.artifacts.where('campaignId').equals(campaignId).toArray(),
    (async () => {
      const artifactIds = (
        await db.artifacts.where('campaignId').equals(campaignId).toArray()
      )
        .filter((artifact) => excludeArtifactIds?.has(artifact.id) !== true)
        .map((artifact) => artifact.id);
      if (artifactIds.length === 0) return [];
      const rows = await db.revisions.where('artifactId').anyOf(artifactIds).toArray();
      return rows;
    })(),
    db.battles.where('campaignId').equals(campaignId).toArray(),
    db.modules.where('campaignId').equals(campaignId).toArray(),
    db.campaigns.get(campaignId),
  ]);
  const referenced = new Set<Id>();
  // The exclusion strips exactly the rows whose delete is being PREVIEWED —
  // their live references and (below) their revision snapshots' references.
  const artifacts =
    excludeArtifactIds === undefined
      ? ownedRows
      : ownedRows.filter((artifact) => !excludeArtifactIds.has(artifact.id));
  for (const artifact of artifacts) {
    for (const id of artifact.imageIds) referenced.add(id);
    if (artifact.coverImageId !== null) referenced.add(artifact.coverImageId);
    if (artifact.kind === 'encounter' && artifact.data.mapImageId !== null) {
      referenced.add(artifact.data.mapImageId);
    }
  }
  for (const revision of revisions) {
    // Old (pre-M3) snapshots lack both fields — read defensively.
    const snapshot = revision.snapshot as {
      imageIds?: Id[];
      coverImageId?: Id | null;
      data?: { mapImageId?: Id | null };
    } | null;
    if (snapshot === null) continue;
    for (const id of snapshot.imageIds ?? []) referenced.add(id);
    const cover = snapshot.coverImageId;
    if (cover !== undefined && cover !== null) referenced.add(cover);
    const map = snapshot.data?.mapImageId;
    if (map !== undefined && map !== null) referenced.add(map);
  }
  for (const battle of battles) {
    if (battle.board.mapImageId !== null) referenced.add(battle.board.mapImageId);
  }
  for (const module of modules) {
    if (module.coverImageId !== null) referenced.add(module.coverImageId);
  }
  if (campaign?.coverImageId != null) referenced.add(campaign.coverImageId);
  return referenced;
}

/**
 * Deletes every image of the campaign that nothing references anymore.
 * Called after artifact deletion (cascade) and after run picks discard
 * candidates. Safe inside a caller's transaction only when `db.images` AND
 * every table `referencedImageIds` reads (artifacts, revisions, battles,
 * modules, campaigns) are part of its scope (a read on a table the scope
 * omits throws "object store not found").
 */
export async function pruneUnreferencedImages(campaignId: Id): Promise<number> {
  const referenced = await referencedImageIds(campaignId);
  // Cache immunity (D2) is STRUCTURAL here, deliberately read-free: cached
  // shared blobs live at global scope (`campaignId: null`) and this prune
  // only ever scans `where('campaignId').equals(campaignId)` — a campaign
  // prune cannot see a global row, inside ANY caller transaction scope.
  // (An explicit cache-table read here would join the caller's scope and
  // throw inside cascades whose scope cannot include it — deleteModule's.)
  const images = await db.images.where('campaignId').equals(campaignId).toArray();
  const orphans = images.filter((image) => !referenced.has(image.id));
  if (orphans.length === 0) return 0;
  await db.images.bulkDelete(orphans.map((image) => image.id));
  return orphans.length;
}

/**
 * Deletes unreferenced images from a candidate list (the keep list survives).
 * Used by the run's pick step to discard candidates; anything referenced by
 * an artifact or revision is never deleted (defensive — picking appends
 * before pruning).
 */
export async function deleteUnreferencedImages(campaignId: Id, ids: readonly Id[]): Promise<number> {
  if (ids.length === 0) return 0;
  const referenced = await referencedImageIds(campaignId);
  const deletable = ids.filter((id) => !referenced.has(id));
  if (deletable.length === 0) return 0;
  await db.images.bulkDelete(deletable);
  return deletable.length;
}
