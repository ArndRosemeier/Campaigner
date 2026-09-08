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
import { pruneUnreferencedImages } from '@/db/imageRepo';
import { NotFoundError } from '@/lib/errors';

export type CampaignPatch = EntityPatch<Campaign>;

/** All campaigns, most recently updated first (picker order). */
export async function listCampaigns(): Promise<Campaign[]> {
  const rows = await db.campaigns.toArray();
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Total campaign count (onboarding detection, guide routing). */
export async function countCampaigns(): Promise<number> {
  return db.campaigns.count();
}

export async function getCampaign(id: string): Promise<Campaign | undefined> {
  return db.campaigns.get(id);
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
 * delete path of their own — its modules, the modules' live battles and
 * their deliverable outlines. Everything else prunes only by reference;
 * these tables key on `campaignId` directly, so leaving them behind would
 * strand permanent orphans that every backup re-exports forever.
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
      db.deliverables,
      db.settings,
    ],
    async () => {
      const artifacts = await db.artifacts.where('campaignId').equals(id).toArray();
      const artifactIds = artifacts.map((artifact) => artifact.id);

      if (artifactIds.length > 0) {
        await db.revisions.where('artifactId').anyOf(artifactIds).delete();
      }
      await db.artifacts.where('campaignId').equals(id).delete();
      await db.runs.where('campaignId').equals(id).delete();
      await db.images.where('campaignId').equals(id).delete();
      await db.modules.where('campaignId').equals(id).delete();
      await db.battles.where('campaignId').equals(id).delete();
      await db.deliverables.where('campaignId').equals(id).delete();
      const settings = await db.settings.get('settings');
      if (settings?.lastModule?.campaignId === id) {
        await db.settings.update('settings', { lastModule: null });
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
  deliverables: number;
}

export async function describeGeneratedContent(campaignId: string): Promise<GeneratedContentCounts> {
  const [artifacts, modules, battles, runs, deliverables] = await Promise.all([
    listArtifactsByCampaign(campaignId),
    listModulesByCampaign(campaignId),
    db.battles.where('campaignId').equals(campaignId).toArray(),
    db.runs.where('campaignId').equals(campaignId).count(),
    db.deliverables.where('campaignId').equals(campaignId).count(),
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
    deliverables,
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
  deliverables: number;
  imagesPruned: number;
}

/**
 * Fresh-generation wipe (owner-ordered "remove all"): deletes everything a
 * campaign's generation produced — every non-`pc` artifact (campaign- AND
 * module-owned, with revisions scrubbed through the artifact delete path),
 * every module row, every battle of the campaign, plus the campaign runs and
 * deliverable outlines that would otherwise dangle into deleted rows (the
 * `deleteCampaign` table set minus the campaign row itself) — while the Party
 * (`pc` artifacts, untouched with their revisions/images/links), the campaign
 * row, settings, personas and the global library survive.
 *
 * Transaction discipline (no half-applied wipe): in-flight module passes are
 * aborted BEFORE the transaction opens (a native-promise dynamic import must
 * never gap a Dexie scope), then the whole disposal is ONE `rw` transaction
 * over every touched table. Modules, artifacts, battles, runs and
 * deliverables are ALL re-listed INSIDE it — the dialog's counts never decide
 * what goes — and any failure rolls the entire wipe back loudly (AGENTS rule
 * 1: a partial wipe with a success toast is the failure mode this exists to
 * prevent).
 *
 * Battles: every battle row carries its campaign's id (the schema mandates
 * `moduleId` too, so no module-less straggler can exist outside this sweep).
 * Images: orphaned campaign blobs prune through the existing
 * `pruneUnreferencedImages` path, which only ever scans this campaign's rows
 * — library/global images are structurally unreachable and survive.
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
      db.deliverables,
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
      const moduleCount = await db.modules.where('campaignId').equals(campaignId).count();
      const runCount = await db.runs.where('campaignId').equals(campaignId).count();
      const deliverableCount = await db.deliverables.where('campaignId').equals(campaignId).count();

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
      await db.modules.where('campaignId').equals(campaignId).delete();
      // Runs point at deleted artifacts/modules (targetArtifactId /
      // placementModuleId) and deliverables belong to deleted modules (their
      // covers may un-anchor campaign images) — both would dangle, so both
      // go (deleteCampaign precedent).
      await db.runs.where('campaignId').equals(campaignId).delete();
      await db.deliverables.where('campaignId').equals(campaignId).delete();
      // The TopBar last-module shortcut must not outlive the wiped modules —
      // a stale shortcut navigates to a dead reader route.
      const settings = await db.settings.get('settings');
      if (settings?.lastModule?.campaignId === campaignId) {
        await db.settings.update('settings', { lastModule: null });
      }
      // Final image sweep: catches blobs orphaned by the battle/deliverable
      // deletes above (covers, battlemaps) that no per-artifact prune saw.
      const imagesPruned = await pruneUnreferencedImages(campaignId);

      return {
        byKind: [...kindCounts.entries()]
          .map(([kind, count]) => ({ kind, count }))
          .sort((a, b) => a.kind.localeCompare(b.kind)),
        artifacts: doomed.length,
        pcsKept: artifacts.length - doomed.length,
        modules: moduleCount,
        battles: battles.length,
        runs: runCount,
        deliverables: deliverableCount,
        imagesPruned,
      };
    },
  );
}