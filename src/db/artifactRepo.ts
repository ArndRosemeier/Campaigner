import {
  anyArtifactSchema,
  artifactRevisionSchema,
  artifactSchema,
  createArtifact as buildArtifact,
  newId,
  stampNewEntity,
  ARTIFACT_KIND_LABELS,
  BULK_REMOVE_EXCLUDED_KINDS,
  type AnyArtifact,
  type Artifact,
  type ArtifactData,
  type ArtifactKind,
  type ArtifactPatch,
  type ArtifactRevision,
  type CreateArtifactInput,
  type GlobalArtifact,
  type Id,
  type MonsterEntry,
  type RevisionSource,
  type StoredImage,
  MAX_REVISIONS_PER_ARTIFACT,
  globalArtifactKindSchema,
  globalArtifactSchema,
} from '@/domain';
import type { Table } from 'dexie';

import { db } from '@/db/db';
import { parseBattleRow, scrubArtifactFromBattles } from '@/db/battleRepo';
import { isBattleEmpty } from '@/db/fighterStats';
import {
  buildStoredImage,
  deleteImageIfUnreferenced,
  deleteUnreferencedImages,
  pruneUnreferencedImages,
  reanchorImages,
  referencedImageIds,
  type NewStoredImage,
} from '@/db/imageRepo';
import { NotFoundError } from '@/lib/errors';

/** Who is saving, and (for persona saves) which run produced the content. */
export interface RevisionMeta {
  source: RevisionSource;
  runId?: Id | null;
}

const USER_SAVE: RevisionMeta = { source: 'user' };

/**
 * Legacy-row guard at the Dexie boundary (the ratified `parseBattleRow`
 * template, battleRepo): zod materializes schema defaults for fields an
 * older row lacks — `moduleId` (v10 backfill equivalent), the encounter
 * data block's `mapImageId`/`layout`/`preset`/`locationKind`, the M3 image
 * fields on pre-v2 rows — and a genuinely corrupt row fails loudly here
 * (AGENTS rules 1+3) instead of crashing a render with `undefined` fields.
 * Every read function below parses; every write path already parses.
 */
function parseArtifactRow<T extends AnyArtifact>(row: T): T {
  // The union parse returns whichever variant matched — same variant as the
  // input row (scope fields are not changed by parsing), so the generic cast
  // is truthful.
  return anyArtifactSchema.parse(row) as T;
}

/** Same guard for revision rows: the snapshot is parsed against the artifact
 * schema, so historical snapshots gain the same defaults (and old envelope
 * fields `source`/`runId` default to their pre-M3 values). */
function parseRevisionRow(row: ArtifactRevision): ArtifactRevision {
  return artifactRevisionSchema.parse(row);
}

export async function getArtifact(id: Id): Promise<Artifact | undefined> {
  const row = await db.artifacts.get(id);
  // The campaignId index guarantees ownership for campaign-scoped reads;
  // a global row here would be a caller bug (no global writer exists until
  // M6-C, which switches cross-scope readers to getAnyArtifact).
  if (row === undefined) return undefined;
  const parsed = parseArtifactRow(row);
  return parsed.campaignId !== null ? parsed : undefined;
}

/** Any-scope read (10-MILESTONE-6): owned or global. Cross-scope surfaces
 * (publish/adopt, the library, battle stat lookup) use this. */
export async function getAnyArtifact(id: Id): Promise<AnyArtifact | undefined> {
  const row = await db.artifacts.get(id);
  return row === undefined ? undefined : parseArtifactRow(row);
}

/** bulkGet preserving no particular order; missing ids dropped. Returns any
 * scope — callers that require owned rows narrow on `campaignId`. */
export async function listArtifactsByIds(ids: readonly Id[]): Promise<AnyArtifact[]> {
  const rows = await db.artifacts.bulkGet([...ids]);
  return rows
    .filter((row): row is AnyArtifact => row !== undefined)
    .map(parseArtifactRow);
}

export async function listArtifactsByCampaign(campaignId: Id): Promise<Artifact[]> {
  // The campaignId index only contains rows whose campaignId is a valid key
  // — every hit is owned (campaign- or module-scoped), never global. Rows are
  // schema-parsed on load: on large campaigns this parses every row, which is
  // cheap next to the Dexie IO that fetched them.
  const rows = (await db.artifacts.where('campaignId').equals(campaignId).toArray()).filter(
    (row): row is Artifact => row.campaignId !== null,
  );
  return rows.map(parseArtifactRow).sort((a, b) => a.name.localeCompare(b.name));
}

/** Global library rows (10-MILESTONE-6): a full scan — global artifacts are
 * few and there is no index on a null key. Alphabetical by name. */
