import {
  campaignSchema,
  createCampaign as buildCampaign,
  type Campaign,
  type EntityPatch,
  type NewCampaign,
} from '@/domain';
import { db } from '@/db/db';
import { deleteArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { listModulesByCampaign } from '@/db/moduleRepo';
import {
  deleteModuleVersionsForModules,
  pruneOrphanedModuleVersions,
} from '@/db/moduleVersionRepo';
import { pruneUnreferencedImages } from '@/db/imageRepo';
import { NotFoundError } from '@/lib/errors';

export type CampaignPatch = EntityPatch<Campaign>;

/**
 * Parses on read so rows written before a schema addition pick up new
 * defaulted fields (e.g. `coverImageId`) — and an invalid row fails loudly
 * instead of leaking a partial type (AGENTS rule 1, moduleRepo precedent).
 */
function parseCampaignRow(row: Campaign): Campaign {
  return campaignSchema.parse(row);
}

/** All campaigns, most recently updated first (picker order). */
export async function listCampaigns(): Promise<Campaign[]> {
  const rows = await db.campaigns.toArray();
  return rows.map(parseCampaignRow).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Total campaign count (onboarding detection, guide routing). */
export async function countCampaigns(): Promise<number> {
  return db.campaigns.count();
}

export async function getCampaign(id: string): Promise<Campaign | undefined> {
  const row = await db.campaigns.get(id);
  return row === undefined ? undefined : parseCampaignRow(row);
}

export async function createCampaign(input: NewCampaign): Promise<Campaign> {
  const campaign = buildCampaign(input);
  await db.campaigns.put(campaign);
  return campaign;
}

/**
 * Merges a patch onto the row (read-modify-write inside a transaction) and
 * re-validates through the schema, so the DB never holds invalid rows.
 */
export async function updateCampaign(id: string, patch: CampaignPatch): Promise<Campaign> {
  return db.transaction('rw', db.campaigns, async () => {
    const current = await db.campaigns.get(id);
    if (!current) throw new NotFoundError('Campaign', id);
    const updated = campaignSchema.parse({ ...current, ...patch, updatedAt: Date.now() });
    await db.campaigns.put(updated);
    return updated;
  });
}

/**
 * Deletes a campaign and everything that hangs off it in one transaction:
 * its artifacts, those artifacts' revisions, its persona runs, its images
 * (M3-A), plus the campaign-anchored rows that carry its id but have no
 * delete path of their own — its modules and the modules' live battles.
 * Everything else prunes only by reference;
 * these tables key on `campaignId` directly, so leaving them behind would
 * strand permanent orphans that every backup re-exports forever.
 *
 * The modules' durable document versions (docs/18 §2.3 simple undo) go with
 * them in the SAME transaction — the module ids are enumerated from the rows
 * INSIDE it, immediately before the module delete, through the ONE sweep seam
 * and its orphan door (§2.1), so a version row can never outlive the document
 * it describes (and a failure rolls the modules AND their stacks back
 * together).
 *
 * The TopBar's last-module shortcut is cleared when it pointed into this
 * campaign — a stale shortcut would navigate to a deleted module's reader
 * route (dead route).
 */
export async function deleteCampaign(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.campaigns,
      db.artifacts,
      db.revisions,
      db.runs,
      db.images,
      db.modules,
      db.battles,
      db.creatureImages,
      db.settings,
      db.moduleVersions,
    ],
    async () => {
      const artifacts = await db.artifacts.where('campaignId').equals(id).toArray();
      const artifactIds = artifacts.map((artifact) => artifact.id);

      if (artifactIds.length > 0) {
        await db.revisions.where('artifactId').anyOf(artifactIds).delete();
      }
      await db.artifacts.where('campaignId').equals(id).delete();
      await db.runs.where('campaignId').equals(id).delete();
      // The campaign's creature presentation rows go with its images
      // (docs/11 D5 amendment): a row whose blob is gone would read as a
      // portrait that exists and render nothing.
      await db.creatureImages.where('campaignId').equals(id).delete();
      await db.images.where('campaignId').equals(id).delete();
      // Module rows re-listed INSIDE the transaction: the ids the version
      // sweep needs are the ones that exist at delete time (docs/18 §2.1) —
      // after this delete they are unrecoverable, and the tx holds
      // `db.modules`, so no concurrent insert can land between the two.
      const modules = await db.modules.where('campaignId').equals(id).toArray();
      await deleteModuleVersionsForModules(modules.map((module) => module.id));
      // Plus rows whose module is already gone (residue from a pre-sweep
      // wipe): a version row carries no `campaignId`, so only the global
      // orphan door can reach them — garbage by definition, no campaign owns
      // a module that does not exist.
      await pruneOrphanedModuleVersions();
      await db.modules.where('campaignId').equals(id).delete();
      await db.battles.where('campaignId').equals(id).delete();
      const settings = await db.settings.get('settings');
      if (settings?.lastModule?.campaignId === id) {
        await db.settings.update('settings', { lastModule: null });
      }
      // The New Module draft is TAGGED with its campaign (settings
      // `newModuleDraft`, docs/17): the campaign it was written for is being
      // deleted, so the draft goes with it — leaving it would strand a record
      // whose tag can never match again.
      if (settings?.newModuleDraft?.campaignId === id) {
        await db.settings.update('settings', { newModuleDraft: null });
      }
      await db.campaigns.delete(id);
    },
  );
}

