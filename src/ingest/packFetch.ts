import { z } from 'zod';

import { mapWithConcurrency } from '@/lib/parallel';
import { errorMessage } from '@/lib/errors';
import type { GameSystem } from '@/domain/gameSystem';
import type { Rulebook } from '@/domain/rulebook';

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
 *
 * Ref chain (16 §1.1 amendment, 2026-09-06): each fetch runs NEWEST-first —
 * `HEAD` (the repo's default branch) — and falls back to the pinned VERIFIED
 * ref when the newest attempt looks like format drift (valid/total below
 * `PACK_FETCH_FALLBACK_VALID_RATIO`) or its listing fails. Both refs resolve
 * on the existing endpoints (raw + trees API accept `HEAD`); the winning
 * attempt is imported, and the report names BOTH attempts loudly when the
 * chain fired — no silent degradation.
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
  /**
   * Pinned VERIFIED ref (16 §1.1 amendment) — the fallback target of the
   * newest-first chain (`HEAD` first). The verified format the adapters were
   * validated against, e.g. `v14-dev` pf2e / `6.0.x` dnd5e.
   */
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

// --- Newest-first ref chain (16 §1.1 amendment, 2026-09-06) -------------------

/**
 * The newest ref of the chain: the repo's default branch. Both endpoints of
 * the engine (raw.githubusercontent.com and the git/trees API) accept `HEAD`
 * directly — no git protocol, no new plumbing.
 */
export const PACK_FETCH_NEWEST_REF = 'HEAD';

/**
 * Format-drift threshold (16 §1.1 amendment, documented constant): the newest
 * attempt falls back to the pinned verified ref when its valid/total ratio
 * drops below this — a suspected upstream format change, not any-error.
 */
export const PACK_FETCH_FALLBACK_VALID_RATIO = 0.5;

/**
 * The per-source ref chain: `HEAD` first (newest = default branch), then the
 * pinned verified ref. A source already pinned to `HEAD` has a one-ref chain.
 */
export function packRefChain(source: PackFetchSource): readonly string[] {
  return source.ref === PACK_FETCH_NEWEST_REF
    ? [source.ref]
    : [PACK_FETCH_NEWEST_REF, source.ref];
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

/**
 * Listing-integrity boundary (16-BESTIARY-FETCH §8): the trees-API listing is
 * hostile input — a path with a `..` segment, a backslash, or an absolute form
 * could escape the pack directory in a careless consumer. A hostile path fails
 * the WHOLE listing loudly (a named error quoting the offending path), never a
 * silent per-path filter that would mask a tampered listing.
 */
function assertListingIntegrity(paths: readonly string[]): void {
  for (const path of paths) {
    if (path.split('/').includes('..') || path.includes('\\') || path.startsWith('/')) {
      throw new Error(
        'pack listing failed: listing-integrity violation — hostile tree path ' +
          `"${path}" (a ".." segment, a backslash, or an absolute path)`,
      );
    }
  }
}

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
  // Validate at the boundary (AGENTS rule 3): parse INSIDE the named-error
  // scope, so a malformed listing body fails as a named listing failure, not
  // as a raw SyntaxError escaping from response.json().
  let parsed: z.infer<typeof githubTreeSchema>;
  try {
    parsed = githubTreeSchema.parse(await response.json());
  } catch (error) {
    throw new Error(
      `pack listing failed: could not parse the listing response — ${errorMessage(error)}`,
      { cause: error },
    );
  }
  assertListingIntegrity(parsed.tree.map((entry) => entry.path));
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

/**
 * Per-file fetch hardening (16-BESTIARY-FETCH §8): one raw document must
 * neither hang the fetch nor smuggle in an absurd payload — real creature
 * files are ≪ 1 MB (docs/16 §4: the 337 dnd5e YAMLs total 9.37 MB). A timeout
 * or an oversize body is a COLLECTED failure entry for that file (same shape
 * as every other download failure), never a throw that kills the pack.
 */
/** Hard ceiling for one raw file download (AbortSignal.timeout). */
export const PACK_FETCH_TIMEOUT_MS = 30_000;
/** Sanity cap for one raw creature document; real files land far below it. */
export const PACK_FETCH_MAX_BYTES = 5 * 1024 * 1024;

/** Names a failed download's cause; a fetch timeout gets its own named message. */
function downloadFailureCause(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'TimeoutError'
  ) {
    return `timed out after ${String(PACK_FETCH_TIMEOUT_MS)}ms (AbortSignal.timeout)`;
  }
  return errorMessage(error);
}

async function downloadOne(
  source: PackFetchSource,
  path: string,
  fetchFn: typeof fetch,
): Promise<DownloadOutcome> {
  // File names are relative to the pack root so import reports and the book
  // filename stay readable ('pathfinder-monster-core/goblin.json').
  const name = path.slice(source.packRoot.length + 1);
  try {
    const response = await fetchFn(rawUrl(source, path), {
      signal: AbortSignal.timeout(PACK_FETCH_TIMEOUT_MS),
    });
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
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > PACK_FETCH_MAX_BYTES) {
      return {
        ok: false,
        failure: {
          file: name,
          name: '',
          message:
            `download failed: ${declaredLength} bytes — over the ` +
            `${String(PACK_FETCH_MAX_BYTES)}-byte sanity cap`,
        },
      };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > PACK_FETCH_MAX_BYTES) {
      return {
        ok: false,
        failure: {
          file: name,
          name: '',
          message:
            `download failed: ${String(bytes.byteLength)} bytes — over the ` +
            `${String(PACK_FETCH_MAX_BYTES)}-byte sanity cap`,
        },
      };
    }
    if (bytes.byteLength === 0) {
      return { ok: false, failure: { file: name, name: '', message: 'download failed: empty body' } };
    }
    return { ok: true, file: { name, bytes } };
  } catch (error) {
    return {
      ok: false,
      failure: { file: name, name: '', message: `download failed: ${downloadFailureCause(error)}` },
    };
  }
}