export async function listGlobalArtifacts(): Promise<GlobalArtifact[]> {
  const rows = await db.artifacts.filter((row) => row.campaignId === null).toArray();
  return rows
    .filter((row): row is GlobalArtifact => row.campaignId === null)
    .map(parseArtifactRow)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Artifacts owned by one module (10-MILESTONE-6). The [moduleId+kind] index
 * only contains rows with a moduleId key — every hit is module-owned and
 * therefore campaign-anchored. Alphabetical by name. */
export async function listArtifactsByModule(moduleId: Id): Promise<Artifact[]> {
  const rows = await db.artifacts.where('moduleId').equals(moduleId).toArray();
  return rows
    .filter((row): row is Artifact => row.campaignId !== null)
    .map(parseArtifactRow)
    .sort((a, b) => a.name.localeCompare(b.name));
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

/** Merges a patch and saves it as a new revision (race-safe). Works on both
 * scopes: a global row is parsed against the global shape (M6-C — library
 * entries are editable, D7); the scope fields themselves are NOT patchable
 * here — the explicit move/adopt/publish functions own those transitions. */
export async function updateArtifact(
  id: Id,
  patch: ArtifactPatch,
  meta: RevisionMeta = USER_SAVE,
): Promise<AnyArtifact> {
  return db.transaction('rw', db.artifacts, db.revisions, async () => {
    const current = await db.artifacts.get(id);
    if (!current) throw new NotFoundError('Artifact', id);
    // Scope fields are pinned to the row's current values — a plain patch
    // never re-anchors an artifact; the explicit move/adopt/publish
    // functions own those transitions.
    const scopePatch = { campaignId: current.campaignId, moduleId: current.moduleId };
    // Parse-normalize the merged row: keeps the union sound when `patch.data`
    // replaces the whole data object, and rejects kind/data mismatches.
    const merged = anyArtifactSchema.parse({ ...current, ...patch, ...scopePatch });
    const next = anyArtifactSchema.parse({
      ...merged,
      currentRevision: current.currentRevision + 1,
      updatedAt: Date.now(),
    });
    if (next.kind !== current.kind) {
      throw new Error('An artifact update may not change its kind.');
    }
    await writeRevision(next, meta);
    return next;
  });
}

/** One generated blob, stored and attached in the same transaction. */
export interface AttachableImage extends NewStoredImage {
  /** The created image becomes the artifact's cover (the queues' single
   * candidate; the skip-if-imaged guards guarantee no cover exists yet). */
  asCover?: boolean;
}

/**
 * The image-attach seam (F4): everything between "image row exists" and
 * "the artifact references it" happens in ONE rw transaction over images +
 * artifacts + revisions. The three historical call sites wrote the image
 * row, then the artifact row, then (pick step) the step row and the prune —
 * four unrelated transactions, so a crash in between leaked the blob as an
 * unreferenced-orphan or left the artifact pointing at nothing.
 *
 * Callers keep their own surrounding semantics (run-step writes, toasts);
 * only the image/artifact pair is owned here. `updateArtifact` joins as a
 * nested transaction; the prune runs last, so kept images are already
 * referenced when the candidate scan runs. `db.battles` rides the scope
 * because the post-attach prune refchecks frozen battle boards (single-map
 * slot), and `db.modules` + `db.campaigns` ride it because the prune
 * refchecks module/campaign covers — a table the scope omits throws
 * "object store not found" at the read (the deleteArtifact-scope precedent).
 *
 * The optional `data` patch rides the SAME transaction: content writes that
 * must land with the attach (map-regenerate's layout/mapImageId/preset/
 * siteShape/budgetAdvisory) commit atomically with the re-anchor instead of
 * a second `updateArtifact` write — a crash between the two used to strand
 * a library-scoped unreferenced image while the artifact kept the old map.
 *
 * The blob→bytes conversion is NOT Dexie work: `Blob.prototype.arrayBuffer()`
 * resolves on a native promise whose await would commit this transaction
 * early (the Dexie async-transaction trap, http://bit.ly/2kdckMn). Every
 * image row is therefore prepared (bytes + schema parse) BEFORE the tx opens;
 * the tx scope contains Dexie operations only.
 */
export async function attachImagesToArtifact(
  id: Id,
  input: {
    /** Image rows stored INSIDE the attach transaction — their blobs are
     * prepared (byte conversion + parse) BEFORE it opens (generated-image
     * paths). */
    createImages?: readonly AttachableImage[];
    /** Already-stored image ids appended to the artifact's imageIds. */
    appendImageIds?: readonly Id[];
    /** Already-stored image ids REMOVED from the artifact's imageIds in the
     * same transaction (single-map-slot replace: the regenerate finalize
     * swaps the previous battlemap out while the fresh one lands — the
     * gallery holds exactly one map per encounter, never an append). */
    removeImageIds?: readonly Id[];
    /** Already-stored image ids scrubbed from THIS artifact's revision
     * snapshots in the same transaction (portrait delete-after-replace:
     * the superseded cover's history pins are released atomically with the
     * fresh cover's commit, so the post-attach prune frees exactly the
     * superseded blob — never before the replacement lands). Only this
     * artifact's snapshots are touched; other artifacts' pins still
     * refcount-protect a shared id through the prune. */
    scrubImageIds?: readonly Id[];
    /** Re-anchor the attached images to this campaign anchor (D2/D9 — `null`
     * moves them into the library before a global target references them). */
    anchorImagesTo?: Id | null;
    /** The cover after the attach: explicit id, `null` clears, undefined keeps. */
    coverImageId?: Id | null;
    /** Content patch applied to the artifact in the SAME transaction (see
     * above): the whole `data` object, replacing it wholesale like an
     * `updateArtifact` patch. */
    data?: ArtifactData;
    /** Revision attribution for the attach save; defaults to a user save. */
    meta?: RevisionMeta;
    /** Post-attach prune: discards among these candidates that nothing
     * references anymore are deleted from `campaignId`'s images. */
    pruneCandidates?: { campaignId: Id; candidateIds: readonly Id[] };
  },
): Promise<AnyArtifact> {
  // Phase 1 — outside the transaction: the only native-promise work (the
  // blob read) happens here, so the tx scope below stays Dexie-only.
  const preparedImages: { image: StoredImage; asCover: boolean }[] = [];
  for (const newImage of input.createImages ?? []) {
    preparedImages.push({
      image: await buildStoredImage(newImage),
      asCover: newImage.asCover === true,
    });
  }
  return db.transaction(
    'rw',
    [db.images, db.artifacts, db.revisions, db.battles, db.modules, db.campaigns, db.creatureImages],
    async () => {
    const created: Id[] = [];
    let createdCover: Id | null = null;
    for (const { image, asCover } of preparedImages) {
      await db.images.put(image);
      created.push(image.id);
      if (asCover) createdCover = image.id;
    }
    const attached = [...created, ...(input.appendImageIds ?? [])];
    if (input.anchorImagesTo !== undefined && attached.length > 0) {
      await reanchorImages(attached, input.anchorImagesTo);
    }
    const current = await getAnyArtifact(id);
    if (current === undefined) throw new NotFoundError('Artifact', id);
    // A keep wins over a removal: an id that is both appended and removed
    // stays (defensive — the map-slot caller never sends the selected id as
    // removed, but the seam must not strand a kept image).
    const attachedSet = new Set(attached);
    const removed = new Set((input.removeImageIds ?? []).filter((imageId) => !attachedSet.has(imageId)));
    const mergedImages = [
      ...current.imageIds.filter((imageId) => !removed.has(imageId)),
      ...attached.filter((imageId) => !current.imageIds.includes(imageId)),
    ];
    const next = await updateArtifact(id, {
      imageIds: mergedImages,
      ...(input.data !== undefined ? { data: input.data } : {}),
      coverImageId: input.coverImageId !== undefined ? input.coverImageId : createdCover,
    }, input.meta ?? USER_SAVE);
    if (input.scrubImageIds !== undefined && input.scrubImageIds.length > 0) {
      await scrubSnapshotImages(id, input.scrubImageIds);
    }
    if (input.pruneCandidates !== undefined) {
      await deleteUnreferencedImages(
        input.pruneCandidates.campaignId,
        input.pruneCandidates.candidateIds,
      );
    }
    return next;
  });
}

/**
 * The tables a sanctioned scope transition needs (docs/18 §2.1: `moveScope` is
 * the ONLY path that may change `campaignId`/`moduleId`). Callers that must
 * release ownership INSIDE a larger transaction (deleteModule's 'keep' branch)
 * open their outer scope over at least these tables and hand it in, so the
 * release runs in the same scope instead of a second, unsanctioned raw write.
 */
export interface ScopeTx {
  artifacts: Table<AnyArtifact, Id>;
  revisions: Table<ArtifactRevision, Id>;
  images: Table<StoredImage, Id>;
}

/** Applies a scope transition (module move, adoption, publication) as a
 * revisioned save — the ONLY path that may change `campaignId`/`moduleId`
 * (10-MILESTONE-6 B/C). Content fields are untouched. `tx` lets one caller
 * (the delete dialog's 'keep' branch) run a BULK release inside its own rw
 * transaction — the transition stays this function, never an inlined
 * `table.modify({moduleId: null})` that skips the revision contract. */
async function moveScope(
  id: Id,
  changes: { campaignId?: Id | null; moduleId?: Id | null },
  meta: RevisionMeta = USER_SAVE,
  images?: { anchor: Id | null },
  tx?: ScopeTx,
): Promise<AnyArtifact> {
  // `db.images` joins the transaction when the move re-anchors its images
  // (adopt/publish): a crash between the row move and the image re-anchor
  // would desynchronize scopes — a library image stranded in a campaign's
  // prune scope (permanent blob loss via pruneUnreferencedImages) or a
  // campaign image the old campaign's prune can no longer see.
  const scope = async (): Promise<AnyArtifact> => {
    const current = await db.artifacts.get(id);
    if (!current) throw new NotFoundError('Artifact', id);
    if (images !== undefined) {
      // The re-anchor set comes from the row as read INSIDE the transaction
      // (fresher than the caller's pre-read snapshot), cover included (D2).
      const imageIds =
        current.coverImageId !== null
          ? [...current.imageIds, current.coverImageId]
          : current.imageIds;
      await reanchorImages(imageIds, images.anchor);
    }
    const next = anyArtifactSchema.parse({
      ...current,
      ...changes,
      currentRevision: current.currentRevision + 1,
      updatedAt: Date.now(),
    });
    await writeRevision(next, meta);
    return next;
  };
  if (tx !== undefined) return scopeInTx(tx, id, changes, meta, images);
  return db.transaction('rw', [db.artifacts, db.revisions, db.images], scope);
}

/** The in-transaction half of a scope transition: everything `scope` does,
 * reading the row through the caller's own transaction instead of opening a
 * second one (a bulk release inside `deleteModule`'s scope). */
async function scopeInTx(
  tx: ScopeTx,
  id: Id,
  changes: { campaignId?: Id | null; moduleId?: Id | null },
  meta: RevisionMeta,
  images?: { anchor: Id | null },
): Promise<AnyArtifact> {
  const current = await tx.artifacts.get(id);
  if (!current) throw new NotFoundError('Artifact', id);
  if (images !== undefined) {
    const imageIds =
      current.coverImageId !== null
        ? [...current.imageIds, current.coverImageId]
        : current.imageIds;
    await reanchorImages(imageIds, images.anchor);
  }
  const next = anyArtifactSchema.parse({
    ...current,
    ...changes,
    currentRevision: current.currentRevision + 1,
    updatedAt: Date.now(),
  });
  await tx.artifacts.put(next);
  await tx.revisions.put(revisionRowFor(next, meta));
  return next;
}

/**
 * Assign a generated campaign artifact to its module while preserving the
 * compatibility tag in the same revision. Plain `updateArtifact` pins scope
 * fields, so generation writers must use this explicit ownership pathway.
 *
 * Loud existence check (AGENTS rule 1): the module row must still exist —
 * a module deleted while its generation was in flight can never receive an
 * ownership stamp, so a dangling `moduleId` pointing at a removed row is
 * impossible to create through this pathway.
 */
export async function stampModuleOwnership(
  id: Id,
  moduleId: Id,
  moduleTag: string,
  meta: RevisionMeta = USER_SAVE,
): Promise<Artifact> {
  return db.transaction('rw', db.artifacts, db.revisions, db.modules, async () => {
    const current = await db.artifacts.get(id);
    if (current === undefined) throw new NotFoundError('Artifact', id);
    if (current.campaignId === null) {
      throw new Error('A global library entry cannot be stamped into a module.');
    }
    const module = await db.modules.get(moduleId);
    if (module === undefined) {
      throw new Error(
        `Cannot stamp module ownership: module ${moduleId} no longer exists — ` +
          'it was deleted while its generation was still running.',
      );
    }
    const next = artifactSchema.parse({
      ...current,
      moduleId,
      tags: current.tags.includes(moduleTag) ? current.tags : [...current.tags, moduleTag],
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
 *
 * Single-map-slot guard (owner decision, docs/11): the LIVE battlemap of an
 * encounter (`data.mapImageId`) can never be deleted — neither from its own
 * gallery nor from any other artifact's. The gallery holds exactly one map
 * per encounter and Regenerate replaces it; deleting the row would destroy
 * the blob under the live board. Refuses LOUDLY (both gallery call sites
 * surface the throw as a toast) with guidance toward Regenerate.
 */
export async function removeImageFromArtifact(artifactId: Id, imageId: Id): Promise<void> {
  const mapped = await db.artifacts
    .filter((row) => row.kind === 'encounter' && (row.data as { mapImageId?: unknown }).mapImageId === imageId)
    .toArray();
  const owner = mapped[0];
  if (owner !== undefined) {
    const ownerName = (owner as { name?: unknown }).name;
    throw new Error(
      `Regenerate replaces the battlemap; the live map cannot be deleted${
        typeof ownerName === 'string' ? ` (it is the battlemap of encounter “${ownerName}”)` : ''
      } — run Regenerate on the encounter to swap in a fresh map.`,
    );
  }
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
    await scrubSnapshotRows(revisions, [imageId]);
  });
  await deleteImageIfUnreferenced(imageId);
}

/**
 * Releases snapshot pins for image ids on ONE artifact's revision history.
 * Runs inside the caller's rw transaction over artifacts + revisions (both
 * `removeImageFromArtifact` and the attach seam's delete-after-replace
 * provide one). Scrubbed snapshots render the entity without the image;
 * restored revisions simply show it imageless — the restore path stays
 * intact, only the pin is gone.
 */
async function scrubSnapshotImages(artifactId: Id, imageIds: readonly Id[]): Promise<void> {
  const revisions = await db.revisions.where('artifactId').equals(artifactId).toArray();
  await scrubSnapshotRows(revisions, imageIds);
}

async function scrubSnapshotRows(
  revisions: ArtifactRevision[],
  imageIds: readonly Id[],
): Promise<void> {
  const scrubbed = new Set(imageIds);
  for (const revision of revisions) {
    // Snapshot images are scrubbed in place; the row is parsed on load
    // everywhere else (parseRevisionRow), so only the two fields this
    // function touches are read here.
    const snapshot = revision.snapshot as {
      imageIds?: Id[];
      coverImageId?: Id | null;
    } | null;
    if (snapshot === null) continue;
    const inList = (snapshot.imageIds ?? []).some((id) => scrubbed.has(id));
    const isCover = snapshot.coverImageId !== undefined && snapshot.coverImageId !== null && scrubbed.has(snapshot.coverImageId);
    if (!inList && !isCover) continue;
    await db.revisions.put({
      ...revision,
      snapshot: {
        ...snapshot,
        ...(inList ? { imageIds: (snapshot.imageIds ?? []).filter((id) => !scrubbed.has(id)) } : {}),
        ...(isCover ? { coverImageId: null } : {}),
      } as unknown as Artifact,
    });
  }
}

/**
 * Restores a historical snapshot by saving it as a new revision (05-UI:
 * "restore = save as new revision"); the old revisions stay untouched.
 *
 * Scope is pinned to the CURRENT row (updateArtifact semantics): a snapshot
 * taken under a different scope restores CONTENT-ONLY — campaignId/moduleId
 * never time-travel, because the explicit scope transitions (moveToModule /
 * adoptIntoCampaign / publishToLibrary, via moveScope) are the only
 * sanctioned pathway for scope changes and the revision list UI keeps
 * offering them.
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
      // Scope pin: the snapshot's own campaignId/moduleId are ignored.
      campaignId: current.campaignId,
      moduleId: current.moduleId,
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

/**
 * Moves an owned artifact into a module of its own campaign (10-MILESTONE-6
 * M6-B). The target module must exist and share the artifact's campaign
 * anchor — a cross-campaign move would strand images and battle rows that
 * key on the old campaignId, so it is refused loudly, not clamped.
 */
export async function moveToModule(id: Id, moduleId: Id): Promise<AnyArtifact> {
  const artifact = await db.artifacts.get(id);
  if (!artifact) throw new NotFoundError('Artifact', id);
  if (artifact.campaignId === null) {
    throw new Error(
      'A global library entry cannot move into a module — adopt it into a campaign first.',
    );
  }
  const targetModule = await db.modules.get(moduleId);
  if (targetModule === undefined) throw new NotFoundError('Module', moduleId);
  if (targetModule.campaignId !== artifact.campaignId) {
    throw new Error(
      `"${targetModule.title}" belongs to another campaign — artifacts can only move into modules of their own campaign.`,
    );
  }
  return moveScope(id, { moduleId });
}

/**
 * Returns an artifact to campaign ownership. A module-owned row keeps its
 * campaign anchor and only clears the module binding (M6-B). A global
 * library entry needs an explicit target campaign to adopt into (M6-C —
 * its `campaignId: null` becomes a real anchor in the same write).
 */
export async function adoptIntoCampaign(id: Id, campaignId?: Id): Promise<AnyArtifact> {
  const artifact = await db.artifacts.get(id);
  if (!artifact) throw new NotFoundError('Artifact', id);
  if (artifact.campaignId === null) {
    if (campaignId === undefined) {
      throw new Error(
        `"${artifact.name}" lives in the global library — pick a campaign to adopt it into.`,
      );
    }
    // Images follow the artifact out of the library (D2) — they re-anchor
    // into the adopting campaign and its prune takes them back under its
    // wing. The re-anchor happens INSIDE moveScope's transaction.
    return moveScope(id, { campaignId, moduleId: null }, USER_SAVE, { anchor: campaignId });
  }
  if (campaignId !== undefined && campaignId !== artifact.campaignId) {
    throw new Error(
      `"${artifact.name}" is anchored to another campaign and cannot be adopted there.`,
    );
  }
  return moveScope(id, { moduleId: null });
}

/**
 * Publishes an owned artifact into the global library (10-MILESTONE-6 C,
 * D6/D7): the row loses both anchors (one artifact, always referenced —
 * never copied) and its images re-anchor to the library with it (D2), so
 * the old campaign's prune can no longer delete them. Only the library
 * kinds may be published (D6); the id, links, revisions and data survive
 * untouched.
 */
export async function publishToLibrary(id: Id): Promise<GlobalArtifact> {
  const row = await db.artifacts.get(id);
  if (!row) throw new NotFoundError('Artifact', id);
  if (row.campaignId === null) {
    throw new Error(`"${row.name}" is already in the global library.`);
  }
  if (!globalArtifactKindSchema.safeParse(row.kind).success) {
    throw new Error(
      `"${row.name}" is a ${row.kind} — only npcs, locations, events, factions and encounters can be published to the library.`,
    );
  }
  // Images travel (D2): re-anchored to the library inside the same
  // transaction that moves the row, so the campaign's prune (e.g. from a
  // concurrent delete) can never see them as orphans — and a crash can
  // never leave the row and its images scope-desynchronized.
  const published = await moveScope(id, { campaignId: null, moduleId: null }, USER_SAVE, {
    anchor: null,
  });
  return globalArtifactSchema.parse(published);
}

/**
 * Campaigns whose artifacts link at `id` (the adopt-from-library confirm
 * lists them: references in other campaigns become unresolved chips when
 * the row is adopted away — D7, always reference).
 */
export async function campaignsReferencingArtifact(id: Id): Promise<Id[]> {
  const rows = await db.artifacts.toArray();
  const campaigns = new Set<Id>();
  for (const row of rows) {
    if (row.campaignId !== null && row.links.some((link) => link.targetId === id)) {
      campaigns.add(row.campaignId);
    }
  }
  return [...campaigns];
}

export async function listRevisions(artifactId: Id): Promise<ArtifactRevision[]> {
  const rows = await db.revisions.where('artifactId').equals(artifactId).toArray();
  return rows.map(parseRevisionRow).sort((a, b) => b.revision - a.revision);
}

/** Deletes an artifact and its revision history. Idempotent. */
export async function deleteArtifact(id: Id): Promise<void> {
  // Global-scope images collected for the post-commit unreferenced check
  // below (never read inside the transaction: the check's cache-immunity
  // read joins the caller's scope, and this delete nests inside
  // deleteModule's cascade whose scope is fixed — a cache-table read in
  // there throws "not included in parent transaction").
  let globalImagesToRecheck: Id[] = [];
  await db.transaction(
    'rw',
    [
      db.artifacts,
      db.revisions,
      db.images,
      db.battles,
      db.modules,
      db.campaigns,
      db.creatureImages,
    ],
    async () => {
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
      // Battles reference pc/npc artifacts as tokens. A deleted fighter
      // scrubs its tokens; empty battles delete themselves.
      if (artifact.campaignId === null) {
        // Global artifact (M6): no campaign prune reaches its library images,
        // so each is checked after commit, now that the row and revisions are
        // gone. Shared image ids survive until their last global referencer
        // is deleted — and cached portrait blobs survive regardless (the
        // check's NEVER-DELETE immunity, D2).
        globalImagesToRecheck =
          artifact.coverImageId !== null
            ? [...artifact.imageIds, artifact.coverImageId]
            : artifact.imageIds;
      } else {
        await scrubArtifactFromBattles(artifact.campaignId, id);
        // Campaign prune: cached blobs are global-scope rows this scan
        // cannot see (structural immunity — see pruneUnreferencedImages).
        await pruneUnreferencedImages(artifact.campaignId);
      }
    }
  });
  for (const imageId of globalImagesToRecheck) {
    await deleteImageIfUnreferenced(imageId);
  }
}

/**
 * What a per-region bulk delete takes with it. The confirm dialog renders a
 * LIVE prediction of these numbers (`describeArtifactKindRemoval`); the
 * execute path re-derives them INSIDE its transaction and returns what
 * actually went (05-UI §Left pane — Campaign tree; docs/18 §2.1).
 */
export interface ArtifactKindRemovalCounts {
  kind: ArtifactKind;
  /** Campaign-level artifacts of that kind — module-owned rows are out of reach. */
  artifacts: number;
  /** Revision-history rows that go with them (no undo exists for artifacts). */
  revisions: number;
  /** Surviving artifacts whose link list loses a target (the cascade scrubs them). */
  backLinkedArtifacts: number;
  /** Battle tokens scrubbed from this campaign's boards. */
  battleTokensScrubbed: number;
  /** Boards that empty out and delete themselves after the scrub. */
  battlesDeleted: number;
  /** Boards left without their seeding encounter (`encounterArtifactId` dangles —
   * the battle surface says so in as many words, "Seeded encounter no longer exists."). */
  battleProvenancesLost: number;
  /** Campaign image blobs the cascade frees (nothing else references them). */
  imagesPruned: number;
  /** Surviving encounter roster entries left citing a deleted AUTHORED NPC
   * (`npc-ref`): they resolve to the loud `missing ref` badge (docs/11,
   * `resolveMonsterEntry`) — the delete never rewrites an encounter's roster.
   * A `rulebook` entry can never appear here: it cites the read-only library
   * and names no campaign row (docs/11 D9). */
  rosterRefsDangling: number;
}

/** The kinds a per-region bulk delete refuses (domain constant: the Party). */
function assertBulkRemovableKind(kind: ArtifactKind): void {
  if (BULK_REMOVE_EXCLUDED_KINDS.includes(kind)) {
    throw new Error(
      `${ARTIFACT_KIND_LABELS[kind]} has no per-region remove-all — the Party is protected content, and "Clear workspace" in Edit campaign is the only path that deletes it.`,
    );
  }
}

/**
 * Read-only core of the per-region remove-all: the rows a kind sweep would
 * take, plus the counts that describe what goes with them. Runs outside a
 * transaction (the confirm's live census) AND inside the delete's own
 * transaction (the in-tx re-list), so the two can never drift.
 */
async function inspectKindRemoval(
  campaignId: Id,
  kind: ArtifactKind,
): Promise<{ doomed: Artifact[]; counts: ArtifactKindRemovalCounts }> {
  // Campaign-scoped, campaign-LEVEL rows only: `plainRows` in the tree are
  // `moduleId === null`, and module-owned rows (plus module documents,
  // module entity records and module versions) are deliberately out of reach.
  const owned = await listArtifactsByCampaign(campaignId);
  const doomed = owned.filter(
    (artifact) => artifact.kind === kind && artifact.moduleId === null,
  );
  const counts: ArtifactKindRemovalCounts = {
    kind,
    artifacts: doomed.length,
    revisions: 0,
    backLinkedArtifacts: 0,
    battleTokensScrubbed: 0,
    battlesDeleted: 0,
    battleProvenancesLost: 0,
    imagesPruned: 0,
    rosterRefsDangling: 0,
  };
  if (doomed.length === 0) return { doomed, counts };
  const doomedIds = new Set(doomed.map((artifact) => artifact.id));

  const [revisions, survivors, battles, campaignImages, referencedAfter] = await Promise.all([
    db.revisions.where('artifactId').anyOf([...doomedIds]).count(),
    // Every surviving artifact, ANY scope: the cascade's link scrub is
    // global (`deleteArtifact` scans `db.artifacts`), so a library row or
    // another campaign's row that links here is rewritten too — and counted
    // here, because that rewrite is the surprising half of this delete.
    db.artifacts.toCollection().toArray(),
    db.battles.where('campaignId').equals(campaignId).toArray(),
    db.images.where('campaignId').equals(campaignId).toArray(),
    // The image reference set as it will be once the doomed rows (and their
    // revision snapshots) are gone — the same coverage scan the prune uses,
    // so the confirm's number is the prune's number.
    referencedImageIds(campaignId, doomedIds),
  ]);

  counts.revisions = revisions;
  for (const row of survivors) {
    if (doomedIds.has(row.id)) continue;
    if (row.links.some((link) => doomedIds.has(link.targetId))) {
      counts.backLinkedArtifacts += 1;
    }
    if (row.kind !== 'encounter') continue;
    const roster = (row.data as { monsters?: MonsterEntry[] }).monsters;
    if (!Array.isArray(roster)) continue;
    for (const entry of roster) {
      const source = entry.source;
      // ONLY an authored-NPC citation can dangle (docs/11 D9): a `rulebook`
      // entry names a library chunk, and no library row is ever in `doomedIds`.
      if (source.type === 'npc-ref' && doomedIds.has(source.artifactId)) {
        counts.rosterRefsDangling += 1;
      }
    }
  }
  for (const row of battles) {
    const battle = parseBattleRow(row);
    if (
      battle.encounterArtifactId !== null &&
      doomedIds.has(battle.encounterArtifactId)
    ) {
      counts.battleProvenancesLost += 1;
    }
    const doomedTokens = battle.board.tokens.filter(
      (token) => token.artifactId !== null && doomedIds.has(token.artifactId),
    );
    if (doomedTokens.length === 0) continue;
    counts.battleTokensScrubbed += doomedTokens.length;
    const kept = battle.board.tokens.filter(
      (token) => token.artifactId === null || !doomedIds.has(token.artifactId),
    );
    if (isBattleEmpty({ ...battle, board: { ...battle.board, tokens: kept } })) {
      counts.battlesDeleted += 1;
    }
  }
  counts.imagesPruned = campaignImages.filter((image) => !referencedAfter.has(image.id)).length;
  return { doomed, counts };
}

/**
 * What removing every campaign-level artifact of ONE kind would take with it
 * (the tree's per-region confirm reads this live, keyed on the open dialog).
 * Display only: the execute path re-lists inside its own transaction, so
 * these numbers never decide what goes.
 */
export async function describeArtifactKindRemoval(
  campaignId: Id,
  kind: ArtifactKind,
): Promise<ArtifactKindRemovalCounts> {
  assertBulkRemovableKind(kind);
  const { counts } = await inspectKindRemoval(campaignId, kind);
  return counts;
}

/**
 * Per-region bulk delete (owner request: "remove all" beside the kind's `+`):
 * removes every campaign-level artifact of ONE kind in ONE campaign and its
 * generated detail — revision history, back-links pointing at it, battle
 * tokens, freed blobs — while every other kind, the Party, module-owned rows,
 * module documents and versions, and the global library survive untouched.
 * The middle rung of the destructive ladder: per-item trash → THIS → "Remove
 * all generated content" → "Clear workspace" (docs/18 §2.1).
 *
 * Shape: ONE `rw` transaction over exactly the tables `deleteArtifact` needs,
 * the campaign's rows of that kind re-listed INSIDE it (a row created after
 * the dialog opened is swept by the same pass and counted), then the frozen
 * `deleteArtifact` per row — nested, and its scope is a subset, so it joins
 * this transaction: any failure rolls the whole pass back loudly and no
 * success toast can describe a partial run (AGENTS rule 1). Idempotent: zero
 * rows is a success with honest zeros, not an error; an unknown campaign is
 * loud, and `pc` is refused outright.
 *
 * Deliberately NOT scrubbed (audited, docs/18 §2.1 / the decision ledger):
 * deliverable outline nodes (they render the loud "missing artifact"), run
 * `targetArtifactId` / `contextArtifactIds` (rendered as no target; the
 * context list simply omits the gone row), battle `seedFighters` rows (inert
 * once their tokens are scrubbed) and encounter rosters (`npc-ref` — they fall
 * back to the loud `missing ref` badge, and rewriting an authored roster behind
 * the GM's back would be worse). All of these dangle identically through the
 * per-item trash today. A `rulebook` entry is not in this list at all: it
 * cites the read-only library, so no delete here can touch it.
 */
export async function deleteArtifactsOfKind(
  campaignId: Id,
  kind: ArtifactKind,
): Promise<ArtifactKindRemovalCounts> {
  assertBulkRemovableKind(kind);
  return db.transaction(
    'rw',
    [db.artifacts, db.revisions, db.images, db.battles, db.modules, db.campaigns, db.creatureImages],
    async () => {
      const campaign = await db.campaigns.get(campaignId);
      if (campaign === undefined) throw new NotFoundError('Campaign', campaignId);
      // In-tx re-list (deleteModule / wipe doctrine): rows that landed after
      // the confirm counted are swept too, and the returned counts — which
      // drive the success toast — describe what actually went.
      const { doomed, counts } = await inspectKindRemoval(campaignId, kind);
      if (doomed.length === 0) return counts;
      // The two numbers no prediction can claim: images the per-row prunes
      // free, and boards that emptied out and deleted themselves. Measured
      // across the pass, in-tx, instead of guessed.
      const imagesBefore = await db.images.where('campaignId').equals(campaignId).count();
      const battlesBefore = await db.battles.where('campaignId').equals(campaignId).count();
      for (const artifact of doomed) {
        await deleteArtifact(artifact.id);
      }
      const imagesAfter = await db.images.where('campaignId').equals(campaignId).count();
      const battlesAfter = await db.battles.where('campaignId').equals(campaignId).count();
      return { ...counts, imagesPruned: imagesBefore - imagesAfter, battlesDeleted: battlesBefore - battlesAfter };
    },
  );
}

/**
 * Core revision write: puts the artifact row, its revision snapshot, and
 * trims old revisions. Must run inside a `rw` transaction over
 * `artifacts` + `revisions` (all public functions above provide one) so that
 * overlapping saves serialize instead of clobbering revision numbers.
 */
async function writeRevision(valid: AnyArtifact, meta: RevisionMeta): Promise<void> {
  await db.artifacts.put(valid);
  await db.revisions.put(revisionRowFor(valid, meta));
  await trimRevisions(valid.id);
}

/** One revision snapshot row for a written artifact (the writeRevision shape,
 * extracted so the in-transaction scope path records the SAME row). */
function revisionRowFor(valid: AnyArtifact, meta: RevisionMeta): ArtifactRevision {
  return {
    ...stampNewEntity(valid.updatedAt),
    artifactId: valid.id,
    revision: valid.currentRevision,
    snapshot: structuredClone(valid),
    source: meta.source,
    runId: meta.runId ?? null,
  };
}

/**
 * Bulk release of ONE module's rows into plain campaign ownership, inside the
 * caller's transaction (deleteModule's 'keep' branch). ONE shape for the whole
 * release, exactly as a single release writes it: `moduleId: null`, a bumped
 * `currentRevision`, a fresh `updatedAt` and the matching revision snapshot.
 * This is `moveScope` (the only sanctioned scope writer, docs/18 §2.1) applied
 * per row — never a raw `table.modify({moduleId: null})`, which would leave a
 * scope change that no revision records and no undo can see.
 *
 * Ordering is deterministic (the caller passes the module's rows sorted by
 * name) so a mid-release failure rolls back to the same state every time; the
 * whole thing rides the caller's transaction, so a failure releases NOTHING.
 */
export async function releaseModuleOwnership(
  artifacts: readonly Artifact[],
  tx: ScopeTx,
): Promise<void> {
  for (const artifact of artifacts) {
    await moveScope(artifact.id, { moduleId: null }, USER_SAVE, undefined, tx);
  }
}

/** Deletes the oldest revisions beyond the per-artifact cap. */
async function trimRevisions(artifactId: Id): Promise<void> {
  const rows = await db.revisions.where('artifactId').equals(artifactId).toArray();
  if (rows.length <= MAX_REVISIONS_PER_ARTIFACT) return;

  rows.sort((a, b) => a.revision - b.revision);
  const excess = rows.slice(0, rows.length - MAX_REVISIONS_PER_ARTIFACT);
  await db.revisions.bulkDelete(excess.map((row) => row.id));
}
