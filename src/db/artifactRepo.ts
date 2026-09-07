import {
  anyArtifactSchema,
  artifactRevisionSchema,
  artifactSchema,
  createArtifact as buildArtifact,
  newId,
  stampNewEntity,
  type AnyArtifact,
  type Artifact,
  type ArtifactData,
  type ArtifactPatch,
  type ArtifactRevision,
  type CreateArtifactInput,
  type GlobalArtifact,
  type Id,
  type RevisionSource,
  type StoredImage,
  MAX_REVISIONS_PER_ARTIFACT,
  globalArtifactKindSchema,
  globalArtifactSchema,
} from '@/domain';
import { db } from '@/db/db';
import { scrubArtifactFromBattles } from '@/db/battleRepo';
import {
  buildStoredImage,
  deleteImageIfUnreferenced,
  deleteUnreferencedImages,
  pruneUnreferencedImages,
  reanchorImages,
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
 * referenced when the candidate scan runs.
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
  return db.transaction('rw', [db.images, db.artifacts, db.revisions], async () => {
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
    const mergedImages = [
      ...current.imageIds,
      ...attached.filter((imageId) => !current.imageIds.includes(imageId)),
    ];
    const next = await updateArtifact(id, {
      imageIds: mergedImages,
      ...(input.data !== undefined ? { data: input.data } : {}),
      coverImageId: input.coverImageId !== undefined ? input.coverImageId : createdCover,
    }, input.meta ?? USER_SAVE);
    if (input.pruneCandidates !== undefined) {
      await deleteUnreferencedImages(
        input.pruneCandidates.campaignId,
        input.pruneCandidates.candidateIds,
      );
    }
    return next;
  });
}

/** Applies a scope transition (module move, adoption, publication) as a
 * revisioned save — the ONLY path that may change `campaignId`/`moduleId`
 * (10-MILESTONE-6 B/C). Content fields are untouched. */
async function moveScope(
  id: Id,
  changes: { campaignId?: Id | null; moduleId?: Id | null },
  meta: RevisionMeta = USER_SAVE,
  images?: { anchor: Id | null },
): Promise<AnyArtifact> {
  // `db.images` joins the transaction when the move re-anchors its images
  // (adopt/publish): a crash between the row move and the image re-anchor
  // would desynchronize scopes — a library image stranded in a campaign's
  // prune scope (permanent blob loss via pruneUnreferencedImages) or a
  // campaign image the old campaign's prune can no longer see.
  return db.transaction('rw', [db.artifacts, db.revisions, db.images], async () => {
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
  });
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
      // Snapshot images are scrubbed in place; the row is parsed on load
      // everywhere else (parseRevisionRow), so only the two fields this
      // function touches are read here.
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
      `"${row.name}" is a ${row.kind} — only npcs, locations, factions and encounters can be published to the library.`,
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
 * Core revision write: puts the artifact row, its revision snapshot, and
 * trims old revisions. Must run inside a `rw` transaction over
 * `artifacts` + `revisions` (all public functions above provide one) so that
 * overlapping saves serialize instead of clobbering revision numbers.
 */
async function writeRevision(valid: AnyArtifact, meta: RevisionMeta): Promise<void> {
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
