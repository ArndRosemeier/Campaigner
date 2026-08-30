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
 * its artifacts, those artifacts' revisions, and its persona runs.
 */
export async function deleteCampaign(id: string): Promise<void> {
  await db.transaction('rw', db.campaigns, db.artifacts, db.revisions, db.runs, async () => {
    const artifacts = await db.artifacts.where('campaignId').equals(id).toArray();
    const artifactIds = artifacts.map((artifact) => artifact.id);

    if (artifactIds.length > 0) {
      await db.revisions.where('artifactId').anyOf(artifactIds).delete();
    }
    await db.artifacts.where('campaignId').equals(id).delete();
    await db.runs.where('campaignId').equals(id).delete();
    await db.campaigns.delete(id);
  });
}
