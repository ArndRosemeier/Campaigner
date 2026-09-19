import { ROUTES, graphPath, modulesPath, spellsPath, workspacePath } from '@/app/routes';

/** One "Go to" destination in the quick-find palette. */
export interface GoToEntry {
  label: string;
  to: string;
}

/**
 * The quick-find palette's navigation entries (05-UI.md §Quick-find): the
 * campaign sections plus the app-level screens. Ctrl+K then doubles as an app
 * map — every screen is reachable without learning where its button hides.
 *
 * There is deliberately NO module-wide battle destination (docs/17 row 254):
 * a battle belongs to its ENCOUNTER, so a module-wide entry would re-introduce
 * exactly the module-keyed singleton the owner had removed. A battle is reached
 * from the encounter that owns it — its card's `Run battle`/`Open battle`
 * button. Pure data so hosts only need to wire `navigate`.
 *
 * `pathname` is kept in the signature for the context-aware hosts that already
 * pass it (the palette is one call site); nothing module-keyed is derived from
 * it any more.
 */
export function quickFindGoToEntries(campaignId: string, _pathname: string): readonly GoToEntry[] {
  const entries: GoToEntry[] = [
    { label: 'Workspace', to: workspacePath(campaignId) },
    { label: 'Modules', to: modulesPath(campaignId) },
    { label: 'Graph', to: graphPath(campaignId) },
    { label: 'Spells', to: spellsPath(campaignId) },
  ];
  entries.push(
    { label: 'Rules', to: ROUTES.rules },
    { label: 'Settings', to: ROUTES.settings },
  );
  return entries;
}
