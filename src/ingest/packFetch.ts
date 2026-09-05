import { z } from 'zod';

import { mapWithConcurrency } from '@/lib/parallel';
import { errorMessage } from '@/lib/errors';

import { importPack, type PackImportDeps, type PackImportProgress, type PackImportResult } from './packImport';
import { getPackAdapter } from './packs/registry';
import type { PackEntryFailure, PackInputFile } from './packs/types';

/**
 * User-triggered bestiary-pack fetching (16-BESTIARY-FETCH). This file is the
 * app's ONLY networked import surface: it downloads creature files from the
 * pinned upstream repos and hands the bytes to the UNCHANGED `importPack`
 * pipeline — no fork. Adapters and `packImport` stay network-free
 * (12-BESTIARY-PACKS §5, asserted by tests).
 *
 * Engine (16-BESTIARY-FETCH §3, verified 2026-09-05): files come from
 * `raw.githubusercontent.com` (CORS `access-control-allow-origin: *`), pack
 * discovery from the GitHub git/trees API (`api.github.com`, CORS `*`,
 * unauthenticated 60 req/h per IP — 403/429 name the limit). codeload
 * zipballs (ACAO pinned to render.githubusercontent.com), GitHub release
 * assets (no ACAO) and jsDelivr (50 MB package cap / branch refs unsupported)
 * are browser-blocked — see the spec's CORS matrix; there is no proxy
 * fallback: failures are loud.
 */

// --- Sources & recipes -------------------------------------------------------

/** One fetchable pack: a repo directory containing creature documents. */
export interface PackRecipe {
  /** Repo-root path of the pack directory, e.g. 'packs/pf2e/pathfinder-monster-core'. */
  id: string;
  /** Book title / UI label. */
  label: string;
  /** Verified creature-file count (display only; the listing decides what is fetched). */
  creatures: number;
}

export interface PackFetchSource {
  /** Must be a registered pack adapter id. */
  adapterId: string;
  owner: string;
  repo: string;
  /** Pinned ref (16-BESTIARY-FETCH, ratified decision 2). */
  ref: string;
  /** Repo-root path whose direct children are the packs. */
  packRoot: string;
  /** Curated default recipes (ratified decision 1); counts verified against the pinned ref. */
  curated: readonly PackRecipe[];
}

/**
 * Curated recipes — core bestiaries per adapter. pf2e folder names verified at
 * `v14-dev` (the brief's "bestiary/bestiary-2/monster-core" examples do not
 * exist; the real names are the `pathfinder-*` ones), dnd5e at `6.0.x`.
 */
export const PACK_FETCH_SOURCES: readonly PackFetchSource[] = [
  {
    adapterId: 'foundry-pf2e',
    owner: 'foundryvtt',
    repo: 'pf2e',
    ref: 'v14-dev',
    packRoot: 'packs/pf2e',
    curated: [
      { id: 'packs/pf2e/pathfinder-monster-core', label: 'Pathfinder Monster Core', creatures: 492 },
      { id: 'packs/pf2e/pathfinder-monster-core-2', label: 'Pathfinder Monster Core 2', creatures: 446 },
      { id: 'packs/pf2e/pathfinder-bestiary', label: 'Pathfinder Bestiary', creatures: 166 },
      { id: 'packs/pf2e/pathfinder-bestiary-2', label: 'Pathfinder Bestiary 2', creatures: 160 },
      { id: 'packs/pf2e/pathfinder-bestiary-3', label: 'Pathfinder Bestiary 3', creatures: 165 },
      { id: 'packs/pf2e/pathfinder-npc-core', label: 'Pathfinder NPC Core', creatures: 272 },
      { id: 'packs/pf2e/npc-gallery', label: 'NPC Gallery', creatures: 6 },
      { id: 'packs/pf2e/menace-under-otari-bestiary', label: 'Menace under Otari (free starter bestiary)', creatures: 93 },
    ],
  },
  {
    adapterId: 'foundry-dnd5e-srd',
    owner: 'foundryvtt',
    repo: 'dnd5e',
    ref: '6.0.x',
    packRoot: 'packs/_source/monsters',
    curated: [
      { id: 'packs/_source/monsters', label: 'D&D 5e SRD Monsters', creatures: 337 },
    ],
  },
];

export function getPackFetchSource(adapterId: string): PackFetchSource {
  const source = PACK_FETCH_SOURCES.find((candidate) => candidate.adapterId === adapterId);
  if (source === undefined) {
    throw new Error(
      `no pack fetch source for adapter "${adapterId}" (available: ${PACK_FETCH_SOURCES.map((entry) => entry.adapterId).join(', ')})`,
    );
  }
  // Registration invariant: a source without its adapter would fail mid-fetch.
  getPackAdapter(source.adapterId);
  return source;
}

