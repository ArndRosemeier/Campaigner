import type {
  Id,
  Module,
  ModulePart,
  ModulePatch,
  ModuleRow,
  ModuleSpine,
} from '@/domain';
import {
  moduleRowFromDocument,
  moduleRowFromLevelWrites,
  moduleRowFromView,
  moduleRowSchema,
  moduleViewFromRow,
  type ModuleLevelWrite,
} from '@/domain';
import { db } from '@/db/db';
import {
  deleteArtifact,
  listArtifactsByModule,
  releaseModuleOwnership,
} from '@/db/artifactRepo';
import { deleteImageIfUnreferenced } from '@/db/imageRepo';
import { deleteModuleVersionsForModules } from '@/db/moduleVersionRepo';
import { CampaignDocumentExistsError, NotFoundError } from '@/lib/errors';
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
 *
 * Since the storage cut (docs/17 row 382, `version(32)`) the row stores ONE
 * document and this DERIVES the legacy `spine`/`parts` view from it
 * (`domain/moduleDocument.legacyViewFromModuleDocument`), so every reader in
 * the tree speaks the same shape it always did. Nothing is stored twice.
 */
function parseModuleRow(row: ModuleRow): Module {
  return moduleViewFromRow(moduleRowSchema.parse(row));
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
    const module = parseModuleRow(current);
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

/**
 * The canonical save: full-row validate + put with a fresh `updatedAt`.
 * Overwrites the row wholesale — callers must pass the complete module (read
 * via `getModule`/live query or produced by `patchModule`).
 */
export async function saveModule(module: Module): Promise<Module> {
  const valid = moduleRowSchema.parse({
    ...moduleRowFromView(module),
    updatedAt: Date.now(),
  });
  await db.modules.put(valid);
  return moduleViewFromRow(valid);
}

/**
 * The historical CREATION name for `saveModule` — THE same validated upsert
 * (AGENTS rule 4, docs/17 row 312).
 *
 * `createModule` and `saveModule` spelled the identical body twice in this
 * file: same `moduleSchema.parse({ ...module, updatedAt: Date.now() })`, same
 * `put`, same return. They are one operation under two names, and the
 * survivor is `saveModule` — the row's documented canonical save, and the one
 * `patchModule`/`failInterruptedModuleGen` already write through.
 *
 * It is an ALIAS rather than a deleted export ON PURPOSE, and the reason is
 * recorded rather than implied: ~120 callers import this name (the module
 * creation dialog and `llm/moduleGen` among them), so migrating them is a
 * mechanical sweep whose only benefit would be a smaller name surface — while
 * the defect this fold removes is the second IMPLEMENTATION, which is gone.
 * An alias cannot drift from its target; a second `async function` body can.
 */
export const createModule = saveModule;

/**
 * THE one campaign-DOCUMENT creation seam (docs/23 §10 phase 2, docs/17 row
 * 389): a campaign owns exactly ONE module row — its one document — so a
 * SECOND create is REFUSED LOUDLY, naming the document that already exists
 * (`CampaignDocumentExistsError`), and NO row is written (AGENTS rules 1/2:
 * never a silent no-op, never a hidden second row).
 *
 * The check runs INSIDE the same `rw` transaction as the write, so two
 * concurrent creates cannot both pass it. `saveModule`/`createModule` remain
 * the general validated upsert — `patchModule` and its siblings write through
 * them, and a test or an IMPORT that must reproduce a LEGACY multi-module
 * campaign seeds rows directly — but the APP's creation path
 * (`llm/moduleGen.startCampaignDocument`, pinned by
 * `tests/architecture/one-document-per-campaign.test.ts`) goes through HERE.
 */
export async function createCampaignDocument(module: Module): Promise<Module> {
  return db.transaction('rw', db.modules, async () => {
    const existing = await db.modules.where('campaignId').equals(module.campaignId).first();
    if (existing !== undefined) {
      throw new CampaignDocumentExistsError(parseModuleRow(existing).title);
    }
    return saveModule(module);
  });
}

/** Race-safe read-modify-write patch (statuses, parts, spine…). */
export async function patchModule(id: Id, patch: ModulePatch): Promise<Module> {
  return db.transaction('rw', db.modules, async () => {
    const current = await db.modules.get(id);
    if (current === undefined) throw new NotFoundError('Module', id);
    return saveModule({ ...parseModuleRow(current), ...patch });
  });
}

/**
 * THE one atomic SPINE-SUBFIELD patch (docs/17 row 357): re-reads the row
 * INSIDE the transaction (a stale snapshot can never drop a concurrent write)
 * and merges the named fields into the spine, leaving every other spine field
 * — and every part — BYTE-IDENTICAL. The callers are the version restore's
 * premise write (`features/modules/canvas/saveDoc.restorePremise`) and the
 * chat's premise edit (`features/modules/canvas/chatChanges`). The
 * whole-spine replacement and the plan-only replacement were the pass-0
 * checkpoint's writes and are DELETED with pass 0 itself (docs/17 row 392).
 *
 * A module with no spine has no subfield to patch: LOUD, never a silent no-op
 * (AGENTS rule 1) — the caller is asking to change a spine that is not there.
 */
export async function patchModuleSpine(id: Id, patch: Partial<ModuleSpine>): Promise<Module> {
  return db.transaction('rw', db.modules, async () => {
    const current = await db.modules.get(id);
    if (current === undefined) throw new NotFoundError('Module', id);
    const module = parseModuleRow(current);
    if (module.spine === null) {
      throw new Error('Cannot patch the spine of a module without a spine');
    }
    return saveModule({ ...module, spine: { ...module.spine, ...patch } });
  });
}

/**
 * THE one LEVEL-ADDRESSED document write (docs/23 §4, docs/17 row 391): writes
 * one or more LEVELS' section texts and/or recorded run states through the ONE
 * document seam, never a `parts` array keyed by `planIndex`.
 *
 * THE ROW IS RE-READ INSIDE THE TRANSACTION, so a write that landed
 * concurrently (another level's generation, the canvas save, a chat apply) can
 * never be lost to a stale snapshot. The document is spliced by
 * `moduleRowFromLevelWrites` over the row's OWN parsed text, so every byte the
 * write does not name is preserved.
 *
 * THE CALLERS ARE TWO KINDS, and the write says which it is rather than letting
 * a reader guess:
 *   - the GENERATOR (`llm/moduleGen`) states the level's own run state —
 *     `generating` while the call is in flight, then `ready` with the serving
 *     model and `edited: false` (it is the generator's text by construction), or
 *     `failed`/`pending` with the error and the text the attempt did not
 *     replace. A state-only write (no `text`) is how a failed review marks a
 *     level without losing the prose it reviewed.
 *   - a HAND EDIT (the reader's editor) and the board's Apply/Discard state
 *     `status: 'ready'`, `edited: true` and their own `origin`; an OMITTED
 *     `writerModel` CARRIES the id already recorded — the owner's edits must
 *     never erase which model wrote the text they edited (docs/17 row 93).
 *
 * PROVENANCE/AUTHORSHIP ride the same `state` (`docs/17` rows 93/113), and the
 * PREMISE's own provenance (`premiseWriterModel`/`premiseOrigin`) is named
 * separately by a caller that rewrote level 0 — the text is a level like any
 * other, but the premise records no run state.
 */
export async function saveModuleLevels(
  id: Id,
  writes: readonly ModuleLevelWrite[],
  premise?: { writerModel: string; origin: ModulePart['origin'] },
): Promise<Module> {
  return db.transaction('rw', db.modules, async () => {
    const current = await db.modules.get(id);
    if (current === undefined) throw new NotFoundError('Module', id);
    const next = moduleRowSchema.parse({
      ...moduleRowFromLevelWrites(moduleRowSchema.parse(current), writes, premise),
      updatedAt: Date.now(),
    });
    await db.modules.put(next);
    return moduleViewFromRow(next);
  });
}

/**
 * THE one DOCUMENT write (docs/23 §2–§4, docs/17 row 384): replaces the
 * module's ONE text, byte-exact, and nothing else. This is the canvas/chat's
 * write — an edit is a TEXT edit over the whole document, so it cannot land
 * per part.
 *
 * `document` is PARSED inside the transaction by `moduleRowFromDocument`, which
 * refuses a malformed document LOUDLY by line (`ModuleDocumentError`) — the
 * row is never written with text its own reader cannot read back (AGENTS rules
 * 1/3), and because the parse happens in the SAME transaction as the write, a
 * concurrent edit can never slip between validation and persistence.
 *
 * `writerModel` is the authorship signal (docs/17 row 93, exactly as
 * `patchModulePartText` reads it): supplied = a model wrote this text, omitted =
 * a hand edit that CARRIES the recorded id forward. Only the levels whose text
 * actually changed are stamped; every other level's run state and provenance
 * are byte-untouched.
 */
export async function saveModuleDocument(
  id: Id,
  document: string,
  writerModel?: string,
): Promise<Module> {
  return db.transaction('rw', db.modules, async () => {
    const current = await db.modules.get(id);
    if (current === undefined) throw new NotFoundError('Module', id);
    const next = moduleRowSchema.parse({
      ...moduleRowFromDocument(moduleRowSchema.parse(current), document, writerModel),
      updatedAt: Date.now(),
    });
    await db.modules.put(next);
    return moduleViewFromRow(next);
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
