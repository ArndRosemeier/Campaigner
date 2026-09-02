import {
  artifactSchema,
  createArtifact as buildArtifact,
  newId,
  stampNewEntity,
  type AnyArtifact,
  type Artifact,
  type ArtifactPatch,
  type ArtifactRevision,
  type CreateArtifactInput,
  type GlobalArtifact,
  type Id,
  type RevisionSource,
  MAX_REVISIONS_PER_ARTIFACT,
} from '@/domain';
import { db } from '@/db/db';
import { deleteBattlesBySession, scrubArtifactFromBattles } from '@/db/battleRepo';
import { deleteImageIfUnreferenced, pruneUnreferencedImages } from '@/db/imageRepo';
import { NotFoundError } from '@/lib/errors';

/** Who is saving, and (for persona saves) which run produced the content. */
export interface RevisionMeta {
  source: RevisionSource;
  runId?: Id | null;
}

const USER_SAVE: RevisionMeta = { source: 'user' };

export async function getArtifact(id: Id): Promise<Artifact | undefined> {
  const row = await db.artifacts.get(id);
  // The campaignId index guarantees ownership for campaign-scoped reads;
  // a global row here would be a caller bug (no global writer exists until
  // M6-C, which switches cross-scope readers to getAnyArtifact).
  return row !== undefined && row.campaignId !== null ? row : undefined;
}

/** Any-scope read (10-MILESTONE-6): owned or global. Cross-scope surfaces
 * (publish/adopt, the library, battle stat lookup) use this. */
export async function getAnyArtifact(id: Id): Promise<AnyArtifact | undefined> {
  return db.artifacts.get(id);
}

/** bulkGet preserving no particular order; missing ids dropped. Returns any
 * scope — callers that require owned rows narrow on `campaignId`. */
export async function listArtifactsByIds(ids: readonly Id[]): Promise<AnyArtifact[]> {
  const rows = await db.artifacts.bulkGet([...ids]);
  return rows.filter((row): row is AnyArtifact => row !== undefined);
}

