import { useLiveQuery } from 'dexie-react-hooks';

import { compareModulesByStartLevel, type Id, type Module, type ModuleDocumentVersion } from '@/domain';
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

/**
 * A campaign's modules for the UI, in ARC ORDER (docs/17 row 297): start level
 * ascending, then the narrower range, then `createdAt`, then `id` —
 * `domain/module.compareModulesByStartLevel`. THE display seam: every module
 * LIST a human reads (the modules page, the campaign tree, the pickers) sorts
 * here, so they cannot drift apart.
 *
 * The repo's own read (`listModulesByCampaign`) deliberately keeps its
 * "newest first" order for the SEMANTIC callers that depend on it; this hook
 * is where the human-facing order is applied, and it is the ONLY place
 * `compareModulesByStartLevel` is called.
 */
export function useModules(campaignId: Id | undefined): Module[] | undefined {
  return useLiveQuery(
    async () => {
      if (campaignId === undefined) return undefined;
      const modules = await listModulesByCampaign(campaignId);
      return [...modules].sort(compareModulesByStartLevel);
    },
    [campaignId],
  );
}
