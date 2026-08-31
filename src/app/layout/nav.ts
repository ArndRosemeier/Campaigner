import { ROUTES, workspacePath } from '@/app/routes';

/** One primary navigation entry in the top bar (05-UI.md §Top bar). */
export interface NavItem {
  label: string;
  to: string;
  /**
   * Passed to `NavLink.end`: when true the link is only active on the exact
   * path, otherwise it stays active on nested paths too.
   */
  end: boolean;
}

/**
 * The primary navigation, in spec order: Workspace / Rules / Settings.
 *
 * The Workspace link targets the open campaign's workspace when one is open
 * (campaign-scoped URL), and falls back to the campaign picker otherwise —
 * there is no "current campaign" outside the picker to link to.
 */
export function navItems(campaignId: string | undefined): readonly NavItem[] {
  return [
    campaignId === undefined
      ? { label: 'Workspace', to: ROUTES.campaignPicker, end: true }
      : { label: 'Workspace', to: workspacePath(campaignId), end: false },
    { label: 'Rules', to: ROUTES.rules, end: false },
    { label: 'Settings', to: ROUTES.settings, end: false },
  ];
}
