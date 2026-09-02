import type { Id, Module, ModulePatch, ModuleSpine, PartPlan } from '@/domain';
import { moduleSchema } from '@/domain';
import { db } from '@/db/db';
import { deleteArtifact, listArtifactsByModule } from '@/db/artifactRepo';
import { NotFoundError } from '@/lib/errors';

/**
 * Module repo (08-MODULE-DESIGNER M4-A): CRUD plus `saveModule` (full-row
 * validate + put). Modules are NOT revisioned — parts are individually
 * regenerable, that is the undo. Status churn during generation goes through
 * the same validated save so a half-written row can never persist.
 */

/**
 * Parses on read so rows written before a schema addition pick up new
 * defaulted fields (e.g. `focusedEntities`, `entitySort`) — and an invalid
 * row fails loudly instead of leaking a partial type (AGENTS rule 1).
 */
function parseModuleRow(row: Module): Module {
  return moduleSchema.parse(row);
}

export async function getModule(id: Id): Promise<Module | undefined> {
  const row = await db.modules.get(id);
  return row === undefined ? undefined : parseModuleRow(row);
}

/** All modules of a campaign, newest first. */
export async function listModulesByCampaign(campaignId: Id): Promise<Module[]> {
  const rows = await db.modules.where('campaignId').equals(campaignId).toArray();
  return rows.map(parseModuleRow).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Creates a module row (factory builds + validates). */
export async function createModule(module: Module): Promise<Module> {
  const valid = moduleSchema.parse({ ...module, updatedAt: Date.now() });
  await db.modules.put(valid);
  return valid;
}

/**
 * The canonical save: full-row validate + put with a fresh `updatedAt`.
 * Overwrites the row wholesale — callers must pass the complete module (read
 * via `getModule`/live query or produced by `patchModule`).
 */
export async function saveModule(module: Module): Promise<Module> {
  const valid = moduleSchema.parse({ ...module, updatedAt: Date.now() });
  await db.modules.put(valid);
  return valid;
}

/** Race-safe read-modify-write patch (statuses, parts, spine…). */
export async function patchModule(id: Id, patch: ModulePatch): Promise<Module> {
  return db.transaction('rw', db.modules, async () => {
    const current = await db.modules.get(id);
    if (current === undefined) throw new NotFoundError('Module', id);
    return saveModule({ ...current, ...patch });
  });
}

/** Replaces the approved spine (checkpoint edits) without touching parts. */
export async function saveSpine(id: Id, spine: ModuleSpine): Promise<Module> {
  return patchModule(id, { spine });
}

/** Replaces the part plan only (spine premise/themes kept). */
export async function savePartPlan(id: Id, partPlan: PartPlan[]): Promise<Module> {
  return db.transaction('rw', db.modules, async () => {
    const current = await db.modules.get(id);
    if (current === undefined) throw new NotFoundError('Module', id);
    if (current.spine === null) {
      throw new Error('Cannot save a part plan on a module without a spine');
    }
    return saveModule({ ...current, spine: { ...current.spine, partPlan } });
  });
}

/**
 * Deletes a module row and disposes of the artifacts it owns (10-MILESTONE-6
 * D5): `'cascade'` deletes them (with their revisions/images scrub), `'keep'`
 * releases them into campaign ownership (`moduleId: null`, campaign anchor
 * stays). The choice is explicit and loud — the confirm dialog in the module
 * list is the only caller — so a silent orphaning or a silent wipe can
 * never happen by accident.
 */
export async function deleteModule(
  id: Id,
  ownedArtifacts: 'cascade' | 'keep',
): Promise<void> {
  const ownedRows = await listArtifactsByModule(id);
  if (ownedArtifacts === 'keep') {
    // Module-owned rows carry the module's campaignId, so clearing the
    // module binding drops them back into plain campaign ownership with
    // their images/links/revisions untouched.
    await db.artifacts.where('moduleId').equals(id).modify({ moduleId: null });
    await db.modules.delete(id);
    return;
  }
  for (const artifact of ownedRows) {
    await deleteArtifact(artifact.id);
  }
  await db.modules.delete(id);
}
