/**
 * Single source of truth for every route in the app (05-UI.md §Routes).
 *
 * Route *patterns* (with `:param` segments) are used by the router in
 * `app/router.tsx`; the `*Path()` builders below are used everywhere else
 * (links, navigation) so path strings are never hand-written twice.
 */
export const ROUTES = {
  /** Campaign picker (list + create). */
  campaignPicker: '/',
  /** Workspace (three-pane) for a campaign. */
  workspace: '/c/:campaignId',
  /** Workspace with a specific artifact open. */
  artifact: '/c/:campaignId/a/:artifactId',
  /** Link graph for a campaign (M2). */
  graph: '/c/:campaignId/graph',
  /** Rules library (books list + browser). */
  rules: '/rules',
  /** Settings page. */
  settings: '/settings',
} as const satisfies Record<string, `/${string}`>;

/** Route parameters per route pattern, for typed `useParams` calls. */
export interface RouteParams {
  workspace: { campaignId: string };
  artifact: { campaignId: string; artifactId: string };
}

/** Path of the link-graph screen for a given campaign. */
export function graphPath(campaignId: string): `/c/${string}/graph` {
  return `/c/${encodeURIComponent(campaignId)}/graph`;
}

/** Path of the workspace screen for a given campaign. */
export function workspacePath(campaignId: string): `/c/${string}` {
  return `/c/${encodeURIComponent(campaignId)}`;
}

/** Path of the workspace screen with a given artifact open. */
export function artifactPath(campaignId: string, artifactId: string): `/c/${string}/a/${string}` {
  return `/c/${encodeURIComponent(campaignId)}/a/${encodeURIComponent(artifactId)}`;
}
