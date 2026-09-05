import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PackMeta } from '@/domain/rulebook';
import type { RuleChunk } from '@/domain';
import {
  PACK_FETCH_CONCURRENCY,
  PACK_FETCH_FALLBACK_VALID_RATIO,
  PACK_FETCH_MAX_BYTES,
  PACK_FETCH_NEWEST_REF,
  PACK_FETCH_SOURCES,
  PACK_FETCH_TIMEOUT_MS,
  clearPackTreeCache,
  fetchAndImportPack,
  listPackRecipes,
  packRefChain,
  selectCreatureFiles,
  throttleProgress,
} from '@/ingest/packFetch';
import type { PackFetchProgress } from '@/ingest/packFetch';
import type { PackImportDeps, PackImportProgress } from '@/ingest/packImport';

import { baseNpc, folderDoc } from './packs/fixtures';

/**
 * Pack fetcher tests (16-BESTIARY-FETCH §9): every network response is
 * mocked — these tests pin the engine's loud failure policy, the provenance
 * stamp, the curated recipes' pinned refs, and the bounded concurrency. The
 * adapters themselves stay network-free (asserted in their own test files).
 */

const PF2E_TREE = {
  sha: 'tree-sha',
  truncated: false,
  tree: [
    { path: 'packs', type: 'tree' },
    { path: 'packs/pf2e', type: 'tree' },
    { path: 'packs/pf2e/npc-gallery', type: 'tree' },
    { path: 'packs/pf2e/npc-gallery/acolyte-of-nethys.json', type: 'blob' },
    { path: 'packs/pf2e/npc-gallery/priest-of-pharasma.json', type: 'blob' },
    // Non-creature content in the pack dir: never fetched.
    { path: 'packs/pf2e/npc-gallery/_folders.json', type: 'blob' },
    { path: 'packs/pf2e/npc-gallery/notes.txt', type: 'blob' },
    // A second pack for the full-list grouping test.
    { path: 'packs/pf2e/blog-bestiary/raven.json', type: 'blob' },
    { path: 'packs/pf2e/blog-bestiary/_folders.json', type: 'blob' },
    // Code outside the pack root: invisible to the fetcher.
    { path: 'src/module.json', type: 'blob' },
  ],
};

function listingResponse(tree: unknown): Response {
  return new Response(JSON.stringify(tree), { status: 200 });
}

function creatureResponse(value: unknown, status = 200): Response {
  return new Response(status === 200 ? JSON.stringify(value) : 'nope', {
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
  });
}

/** Routes GitHub listing + raw file URLs to canned responses / errors. */
function mockFetch(routes: Record<string, Response | Error>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const mock = vi.fn((url: string | URL | Request) => {
    const key = typeof url === 'string' ? url : url instanceof Request ? url.url : url.href;
    calls.push(key);
    const route = routes[key];
    if (route === undefined) throw new Error(`unexpected fetch: ${key}`);
    if (route instanceof Error) return Promise.reject(route);
    return Promise.resolve(route);
  }) as unknown as typeof fetch & { calls: string[] };
  mock.calls = calls;
  return mock;
}

const PINNED_LIST_URL = 'https://api.github.com/repos/foundryvtt/pf2e/git/trees/v14-dev?recursive=1';
const HEAD_LIST_URL = 'https://api.github.com/repos/foundryvtt/pf2e/git/trees/HEAD?recursive=1';
/** Raw file URL at the NEWEST ref (the chain's first attempt). */
const RAW = (path: string): string =>
  `https://raw.githubusercontent.com/foundryvtt/pf2e/HEAD/${path}`;
/** Raw file URL at the pinned VERIFIED ref (the chain's fallback target). */
const RAW_PINNED = (path: string): string =>
  `https://raw.githubusercontent.com/foundryvtt/pf2e/v14-dev/${path}`;

type MemoryDeps = PackImportDeps & {
  created: { title: string; system: string; filename: string }[];
  persisted: RuleChunk[][];
  finalized: { id: string; packMeta: PackMeta | null }[];
  failed: { id: string; message: string }[];
};

function memoryDeps(): MemoryDeps {
  const created: { title: string; system: string; filename: string }[] = [];
  const persisted: RuleChunk[][] = [];
  const finalized: { id: string; packMeta: PackMeta | null }[] = [];
  const failed: { id: string; message: string }[] = [];
  let lastBookId = '';
  const makeBook = (title: string, status: 'processing' | 'ready', packMeta: PackMeta | null) => ({
    id: lastBookId,
    createdAt: 1,
    updatedAt: 1,
    title,
    system: 'pathfinder2e' as const,
    filename: 'pack.json',
    pageCount: 0,
    status,
    errorMessage: '',
    origin: 'pack' as const,
    packMeta,
  });
  const deps: MemoryDeps = {
    createBook: (input) => {
      created.push(input);
      lastBookId = crypto.randomUUID();
      return Promise.resolve(makeBook(input.title, 'processing', null));
    },
    persistChunks: (chunks) => {
      persisted.push(chunks);
      return Promise.resolve();
    },
    finalizeBook: (id, packMeta) => {
      finalized.push({ id, packMeta });
      return Promise.resolve(makeBook(id, 'ready', packMeta));
    },
    failBook: (id, message) => {
      failed.push({ id, message });
      return Promise.resolve();
    },
    created,
    persisted,
    finalized,
    failed,
  };
  return deps;
}

