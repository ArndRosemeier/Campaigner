import type {
  Id,
  Module,
  ModulePart,
  ModulePatch,
  ModuleSpine,
  PartPlan,
  TextOrigin,
} from '@/domain';
import { moduleSchema, recordedWritingModel } from '@/domain';
import { db } from '@/db/db';
import {
  deleteArtifact,
  listArtifactsByModule,
  releaseModuleOwnership,
} from '@/db/artifactRepo';
import { deleteImageIfUnreferenced } from '@/db/imageRepo';
import { deleteModuleVersionsForModules } from '@/db/moduleVersionRepo';
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

/**
 * Every module row whose persisted status is `'generating'` (docs/17 row 110).
 *
 * The rows INDEX carries no `status` (adding one would be a Dexie version for
 * a query that runs a handful of times per session), so this filters the
 * collection; the row count is a workspace's modules, never a hot path.
 */
export async function listGeneratingModules(): Promise<Module[]> {
  const rows = await db.modules.filter((row) => row.status === 'generating').toArray();
  return rows.map(parseModuleRow);
}

/**
 * The interrupted-generation reconcile write (docs/17 row 110): marks a module
 * whose row says `'generating'` as FAILED with `errorMessage`, and rewinds
 * every part slot still at `'generating'` to `'pending'` so the EXISTING
 * recovery path (`moduleGen.generateMissingParts`/`runParts`, which re-runs
 * every part whose status is not `'ready'`) can write them again.
 *
 * `isClaimed` is the liveness guard and it is called INSIDE the transaction,
 * where it cannot race the write it protects: a row is only failed when no
 * live controller claims it at the moment of the write. A caller that cannot
 * answer "is this owned right now?" must not call this at all — the guard is
 * what makes the write safe, and there is deliberately no way to skip it.
 *
 * Returns the failed row, or `undefined` when the row is gone, no longer says
 * `'generating'`, or is claimed (all three are no-ops, so the call is
 * idempotent: after it lands, the row is no longer `'generating'`).
 */
export async function failInterruptedModuleGen(
  id: Id,
  errorMessage: string,
  isClaimed: () => boolean,
): Promise<Module | undefined> {
  return db.transaction('rw', db.modules, async () => {
    const current = await db.modules.get(id);
    if (current === undefined) return undefined;
    const module = moduleSchema.parse(current);
    if (module.status !== 'generating') return undefined;
    if (isClaimed()) return undefined;
    const parts = module.parts.map((part) =>
      part.status === 'generating'
        ? { ...part, status: 'pending' as const, errorMessage: '' }
        : part,
    );
    return saveModule({ ...module, status: 'failed', errorMessage, parts });
  });
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
 *
 * PROVENANCE (docs/17 row 93): `writerModel` is optional and its ABSENCE is
 * the load-bearing default.
 *   - a HAND EDIT (the reader's PartTextEditor, the canvas' manual Save) does
 *     not pass it, and the part KEEPS the id already recorded on the row: the
 *     field answers "which model WROTE this", so the owner's edits must never
 *     erase the provenance of the text they edited (owner decision);
 *   - a chat-applied rewrite passes the CHAT model — the model that wrote the
 *     text now on the row, i.e. the LAST writer;
 *   - a part with no recorded id that a hand edit touches stays `''` (not
 *     recorded → the reader displays nothing), never a settings-derived guess.
 *
 * AUTHORSHIP (docs/17 row 113): this function is ALSO the one place a part's
 * `origin` is stamped, and the rule is the same argument the line above makes
 * — the origin is knowable HERE and thrown away nowhere else. Handing it a
 * `writerModel` records `origin: 'model'` (a model wrote the text now on the
 * row: a canvas chat apply, an accepted AI proposal, an auto-accepted one);
 * omitting it records `origin: 'human'`. `edited` deliberately stays `true`
 * for BOTH — it means "written outside the generator", which is what its
 * readers assume — so the two fields are recorded side by side rather than
 * one being overloaded into a lie. A generator write sets `edited: false` and
 * `origin: 'model'` itself (it is the generator's own text by construction).
 *
 * `authorship` is for the one caller shape the writer-model signal cannot
 * express — a write that does not CHANGE who wrote the text: the board's
 * Apply re-lands the text the engine just wrote (so the model's origin must
 * survive it) and the board's Discard puts the PREVIOUS text back together
 * with the authorship that text had (`stagedRewrites` captures it before the
 * rewrite overwrites the row). It states the origin the caller holds; it is
 * not a second record of authorship — nothing else derives or stores one, and
 * `undefined` keeps the writer-model rule above as the single default.
 */
export async function patchModulePartText(
  id: Id,
  planIndex: number,
  markdown: string,
  writerModel?: string,
  authorship?: TextOrigin | null,
): Promise<Module> {
  return db.transaction('rw', db.modules, async () => {
    const current = await db.modules.get(id);
    if (current === undefined) throw new NotFoundError('Module', id);
    const module = moduleSchema.parse(current);
    const existing = module.parts.find((part) => part.planIndex === planIndex);
    const nextPart: ModulePart = {
      planIndex,
      markdown,
      status: 'ready',
      errorMessage: '',
      edited: true,
      // Omitted `writerModel` = this write cannot name a model (a hand edit),
      // so the recorded id is CARRIED — never blanked.
      writerModel: writerModel ?? recordedWritingModel(existing?.writerModel) ?? '',
      // The author of the text this write just landed. A write that named a
      // model is machine-written; one that could not is the owner's; and a
      // caller that KNOWS the authorship (a write that did not change it)
      // states it.
      origin: authorship !== undefined ? authorship : writerModel === undefined ? 'human' : 'model',
    };
    const parts = existing === undefined
      ? [...module.parts, nextPart].sort((a, b) => a.planIndex - b.planIndex)
      : module.parts.map((part) => (part.planIndex === planIndex ? nextPart : part));
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
      db.creatureImages,
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
      // again. They die through the ONE sweep seam (§2.1), nested in this
      // scope, so a failed delete leaves them intact.
      await deleteModuleVersionsForModules([id]);
      // The TopBar last-module shortcut must not outlive the module it
      // points at — a stale shortcut navigates to a dead reader route.
      const settings = await db.settings.get('settings');
      if (settings?.lastModule?.moduleId === id) {
        await db.settings.update('settings', { lastModule: null });
      }
      if (ownedArtifacts === 'keep') {
        // Module-owned rows carry the module's campaignId, so clearing the
        // module binding drops them back into plain campaign ownership with
        // their content/images/links untouched. The release rides the
        // SANCTIONED scope seam (`releaseModuleOwnership` → `moveScope`, the
        // only writer allowed to change scope, docs/18 §2.1) inside THIS
        // transaction: one revision snapshot + a fresh `updatedAt` per row,
        // so the change is visible in the artifact's history and a failure
        // releases nothing (the rows come from the in-tx re-list above).
        await releaseModuleOwnership(ownedRows, {
          artifacts: db.artifacts,
          revisions: db.revisions,
          images: db.images,
        });
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
