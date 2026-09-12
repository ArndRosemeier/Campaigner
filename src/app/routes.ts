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
  /** Table surface for a module's live battle (M6-E). */
  battle: '/c/:campaignId/m/:moduleId/battle',
  /** Whole-module board for one module (08 §Module board) — the module's
   * spatial overview. */
  board: '/c/:campaignId/m/:moduleId/board',
  /** Document co-authoring canvas for ONE module (whole-module document,
   * 08 §Module canvas). */
  canvas: '/c/:campaignId/m/:moduleId/canvas',
  /** Module list (M4). */
  modules: '/c/:campaignId/modules',
  /** Module reader for one module (M4). */
  module: '/c/:campaignId/m/:moduleId',
  /** Rules library (books list + browser). */
  rules: '/rules',
  /** Settings page. */
  settings: '/settings',
  /** Experiment lab (discreet dev surface, linked from Settings only). */
  lab: '/lab',
  /** First-module guide (opened in another tab from the wizard/help/empty states). */
  guide: '/guide',
  /** One guide chapter by id. */
  guideChapter: '/guide/:chapterId',
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

/** Path of the table surface for a module's live battle (M6-E). */
export function battlePath(
  campaignId: string,
  moduleId: string,
): `/c/${string}/m/${string}/battle` {
  return `/c/${encodeURIComponent(campaignId)}/m/${encodeURIComponent(moduleId)}/battle`;
}

/**
 * Path of the whole-module board for one module (08 §Module board). An
 * optional node key becomes a `#node-<key>` hash the board centers on.
 */
export function boardPath(
  campaignId: string,
  moduleId: string,
  nodeKey?: string,
): `/c/${string}/m/${string}/board${string}` {
  const hash = nodeKey === undefined ? '' : `#node-${encodeURIComponent(nodeKey)}`;
  return `/c/${encodeURIComponent(campaignId)}/m/${encodeURIComponent(moduleId)}/board${hash}`;
}

/**
 * The canvas deep-link scroll target: a part's `planIndex`, or `'premise'`
 * for a scroll to the top (canvas v3 — `?part=` is a SCROLL target on the
 * whole-module document, not a scope).
 */
export type CanvasPartParam = number | 'premise';

/** Serializes the canvas scroll target for the `?part=` query parameter. */
export function canvasPartParam(part: CanvasPartParam): string {
  return part === 'premise' ? 'premise' : String(part);
}

/**
 * Path of the whole-module document canvas (08 §Module canvas). An optional
 * part target becomes a `?part=<planIndex|premise>` query parameter the
 * page SCROLLS to (the editor doc is the whole module; `#part-<n>` hashes
 * are honored the same way — the reader's deep-link convention).
 */
export function canvasPath(
  campaignId: string,
  moduleId: string,
  part?: CanvasPartParam,
): `/c/${string}/m/${string}/canvas${string}` {
  const query =
    part === undefined ? '' : `?part=${encodeURIComponent(canvasPartParam(part))}`;
  return `/c/${encodeURIComponent(campaignId)}/m/${encodeURIComponent(moduleId)}/canvas${query}`;
}

/**
 * Path of the whole-module document canvas with the chat sidebar forced
 * OPEN (08 §Module canvas chat, docs/17 row 57 — the chat is the front
 * door): the reader header's Chat link (next to Canvas) routes here, so one
 * click from the module reader starts talking to the module. The modules
 * list row's own Chat entry to this same path was dropped by owner decision
 * 2026-09-10 (docs/17 row 91, AMENDS 57 — one row icon per destination).
 * The page reads `?chat=open` and opens the sidebar even when the session
 * toggle closed it.
 */
export function canvasChatPath(
  campaignId: string,
  moduleId: string,
): `/c/${string}/m/${string}/canvas${string}` {
  return `/c/${encodeURIComponent(campaignId)}/m/${encodeURIComponent(moduleId)}/canvas?chat=open`;
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

/**
 * Path of the first-module guide (M-onboarding). Without a chapter id the
 * page renders the first chapter.
 */
export function guidePath(chapterId?: string): '/guide' | `/guide/${string}` {
  return chapterId === undefined
    ? ROUTES.guide
    : `${ROUTES.guide}/${encodeURIComponent(chapterId)}`;
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
    matchPath(ROUTES.battle, pathname)?.params.campaignId ??
    matchPath(ROUTES.board, pathname)?.params.campaignId ??
    matchPath(ROUTES.canvas, pathname)?.params.campaignId ??
    matchPath(ROUTES.modules, pathname)?.params.campaignId ??
    matchPath(ROUTES.module, pathname)?.params.campaignId ??
    matchPath(ROUTES.workspace, pathname)?.params.campaignId
  );
}
