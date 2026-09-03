import { ROUTES, deliverablesPath, graphPath, modulesPath, workspacePath } from '@/app/routes';

/** One navigation entry rendered as a link. */
export interface NavItem {
  label: string;
  to: string;
  /**
   * Passed to `NavLink.end`: when true the link is only active on the exact
   * path, otherwise it stays active on nested paths too.
   */
  end: boolean;
}

/** One campaign-level tab in the campaign bar (below the top bar). */
export interface CampaignTab {
  label: string;
  to: string;
  end: boolean;
  /** True when no campaign is open — the tab renders disabled. */
  disabled: boolean;
}

/**
 * App-level navigation, shown in the top bar on every route: Rules and
 * Settings. (The app name links home to the campaign picker; campaign-scoped
 * sections live in `campaignTabs` below.)
 */
export function appNavItems(): readonly NavItem[] {
  return [
    { label: 'Rules', to: ROUTES.rules, end: false },
    { label: 'Settings', to: ROUTES.settings, end: false },
  ];
}

/**
 * The campaign-level tabs, rendered by the campaign bar on EVERY route so the
 * app's structure stays visible: Workspace / Modules / Deliverables / Graph.
 * Without an open campaign the tabs render disabled (with a hint) instead of
 * disappearing — a changing nav reads as different apps.
 */
export function campaignTabs(campaignId: string | undefined): readonly CampaignTab[] {
  return [
    { label: 'Workspace', to: workspacePath(campaignId ?? ''), end: false, disabled: campaignId === undefined },
    { label: 'Modules', to: modulesPath(campaignId ?? ''), end: false, disabled: campaignId === undefined },
    { label: 'Deliverables', to: deliverablesPath(campaignId ?? ''), end: false, disabled: campaignId === undefined },
    { label: 'Graph', to: graphPath(campaignId ?? ''), end: false, disabled: campaignId === undefined },
  ];
}