// --- Per-attempt probe (side-effect-free import evaluation) -------------------

/**
 * Side-effect-free `PackImportDeps` for the per-attempt probe (16 §1.1
 * amendment): the threshold rule must compare attempts BEFORE any book exists,
 * so each attempt's downloaded files run through the UNCHANGED `importPack`
 * (same parse, same validation, same report shape) with in-memory deps — no
 * Dexie write, no book row. The winning attempt is imported for real
 * afterwards. `failBook` records its message: `importPack` calls it exactly on
 * the zero-valid-entries path, which separates that loud-but-expected outcome
 * from a genuine import error (rethrown).
 */
function probePackImportDeps(recordFailBook: (message: string) => void): PackImportDeps {
  const state: { book: Rulebook | null } = { book: null };
  const makeBook = (input: { title: string; system: GameSystem; filename: string }): Rulebook => ({
    id: crypto.randomUUID(),
    createdAt: 0,
    updatedAt: 0,
    title: input.title,
    system: input.system,
    filename: input.filename,
    pageCount: 0,
    status: 'processing',
    errorMessage: '',
    origin: 'pack',
    packMeta: null,
  });
  return {
    createBook: (input) => {
      state.book = makeBook(input);
      return Promise.resolve(state.book);
    },
    persistChunks: () => Promise.resolve(),
    finalizeBook: (id, packMeta) => {
      const book = state.book;
      if (book === null) throw new Error('probe import: finalizeBook ran before createBook');
      return Promise.resolve({ ...book, id, status: 'ready', packMeta });
    },
    failBook: (_id, message) => {
      recordFailBook(message);
      return Promise.resolve();
    },
  };
}

interface PackAttemptProbe {
  /** Valid entries the attempt's import produced. */
  valid: number;
  /** `importPack`'s zero-entry report message when nothing validated (null otherwise). */
  zeroEntriesMessage: string | null;
}

