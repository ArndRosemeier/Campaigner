import { useLiveQuery } from 'dexie-react-hooks';

import { artifactRepo, campaignRepo } from '@/db';
import type { Artifact, ArtifactRevision, Campaign, Id } from '@/domain';

/**
 * Live-query hooks for the campaign feature (01-DATA-MODEL: components never
 * call `db.*` directly — they go through repos or these hooks).
 *
 * Hooks returning `undefined` mean "still loading"; the workspace page uses a
 * `null` sentinel for "definitively missing".
 */

export interface CampaignSummary {
  campaign: Campaign;
  artifactCount: number;
}

export function useCampaignSummaries(): CampaignSummary[] | undefined {
  return useLiveQuery(async () => {
    const campaigns = await campaignRepo.listCampaigns();
    return Promise.all(
      campaigns.map(async (campaign) => ({
        campaign,
        artifactCount: await artifactRepo.countArtifactsByCampaign(campaign.id),
      })),
    );
  }, []);
}

/** `undefined` = loading, `null` = no such campaign. */
export function useCampaign(id: Id | undefined): Campaign | null | undefined {
  return useLiveQuery(
    async () => (id === undefined ? undefined : ((await campaignRepo.getCampaign(id)) ?? null)),
    [id],
  );
}

export function useArtifacts(campaignId: Id | undefined): Artifact[] | undefined {
  return useLiveQuery(
    async () =>
      campaignId === undefined ? undefined : artifactRepo.listArtifactsByCampaign(campaignId),
    [campaignId],
  );
}

export function useRevisions(artifactId: Id | undefined): ArtifactRevision[] | undefined {
  return useLiveQuery(
    async () => (artifactId === undefined ? undefined : artifactRepo.listRevisions(artifactId)),
    [artifactId],
  );
}
