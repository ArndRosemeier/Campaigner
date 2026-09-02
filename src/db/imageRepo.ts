import {
  storedImageSchema,
  stampNewEntity,
  type Id,
  type StoredImage,
} from '@/domain';
import { db } from '@/db/db';

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

export async function createImage(input: NewStoredImage): Promise<StoredImage> {
  const bytes = new Uint8Array(await input.blob.arrayBuffer());
  const image = storedImageSchema.parse({
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
  await db.images.put(image);
  return image;
}

/** Promotes/demotes an image's role (M5-C): setting an artwork image as a
 * battlemap promotes it so map pickers offer it. */
export async function setImageRole(id: Id, role: 'artwork' | 'map'): Promise<void> {
  await db.images.update(id, { role });
}

export async function getImage(id: Id): Promise<StoredImage | undefined> {
  return db.images.get(id);
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
 */
async function referencedImageIdsGlobal(): Promise<Set<Id>> {
  const [artifacts, revisions] = await Promise.all([
    db.artifacts.toArray(),
    db.revisions.toArray(),
  ]);
  const referenced = new Set<Id>();
  for (const artifact of artifacts) {
    for (const id of artifact.imageIds) referenced.add(id);
    if (artifact.coverImageId !== null) referenced.add(artifact.coverImageId);
  }
  for (const revision of revisions) {
    const snapshot = revision.snapshot as {
      imageIds?: Id[];
      coverImageId?: Id | null;
    } | null;
    if (snapshot === null) continue;
    for (const id of snapshot.imageIds ?? []) referenced.add(id);
    const cover = snapshot.coverImageId;
    if (cover !== undefined && cover !== null) referenced.add(cover);
  }
  return referenced;
}

/**
 * All image ids referenced anywhere in the campaign — by artifacts
 * (`imageIds`/`coverImageId`) and by revision snapshots (restored history
 * must still render).
 */
export async function referencedImageIds(campaignId: Id): Promise<Set<Id>> {
  const [artifacts, revisions] = await Promise.all([
    db.artifacts.where('campaignId').equals(campaignId).toArray(),
    (async () => {
      const artifactIds = (await db.artifacts.where('campaignId').equals(campaignId).toArray()).map(
        (artifact) => artifact.id,
      );
      if (artifactIds.length === 0) return [];
      const rows = await db.revisions.where('artifactId').anyOf(artifactIds).toArray();
      return rows;
    })(),
  ]);
  const referenced = new Set<Id>();
  for (const artifact of artifacts) {
    for (const id of artifact.imageIds) referenced.add(id);
    if (artifact.coverImageId !== null) referenced.add(artifact.coverImageId);
  }
  for (const revision of revisions) {
    // Old (pre-M3) snapshots lack both fields — read defensively.
    const snapshot = revision.snapshot as {
      imageIds?: Id[];
      coverImageId?: Id | null;
    } | null;
    if (snapshot === null) continue;
    for (const id of snapshot.imageIds ?? []) referenced.add(id);
    const cover = snapshot.coverImageId;
    if (cover !== undefined && cover !== null) referenced.add(cover);
  }
  return referenced;
}

/**
 * Deletes every image of the campaign that nothing references anymore.
 * Called after artifact deletion (cascade) and after run picks discard
 * candidates. Safe inside a caller's transaction when `db.images` (and the
 * tables it reads) are part of its scope.
 */
export async function pruneUnreferencedImages(campaignId: Id): Promise<number> {
  const referenced = await referencedImageIds(campaignId);
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