/**
 * Runs one attempt's downloaded files through `importPack` with the probe deps
 * and reports the valid-entry count. A zero-entry import is an expected probe
 * outcome (0 valid), not a failure — its report message is kept for the loud
 * chain error; anything else rethrows.
 */
async function probePackAttemptImport(
  adapterId: string,
  inputs: readonly PackInputFile[],
  title: string,
  extraFailures: readonly PackEntryFailure[],
): Promise<PackAttemptProbe> {
  const state: { failBookMessage: string | null } = { failBookMessage: null };
  try {
    const result = await importPack(adapterId, inputs, {
      title,
      deps: probePackImportDeps((message) => {
        state.failBookMessage = message;
      }),
      extraFailures,
    });
    return { valid: result.imported, zeroEntriesMessage: null };
  } catch (error) {
    if (state.failBookMessage === null) throw error;
    return { valid: 0, zeroEntriesMessage: state.failBookMessage };
  }
}

// --- The one user-triggered action (fetch → importPack) ------------------------

/**
 * Fetch result: the unchanged `PackImportResult` plus the loud chain note.
 * `fetchNote` is set exactly when the fallback chain fired (16 §1.1
 * amendment, decision 3: the report and toast name BOTH attempts — no silent
 * degradation anywhere).
 */
export type PackFetchResult = PackImportResult & { fetchNote?: string };

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
 * Progress throttle window (~10 Hz, 16-BESTIARY-FETCH §5/§8): a 492-file pack
 * would otherwise drive one UI setState per downloaded file and re-render the
 * card hundreds of times; callbacks coalesce to at most ~10 emits per second.
 */
export const PACK_FETCH_PROGRESS_INTERVAL_MS = 100;

interface ThrottledProgress<T> {
  send: (value: T) => void;
  /** Emits the newest held update now (cancels the trailing timer). */
  flush: () => void;
}

/**
 * Leading+trailing throttle for progress callbacks: the first send emits
 * immediately, sends inside the window coalesce into one trailing emit of the
 * NEWEST value, and `flush()` emits whatever is held without waiting — the
 * final update (e.g. done === total) is never dropped.
 */
export function throttleProgress<T>(
  emit: (value: T) => void,
  intervalMs: number,
): ThrottledProgress<T> {
  let lastEmittedAt = 0;
  let pending: T | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const emitPending = (): void => {
    timer = undefined;
    if (pending === null) return;
    const value = pending;
    pending = null;
    lastEmittedAt = Date.now();
    emit(value);
  };
  return {
    send: (value: T): void => {
      pending = value;
      if (timer !== undefined) return;
      const elapsed = Date.now() - lastEmittedAt;
      if (elapsed >= intervalMs) emitPending();
      else timer = setTimeout(emitPending, intervalMs - elapsed);
    },
    flush: (): void => {
      if (timer !== undefined) clearTimeout(timer);
      emitPending();
    },
  };
}

/**
 * One attempt of the newest-first chain: everything a ref produced, compared
 * by the threshold rule before any book exists.
 */
interface PackAttempt {
  /** The ref this attempt fetched from ('HEAD' or the pinned verified ref). */
  ref: string;
  /** Selected creature files — the denominator of the attempt's valid/total ratio. */
  total: number;
  /** Valid entries the attempt's probe import produced. */
  valid: number;
  /** Files that downloaded OK (re-imported for real when this attempt wins). */
  inputs: PackInputFile[];
  /** Collected download failures (folded into whichever import ships). */
  downloadFailures: PackEntryFailure[];
  /** `importPack`'s zero-entry report message when nothing validated (null otherwise). */
  zeroEntriesMessage: string | null;
}