/** Removable-content census for one campaign (the wipe confirm dialog reads
 * this live; the execute path below re-lists everything inside its own
 * transaction and never trusts these numbers). */
export interface GeneratedContentCounts {
  /** Removable (non-`pc`) artifacts grouped by kind, alphabetical by kind. */
  byKind: { kind: string; count: number }[];
  /** Total removable (non-`pc`) artifacts. */
  removableArtifacts: number;
  /** `pc` artifacts — kept untouched by the wipe. */
  pcCount: number;
  modules: number;
  battles: number;
  runs: number;
}

export async function describeGeneratedContent(campaignId: string): Promise<GeneratedContentCounts> {
  const [artifacts, modules, battles, runs] = await Promise.all([
    listArtifactsByCampaign(campaignId),
    listModulesByCampaign(campaignId),
    db.battles.where('campaignId').equals(campaignId).toArray(),
    db.runs.where('campaignId').equals(campaignId).count(),
  ]);
  const kindCounts = new Map<string, number>();
  let pcCount = 0;
  for (const artifact of artifacts) {
    if (artifact.kind === 'pc') {
      pcCount += 1;
      continue;
    }
    kindCounts.set(artifact.kind, (kindCounts.get(artifact.kind) ?? 0) + 1);
  }
  const byKind = [...kindCounts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
  return {
    byKind,
    removableArtifacts: artifacts.length - pcCount,
    pcCount,
    modules: modules.length,
    battles: battles.length,
    runs,
  };
}

/** What `removeAllGeneratedContent` actually deleted — recounted from the
 * fresh in-transaction re-list, so the success toast reports what went, not
 * what the dialog showed when it opened. */
export interface RemovedContentCounts {
  /** Deleted (non-`pc`) artifacts grouped by kind, alphabetical by kind. */
  byKind: { kind: string; count: number }[];
  artifacts: number;
  pcsKept: number;
  modules: number;
  battles: number;
  runs: number;
  /**
   * Cited creatures' presentation portraits this campaign held
   * (`db/creatureImages`, docs/11 D5 amendment): the rows ARE campaign state,
   * so the wipe takes them; the creatures themselves are the library's and the
   * shared canonical slots are untouched.
   */
  creaturePortraitsCleared: number;
  imagesPruned: number;
}

/**
 * Fresh-generation wipe (owner-ordered "remove all"): deletes everything a
 * campaign's generation produced — every non-`pc` artifact (campaign- AND
 * module-owned, with revisions scrubbed through the artifact delete path),
 * every module row, every battle of the campaign, plus the campaign runs that
 * would otherwise dangle into deleted rows (the `deleteCampaign` table set
 * minus the campaign row itself) — while the Party
 * (`pc` artifacts, untouched with their revisions/images/links), the campaign
 * row, settings, personas and the global library survive.
 *
 * Transaction discipline (no half-applied wipe): in-flight module passes are
 * aborted BEFORE the transaction opens (a native-promise dynamic import must
 * never gap a Dexie scope), then the whole disposal is ONE `rw` transaction
 * over every touched table. Modules, artifacts, battles and runs are ALL
 * re-listed INSIDE it — the dialog's counts never decide
 * what goes — and any failure rolls the entire wipe back loudly (AGENTS rule
 * 1: a partial wipe with a success toast is the failure mode this exists to
 * prevent).
 *
 * Battles: every battle row carries its campaign's id (the schema mandates
 * `moduleId` too, so no module-less straggler can exist outside this sweep).
 * Images: orphaned campaign blobs prune through the existing
 * `pruneUnreferencedImages` path, which only ever scans this campaign's rows
 * — library/global images are structurally unreachable and survive.
 *
 * Durable module versions (docs/18 §2.3 simple undo): the modules this wipe
 * removes take their version rows with them, in the SAME transaction, through
 * the ONE sweep seam and its orphan door (§2.1) — the ids are re-listed
 * inside the transaction right before the module delete. Undo history is not
 * "kept content": a version describes a document whose module is gone.
 */
export async function removeAllGeneratedContent(campaignId: string): Promise<RemovedContentCounts> {
  // Abort in-flight spine/parts passes first (deleteModule precedent): they
  // would keep writing into modules this wipe removes, and their finalize
  // placement checks then fail those runs loudly instead of resurrecting
  // rows. Deliberately OUTSIDE the transaction — the dynamic import awaits a
  // native promise, which would commit an open Dexie scope early.
  const prelisted = await listModulesByCampaign(campaignId);
  const { cancelModuleGen } = await import('@/llm/moduleGen');
  for (const module of prelisted) {
    cancelModuleGen(module.id);
  }

  return db.transaction(
    'rw',
    [
      db.campaigns,
      db.modules,
      db.artifacts,
      db.revisions,
      db.images,
      db.battles,
      db.settings,
      db.runs,
      db.moduleVersions,
      // Creature presentation rows ride the scope: this wipe deletes them and
      // every per-row `deleteArtifact` below reaches the image prune, whose
      // reference walk READS this table (docs/18 §2.1 — a scope that omits it
      // throws "object store did not exist" mid-wipe, the half-applied delete
      // this transaction exists to prevent).
      db.creatureImages,
    ],
    async () => {
      const campaign = await db.campaigns.get(campaignId);
      if (campaign === undefined) throw new NotFoundError('Campaign', campaignId);
      // Fresh recount INSIDE the transaction (deleteModule precedent): rows
      // that landed after the dialog opened are wiped by the same pass, and
      // the returned counts describe what actually went.
      const artifacts = await listArtifactsByCampaign(campaignId);
      const doomed = artifacts.filter((artifact) => artifact.kind !== 'pc');
      const kindCounts = new Map<string, number>();
      for (const artifact of doomed) {
        kindCounts.set(artifact.kind, (kindCounts.get(artifact.kind) ?? 0) + 1);
      }
      const battles = await db.battles.where('campaignId').equals(campaignId).toArray();
      // Re-listed (not counted) so the same read yields the ids the version
      // sweep needs — and the count stays in-tx honest (deleteModule
      // precedent): a module that landed after the dialog opened is wiped by
      // the same pass, versions included.
      const modules = await db.modules.where('campaignId').equals(campaignId).toArray();
      const runCount = await db.runs.where('campaignId').equals(campaignId).count();

      // The existing artifact delete path per doomed row (nested: its tables
      // are a subset of this scope, so it joins this transaction): revision
      // history scrubbed, links from surviving PCs cleaned, battle tokens
      // scrubbed, orphaned campaign images pruned.
      for (const artifact of doomed) {
        await deleteArtifact(artifact.id);
      }
      // Battles are live play state, not Party content: none can survive the
      // modules and encounters they were seeded from (deleteArtifact only
      // scrubs tokens — a PC-only board would linger without this sweep).
      await db.battles.where('campaignId').equals(campaignId).delete();
      // The modules' durable document versions belong to the module rows
      // (docs/18 §2.3 simple undo): they die in the SAME transaction as the
      // delete through the ONE sweep seam (§2.1) — a failed wipe leaves both
      // untouched — plus the orphan door for rows whose module is already
      // gone (residue a pre-sweep wipe left; no campaignId on a version row,
      // so only the global query can reach them).
      await deleteModuleVersionsForModules(modules.map((module) => module.id));
      await pruneOrphanedModuleVersions();
      await db.modules.where('campaignId').equals(campaignId).delete();
      // Runs point at deleted artifacts/modules (targetArtifactId /
      // placementModuleId) — they would dangle, so they go (deleteCampaign
      // precedent).
      await db.runs.where('campaignId').equals(campaignId).delete();
      // Cited creatures' presentation rows are this campaign's own state and
      // go with it (docs/11 D5 amendment): the library rows and the shared
      // canonical portrait slots survive untouched, so the next campaign still
      // clones the same art.
      const creaturePortraitsCleared = await db.creatureImages
        .where('campaignId')
        .equals(campaignId)
        .delete();
      // The TopBar last-module shortcut must not outlive the wiped modules —
      // a stale shortcut navigates to a dead reader route.
      const settings = await db.settings.get('settings');
      if (settings?.lastModule?.campaignId === campaignId) {
        await db.settings.update('settings', { lastModule: null });
      }
      // KEPT ON PURPOSE: the New Module draft (settings `newModuleDraft`) is
      // NOT cleared here. "Remove all generated content" exists so generation
      // can restart clean, and the draft is what makes restarting cheap — the
      // owner retries the module that just went away without retyping the
      // concept. It holds no generated content, and its campaign tag still
      // matches. (Clear workspace keeps it too; `deleteCampaign` clears it,
      // because there the campaign itself is gone.)
      // Final image sweep: catches blobs orphaned by the battle deletes above
      // (covers, battlemaps) that no per-artifact prune saw.
      const imagesPruned = await pruneUnreferencedImages(campaignId);

      return {
        byKind: [...kindCounts.entries()]
          .map(([kind, count]) => ({ kind, count }))
          .sort((a, b) => a.kind.localeCompare(b.kind)),
        artifacts: doomed.length,
        pcsKept: artifacts.length - doomed.length,
        modules: modules.length,
        battles: battles.length,
        runs: runCount,
        creaturePortraitsCleared,
        imagesPruned,
      };
    },
  );
}