/** Creature files under one pack (relative to the pack dir, adapter-parseable, no `_` metadata docs). */
export function selectCreatureFiles(
  adapterExtensions: readonly string[],
  packRoot: string,
  packId: string,
  paths: readonly string[],
): string[] {
  const prefix = `${packId}/`;
  return paths.filter((path) => {
    if (!path.startsWith(prefix) || path === packId) return false;
    const relative = path.slice(packRoot.length + 1);
    const base = path.split('/').pop() ?? '';
    if (base.startsWith('_')) return false; // _folders.json / _folder.yml metadata docs
    const dot = base.lastIndexOf('.');
    const extension = dot === -1 ? '' : base.slice(dot).toLowerCase();
    return adapterExtensions.includes(extension) && relative.length > 0;
  });
}

// --- Repo tree listing (api.github.com git/trees) -----------------------------

const githubTreeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), type: z.string() })),
});

export interface PackTreeListing {
  /** Every blob path in the repo at the pinned ref. */
  blobPaths: readonly string[];
}

const treeCache = new Map<string, PackTreeListing>();

/** Test/session hook: drops the in-memory repo-tree cache. */
export function clearPackTreeCache(): void {
  treeCache.clear();
}

function githubTreeUrl(source: PackFetchSource): string {
  return `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${source.ref}?recursive=1`;
}