beforeEach(() => {
  clearPackTreeCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pack fetch sources (ratified pins)', () => {
  it('keeps packFetch the ONLY networked file in src/ingest (directory scan)', () => {
    // 12-BESTIARY-PACKS §5/§9 as amended by 16-BESTIARY-FETCH: adapters and
    // the import runner parse bytes; fetching lives exclusively in packFetch.
    // Scanned with readdir so a NEW file under src/ingest (including packs/)
    // is covered by the same assertion — no exclusion list to rot.
    const ingestDir = join(import.meta.dirname, '..', '..', 'src', 'ingest');
    const sources = readdirSync(ingestDir, { recursive: true })
      .map((entry) => String(entry).replaceAll('\\', '/'))
      .filter((entry) => entry.endsWith('.ts'))
      .sort();
    expect(sources).toContain('packFetch.ts');
    const fetchCallers = sources.filter((file) =>
      /\bfetch\s*\(|fetchFn|globalThis\.fetch/.test(readFileSync(join(ingestDir, file), 'utf8')),
    );
    expect(fetchCallers).toEqual(['packFetch.ts']);
  });

  it('pins the newest-first chain constants (16 §1.1 amendment)', () => {
    // Documented constants: the newest ref and the format-drift threshold.
    expect(PACK_FETCH_NEWEST_REF).toBe('HEAD');
    expect(PACK_FETCH_FALLBACK_VALID_RATIO).toBe(0.5);
    // Every source's chain: newest (HEAD) first, then its pinned verified ref.
    expect(PACK_FETCH_SOURCES.map((source) => packRefChain(source))).toEqual([
      ['HEAD', 'v14-dev'],
      ['HEAD', '6.0.x'],
    ]);
  });

  it('pins pf2e to v14-dev and dnd5e to 6.0.x with the verified curated recipes', () => {
    const pf2e = PACK_FETCH_SOURCES.find((source) => source.adapterId === 'foundry-pf2e');
    const dnd5e = PACK_FETCH_SOURCES.find((source) => source.adapterId === 'foundry-dnd5e-srd');
    expect(pf2e?.ref).toBe('v14-dev');
    expect(pf2e?.owner).toBe('foundryvtt');
    expect(pf2e?.repo).toBe('pf2e');
    expect(pf2e?.packRoot).toBe('packs/pf2e');
    // Verified 2026-09-05 at v14-dev (docs/16 §4): real folder names + counts.
    expect(pf2e?.curated).toEqual([
      { id: 'packs/pf2e/pathfinder-monster-core', label: 'Pathfinder Monster Core', creatures: 492 },
      { id: 'packs/pf2e/pathfinder-monster-core-2', label: 'Pathfinder Monster Core 2', creatures: 446 },
      { id: 'packs/pf2e/pathfinder-bestiary', label: 'Pathfinder Bestiary', creatures: 166 },
      { id: 'packs/pf2e/pathfinder-bestiary-2', label: 'Pathfinder Bestiary 2', creatures: 160 },
      { id: 'packs/pf2e/pathfinder-bestiary-3', label: 'Pathfinder Bestiary 3', creatures: 165 },
      { id: 'packs/pf2e/pathfinder-npc-core', label: 'Pathfinder NPC Core', creatures: 272 },
      { id: 'packs/pf2e/npc-gallery', label: 'NPC Gallery', creatures: 6 },
      { id: 'packs/pf2e/menace-under-otari-bestiary', label: 'Menace under Otari (free starter bestiary)', creatures: 93 },
    ]);
    expect(dnd5e?.ref).toBe('6.0.x');
    expect(dnd5e?.packRoot).toBe('packs/_source/monsters');
    expect(dnd5e?.curated).toEqual([
      { id: 'packs/_source/monsters', label: 'D&D 5e SRD Monsters', creatures: 337 },
    ]);
  });

  it('serves the curated list without touching the network', async () => {
    const fetchFn = mockFetch({});
    const recipes = await listPackRecipes('foundry-pf2e', { fetchDeps: { fetchFn } });
    expect(recipes).toHaveLength(8);
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(listPackRecipes('foundry-4e', { fetchDeps: { fetchFn } })).rejects.toThrow(
      'no pack fetch source for adapter "foundry-4e"',
    );
  });

  it('selects creature files only (extension filter, `_` metadata docs skipped)', () => {
    const paths = [
      'packs/pf2e/npc-gallery/acolyte-of-nethys.json',
      'packs/pf2e/npc-gallery/_folders.json',
      'packs/pf2e/npc-gallery/notes.txt',
      'packs/pf2e/other-pack/ogre.json',
    ];
    expect(selectCreatureFiles(['.json'], 'packs/pf2e', 'packs/pf2e/npc-gallery', paths)).toEqual([
      'packs/pf2e/npc-gallery/acolyte-of-nethys.json',
    ]);
  });
});

describe('listPackRecipes (advanced full listing)', () => {
  it('lists every pack group with creature counts, metadata-only dirs excluded', async () => {
    const fetchFn = mockFetch({ [PINNED_LIST_URL]: listingResponse(PF2E_TREE) });
    const recipes = await listPackRecipes('foundry-pf2e', { full: true, fetchDeps: { fetchFn } });
    expect(recipes).toEqual([
      { id: 'packs/pf2e/blog-bestiary', label: 'blog-bestiary', creatures: 1 },
      { id: 'packs/pf2e/npc-gallery', label: 'npc-gallery', creatures: 2 },
    ]);
    // One API call; served from the session cache afterwards.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await listPackRecipes('foundry-pf2e', { full: true, fetchDeps: { fetchFn } });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('fails loudly on a rate-limited listing, naming the per-IP limit', async () => {
    const fetchFn = mockFetch({
      [PINNED_LIST_URL]: new Response('rate limited', { status: 403 }),
    });
    await expect(
      listPackRecipes('foundry-pf2e', { full: true, fetchDeps: { fetchFn } }),
    ).rejects.toThrow('60 requests/hour per IP');
  });

  it('fails loudly on HTTP 429 too, naming the per-IP limit', async () => {
    // F10: the 429 branch of the same rate-limit handling, alongside the 403
    // test above — GitHub sends either on an exhausted 60 req/h quota.
    const fetchFn = mockFetch({
      [PINNED_LIST_URL]: new Response('too many requests', { status: 429 }),
    });
    const action = listPackRecipes('foundry-pf2e', { full: true, fetchDeps: { fetchFn } });
    await expect(action).rejects.toThrow('pack listing failed: GitHub API HTTP 429');
    await expect(action).rejects.toThrow('60 requests/hour per IP');
  });

  it.each([
    'packs/pf2e/npc-gallery/../../../etc/passwd.json',
    'packs\\pf2e\\npc-gallery\\goblin.json',
    '/etc/shadow',
  ])('fails loudly on a hostile listing path (%s)', async (hostilePath) => {
    // F1 (listing integrity): the trees-API listing is hostile input — a `..`
    // segment, a backslash, or an absolute path fails the WHOLE listing with a
    // named error quoting the path, never a silent per-path filter.
    const fetchFn = mockFetch({
      [PINNED_LIST_URL]: listingResponse({
        sha: 'tree-sha',
        truncated: false,
        tree: [{ path: hostilePath, type: 'blob' }],
      }),
    });
    await expect(
      listPackRecipes('foundry-pf2e', { full: true, fetchDeps: { fetchFn } }),
    ).rejects.toThrow(
      `pack listing failed: listing-integrity violation — hostile tree path "${hostilePath}"`,
    );
  });

  it('fails loudly with a named error when the listing body is malformed JSON', async () => {
    // F9: the body parse happens inside the named-error scope — a malformed
    // listing fails as a named listing failure, not a raw SyntaxError.
    const fetchFn = mockFetch({
      [PINNED_LIST_URL]: new Response('{"truncated": false, "tree": [', { status: 200 }),
    });
    await expect(
      listPackRecipes('foundry-pf2e', { full: true, fetchDeps: { fetchFn } }),
    ).rejects.toThrow(/^pack listing failed: could not parse the listing response/);
  });

  it('fails loudly on a truncated tree instead of silently missing packs', async () => {
    const fetchFn = mockFetch({
      [PINNED_LIST_URL]: listingResponse({ truncated: true, tree: [] }),
    });
    await expect(
      listPackRecipes('foundry-pf2e', { full: true, fetchDeps: { fetchFn } }),
    ).rejects.toThrow('truncated');
  });

  it('fails loudly on a network error during listing', async () => {
    const fetchFn = mockFetch({ [PINNED_LIST_URL]: new Error('Failed to fetch') });
    await expect(
      listPackRecipes('foundry-pf2e', { full: true, fetchDeps: { fetchFn } }),
    ).rejects.toThrow('pack listing failed');
  });
});

describe('fetchAndImportPack', () => {
  it('fetches the newest ref and imports a ready book with provenance stamped', async () => {
    const fetchFn = mockFetch({
      [HEAD_LIST_URL]: listingResponse(PF2E_TREE),
      [RAW('packs/pf2e/npc-gallery/acolyte-of-nethys.json')]: creatureResponse(baseNpc('Acolyte of Nethys')),
      [RAW('packs/pf2e/npc-gallery/priest-of-pharasma.json')]: creatureResponse(baseNpc('Priest of Pharasma')),
    });
    const deps = memoryDeps();
    const fetchProgress: string[] = [];
    const importProgress: PackImportProgress[] = [];

    const result = await fetchAndImportPack('foundry-pf2e', 'packs/pf2e/npc-gallery', {
      deps,
      fetchDeps: { fetchFn },
      onFetchProgress: (progress) => {
        fetchProgress.push(`${progress.phase}:${String(progress.done)}/${String(progress.total)}`);
      },
      onProgress: (progress) => importProgress.push(progress),
    });

    expect(result.imported).toBe(2);
    expect(deps.created[0]?.title).toBe('NPC Gallery'); // curated label becomes the book title
    expect(result.book.status).toBe('ready');
    // Only the creature files were requested — metadata/docs never fetched.
    expect(fetchFn.calls.filter((url) => url.startsWith('https://raw.githubusercontent.com'))).toHaveLength(2);
    expect(fetchFn.calls.some((url) => url.includes('_folders.json'))).toBe(false);
    expect(fetchFn.calls.some((url) => url.includes('notes.txt'))).toBe(false);

    // Newest healthy → a SINGLE pass (16 §1.1): one listing call, no fallback
    // attempt, the pinned verified ref never touched.
    expect(fetchFn.calls.filter((url) => url.startsWith('https://api.github.com'))).toHaveLength(1);
    expect(fetchFn.calls.some((url) => url.includes('/v14-dev/'))).toBe(false);
    expect(result.fetchNote).toBeUndefined();

    // Provenance (16 §1.1 decision 5): the ref ACTUALLY imported + the trail.
    const meta = result.book.packMeta;
    expect(meta?.sourceRef).toBe('HEAD');
    expect(meta?.sourceUrl).toBe(
      'https://github.com/foundryvtt/pf2e/tree/HEAD/packs/pf2e/npc-gallery',
    );
    expect(typeof meta?.fetchedAt).toBe('number');
    expect(meta?.attemptedRefs).toEqual(['HEAD']);

    // Progress: downloading phase counts up to the file total; import phase
    // keeps its existing shape.
    expect(fetchProgress[0]).toBe('listing:0/0');
    expect(fetchProgress.at(-1)).toBe('downloading:2/2');
    expect(importProgress).toEqual([{ bookId: result.book.id, done: 2, total: 2 }]);
  });

  it('collects a partial download failure loudly in the report and packMeta', async () => {
    // 1/2 valid = exactly the threshold → NOT below it (16 §1.1: the fallback
    // fires only when valid/total < 0.5), so this stays a single newest pass.
    const fetchFn = mockFetch({
      [HEAD_LIST_URL]: listingResponse(PF2E_TREE),
      [RAW('packs/pf2e/npc-gallery/acolyte-of-nethys.json')]: creatureResponse(baseNpc('Acolyte of Nethys')),
      [RAW('packs/pf2e/npc-gallery/priest-of-pharasma.json')]: creatureResponse(baseNpc('Priest of Pharasma'), 404),
    });
    const deps = memoryDeps();

    const result = await fetchAndImportPack('foundry-pf2e', 'packs/pf2e/npc-gallery', {
      deps,
      fetchDeps: { fetchFn },
    });
    expect(result.imported).toBe(1);
    expect(result.failed).toEqual([
      {
        file: 'npc-gallery/priest-of-pharasma.json',
        name: '',
        message: 'download failed: HTTP 404 Not Found',
      },
    ]);
    expect(result.book.packMeta?.entriesFailed).toBe(1);
    expect(result.book.status).toBe('ready');
  });

  it('collects a network failure as a named failure entry', async () => {
    const fetchFn = mockFetch({
      [HEAD_LIST_URL]: listingResponse(PF2E_TREE),
      [RAW('packs/pf2e/npc-gallery/acolyte-of-nethys.json')]: creatureResponse(baseNpc('Acolyte of Nethys')),
      [RAW('packs/pf2e/npc-gallery/priest-of-pharasma.json')]: new Error('Failed to fetch'),
    });
    const deps = memoryDeps();

    const result = await fetchAndImportPack('foundry-pf2e', 'packs/pf2e/npc-gallery', {
      deps,
      fetchDeps: { fetchFn },
    });
    expect(result.failed[0]?.file).toBe('npc-gallery/priest-of-pharasma.json');
    expect(result.failed[0]?.message).toContain('download failed: Failed to fetch');
  });

  it('sends an AbortSignal.timeout signal with every raw file fetch', async () => {
    // F8 hardening wiring: each raw document fetch is bounded by the
    // documented per-file timeout constant; the listing call keeps its own
    // headers-only init.
    const rawSignals: (AbortSignal | null | undefined)[] = [];
    const fetchFn = vi.fn((url: string | URL, init?: RequestInit) => {
      const key = typeof url === 'string' ? url : url instanceof Request ? url.url : url.href;
      if (key === HEAD_LIST_URL) return Promise.resolve(listingResponse(PF2E_TREE));
      rawSignals.push(init?.signal);
      return Promise.resolve(creatureResponse(baseNpc('Wired Creature')));
    }) as unknown as typeof fetch;

    const result = await fetchAndImportPack('foundry-pf2e', 'packs/pf2e/npc-gallery', {
      deps: memoryDeps(),
      fetchDeps: { fetchFn },
    });
    expect(result.imported).toBe(2); // both raw files went through the signal path
    expect(rawSignals).toHaveLength(2);
    for (const signal of rawSignals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    }
  });

  it('collects a timed-out download as a named failure entry (not a throw)', async () => {
    // F8: AbortSignal.timeout rejects with a TimeoutError-named error; the
    // injected stub mimics exactly that rejection shape.
    const fetchFn = mockFetch({
      [HEAD_LIST_URL]: listingResponse(PF2E_TREE),
      [RAW('packs/pf2e/npc-gallery/acolyte-of-nethys.json')]: creatureResponse(baseNpc('Acolyte of Nethys')),
      [RAW('packs/pf2e/npc-gallery/priest-of-pharasma.json')]: Object.assign(
        new Error('The operation was aborted due to timeout'),
        { name: 'TimeoutError' },
      ),
    });
    const deps = memoryDeps();

    const result = await fetchAndImportPack('foundry-pf2e', 'packs/pf2e/npc-gallery', {
      deps,
      fetchDeps: { fetchFn },
    });
    expect(result.failed).toEqual([
      {
        file: 'npc-gallery/priest-of-pharasma.json',
        name: '',
        message: `download failed: timed out after ${String(PACK_FETCH_TIMEOUT_MS)}ms (AbortSignal.timeout)`,
      },
    ]);
    expect(PACK_FETCH_TIMEOUT_MS).toBe(30_000); // documented constant
    expect(result.imported).toBe(1); // the healthy file still imports
    expect(result.book.status).toBe('ready');
  });

  it('collects an oversized download as a named failure entry (not a throw)', async () => {
    // F8: one creature document is ≪ 1 MB; a body over the documented cap is
    // a collected per-file failure, and the pack still imports the rest.
    const oversized = new Uint8Array(PACK_FETCH_MAX_BYTES + 1);
    const fetchFn = mockFetch({
      [HEAD_LIST_URL]: listingResponse(PF2E_TREE),
      [RAW('packs/pf2e/npc-gallery/acolyte-of-nethys.json')]: creatureResponse(baseNpc('Acolyte of Nethys')),
      [RAW('packs/pf2e/npc-gallery/priest-of-pharasma.json')]: new Response(oversized, { status: 200 }),
    });
    const deps = memoryDeps();

    const result = await fetchAndImportPack('foundry-pf2e', 'packs/pf2e/npc-gallery', {
      deps,
      fetchDeps: { fetchFn },
    });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.file).toBe('npc-gallery/priest-of-pharasma.json');
    expect(result.failed[0]?.message).toContain(
      `over the ${String(PACK_FETCH_MAX_BYTES)}-byte sanity cap`,
    );
    expect(PACK_FETCH_MAX_BYTES).toBe(5 * 1024 * 1024); // documented constant
    expect(result.imported).toBe(1);
    expect(deps.finalized).toHaveLength(1);
  });

  it('imports nothing and throws loudly naming BOTH refs when every attempt yields zero valid entries', async () => {
    // All-fail edge (16 §1.1): 0 valid on newest AND fallback → all-fail
    // semantics as today — loud, and NO book was created (the newest attempt
    // is below threshold, so the verified ref runs too; its documents are
    // equally unusable).
    const fetchFn = mockFetch({
      [HEAD_LIST_URL]: listingResponse(PF2E_TREE),
      [PINNED_LIST_URL]: listingResponse(PF2E_TREE),
      [RAW('packs/pf2e/npc-gallery/acolyte-of-nethys.json')]: creatureResponse(folderDoc()),
      [RAW('packs/pf2e/npc-gallery/priest-of-pharasma.json')]: creatureResponse(folderDoc()),
      [RAW_PINNED('packs/pf2e/npc-gallery/acolyte-of-nethys.json')]: creatureResponse(folderDoc()),
      [RAW_PINNED('packs/pf2e/npc-gallery/priest-of-pharasma.json')]: creatureResponse(folderDoc()),
    });
    const deps = memoryDeps();

    await expect(
      fetchAndImportPack('foundry-pf2e', 'packs/pf2e/npc-gallery', { deps, fetchDeps: { fetchFn } }),
    ).rejects.toThrow(
      /pack fetch failed for "NPC Gallery" — no valid entries from any ref in the chain, no pack book was created\. .*newest \(HEAD\): 0\/2 valid.*verified \(v14-dev\): 0\/2 valid.*no valid creature entries/s,
    );
    // No book: not created, not failed, not finalized.
    expect(deps.created).toHaveLength(0);
    expect(deps.failed).toHaveLength(0);
    expect(deps.finalized).toHaveLength(0);
    // Exactly one listing call per attempt (no hidden extra calls).
    expect(fetchFn.calls.filter((url) => url.startsWith('https://api.github.com'))).toHaveLength(2);
  });

  it('throws the combined loud error when every download fails on BOTH refs', async () => {
    const fetchFn = mockFetch({
      [HEAD_LIST_URL]: listingResponse(PF2E_TREE),
      [PINNED_LIST_URL]: listingResponse(PF2E_TREE),
      [RAW('packs/pf2e/npc-gallery/acolyte-of-nethys.json')]: creatureResponse(baseNpc(), 500),
      [RAW('packs/pf2e/npc-gallery/priest-of-pharasma.json')]: creatureResponse(baseNpc(), 500),
      [RAW_PINNED('packs/pf2e/npc-gallery/acolyte-of-nethys.json')]: creatureResponse(baseNpc(), 500),
      [RAW_PINNED('packs/pf2e/npc-gallery/priest-of-pharasma.json')]: creatureResponse(baseNpc(), 500),
    });
    const deps = memoryDeps();

    await expect(
      fetchAndImportPack('foundry-pf2e', 'packs/pf2e/npc-gallery', { deps, fetchDeps: { fetchFn } }),
    ).rejects.toThrow(
      /newest \(HEAD\): 0\/2 valid — all 2 downloads failed.*HTTP 500.*verified \(v14-dev\): 0\/2 valid — all 2 downloads failed/s,
    );
    expect(deps.created).toHaveLength(0);
  });

  it('rejects an unknown pack path before any download', async () => {
    const fetchFn = mockFetch({ [HEAD_LIST_URL]: listingResponse(PF2E_TREE) });
    const deps = memoryDeps();
    await expect(
      fetchAndImportPack('foundry-pf2e', 'packs/pf2e/not-a-pack', { deps, fetchDeps: { fetchFn } }),
    ).rejects.toThrow('no creature files found under "packs/pf2e/not-a-pack"');
    expect(deps.created).toHaveLength(0);
    // Threshold fallback, NOT any-error (16 §1.1): an empty selection is a
    // loud configuration error — the verified ref's listing is never tried.
    expect(fetchFn.calls.some((url) => url.includes('/v14-dev/'))).toBe(false);
  });

  it('selects and fetches creature files through nested book-N layouts (AP bestiaries)', async () => {
    // F10 / docs/16 §4: AP bestiaries nest further, e.g.
    // packs/pf2e/gatewalkers-bestiary/book-1-.../x.json — the recipe names the
    // PACK, selection recurses through the nested layout, the raw URLs keep
    // the nested path, and the report/filenames stay relative to the pack dir.
    const nestedTree = {
      sha: 'tree-sha',
      truncated: false,
      tree: [
        { path: 'packs/pf2e/gatewalkers-bestiary/book-1-hellknight-hill/_folders.json', type: 'blob' },
        { path: 'packs/pf2e/gatewalkers-bestiary/book-1-hellknight-hill/deathcap-ambusher.json', type: 'blob' },
        { path: 'packs/pf2e/gatewalkers-bestiary/book-2-spire-of-xibalan/cinder-crab.json', type: 'blob' },
      ],
    };
    const fetchFn = mockFetch({
      [HEAD_LIST_URL]: listingResponse(nestedTree),
      [RAW('packs/pf2e/gatewalkers-bestiary/book-1-hellknight-hill/deathcap-ambusher.json')]: creatureResponse(baseNpc('Deathcap Ambusher')),
      [RAW('packs/pf2e/gatewalkers-bestiary/book-2-spire-of-xibalan/cinder-crab.json')]: creatureResponse(baseNpc('Cinder Crab')),
    });
    const deps = memoryDeps();

    const result = await fetchAndImportPack('foundry-pf2e', 'packs/pf2e/gatewalkers-bestiary', {
      deps,
      fetchDeps: { fetchFn },
    });
    expect(result.imported).toBe(2);
    expect(deps.persisted[0]?.map((chunk) => chunk.headingPath[0])).toEqual([
      'Deathcap Ambusher',
      'Cinder Crab',
    ]);
    // Non-curated recipe: the book title falls back to the pack dir name.
    expect(deps.created[0]?.title).toBe('gatewalkers-bestiary');
    // The metadata doc inside the nested book dir was never fetched.
    expect(fetchFn.calls.some((url) => url.includes('_folders.json'))).toBe(false);
    // Filenames in the parse inputs keep the nested path relative to the pack.
    expect(deps.persisted[0]?.every((chunk) => chunk.bookId === result.book.id)).toBe(true);
  });

  it('bounds download concurrency with the shared pool util', async () => {
    const fileCount = 6;
    const tree = {
      sha: 'tree-sha',
      truncated: false,
      tree: Array.from({ length: fileCount }, (_, index) => ({
        path: `packs/pf2e/npc-gallery/creature-${String(index)}.json`,
        type: 'blob',
      })),
    };
    let active = 0;
    let maxActive = 0;
    const gates: (() => void)[] = [];
    const fetchFn = vi.fn((url: string | URL) => {
      const key = String(url);
      if (key === HEAD_LIST_URL) return Promise.resolve(listingResponse(tree));
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<Response>((resolve) => {
        gates.push(() => {
          active -= 1;
          resolve(creatureResponse(baseNpc(`Creature ${key.at(-1)}`)));
        });
      });
    });

    const action = fetchAndImportPack('foundry-pf2e', 'packs/pf2e/npc-gallery', {
      deps: memoryDeps(),
      fetchDeps: { fetchFn: fetchFn as unknown as typeof fetch },
    });
    // A macrotask tick flushes every pending microtask hop of the pool.
    const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    // Wait until the pool has started as many downloads as it may run at once…
    for (let ticks = 0; gates.length < PACK_FETCH_CONCURRENCY && ticks < 100; ticks += 1) {
      await tick();
    }
    expect(gates).toHaveLength(PACK_FETCH_CONCURRENCY); // exactly the bound, not fileCount
    expect(maxActive).toBeLessThanOrEqual(PACK_FETCH_CONCURRENCY);
    for (const gate of gates.splice(0)) gate();
    // …then keep releasing as the pool starts the remaining files.
    for (let ticks = 0; gates.length < fileCount - PACK_FETCH_CONCURRENCY && ticks < 100; ticks += 1) {
      await tick();
    }
    for (const gate of gates.splice(0)) gate();
    const result = await action;
    expect(result.imported).toBe(fileCount);
    expect(maxActive).toBe(PACK_FETCH_CONCURRENCY); // parallel, but never above the bound
  }, 15000);
});

