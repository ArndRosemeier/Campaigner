import type { IndexableType } from 'dexie';

import type { Id, ModuleDocumentVersion, ModuleVersionSource } from '@/domain';
import {
  assembleModulePartsDocument,
  MODULE_VERSION_CAP,
  moduleDocumentVersionSchema,
  moduleSchema,
} from '@/domain';
import { newId } from '@/domain/entity';
import { db } from '@/db/db';
import { NotFoundError } from '@/lib/errors';

/**
 * Durable module document versions (owner-directed simple undo: "Before each
 * AI change, simply save the whole content in a version"; docs/17 ledger row
 * 63, docs/18 §2.3): the ONE snapshot seam every AI-produced whole-document
 * write funnels through, plus the menu's read and the Clear-all door.
 *
 * What a row IS: the WHOLE module parts document — the SAME text
 * `assembleModulePartsDocument` builds and `splitPartsDocument` splits
 * (`==========` separators, `[Part <n> of <total> — <title>]` labels, every
 * planned part in plan order, spine premise excluded), captured BYTE-EXACT as
 * it stood immediately BEFORE the change it precedes. There is no second
 * document format: a restore re-splits the stored text against the CURRENT
 * plan through the existing split/save seam.
 *
 * Snapshot BEFORE the write, never after — `saveWholeModuleDocument` takes it
 * inside its own seam for canvas AI saves, and `moduleGen`'s AI passes take
 * it at pass entry (before the first row write). A snapshot failure throws
 * LOUDLY to the caller: an AI change whose pre-state could not be recorded
 * must not land silently (AGENTS 1) — the callers surface it (canvas toast /
 * failed module pass).
 *
 * Bounded growth: at most `MODULE_VERSION_CAP` rows per module, the OLDEST
 * pruned in the same transaction as the insert; the menu states the retention
 * and the Clear-all door empties ONE module's stack (never another's).
 *
 * Death has ONE implementation too (docs/18 §2.1): `deleteModuleVersionsForModules`
 * is called by every path that removes module rows — `deleteModule` and the
 * three campaign-scoped bulk deletes — each of them inside its own delete
 * transaction, plus `pruneOrphanedModuleVersions` for rows whose module row
 * is already gone (residue a pre-sweep wipe left). The menu's per-module
 * Clear-all door is a separate, module-keyed scope (`clearModuleVersions`).
 */

/**
 * Captures the pre-change whole-module parts document onto the durable stack.
 * Returns the row, or `null` for a module with NO planned parts: such a module
 * has no parts document at all (the canvas and the chat both refuse it, and
 * no part text can exist to lose — `discardSpine` keeps parts but clears the
 * plan, which is the structural no-document case, not a failed snapshot).
 * A missing module row throws (nothing can be snapshotted onto a deleted
 * module), and so does a malformed row.
 */
export async function snapshotModuleVersion(
  moduleId: Id,
  source: ModuleVersionSource,
  label: string,
): Promise<ModuleDocumentVersion | null> {
  const row = await db.modules.get(moduleId);
  if (row === undefined) {
    throw new NotFoundError('Module', moduleId);
  }
  const module = moduleSchema.parse(row);
  const partPlan = module.spine?.partPlan ?? [];
  if (partPlan.length === 0) return null;
  const { document } = assembleModulePartsDocument({ partPlan, parts: module.parts });
  return db.transaction('rw', db.moduleVersions, async () => {
    // The module's rows are re-listed INSIDE the transaction: the stack that
    // decides the timestamp AND the prune is the one in the database, never a
    // stale reading. `createdAt` is strictly increasing per module —
    // `Date.now()` is only a millisecond wide, and two snapshots landing in
    // the same tick would otherwise make "newest" a coin flip for both the
    // menu order and the prune (a burst of AI passes must still prune the
    // OLDEST row, never an arbitrary one).
    const existing = await db.moduleVersions.where('moduleId').equals(moduleId).toArray();
    const newest = existing.reduce((max, entry) => Math.max(max, entry.createdAt), 0);
    const now = Math.max(Date.now(), newest + 1);
    const version = moduleDocumentVersionSchema.parse({
      id: newId(),
      createdAt: now,
      updatedAt: now,
      moduleId,
      source,
      label,
      docText: document,
    });
    await db.moduleVersions.put(version);
    // Prune in the SAME transaction: the retained window is never momentarily
    // wider than the cap, and a prune can never outlive a rolled back insert.
    if (existing.length + 1 > MODULE_VERSION_CAP) {
      const doomed = [...existing, version]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(MODULE_VERSION_CAP);
      await db.moduleVersions.bulkDelete(doomed.map((entry) => entry.id));
    }
    return version;
  });
}