async function loadTreeListing(
  source: PackFetchSource,
  fetchFn: typeof fetch,
): Promise<PackTreeListing> {
  const cacheKey = `${source.owner}/${source.repo}@${source.ref}`;
  const cached = treeCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let response: Response;
  try {
    response = await fetchFn(githubTreeUrl(source), {
      headers: { Accept: 'application/vnd.github+json' },
    });
  } catch (error) {
    throw new Error(
      `pack listing failed: could not reach api.github.com — ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    const rateLimited = response.status === 403 || response.status === 429;
    throw new Error(
      `pack listing failed: GitHub API HTTP ${String(response.status)} ${response.statusText}` +
        (rateLimited
          ? ' — the unauthenticated GitHub API allows 60 requests/hour per IP; try again later'
          : ''),
    );
  }
  // Validate at the boundary (AGENTS rule 3): a malformed listing is an error.
  const parsed = githubTreeSchema.parse(await response.json());
  if (parsed.truncated) {
    throw new Error(
      'pack listing failed: GitHub truncated the repo tree (over the 100k-entry cap) — fetch a specific curated pack instead',
    );
  }
  const listing: PackTreeListing = {
    blobPaths: parsed.tree.filter((entry) => entry.type === 'blob').map((entry) => entry.path),
  };
  treeCache.set(cacheKey, listing);
  return listing;
}

/**
 * All fetchable packs in the repo (the advanced "list everything" toggle,
 * ratified decision 1). Costs one git/trees API call (cached per session);
 * curated mode is a constant and touches no network.
 */
export async function listPackRecipes(
  adapterId: string,
  options: { full?: boolean; fetchDeps?: PackFetchDeps } = {},
): Promise<readonly PackRecipe[]> {
  const source = getPackFetchSource(adapterId);
  if (options.full !== true) return source.curated;

  const listing = await loadTreeListing(source, fetchFnOf(options.fetchDeps));
  const groups = new Map<string, number>();
  for (const path of listing.blobPaths) {
    if (!path.startsWith(`${source.packRoot}/`)) continue;
    const relative = path.slice(source.packRoot.length + 1);
    const packDir = relative.split('/')[0];
    if (packDir === undefined || packDir === '') continue;
    const key = `${source.packRoot}/${packDir}`;
    const creatureFiles = selectCreatureFiles(
      getPackAdapter(source.adapterId).extensions,
      source.packRoot,
      key,
      [path],
    );
    if (creatureFiles.length === 0) continue; // non-creature doc (or metadata) — not fetchable content
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.entries()]
    .map(([id, creatures]) => ({ id, label: id.slice(source.packRoot.length + 1), creatures }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// --- Selective file fetch ------------------------------------------------------

export type PackFetchPhase = 'listing' | 'downloading';

export interface PackFetchProgress {
  phase: PackFetchPhase;
  done: number;
  total: number;
  /** File currently downloaded / listing description. */
  detail?: string;
}

export interface PackFetchDeps {
  /** Defaults to the global `fetch`; injectable for tests. */
  fetchFn?: typeof fetch | undefined;
}

function fetchFnOf(deps: PackFetchDeps | undefined): typeof fetch {
  const injected = deps?.fetchFn;
  if (injected !== undefined) return injected;
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('pack fetch needs a fetch implementation (none available in this environment)');
  }
  return globalThis.fetch.bind(globalThis);
}

function rawUrl(source: PackFetchSource, path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.ref}/${encoded}`;
}

type DownloadOutcome = { ok: true; file: PackInputFile } | { ok: false; failure: PackEntryFailure };

async function downloadOne(
  source: PackFetchSource,
  path: string,
  fetchFn: typeof fetch,
): Promise<DownloadOutcome> {
  // File names are relative to the pack root so import reports and the book
  // filename stay readable ('pathfinder-monster-core/goblin.json').
  const name = path.slice(source.packRoot.length + 1);
  try {
    const response = await fetchFn(rawUrl(source, path));
    if (!response.ok) {
      return {
        ok: false,
        failure: {
          file: name,
          name: '',
          message: `download failed: HTTP ${String(response.status)} ${response.statusText}`,
        },
      };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      return { ok: false, failure: { file: name, name: '', message: 'download failed: empty body' } };
    }
    return { ok: true, file: { name, bytes } };
  } catch (error) {
    return {
      ok: false,
      failure: { file: name, name: '', message: `download failed: ${errorMessage(error)}` },
    };
  }
}

// --- The one user-triggered action (fetch → importPack) ------------------------

export interface PackFetchOptions {
  /** Download-phase progress (listing + per-file). */
  onFetchProgress?: ((progress: PackFetchProgress) => void) | undefined;
  /** Import-phase progress — the existing pack import shape (book chip). */
  onProgress?: ((progress: PackImportProgress) => void) | undefined;
  deps?: PackImportDeps | undefined;
  fetchDeps?: PackFetchDeps | undefined;
}

/** Download concurrency for raw.githubusercontent.com (bounded, not user-configured). */
export const PACK_FETCH_CONCURRENCY = 4;

/**
 * Fetches one pack from its pinned source repo and imports it through the
 * unchanged `importPack` (ratified decision 4). Loud failure policy
 * (16-BESTIARY-FETCH §8): a failed download is a collected failure entry in
 * the import report (never catch-and-continue); a fetch with zero downloaded
 * files throws before any book is created; an import with zero valid entries
 * marks the book `error` via the existing importPack semantics.
 */
export async function fetchAndImportPack(
  adapterId: string,
  recipeId: string,
  options: PackFetchOptions = {},
): Promise<PackImportResult> {
  const source = getPackFetchSource(adapterId);
  const adapter = getPackAdapter(source.adapterId);
  const fetchFn = fetchFnOf(options.fetchDeps);

  options.onFetchProgress?.({
    phase: 'listing',
    done: 0,
    total: 0,
    detail: `listing ${source.owner}/${source.repo}@${source.ref}`,
  });
  const listing = await loadTreeListing(source, fetchFn);

  const files = selectCreatureFiles(adapter.extensions, source.packRoot, recipeId, listing.blobPaths);
  if (files.length === 0) {
    throw new Error(
      `no creature files found under "${recipeId}" in ${source.owner}/${source.repo}@${source.ref} — check the pack path`,
    );
  }

  const curated = source.curated.find((recipe) => recipe.id === recipeId);
  const title = curated?.label ?? recipeId.slice(source.packRoot.length + 1);

  let done = 0;
  const outcomes = await mapWithConcurrency(files, PACK_FETCH_CONCURRENCY, async (path) => {
    const outcome = await downloadOne(source, path, fetchFn);
    done += 1;
    options.onFetchProgress?.({
      phase: 'downloading',
      done,
      total: files.length,
      detail: outcome.ok ? outcome.file.name : path,
    });
    return outcome;
  });

  const inputs: PackInputFile[] = [];
  const downloadFailures: PackEntryFailure[] = [];
  for (const outcome of outcomes) {
    if (outcome.ok) inputs.push(outcome.file);
    else downloadFailures.push(outcome.failure);
  }

  if (inputs.length === 0) {
    const first = downloadFailures
      .slice(0, 3)
      .map((failure) => `${failure.file}: ${failure.message}`)
      .join('; ');
    throw new Error(
      `all ${String(downloadFailures.length)} downloads failed for "${title}" — ` +
        `no pack book was created. ${first}` +
        (downloadFailures.length > 3 ? ` (and ${String(downloadFailures.length - 3)} more)` : ''),
    );
  }

  return importPack(source.adapterId, inputs, {
    title,
    onProgress: options.onProgress,
    deps: options.deps,
    extraFailures: downloadFailures,
    provenance: {
      sourceRef: source.ref,
      sourceUrl: `https://github.com/${source.owner}/${source.repo}/tree/${source.ref}/${recipeId}`,
      fetchedAt: Date.now(),
    },
  });
}
