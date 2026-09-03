import { matchPath } from 'react-router-dom';

import { ROUTES, battlePath, deliverablesPath, graphPath, modulesPath, workspacePath } from '@/app/routes';

/** One "Go to" destination in the quick-find palette. */
export interface GoToEntry {
  label: string;
  to: string;
}

/**
 * The quick-find palette's navigation entries (05-UI.md §Quick-find): the
 * campaign sections plus the app-level screens, and a context-aware
 * **Battle table** entry while a module reader is open. Ctrl+K then doubles
 * as an app map — every screen is reachable without learning where its
 * button hides. Pure data so hosts only need to wire `navigate`.
 */
export function quickFindGoToEntries(campaignId: string, pathname: string): readonly GoToEntry[] {
  const entries: GoToEntry[] = [
    { label: 'Workspace', to: workspacePath(campaignId) },
    { label: 'Modules', to: modulesPath(campaignId) },
    { label: 'Deliverables', to: deliverablesPath(campaignId) },
    { label: 'Graph', to: graphPath(campaignId) },
  ];
  const moduleMatch = matchPath(ROUTES.module, pathname);
  const moduleId = moduleMatch?.params.moduleId;
  if (moduleId !== undefined) {
    entries.unshift({ label: 'Battle table (this module)', to: battlePath(campaignId, moduleId) });
  }
  entries.push(
    { label: 'Rules', to: ROUTES.rules },
    { label: 'Settings', to: ROUTES.settings },
  );
  return entries;
}
