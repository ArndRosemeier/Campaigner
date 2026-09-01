import { useLiveQuery } from 'dexie-react-hooks';

import type { Id, Module } from '@/domain';
import { getModule, listModulesByCampaign } from '@/db/moduleRepo';

/** Live-query hooks for the modules feature (mirrors campaign/hooks). */

/** `undefined` = loading, `null` = no such module. */
export function useModule(id: Id | undefined): Module | null | undefined {
  return useLiveQuery(
    async () => (id === undefined ? undefined : ((await getModule(id)) ?? null)),
    [id],
  );
}

export function useModules(campaignId: Id | undefined): Module[] | undefined {
  return useLiveQuery(
    async () => (campaignId === undefined ? undefined : listModulesByCampaign(campaignId)),
    [campaignId],
  );
}