export async function listArtifactsByCampaign(campaignId: Id): Promise<Artifact[]> {
  // The campaignId index only contains rows whose campaignId is a valid key
  // — every hit is owned (campaign- or module-scoped), never global.
  const rows = (await db.artifacts.where('campaignId').equals(campaignId).toArray()).filter(
    (row): row is Artifact => row.campaignId !== null,
  );
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** Global library rows (10-MILESTONE-6): a full scan — global artifacts are
 * few and there is no index on a null key. Alphabetical by name. */
export async function listGlobalArtifacts(): Promise<GlobalArtifact[]> {
  const rows = await db.artifacts.filter((row) => row.campaignId === null).toArray();
  return rows.filter((row): row is GlobalArtifact => row.campaignId === null).sort((a, b) => a.name.localeCompare(b.name));
}

/** Artifacts owned by one module (10-MILESTONE-6). The [moduleId+kind] index
 * only contains rows with a moduleId key — every hit is module-owned and
 * therefore campaign-anchored. Alphabetical by name. */
export async function listArtifactsByModule(moduleId: Id): Promise<Artifact[]> {
  const rows = await db.artifacts.where('moduleId').equals(moduleId).toArray();
  return rows.filter((row): row is Artifact => row.campaignId !== null).sort((a, b) => a.name.localeCompare(b.name));
}

export async function countArtifactsByCampaign(campaignId: Id): Promise<number> {
  return db.artifacts.where('campaignId').equals(campaignId).count();
}

/**
 * Creates an artifact and its revision-1 snapshot (the baseline every later
 * save is measured against — see 04-LLM-PERSONAS "finalize").
 */
export async function createArtifact(
  input: CreateArtifactInput,
  meta: RevisionMeta = USER_SAVE,
): Promise<Artifact> {
  const valid = artifactSchema.parse({ ...buildArtifact(input), updatedAt: Date.now() });
  return db.transaction('rw', db.artifacts, db.revisions, async () => {
    await writeRevision(valid, meta);
    return valid;
  });
}

/**
 * The canonical content save (01-DATA-MODEL §ArtifactRevision): increment
 * `currentRevision`, write the revision row with a deep snapshot, update the
 * artifact row, then trim to the newest 50 revisions.
 *
 * Trusts the passed row's `currentRevision` — callers that read the row
 * themselves (the editor's autosave) should use `updateArtifact`, which does
 * the read and the write inside one transaction and is therefore safe
 * against overlapping saves.
 */
export async function saveArtifact(
  artifact: Artifact,
  meta: RevisionMeta = USER_SAVE,
): Promise<Artifact> {
  const valid = artifactSchema.parse({
    ...artifact,
    currentRevision: artifact.currentRevision + 1,
    updatedAt: Date.now(),
  });
  return db.transaction('rw', db.artifacts, db.revisions, async () => {
    await writeRevision(valid, meta);
    return valid;
  });
}

/** Merges a patch and saves it as a new revision (race-safe). */
export async function updateArtifact(
  id: Id,
  patch: ArtifactPatch,
  meta: RevisionMeta = USER_SAVE,
): Promise<Artifact> {
  return db.transaction('rw', db.artifacts, db.revisions, async () => {
    const current = await db.artifacts.get(id);
    if (!current) throw new NotFoundError('Artifact', id);
    // Parse-normalize the merged row: keeps the union sound when `patch.data`
    // replaces the whole data object, and rejects kind/data mismatches.
    const merged = artifactSchema.parse({ ...current, ...patch });
    const next = artifactSchema.parse({
      ...merged,
      currentRevision: current.currentRevision + 1,
      updatedAt: Date.now(),
    });
    await writeRevision(next, meta);
    return next;
  });
}

/**
 * User-initiated image removal (M4-C; the editor's Images section uses the
 * same contract): detaches the image from the artifact and scrubs the id
 * from the artifact's own revision snapshots, so the blob becomes truly
 * unreferenced and the confirmed delete actually frees it. History stays
 * restorable — restored revisions simply show the entity without the
 * deleted image. The blob row is deleted unless something else (another
 * artifact or another artifact's revisions) still references it.
 */
export async function removeImageFromArtifact(artifactId: Id, imageId: Id): Promise<void> {
  await db.transaction('rw', db.artifacts, db.revisions, async () => {
    const current = await db.artifacts.get(artifactId);
    if (current === undefined) throw new NotFoundError('Artifact', artifactId);
    if (current.imageIds.includes(imageId) || current.coverImageId === imageId) {
      await updateArtifact(artifactId, {
        imageIds: current.imageIds.filter((id) => id !== imageId),
        coverImageId: current.coverImageId === imageId ? null : current.coverImageId,
      });
    }
    const revisions = await db.revisions.where('artifactId').equals(artifactId).toArray();
    for (const revision of revisions) {
      // Read defensively (pre-M3 snapshots lack both fields — see
      // referencedImageIds); rows are not schema-parsed on load.
      const snapshot = revision.snapshot as {
        imageIds?: Id[];
        coverImageId?: Id | null;
      } | null;
      if (snapshot === null) continue;
      const inList = (snapshot.imageIds ?? []).includes(imageId);
      const isCover = snapshot.coverImageId === imageId;
      if (!inList && !isCover) continue;
      await db.revisions.put({
        ...revision,
        snapshot: {
          ...snapshot,
          ...(inList ? { imageIds: (snapshot.imageIds ?? []).filter((id) => id !== imageId) } : {}),
          ...(isCover ? { coverImageId: null } : {}),
        } as unknown as Artifact,
      });
    }
  });
  await deleteImageIfUnreferenced(imageId);
}

/**
 * Restores a historical snapshot by saving it as a new revision (05-UI:
 * "restore = save as new revision"); the old revisions stay untouched.
 */
export async function restoreRevision(artifactId: Id, revision: number): Promise<Artifact> {
  return db.transaction('rw', db.artifacts, db.revisions, async () => {
    const row = await db.revisions
      .where('[artifactId+revision]')
      .equals([artifactId, revision])
      .first();
    if (!row) throw new NotFoundError('ArtifactRevision', `${artifactId}#${revision}`);
    const current = await db.artifacts.get(artifactId);
    if (!current) throw new NotFoundError('Artifact', artifactId);
    const next = artifactSchema.parse({
      ...row.snapshot,
      currentRevision: current.currentRevision + 1,
      updatedAt: Date.now(),
    });
    await writeRevision(next, USER_SAVE);
    return next;
  });
}

/**
 * Duplicates an artifact (tree context menu): fresh identity, "(copy)" name
 * suffix, and its own revision-1 snapshot.
 */
export async function duplicateArtifact(id: Id): Promise<Artifact> {
  const source = await db.artifacts.get(id);
  if (!source) throw new NotFoundError('Artifact', id);
  const now = Date.now();
  const copy = artifactSchema.parse({
    ...structuredClone(source),
    id: newId(),
    createdAt: now,
    updatedAt: now,
    name: `${source.name} (copy)`,
    currentRevision: 1,
  });
  return db.transaction('rw', db.artifacts, db.revisions, async () => {
    await writeRevision(copy, USER_SAVE);
    return copy;
  });
}

export async function listRevisions(artifactId: Id): Promise<ArtifactRevision[]> {
  const rows = await db.revisions.where('artifactId').equals(artifactId).toArray();
  return rows.sort((a, b) => b.revision - a.revision);
}

export async function getRevision(
  artifactId: Id,
  revision: number,
): Promise<ArtifactRevision | undefined> {
  return db.revisions.where('[artifactId+revision]').equals([artifactId, revision]).first();
}

/** Deletes an artifact and its revision history. Idempotent. */
export async function deleteArtifact(id: Id): Promise<void> {
  await db.transaction('rw', db.artifacts, db.revisions, db.images, db.battles, async () => {
    const artifact = await db.artifacts.get(id);
    await db.revisions.where('artifactId').equals(id).delete();
    await db.artifacts.delete(id);
    // Drop links in other artifacts that pointed at the deleted one, so no
    // dangling targets linger in the tree, editor, or link graph.
    const referring = await db.artifacts
      .toCollection()
      .filter((row) => row.links.some((link) => link.targetId === id))
      .toArray();
    for (const row of referring) {
      await db.artifacts.update(row.id, {
        links: row.links.filter((link) => link.targetId !== id),
        updatedAt: Date.now(),
      });
    }
    // Image blobs the deleted artifact was the last referencer of are
    // pruned (M3-A): the check covers remaining artifacts and revisions.
    if (artifact !== undefined) {
      // M5-B: battles reference pc/npc artifacts as tokens and sessions as
      // owners — a deleted fighter scrubs its tokens (empty battles delete
      // themselves); a deleted session drops its battle.
      if (artifact.kind === 'session') {
        await deleteBattlesBySession(id);
      } else if (artifact.campaignId === null) {
        // Global artifact (M6): it can hold no battle tokens yet — battle
        // seeding is campaign-scoped until M6-C/D, and its images prune with
        // the global pass, not a campaign's.
      } else {
        await scrubArtifactFromBattles(artifact.campaignId, id);
        await pruneUnreferencedImages(artifact.campaignId);
      }
    }
  });
}

/**
 * Core revision write: puts the artifact row, its revision snapshot, and
 * trims old revisions. Must run inside a `rw` transaction over
 * `artifacts` + `revisions` (all public functions above provide one) so that
 * overlapping saves serialize instead of clobbering revision numbers.
 */
async function writeRevision(valid: Artifact, meta: RevisionMeta): Promise<void> {
  const revision: ArtifactRevision = {
    ...stampNewEntity(valid.updatedAt),
    artifactId: valid.id,
    revision: valid.currentRevision,
    snapshot: structuredClone(valid),
    source: meta.source,
    runId: meta.runId ?? null,
  };
  await db.artifacts.put(valid);
  await db.revisions.put(revision);
  await trimRevisions(valid.id);
}

/** Deletes the oldest revisions beyond the per-artifact cap. */
async function trimRevisions(artifactId: Id): Promise<void> {
  const rows = await db.revisions.where('artifactId').equals(artifactId).toArray();
  if (rows.length <= MAX_REVISIONS_PER_ARTIFACT) return;

  rows.sort((a, b) => a.revision - b.revision);
  const excess = rows.slice(0, rows.length - MAX_REVISIONS_PER_ARTIFACT);
  await db.revisions.bulkDelete(excess.map((row) => row.id));
}