/**
 * The ONE place durable version rows die (docs/18 §2.1 "Delete a module /
 * campaign / artifact"): every path that removes a module row calls this with
 * the ids it is about to remove — `deleteModule` with its own id, and the
 * campaign-scoped bulk deletes (`deleteCampaign`,
 * `removeAllGeneratedContent`, `deleteCampaignWorkspace`) with their
 * campaign's module ids. The rows describe a document whose module is gone:
 * nothing could ever list, restore or prune them again.
 *
 * The ids are the CALLER's job and must be read in the SAME transaction that
 * deletes the module rows (docs/18 §2.1): the rows are gone afterwards, so a
 * post-hoc enumeration is impossible — and a Dexie `rw` transaction that
 * holds `db.modules` blocks any concurrent transaction that could insert a
 * module row, so nothing can slip in between that enumeration and this sweep
 * (the same in-tx re-list discipline as the wipes' recount). There is no
 * campaign-scoped query to use instead: `moduleVersions` carries no
 * `campaignId` (`moduleId` is the only key a row has), and adding one would
 * be a Dexie version for a delete-only concern.
 *
 * JOINING transaction: the `rw` scope is `db.moduleVersions` alone, so from
 * inside a larger transaction this is a nested SUB-set scope that commits or
 * rolls back WITH it (a failed wipe leaves modules AND versions intact —
 * never a half-state) and standalone it is its own atomic delete.
 */
export async function deleteModuleVersionsForModules(moduleIds: readonly Id[]): Promise<number> {
  if (moduleIds.length === 0) return 0;
  return db.transaction('rw', db.moduleVersions, async () => {
    return db.moduleVersions
      .where('moduleId')
      .anyOf([...moduleIds])
      .delete();
  });
}

/**
 * Module ids that still hold durable version rows but have NO module row —
 * garbage by definition (a version row is only ever written for an existing
 * module: `snapshotModuleVersion` throws `NotFoundError` for a missing one),
 * and unreachable by any module-keyed sweep because the id to sweep with is
 * exactly what is gone.
 *
 * It exists for residue: a database wiped by a build that predates the
 * `deleteModuleVersionsForModules` seam (docs/18 §2.1) kept the rows of the
 * modules that wipe removed, and neither the module id nor the campaign can
 * be recovered from them (`moduleVersions` carries no `campaignId`). The
 * campaign-scoped wipes call `pruneOrphanedModuleVersions` alongside their
 * own sweep, which is the only door that can reach these rows.
 *
 * Companion read of the sweep below (same live-module arbiters): a module id
 * with version rows and no module row. Sorted for deterministic reporting.
 */
export async function listOrphanedModuleVersions(): Promise<Id[]> {
  // Distinct index keys, never the rows themselves: the sweep only needs the
  // ids, and a version row carries a WHOLE module document (`docText`) —
  // materializing the stack to collect ids would read megabytes for nothing.
  const versionModuleIds = await db.moduleVersions.orderBy('moduleId').uniqueKeys();
  const liveModuleIds = await db.modules.toCollection().primaryKeys();
  const live = new Set(uuidKeysOf(liveModuleIds, 'modules.id'));
  return uuidKeysOf(versionModuleIds, 'moduleVersions.moduleId')
    .filter((moduleId) => !live.has(moduleId))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Dexie types index keys as `IndexableType`; every key this seam reads is a
 * uuid STRING (the version schema's `moduleId`, the module row's primary
 * key). A non-string key means a corrupt row: fail loudly instead of
 * stringify-ing it into a bogus id or silently dropping it out of the orphan
 * set (AGENTS rule 1 — never a quiet fallback at a boundary).
 */
function uuidKeysOf(keys: readonly IndexableType[], what: string): Id[] {
  return keys.map((key) => {
    if (typeof key !== 'string') {
      throw new Error(`${what} holds a non-string key (${typeof key}) — the row is corrupt`);
    }
    return key;
  });
}

/**
 * Collects the rows `listOrphanedModuleVersions` reports by riding the ONE
 * sweep (never a second delete of its own) and returns how many went. Intended
 * to be called inside the caller's transaction (the campaign wipes do): the
 * query and the delete then share one rollback scope.
 */
export async function pruneOrphanedModuleVersions(): Promise<number> {
  return deleteModuleVersionsForModules(await listOrphanedModuleVersions());
}

/**
 * The module's durable versions, NEWEST FIRST (the menu's order). Every read
 * zod-parses the row (parse-on-read convention) — a corrupt row fails loudly
 * rather than rendering as a blank entry.
 */
export async function listModuleVersions(moduleId: Id): Promise<ModuleDocumentVersion[]> {
  const rows = await db.moduleVersions.where('moduleId').equals(moduleId).toArray();
  return rows
    .map((row) => moduleDocumentVersionSchema.parse(row))
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

/**
 * Count only (the menu's retention line and the Clear-all confirm copy) —
 * same index, no row materialization.
 */
export async function countModuleVersions(moduleId: Id): Promise<number> {
  return db.moduleVersions.where('moduleId').equals(moduleId).count();
}

/**
 * "Clear all previous versions" for ONE module: deletes exactly that module's
 * durable versions and returns how many went (the loud toast names the
 * number). Another module's stack is structurally untouched (the sweep is
 * keyed by `moduleId`), and NO snapshot is taken first — a snapshot would
 * immediately re-create what the owner just cleared.
 *
 * Deletes the full set in ONE `rw` transaction over the module's rows: a
 * failure rolls the whole clear back, so the stack is never half-emptied.
 */
export async function clearModuleVersions(moduleId: Id): Promise<number> {
  return db.transaction('rw', db.moduleVersions, async () => {
    const rows = await db.moduleVersions.where('moduleId').equals(moduleId).toArray();
    if (rows.length > 0) {
      await db.moduleVersions.bulkDelete(rows.map((row) => row.id));
    }
    return rows.length;
  });
}