describe('newest-first ref chain with verified-ref fallback (16 §1.1 amendment)', () => {
  /** Three-creature tree so ratios land strictly below the 0.5 threshold. */
  const TREE_3 = {
    sha: 'tree-sha',
    truncated: false,
    tree: [
      { path: 'packs/pf2e/npc-gallery/a.json', type: 'blob' },
      { path: 'packs/pf2e/npc-gallery/b.json', type: 'blob' },
      { path: 'packs/pf2e/npc-gallery/c.json', type: 'blob' },
    ],
  };
  const PATHS = ['a.json', 'b.json', 'c.json'].map((name) => `packs/pf2e/npc-gallery/${name}`);
  const routes = (head: (path: string) => Response | Error, pinned: (path: string) => Response | Error) => ({
    [HEAD_LIST_URL]: listingResponse(TREE_3),
    [PINNED_LIST_URL]: listingResponse(TREE_3),
    ...Object.fromEntries(PATHS.map((path) => [RAW(path), head(path)])),
    ...Object.fromEntries(PATHS.map((path) => [RAW_PINNED(path), pinned(path)])),
  });

  it('falls back to the verified snapshot when the newest ref imports below the threshold, loudly', async () => {
    // Format drift (the v14-dev-moved-under-us failure class): HEAD's documents
    // parse to NOTHING (0/3 < 0.5) → the verified ref runs too and wins.
    const fetchFn = mockFetch(
      routes(
        () => creatureResponse(folderDoc()),
        (path) => creatureResponse(baseNpc(`Verified ${path.at(-1)}`)),
      ),
    );
    const deps = memoryDeps();

    const result = await fetchAndImportPack('foundry-pf2e', 'packs/pf2e/npc-gallery', {
      deps,
      fetchDeps: { fetchFn },
    });

    expect(result.imported).toBe(3);
    expect(result.book.status).toBe('ready');
    // Provenance stamps the ref ACTUALLY imported + the attempt trail.
    expect(result.book.packMeta?.sourceRef).toBe('v14-dev');
    expect(result.book.packMeta?.sourceUrl).toBe(
      'https://github.com/foundryvtt/pf2e/tree/v14-dev/packs/pf2e/npc-gallery',
    );
    expect(result.book.packMeta?.attemptedRefs).toEqual(['HEAD', 'v14-dev']);
    // Loud on fallback: the note names BOTH attempts.
    expect(result.fetchNote).toBe(
      'newest (HEAD): 0/3 valid — format drift suspected; imported the verified snapshot (v14-dev) instead: 3/3',
    );
    // Exactly one listing call per attempt (the per-ref cache adds no extras).
    expect(fetchFn.calls.filter((url) => url.startsWith('https://api.github.com'))).toHaveLength(2);
  });

  it('keeps the newest import when it is below the threshold but still beats the verified ref', async () => {
    const fetchFn = mockFetch(
      routes(
        (path) => (path.endsWith('a.json') ? creatureResponse(baseNpc('Head Acolyte')) : creatureResponse(folderDoc())),
        () => creatureResponse(folderDoc()),
      ),
    );
    const deps = memoryDeps();

    const result = await fetchAndImportPack('foundry-pf2e', 'packs/pf2e/npc-gallery', {
      deps,
      fetchDeps: { fetchFn },
    });

    // 1/3 < 0.5 → the verified attempt ran; 1 > 0 → newest wins the comparison.
    expect(result.imported).toBe(1);
    expect(result.book.packMeta?.sourceRef).toBe('HEAD');
    expect(result.book.packMeta?.attemptedRefs).toEqual(['HEAD', 'v14-dev']);
    expect(result.fetchNote).toBe(
      'newest (HEAD): 1/3 valid — below the 0.5 valid-entry threshold (format drift suspected); ' +
        'the verified snapshot (v14-dev) yielded 0/3 — kept the newest ref\'s import: 1/3',
    );
  });

  it('breaks a deterministic tie toward the newest ref', async () => {
    // Equal valid counts (1/3 vs 1/3) → freshness wins: newest is imported.
    const fetchFn = mockFetch(
      routes(
        (path) => (path.endsWith('a.json') ? creatureResponse(baseNpc('Head Acolyte')) : creatureResponse(folderDoc())),
        (path) => (path.endsWith('a.json') ? creatureResponse(baseNpc('Verified Acolyte')) : creatureResponse(folderDoc())),
      ),
    );
    const deps = memoryDeps();

    const result = await fetchAndImportPack('foundry-pf2e', 'packs/pf2e/npc-gallery', {
      deps,
      fetchDeps: { fetchFn },
    });

    expect(result.imported).toBe(1);
    expect(deps.persisted[0]?.[0]?.headingPath[0]).toBe('Head Acolyte');
    expect(result.book.packMeta?.sourceRef).toBe('HEAD');
    expect(result.book.packMeta?.attemptedRefs).toEqual(['HEAD', 'v14-dev']);
    expect(result.fetchNote).toContain('kept the newest ref\'s import: 1/3');
  });

  it('lists and imports the verified ref when the newest listing fails, and says so', async () => {
    // Decision 4: a named error on the newest ref's trees listing (rate limit
    // here) moves the chain to the verified ref's listing.
    const fetchFn = mockFetch({
      [HEAD_LIST_URL]: new Response('rate limited', { status: 403 }),
      [PINNED_LIST_URL]: listingResponse(PF2E_TREE),
      [RAW_PINNED('packs/pf2e/npc-gallery/acolyte-of-nethys.json')]: creatureResponse(baseNpc('Acolyte of Nethys')),
      [RAW_PINNED('packs/pf2e/npc-gallery/priest-of-pharasma.json')]: creatureResponse(baseNpc('Priest of Pharasma')),
    });
    const deps = memoryDeps();

    const result = await fetchAndImportPack('foundry-pf2e', 'packs/pf2e/npc-gallery', {
      deps,
      fetchDeps: { fetchFn },
    });

    expect(result.imported).toBe(2);
    expect(result.book.packMeta?.sourceRef).toBe('v14-dev');
    expect(result.book.packMeta?.attemptedRefs).toEqual(['HEAD', 'v14-dev']);
    // Loud on fallback: the note names the newest listing's cause AND both refs.
    expect(result.fetchNote).toContain('newest (HEAD) listing failed (pack listing failed: GitHub API HTTP 403');
    expect(result.fetchNote).toContain('60 requests/hour per IP');
    expect(result.fetchNote).toContain(
      '— listed and imported the verified snapshot (v14-dev) instead: 2/2 valid',
    );
  });

  it('throws the combined loud listing error when BOTH refs fail to list', async () => {
    const fetchFn = mockFetch({
      [HEAD_LIST_URL]: new Error('Failed to fetch'),
      [PINNED_LIST_URL]: new Response('too many requests', { status: 429 }),
    });
    const deps = memoryDeps();

    await expect(
      fetchAndImportPack('foundry-pf2e', 'packs/pf2e/npc-gallery', { deps, fetchDeps: { fetchFn } }),
    ).rejects.toThrow(
      /pack listing failed for "NPC Gallery" — no pack book was created\. newest \(HEAD\): pack listing failed: could not reach api\.github\.com — Failed to fetch; verified \(v14-dev\): pack listing failed: GitHub API HTTP 429/s,
    );
    expect(deps.created).toHaveLength(0);
  });

  it('serves repeat fetches from the per-ref listing cache — one call per attempt, no hidden extras', async () => {
    const deps = memoryDeps();

    // First fetch: one listing call per attempt of the chain.
    const first = mockFetch(
      routes(
        () => creatureResponse(folderDoc()),
        (path) => creatureResponse(baseNpc(`Verified ${path.at(-1)}`)),
      ),
    );
    await fetchAndImportPack('foundry-pf2e', 'packs/pf2e/npc-gallery', { deps, fetchDeps: { fetchFn: first } });
    expect(first.calls.filter((url) => url.startsWith('https://api.github.com'))).toHaveLength(2);

    // A second full fetch re-uses BOTH cached listings — zero api.github.com
    // calls — and still re-runs the raw GETs of each attempt.
    const second = mockFetch(
      routes(
        () => creatureResponse(folderDoc()),
        (path) => creatureResponse(baseNpc(`Verified ${path.at(-1)}`)),
      ),
    );
    await fetchAndImportPack('foundry-pf2e', 'packs/pf2e/npc-gallery', { deps, fetchDeps: { fetchFn: second } });
    expect(second.calls.filter((url) => url.startsWith('https://api.github.com'))).toHaveLength(0);
    expect(second.calls.filter((url) => url.startsWith('https://raw.githubusercontent.com'))).toHaveLength(6);
  });
});

