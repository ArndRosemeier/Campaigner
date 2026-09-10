import type { Id, Module, ModulePart, ModulePatch, ModuleSpine, PartPlan } from '@/domain';
import { moduleSchema } from '@/domain';
import { db } from '@/db/db';
import { deleteArtifact, listArtifactsByModule } from '@/db/artifactRepo';
import { deleteImageIfUnreferenced } from '@/db/imageRepo';
import { NotFoundError } from '@/lib/errors';
import { deleteBattlesByModule } from '@/db/battleRepo';

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

/** Total module count (onboarding detection). */
export async function countModules(): Promise<number> {
  return db.modules.count();
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
 * THE one part-text save path (18-ARCHITECTURE §2.3): writes ONE part's
 * markdown onto the module row with `status: 'ready'` + `edited: true`.
 * The row is re-read INSIDE the transaction, so a parts write that landed
 * concurrently (another part's save, a generation finishing) can never be
 * lost to a stale snapshot — the patch carries only the changed part.
 * Every part-text write funnels through this (reader hand edits, canvas
 * rewrite Apply/Discard); part bodies live on the MODULE ROW — there is no
 * artifact revision for part markdown.
 */
export async function patchModulePartText(
  id: Id,
  planIndex: number,
  markdown: string,
): Promise<Module> {
  return db.transaction('rw', db.modules, async () => {
    const current = await db.modules.get(id);
    if (current === undefined) throw new NotFoundError('Module', id);
    const module = moduleSchema.parse(current);
    const nextPart: ModulePart = {
      planIndex,
      markdown,
      status: 'ready',
      errorMessage: '',
      edited: true,
    };
    const exists = module.parts.some((part) => part.planIndex === planIndex);
    const parts = exists
      ? module.parts.map((part) =>
          part.planIndex === planIndex ? nextPart : part,
        )
      : [...module.parts, nextPart].sort((a, b) => a.planIndex - b.planIndex);
    return saveModule({ ...module, parts });
  });
}

/**
 * Deletes a module row and disposes of the artifacts it owns (10-MILESTONE-6
 * D5): `'cascade'` deletes them (with their revisions/images scrub), `'keep'`
 * releases them into campaign ownership (`moduleId: null`, campaign anchor
 * stays), and `'promote-referenced'` shares every owned artifact that is
 * referenced from outside the module (auto-promote's reference scan) into
 * campaign ownership while cascading the unreferenced rest — never a silent
 * dangle, never a silent wipe of something another module still uses. The
 * choice is explicit and loud — the confirm dialog in the module list is the
 * only caller — so a silent orphaning or a silent wipe can never happen by
 * accident.
 *
 * The whole disposal is ONE `rw` transaction over every touched table, and
 * the owned rows are re-listed INSIDE it: the chosen branch applies to the
 * rows that exist at delete time (never to a snapshot counted when the
 * dialog opened), and a half-applied cascade is impossible — any failure
 * rolls the module delete back with it.
 *
 * `'promote-referenced'` does its adoptions BEFORE the transaction (each
 * `adoptIntoCampaign` is its own atomic, revisioned scope change through the
 * sanctioned `moveScope` path — never an inline scope write): the delete
 * transaction then re-lists the owned rows, which no longer include the
 * promoted ones, and cascades the rest. A promotion failure throws loudly
 * before anything is deleted.
 *
 * Any in-flight spine/parts pass for this module is aborted first (it would
 * keep writing into a module that is being removed). Runs already in flight
 * FAIL loudly at finalize (their placement existence check refuses a
 * deleted module) — the deletion contract is: in-flight runs fail loudly,
 * already-finalized rows cascade/release, nothing dangles.
 */
export async function deleteModule(
  id: Id,
  ownedArtifacts: 'cascade' | 'keep' | 'promote-referenced',
): Promise<void> {
  // Dynamic imports: moduleGen transitively imports this repo, and the
  // auto-promote reference scan reads it — static imports would be module
  // cycles.
  const { cancelModuleGen } = await import('@/llm/moduleGen');
  cancelModuleGen(id);
  if (ownedArtifacts === 'promote-referenced') {
    const { modulesReferencingOwnedArtifacts } = await import('@/db/artifactAutoPromote');
    const { adoptIntoCampaign } = await import('@/db/artifactRepo');
    const referenced = await modulesReferencingOwnedArtifacts(id);
    for (const entry of referenced) {
      await adoptIntoCampaign(entry.artifact.id);
    }
  }
  // The module's own cover blob (outside the artifact tables): captured
  // BEFORE the transaction deletes the row, freed AFTER it — the refcheck's
  // cache-table read cannot join this scope, and the in-tx cascade prunes
  // still see the row (pinned until the delete lands at the end).
  const doomedCover = (await getModule(id))?.coverImageId ?? null;
  await db.transaction(
    'rw',
    [
      db.modules,
      db.artifacts,
      db.revisions,
      db.images,
      db.battles,
      db.settings,
      db.campaigns,
      db.moduleVersions,
    ],
    async () => {
      // Re-listed INSIDE the transaction (count honesty): rows that landed
      // after the dialog opened are disposed by the same branch.
      const ownedRows = await listArtifactsByModule(id);
      // Battles are live play state, not authored module content; neither
      // delete branch can leave one pointing at a removed module.
      await deleteBattlesByModule(id);
      // The durable document versions belong to the module row itself
      // (docs/18 §2.3 simple undo): no branch keeps them — they describe a
      // document that no longer exists, and nothing could ever prune them
      // again. Same transaction, so a failed delete leaves them intact.
      await db.moduleVersions.where('moduleId').equals(id).delete();
      // The TopBar last-module shortcut must not outlive the module it
      // points at — a stale shortcut navigates to a dead reader route.
      const settings = await db.settings.get('settings');
      if (settings?.lastModule?.moduleId === id) {
        await db.settings.update('settings', { lastModule: null });
      }
      if (ownedArtifacts === 'keep') {
        // Module-owned rows carry the module's campaignId, so clearing the
        // module binding drops them back into plain campaign ownership with
        // their images/links/revisions untouched.
        await db.artifacts.where('moduleId').equals(id).modify({ moduleId: null });
        await db.modules.delete(id);
        return;
      }
      // 'cascade' AND 'promote-referenced' both land here: referenced rows
      // were already adopted above (re-listed ownedRows no longer include
      // them), so the loop deletes exactly the unreferenced rest.
      for (const artifact of ownedRows) {
        await deleteArtifact(artifact.id);
      }
      await db.modules.delete(id);
    },
  );
  if (doomedCover !== null) {
    await deleteImageIfUnreferenced(doomedCover);
  }
}
