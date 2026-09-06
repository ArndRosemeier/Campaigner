import {
  campaignSchema,
  createCampaign as buildCampaign,
  type Campaign,
  type EntityPatch,
  type NewCampaign,
} from '@/domain';
import { db } from '@/db/db';
import { NotFoundError } from '@/lib/errors';

export type CampaignPatch = EntityPatch<Campaign>;

/** All campaigns, most recently updated first (picker order). */
export async function listCampaigns(): Promise<Campaign[]> {
  const rows = await db.campaigns.toArray();
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
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