describe('throttleProgress (~10 Hz progress, F7)', () => {
  it('emits immediately, coalesces bursts, and always flushes the final update', async () => {
    vi.useFakeTimers();
    try {
      const emitted: number[] = [];
      const throttle = throttleProgress((value: number) => emitted.push(value), 100);

      throttle.send(1); // leading edge — immediate
      expect(emitted).toEqual([1]);

      throttle.send(2); // inside the window — coalesced into one trailing emit
      throttle.send(3);
      expect(emitted).toEqual([1]);

      await vi.advanceTimersByTimeAsync(100); // trailing edge emits the NEWEST value
      expect(emitted).toEqual([1, 3]);

      throttle.send(4); // inside the new window — coalesced again
      expect(emitted).toEqual([1, 3]);
      await vi.advanceTimersByTimeAsync(100);
      expect(emitted).toEqual([1, 3, 4]);

      throttle.send(5); // coalesced…
      throttle.flush(); // …but the FINAL update always flushes immediately
      expect(emitted).toEqual([1, 3, 4, 5]);

      throttle.flush(); // nothing held — no duplicate emit
      expect(emitted).toEqual([1, 3, 4, 5]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last per-file progress visible through fetchAndImportPack (final flush)', async () => {
    // Integration half of F7: the throttled download phase still ends with
    // done === total (pinned end-to-end in the provenance test above), and a
    // 100-file burst cannot emit more than ~1 update per throttle window.
    const fileCount = 20;
    const tree = {
      sha: 'tree-sha',
      truncated: false,
      tree: Array.from({ length: fileCount }, (_, index) => ({
        path: `packs/pf2e/npc-gallery/creature-${String(index)}.json`,
        type: 'blob',
      })),
    };
    const fetchFn = vi.fn((url: string | URL) => {
      const key = String(url);
      if (key === HEAD_LIST_URL) return Promise.resolve(listingResponse(tree));
      return Promise.resolve(creatureResponse(baseNpc(`Creature ${key.at(-1)}`)));
    }) as unknown as typeof fetch;

    const updates: PackFetchProgress[] = [];
    const result = await fetchAndImportPack('foundry-pf2e', 'packs/pf2e/npc-gallery', {
      deps: memoryDeps(),
      fetchDeps: { fetchFn },
      onFetchProgress: (progress) => updates.push({ ...progress }),
    });
    expect(result.imported).toBe(fileCount);
    // First update names the listing; the LAST update is the flushed final one.
    expect(updates[0]?.phase).toBe('listing');
    const downloading = updates.filter((progress) => progress.phase === 'downloading');
    expect(downloading.at(-1)?.done).toBe(fileCount);
    expect(downloading.at(-1)?.total).toBe(fileCount);
    // Throttled: 20 files inside one window cannot produce 20 UI updates.
    expect(downloading.length).toBeLessThan(fileCount);
  });
});