/** The first download causes of an all-failing attempt, for the loud chain error. */
function attemptDownloadCauses(attempt: PackAttempt): string {
  const first = attempt.downloadFailures
    .slice(0, 3)
    .map((failure) => `${failure.file}: ${failure.message}`)
    .join('; ');
  return (
    `all ${String(attempt.downloadFailures.length)} downloads failed — ${first}` +
    (attempt.downloadFailures.length > 3
      ? ` (and ${String(attempt.downloadFailures.length - 3)} more)`
      : '')
  );
}

/** Why one attempt produced zero valid entries (for the loud chain error). */
function attemptZeroCause(attempt: PackAttempt): string {
  return attempt.inputs.length === 0 ? attemptDownloadCauses(attempt) : (attempt.zeroEntriesMessage ?? 'no valid entries');
}

/**
 * The loud all-fail error (16 §1.1 amendment: "0 valid on newest AND fallback →
 * all-fail semantics as today (no book, loud)"): names EVERY attempt and its
 * causes, and no book was created.
 */
function noValidEntriesError(
  title: string,
  chain: readonly string[],
  newest: PackAttempt | undefined,
  verified: PackAttempt | undefined,
  newestListingError: string | undefined,
  fallbackListingError: string | undefined,
): Error {
  const parts: string[] = [];
  if (newest === undefined) {
    parts.push(`newest (${chain[0]}): listing failed — ${newestListingError ?? 'unknown cause'}`);
  } else {
    parts.push(`newest (${newest.ref}): 0/${String(newest.total)} valid — ${attemptZeroCause(newest)}`);
  }
  if (verified !== undefined) {
    parts.push(`verified (${verified.ref}): 0/${String(verified.total)} valid — ${attemptZeroCause(verified)}`);
  } else if (fallbackListingError !== undefined) {
    parts.push(`verified (${chain[1] ?? 'n/a'}): listing failed — ${fallbackListingError}`);
  }
  return new Error(
    `pack fetch failed for "${title}" — no valid entries from any ref in the chain, ` +
      `no pack book was created. ${parts.join('; ')}`,
  );
}

/**
 * Fetches one pack through the newest-first ref chain and imports the winning
 * attempt through the unchanged `importPack` (ratified decision 4; 16 §1.1
 * amendment, 2026-09-06).
 *
 * The chain: `HEAD` (newest = default branch) first, then the pinned verified
 * ref. Each attempt is a CANDIDATE — listing → selection → downloads → a
 * side-effect-free probe import through `importPack` — so the threshold rule
 * can compare attempts before any book exists. Only the NEWEST attempt is
 * subject to the threshold: at/above `PACK_FETCH_FALLBACK_VALID_RATIO` the
 * newest import ships and the verified ref costs nothing; below it the
 * verified attempt runs too and whichever attempt yielded MORE valid entries
 * is imported (deterministic tie → newest, preferring freshness at equal
 * quality). A listing error on the newest ref moves the chain to the verified
 * ref's listing (decision 4); both failing throws the combined loud error.
 * When NO attempt yields a valid entry the result is the all-fail semantics:
 * a loud named error and NO book.
 *
 * Loud on fallback (no silent degradation): when the chain fired, the returned
 * result carries `fetchNote` naming BOTH attempts, and provenance stamps the
 * ref ACTUALLY imported (`sourceRef`) plus the attempt trail (`attemptedRefs`).
 */
