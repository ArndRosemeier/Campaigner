import {
  artifactSchema,
  createArtifact as buildArtifact,
  stampNewEntity,
  type Artifact,
  type ArtifactPatch,
  type ArtifactRevision,
  type CreateArtifactInput,
  type Id,
  type RevisionSource,
  MAX_REVISIONS_PER_ARTIFACT,
} from '@/domain';
import { db } from '@/db/db';
import { NotFoundError } from '@/lib/errors';

/** Who is saving, and (for persona saves) which run produced the content. */
export interface RevisionMeta {
  source: RevisionSource;
  runId?: Id | null;
}

const USER_SAVE: RevisionMeta = { source: 'user' };

export async function getArtifact(id: Id): Promise<Artifact | undefined> {
  return db.artifacts.get(id);
}

/** All artifacts of a campaign, alphabetically by name (tree order). */
export async function listArtifactsByCampaign(campaignId: Id): Promise<Artifact[]> {
  const rows = await db.artifacts.where('campaignId').equals(campaignId).toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name));
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
  return persistRevision(buildArtifact(input), meta);
}

/**
 * The canonical content save (01-DATA-MODEL §ArtifactRevision): increment
 * `currentRevision`, write the revision row with a deep snapshot, update the
 * artifact row, then trim to the newest 50 revisions. All in one transaction.
 */
export async function saveArtifact(
  artifact: Artifact,
  meta: RevisionMeta = USER_SAVE,
): Promise<Artifact> {
  return persistRevision({ ...artifact, currentRevision: artifact.currentRevision + 1 }, meta);
}

/** Merges a patch and saves it as a new revision. */
export async function updateArtifact(
  id: Id,
  patch: ArtifactPatch,
  meta: RevisionMeta = USER_SAVE,
): Promise<Artifact> {
  const current = await db.artifacts.get(id);
  if (!current) throw new NotFoundError('Artifact', id);
  // Parse-normalize the merged row: keeps the union sound when `patch.data`
  // replaces the whole data object, and rejects kind/data mismatches.
  const merged = artifactSchema.parse({ ...current, ...patch });
  return saveArtifact(merged, meta);
}

/**
 * Restores a historical snapshot by saving it as a new revision (05-UI:
 * "restore = save as new revision"); the old revisions stay untouched.
 */
export async function restoreRevision(artifactId: Id, revision: number): Promise<Artifact> {
  const row = await getRevision(artifactId, revision);
  if (!row) throw new NotFoundError('ArtifactRevision', `${artifactId}#${revision}`);
  const current = await db.artifacts.get(artifactId);
  if (!current) throw new NotFoundError('Artifact', artifactId);
  return persistRevision(
    { ...row.snapshot, currentRevision: current.currentRevision + 1 },
    USER_SAVE,
  );
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
  await db.transaction('rw', db.artifacts, db.revisions, async () => {
    await db.revisions.where('artifactId').equals(id).delete();
    await db.artifacts.delete(id);
  });
}

/**
 * Single write path for artifact content: validates the row, writes it plus a
 * revision snapshot, and trims old revisions. Caller decides the revision
 * number by setting `currentRevision` beforehand.
 */
async function persistRevision(artifact: Artifact, meta: RevisionMeta): Promise<Artifact> {
  const now = Date.now();
  const valid = artifactSchema.parse({ ...artifact, updatedAt: now });
  const revision: ArtifactRevision = {
    ...stampNewEntity(now),
    artifactId: valid.id,
    revision: valid.currentRevision,
    snapshot: structuredClone(valid),
    source: meta.source,
    runId: meta.runId ?? null,
  };

  await db.transaction('rw', db.artifacts, db.revisions, async () => {
    await db.artifacts.put(valid);
    await db.revisions.put(revision);
    await trimRevisions(valid.id);
  });
  return valid;
}

/** Deletes the oldest revisions beyond the per-artifact cap. */
async function trimRevisions(artifactId: Id): Promise<void> {
  const rows = await db.revisions.where('artifactId').equals(artifactId).toArray();
  if (rows.length <= MAX_REVISIONS_PER_ARTIFACT) return;

  rows.sort((a, b) => a.revision - b.revision);
  const excess = rows.slice(0, rows.length - MAX_REVISIONS_PER_ARTIFACT);
  await db.revisions.bulkDelete(excess.map((row) => row.id));
}
