import { useLiveQuery } from 'dexie-react-hooks';

import type { Id, Module, ModuleDocumentVersion } from '@/domain';
import { getModule, listModulesByCampaign } from '@/db/moduleRepo';
import { listModuleVersions } from '@/db/moduleVersionRepo';

/** Live-query hooks for the modules feature (mirrors campaign/hooks). */

/** `undefined` = loading, `null` = no such module. */
export function useModule(id: Id | undefined): Module | null | undefined {
  return useLiveQuery(
    async () => (id === undefined ? undefined : ((await getModule(id)) ?? null)),
    [id],
  );
}

/**
 * The module's DURABLE document versions, newest first (docs/18 §2.3 simple
 * undo) — live, so the Versions menu updates the moment a snapshot lands or
 * the Clear-all door empties the stack. `undefined` = still loading (the menu
 * never renders an empty state it cannot vouch for).
 */
export function useModuleVersions(id: Id | undefined): ModuleDocumentVersion[] | undefined {
  return useLiveQuery(
    async () => (id === undefined ? undefined : listModuleVersions(id)),
    [id],
  );
}

export function useModules(campaignId: Id | undefined): Module[] | undefined {
  return useLiveQuery(
    async () => (campaignId === undefined ? undefined : listModulesByCampaign(campaignId)),
    [campaignId],
  );
}