export async function fetchAndImportPack(
  adapterId: string,
  recipeId: string,
  options: PackFetchOptions = {},
): Promise<PackFetchResult> {
  const source = getPackFetchSource(adapterId);
  const adapter = getPackAdapter(source.adapterId);
  const fetchFn = fetchFnOf(options.fetchDeps);
  // ~10 Hz progress (16-BESTIARY-FETCH §5): per-file setState would re-render
  // the settings card hundreds of times per pack; flush() guarantees the final
  // update of each phase always lands.
  const fetchProgress = throttleProgress(
    (progress: PackFetchProgress) => options.onFetchProgress?.(progress),
    PACK_FETCH_PROGRESS_INTERVAL_MS,
  );
  const importProgress = throttleProgress(
    (progress: PackImportProgress) => options.onProgress?.(progress),
    PACK_FETCH_PROGRESS_INTERVAL_MS,
  );

  const curated = source.curated.find((recipe) => recipe.id === recipeId);
  const title = curated?.label ?? recipeId.slice(source.packRoot.length + 1);
  const chain = packRefChain(source);

  const attemptedRefs: string[] = [];
  const attempts: PackAttempt[] = [];
  let newestListingError: string | undefined;
  let fallbackListingError: string | undefined;

  for (const [index, ref] of chain.entries()) {
    attemptedRefs.push(ref);
    const refSource: PackFetchSource = { ...source, ref };
    fetchProgress.send({
      phase: 'listing',
      done: 0,
      total: 0,
      detail: `listing ${refSource.owner}/${refSource.repo}@${ref}`,
    });

    let listing: PackTreeListing;
    try {
      listing = await loadTreeListing(refSource, fetchFn);
    } catch (error) {
      if (index === 0) {
        // Listing resilience (16 §1.1 amendment, decision 4): a named error on
        // the newest ref's trees listing (rate limit / network) moves the
        // chain to the verified ref's listing. The per-ref session cache keys
        // by ref; both listings failing throws the combined loud error below.
        newestListingError = errorMessage(error);
        continue;
      }
      // The verified ref's listing failed too. When the newest attempt already
      // completed below the threshold, its import still ships (with the loud
      // note below); otherwise BOTH listings failed — break into the combined
      // loud error. Never a silent degradation.
      fallbackListingError = errorMessage(error);
      break;
    }

    const files = selectCreatureFiles(adapter.extensions, source.packRoot, recipeId, listing.blobPaths);
    if (files.length === 0) {
      // Not a fallback trigger (16 §1.1: threshold fallback, not any-error) —
      // a recipe whose pack directory does not exist at a ref is a loud,
      // named configuration error.
      throw new Error(
        `no creature files found under "${recipeId}" in ${source.owner}/${source.repo}@${ref} — check the pack path`,
      );
    }

    let done = 0;
    let outcomes: DownloadOutcome[];
    try {
      outcomes = await mapWithConcurrency(files, PACK_FETCH_CONCURRENCY, async (path) => {
        const outcome = await downloadOne(refSource, path, fetchFn);
        done += 1;
        fetchProgress.send({
          phase: 'downloading',
          done,
          total: files.length,
          detail: outcome.ok ? outcome.file.name : path,
        });
        return outcome;
      });
    } finally {
      // The final downloading update always flushes — even if the loop fails.
      fetchProgress.flush();
    }

    const inputs: PackInputFile[] = [];
    const downloadFailures: PackEntryFailure[] = [];
    for (const outcome of outcomes) {
      if (outcome.ok) inputs.push(outcome.file);
      else downloadFailures.push(outcome.failure);
    }

    // Failures WITHIN an attempt (individual downloads) stay collected — the
    // threshold rule compares each attempt's valid/total, not its failures.
    const probe =
      inputs.length === 0
        ? { valid: 0, zeroEntriesMessage: null }
        : await probePackAttemptImport(source.adapterId, inputs, title, downloadFailures);
    const attempt: PackAttempt = {
      ref,
      total: files.length,
      valid: probe.valid,
      inputs,
      downloadFailures,
      zeroEntriesMessage: probe.zeroEntriesMessage,
    };
    attempts.push(attempt);

    // Threshold rule (16 §1.1 amendment): only the NEWEST attempt is subject
    // to it — at/above the ratio the newest import ships with no fallback
    // attempt and no extra cost; below it the verified attempt runs too.
    if (index === 0 && attempt.valid / attempt.total >= PACK_FETCH_FALLBACK_VALID_RATIO) break;
  }

  if (attempts.length === 0) {
    // Both listings failed (or the single-element chain's listing did) — the
    // combined loud listing error (16 §1.1 amendment, decision 4).
    const parts = [`newest (${chain[0]}): ${newestListingError ?? 'unknown cause'}`];
    if (fallbackListingError !== undefined) {
      parts.push(`verified (${chain[1] ?? 'n/a'}): ${fallbackListingError}`);
    }
    throw new Error(
      `pack listing failed for "${title}" — no pack book was created. ${parts.join('; ')}`,
    );
  }

  const newest = attempts.find((attempt) => attempt.ref === chain[0]);
  const verified = attempts.find((attempt) => attempt.ref !== chain[0]);

  // All-fail edge (16 §1.1 amendment): 0 valid on newest AND fallback →
  // all-fail semantics as today — loud, and NO book was created.
  if (attempts.every((attempt) => attempt.valid === 0)) {
    throw noValidEntriesError(title, chain, newest, verified, newestListingError, fallbackListingError);
  }

  let winner: PackAttempt;
  let fetchNote: string | undefined;
  if (newest === undefined) {
    // The newest ref never produced an attempt (its listing failed) — the
    // verified attempt is the only complete one; decision 4's loud note.
    const attempt = attempts[0];
    if (attempt === undefined) {
      throw new Error(`pack fetch failed for "${title}" — no attempt matched the ref chain`);
    }
    winner = attempt;
    fetchNote =
      `newest (${chain[0]}) listing failed (${newestListingError ?? 'unknown cause'}) — ` +
      `listed and imported the verified snapshot (${winner.ref}) instead: ` +
      `${String(winner.valid)}/${String(winner.total)} valid`;
  } else if (verified === undefined) {
    // Newest at/above the threshold — imported, no fallback attempt, no note.
    // (The one loud exception: the chain fired but the verified ref could not
    // even be listed — the newest import ships with that named.)
    winner = newest;
    if (fallbackListingError !== undefined) {
      fetchNote =
        `newest (${newest.ref}): ${String(newest.valid)}/${String(newest.total)} valid — below the ` +
        `${String(PACK_FETCH_FALLBACK_VALID_RATIO)} valid-entry threshold (format drift suspected); ` +
        `the verified snapshot (${chain[1] ?? 'n/a'}) could not be listed (${fallbackListingError}) — ` +
        `kept the newest ref's import: ${String(newest.valid)}/${String(newest.total)}`;
    }
  } else {
    // Whichever attempt yielded MORE valid entries wins; the deterministic tie
    // keeps the newest ref (prefer freshness at equal quality).
    winner = verified.valid > newest.valid ? verified : newest;
    fetchNote =
      winner === verified
        ? `newest (${newest.ref}): ${String(newest.valid)}/${String(newest.total)} valid — ` +
          `format drift suspected; imported the verified snapshot (${verified.ref}) instead: ` +
          `${String(verified.valid)}/${String(verified.total)}`
        : `newest (${newest.ref}): ${String(newest.valid)}/${String(newest.total)} valid — below the ` +
          `${String(PACK_FETCH_FALLBACK_VALID_RATIO)} valid-entry threshold (format drift suspected); ` +
          `the verified snapshot (${verified.ref}) yielded ${String(verified.valid)}/${String(verified.total)} — ` +
          `kept the newest ref's import: ${String(newest.valid)}/${String(newest.total)}`;
  }

  try {
    const result = await importPack(source.adapterId, winner.inputs, {
      title,
      onProgress: importProgress.send,
      deps: options.deps,
      extraFailures: winner.downloadFailures,
      provenance: {
        // Provenance stamps the ref ACTUALLY imported + the attempt trail
        // (16 §1.1 amendment, decision 5).
        sourceRef: winner.ref,
        sourceUrl: `https://github.com/${source.owner}/${source.repo}/tree/${winner.ref}/${recipeId}`,
        fetchedAt: Date.now(),
        attemptedRefs: [...attemptedRefs],
      },
    });
    return fetchNote === undefined ? result : { ...result, fetchNote };
  } finally {
    importProgress.flush();
  }
}
