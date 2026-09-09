import Dexie from 'dexie';

import { db } from '@/db/db';
import { deleteArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { listModulesByCampaign } from '@/db/moduleRepo';
import { pruneUnreferencedImages } from '@/db/imageRepo';
import { NotFoundError } from '@/lib/errors';

/** localStorage keys owned by the app; the theme + UI scale survive wipes. */
const APP_STORAGE_PREFIX = 'campaigner.';
const PRESERVED_KEYS = new Set(['campaigner.theme', 'campaigner.uiScale']);

/**
 * "Delete all data" (05-UI.md §Settings danger zone): closes and deletes the
 * IndexedDB database and clears app-owned localStorage (except the theme).
 * The caller reloads the page afterwards so all stores re-seed.
 */
export async function deleteAllData(): Promise<void> {
  db.close(); // synchronous
  // Dexie.delete() returns a Dexie (thenable); normalize for strict typing.
  const deletion: Promise<void> = Dexie.delete(db.name).then(() => undefined);
  await deletion;
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(APP_STORAGE_PREFIX) && !PRESERVED_KEYS.has(key)) {
      localStorage.removeItem(key);
    }
  }
}

/** What `deleteCampaignWorkspace` actually cleared — recounted from the
 * fresh in-transaction re-list, so the success toast reports what went, not
 * what the dialog showed when it opened. */
export interface ClearedWorkspaceCounts {
  /** Deleted artifacts grouped by kind, alphabetical by kind. */
  byKind: { kind: string; count: number }[];
  artifacts: number;
  modules: number;
  battles: number;
  runs: number;
  deliverables: number;
  imagesPruned: number;
}

/**
 * "Clear workspace" (05-UI.md §Campaign picker danger zone): deletes
 * everything under ONE campaign while keeping the campaign row itself (name,
 * description, system — the premise generation restarts from).
 *
 * Campaign-keyed enumeration: modules (parts, board `canvas`, chat threads
 * all live on the module rows, so they go with them), artifacts (EVERY kind
 * including `pc` — unlike `removeAllGeneratedContent`, which keeps the Party
 * — campaign- AND module-owned, revisions scrubbed through the artifact
 * delete path), battles, runs and deliverables (all three would dangle into
 * deleted modules/artifacts). Images prune by reference (the campaign cover
 * blob survives — the prune pins the kept campaign row's `coverImageId` —
 * while module covers and battlemaps go with their rows). The TopBar
 * last-module shortcut is cleared when it pointed into this campaign.
 *
 * Kept, with reasons: the campaign row (the premise — the point of the
 * control); rulebooks/chunks/embeddings/retained PDFs (global source
 * material keyed by book, expensive to rebuild — not workspace output); the
 * global mob-portrait cache (cross-campaign shared art); personas, settings
 * and library artifacts (global, never campaign-keyed); every other
 * campaign's rows (the `campaignId` sweeps cannot see them).
 *
 * Transaction discipline mirrors `removeAllGeneratedContent`: in-flight
 * module passes abort BEFORE the transaction opens (a native-promise dynamic
 * import must never gap a Dexie scope), then ONE `rw` transaction over every
 * touched table re-lists everything INSIDE it — any failure rolls the whole
 * clear back loudly. No Dexie version: deletes only, no schema change.
 */
export async function deleteCampaignWorkspace(campaignId: string): Promise<ClearedWorkspaceCounts> {
  // Abort in-flight spine/parts passes first (deleteModule precedent): they
  // would keep writing into modules this clear removes, and their finalize
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
      db.deliverables,
    ],
    async () => {
      const campaign = await db.campaigns.get(campaignId);
      if (campaign === undefined) throw new NotFoundError('Campaign', campaignId);
      // Fresh recount INSIDE the transaction (deleteModule precedent): rows
      // that landed after the dialog opened are cleared by the same pass,
      // and the returned counts describe what actually went.
      const artifacts = await listArtifactsByCampaign(campaignId);
      const kindCounts = new Map<string, number>();
      for (const artifact of artifacts) {
        kindCounts.set(artifact.kind, (kindCounts.get(artifact.kind) ?? 0) + 1);
      }
      const battles = await db.battles.where('campaignId').equals(campaignId).toArray();
      const moduleCount = await db.modules.where('campaignId').equals(campaignId).count();
      const runCount = await db.runs.where('campaignId').equals(campaignId).count();
      const deliverableCount = await db.deliverables.where('campaignId').equals(campaignId).count();

      // The existing artifact delete path per doomed row (nested: its tables
      // are a subset of this scope, so it joins this transaction): revision
      // history scrubbed, links from surviving rows cleaned, battle tokens
      // scrubbed, orphaned campaign images pruned.
      for (const artifact of artifacts) {
        await deleteArtifact(artifact.id);
      }
      // Battles anchor to the deleted modules and deliverables belong to
      // them; runs point at deleted artifacts/modules — all would dangle, so
      // all go (deleteCampaign precedent, minus the campaign row itself).
      await db.battles.where('campaignId').equals(campaignId).delete();
      await db.modules.where('campaignId').equals(campaignId).delete();
      await db.runs.where('campaignId').equals(campaignId).delete();
      await db.deliverables.where('campaignId').equals(campaignId).delete();
      // The TopBar last-module shortcut must not outlive the cleared modules —
      // a stale shortcut navigates to a dead reader route.
      const settings = await db.settings.get('settings');
      if (settings?.lastModule?.campaignId === campaignId) {
        await db.settings.update('settings', { lastModule: null });
      }
      // Final image sweep: catches blobs orphaned by the battle/deliverable
      // deletes above that no per-artifact prune saw. The kept campaign row's
      // cover stays pinned (referencedImageIds reads it).
      const imagesPruned = await pruneUnreferencedImages(campaignId);

      return {
        byKind: [...kindCounts.entries()]
          .map(([kind, count]) => ({ kind, count }))
          .sort((a, b) => a.kind.localeCompare(b.kind)),
        artifacts: artifacts.length,
        modules: moduleCount,
        battles: battles.length,
        runs: runCount,
        deliverables: deliverableCount,
        imagesPruned,
      };
    },
  );
}
