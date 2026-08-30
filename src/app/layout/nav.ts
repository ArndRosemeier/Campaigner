import { ROUTES } from '@/app/routes';

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
 * The Workspace link points at the campaign picker until a campaign is
 * selected (it will target the active campaign from T3 on).
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { label: 'Workspace', to: ROUTES.campaignPicker, end: true },
  { label: 'Rules', to: ROUTES.rules, end: false },
  { label: 'Settings', to: ROUTES.settings, end: false },
];
