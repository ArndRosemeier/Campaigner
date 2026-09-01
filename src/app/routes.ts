/**
 * Single source of truth for every route in the app (05-UI.md §Routes).
 *
 * Route *patterns* (with `:param` segments) are used by the router in
 * `app/router.tsx`; the `*Path()` builders below are used everywhere else
 * (links, navigation) so path strings are never hand-written twice.
 */
import { matchPath } from 'react-router-dom';

export const ROUTES = {
  /** Campaign picker (list + create). */
  campaignPicker: '/',
  /** Workspace (three-pane) for a campaign. */
  workspace: '/c/:campaignId',
  /** Workspace with a specific artifact open. */
  artifact: '/c/:campaignId/a/:artifactId',
  /** Link graph for a campaign (M2). */
  graph: '/c/:campaignId/graph',
  /** Session Mode play view (M3-C). */
  play: '/c/:campaignId/play',
  /** Deliverable builder for module PDFs (M3-D). */
  deliverables: '/c/:campaignId/deliverables',
  /** Module list (M4). */
  modules: '/c/:campaignId/modules',
  /** Module reader for one module (M4). */
  module: '/c/:campaignId/m/:moduleId',
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

/** Path of the Session Mode play view for a given campaign (M3-C). */
export function playPath(campaignId: string): `/c/${string}/play` {
  return `/c/${encodeURIComponent(campaignId)}/play`;
}

/** Path of the deliverable builder for a given campaign (M3-D). */
export function deliverablesPath(campaignId: string): `/c/${string}/deliverables` {
  return `/c/${encodeURIComponent(campaignId)}/deliverables`;
}

/** Path of the module list for a given campaign (M4). */
export function modulesPath(campaignId: string): `/c/${string}/modules` {
  return `/c/${encodeURIComponent(campaignId)}/modules`;
}

/**
 * Path of the module reader (M4). An optional part index becomes a
 * `#part-<index>` hash the reader scrolls to (quick-find "select scrolls the
 * reader").
 */
export function modulePath(
  campaignId: string,
  moduleId: string,
  partIndex?: number,
): `/c/${string}/m/${string}` {
  const hash = partIndex === undefined ? '' : `#part-${String(partIndex)}`;
  return `/c/${encodeURIComponent(campaignId)}/m/${encodeURIComponent(moduleId)}${hash}`;
}

/** Path of the workspace screen for a given campaign. */
export function workspacePath(campaignId: string): `/c/${string}` {
  return `/c/${encodeURIComponent(campaignId)}`;
}

/** Path of the workspace screen with a given artifact open. */
export function artifactPath(campaignId: string, artifactId: string): `/c/${string}/a/${string}` {
  return `/c/${encodeURIComponent(campaignId)}/a/${encodeURIComponent(artifactId)}`;
}

/**
 * The campaignId when `pathname` is a campaign-scoped route (workspace,
 * artifact, graph), else undefined. For chrome rendered outside the routed
 * page (top bar), which cannot use `useParams` for child-route params.
 */
export function campaignIdFromPath(pathname: string): string | undefined {
  return (
    matchPath(ROUTES.artifact, pathname)?.params.campaignId ??
    matchPath(ROUTES.graph, pathname)?.params.campaignId ??
    matchPath(ROUTES.play, pathname)?.params.campaignId ??
    matchPath(ROUTES.deliverables, pathname)?.params.campaignId ??
    matchPath(ROUTES.modules, pathname)?.params.campaignId ??
    matchPath(ROUTES.module, pathname)?.params.campaignId ??
    matchPath(ROUTES.workspace, pathname)?.params.campaignId
  );
}
