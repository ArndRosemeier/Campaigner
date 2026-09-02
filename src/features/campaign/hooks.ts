import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { artifactRepo, campaignRepo } from '@/db';
import type {
  AnyArtifact,
  Artifact,
  ArtifactRevision,
  Campaign,
  GlobalArtifact,
  Id,
  ScopeToggles,
} from '@/domain';
import { readSettings } from '@/db/settingsRepo';

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

/** The global library (10-MILESTONE-6 C): campaign-independent content,
 * few rows by design — a full scan, sorted by name. Disabled surfaces return
 * an immediate empty list and do not subscribe to unrelated artifact writes. */
export function useGlobalArtifacts(enabled = true): GlobalArtifact[] | undefined {
  return useLiveQuery(
    async () => (enabled ? artifactRepo.listGlobalArtifacts() : []),
    [enabled],
    enabled ? undefined : [],
  );
}

/** Live scope toggles for a surface (D3/D4) — `undefined` while loading. */
export function useScopeToggles(
  surface: 'workspace' | 'moduleView',
): ScopeToggles | undefined {
  return useLiveQuery(async () => (await readSettings()).artifactScopes[surface], [surface]);
}

/** The campaign's artifacts filtered by a surface's scope toggles, with the
 * global library appended when its toggle is on (10-MILESTONE-6 D3/D4).
 * `undefined` while any input is still loading. */
export function useScopedArtifacts(
  surface: 'workspace' | 'moduleView',
  campaignId: Id | undefined,
): AnyArtifact[] | undefined {
  const artifacts = useArtifacts(campaignId);
  const scopes = useScopeToggles(surface);
  const globals = useGlobalArtifacts(scopes?.global ?? false);
  return useMemo(() => {
    if (artifacts === undefined || globals === undefined || scopes === undefined) return undefined;
    const owned = artifacts.filter((artifact) =>
      artifact.moduleId !== null ? scopes.module : scopes.campaign,
    );
    return scopes.global ? [...owned, ...globals] : owned;
  }, [artifacts, globals, scopes]);
}

export function useRevisions(artifactId: Id | undefined): ArtifactRevision[] | undefined {
  return useLiveQuery(
    async () => (artifactId === undefined ? undefined : artifactRepo.listRevisions(artifactId)),
    [artifactId],
  );
}
