import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

/**
 * BEHAVIOURAL pins for the app-shell service worker (docs/17 row 378,
 * docs/18 §5, docs/08 §The app-shell fallback).
 *
 * `public/sw.js` is plain script that only calls `globalThis.addEventListener`
 * and reads `globalThis.caches`, `globalThis.fetch`, `globalThis.registration`
 * and `globalThis.location`, so it is DRIVEN here for real rather than scanned:
 * it is evaluated in a `node:vm` context with those globals stubbed, the
 * handler it registers for `fetch` is captured, and synthetic FetchEvents are
 * dispatched at that handler.
 *
 * WHY THIS MUST BE BEHAVIOURAL. The defect this file pins is that the static
 * host answers 404 for a client-side route — a RESPONSE, not a network
 * rejection — so the old `.catch(() => caches.match('./'))` never ran. Fixing
 * that changes no identifier and no statement SHAPE, so a text scan passes on
 * the broken worker: only running it can tell the two apart. The stubs are
 * faithful to the real environment where it matters: `registration.scope` is an
 * ABSOLUTE url (`<origin><base>/`), exactly what a browser reports.
 */

const root = resolve(import.meta.dirname, '../..');
const SW_PATH = resolve(root, 'public/sw.js');
const SW_SOURCE = readFileSync(SW_PATH, 'utf8');

const ORIGIN = 'https://apps.futuremagic.de';
const SCOPE = `${ORIGIN}/Campaigner/`;
/** The worker script's own url: the base every relative cache key resolves against. */
const SW_URL = `${SCOPE}sw.js`;
const CACHE_NAME = 'campaigner-shell-v1';

const SHELL_BODY = '<!doctype html><title>cached Campaigner shell</title>';
const FRESH_BODY = '<!doctype html><title>Campaigner after a new build</title>';

interface StubRequest {
  readonly url: string;
  readonly method: string;
  readonly mode: string;
}

interface StubFetchEvent {
  readonly request: StubRequest;
  respondWith(value: unknown): void;
}

type FetchListener = (event: StubFetchEvent) => void;

interface DispatchResult {
  readonly respondWithCalled: boolean;
  readonly response: Promise<Response> | undefined;
  readonly thrown: unknown;
}

interface WorkerHarness {
  readonly cache: Map<string, Response>;
  readonly fetchCalls: string[];
  dispatch(request: StubRequest): DispatchResult;
}

/** Cache keys are Requests or strings resolved against the worker's own url. */
function cacheKey(key: string | { url: string }): string {
  return typeof key === 'string' ? new URL(key, SW_URL).href : key.url;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
}

/**
 * Evaluate the real `public/sw.js` and return a handle that dispatches
 * synthetic fetch events at the listener it registered.
 */
function makeWorker(options: {
  fetchImpl: (request: StubRequest) => Promise<Response>;
  cachedShell?: Response;
}): WorkerHarness {
  const cache = new Map<string, Response>();
  if (options.cachedShell !== undefined) cache.set(cacheKey('./'), options.cachedShell);

  const fetchCalls: string[] = [];
  const listeners = new Map<string, FetchListener>();

  const cacheStore = {
    addAll: (keys: readonly string[]) => {
      for (const key of keys) cache.set(cacheKey(key), new Response(`precached ${key}`));
      return Promise.resolve();
    },
    put: (key: string | { url: string }, response: Response) => {
      cache.set(cacheKey(key), response);
      return Promise.resolve();
    },
    match: (key: string | { url: string }) => Promise.resolve(cache.get(cacheKey(key))),
  };

  const sandbox: Record<string, unknown> = {
    console,
    URL,
    Response,
    caches: {
      open: (name: string) => (name === CACHE_NAME ? Promise.resolve(cacheStore) : undefined),
      match: (key: string | { url: string }) => Promise.resolve(cache.get(cacheKey(key))),
      keys: () => Promise.resolve([CACHE_NAME]),
      delete: () => Promise.resolve(true),
    },
    fetch: (request: StubRequest) => {
      fetchCalls.push(request.url);
      return options.fetchImpl(request);
    },
    location: { origin: ORIGIN },
    registration: { scope: SCOPE },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
    addEventListener: (type: string, listener: FetchListener) => {
      listeners.set(type, listener);
    },
  };
  sandbox.globalThis = sandbox;
  createContext(sandbox);
  runInContext(SW_SOURCE, sandbox, { filename: SW_PATH });

  const listener = listeners.get('fetch');
  if (listener === undefined) throw new Error('public/sw.js registered no fetch listener');

  return {
    cache,
    fetchCalls,
    dispatch: (request: StubRequest): DispatchResult => {
      let response: Promise<Response> | undefined;
      let thrown: unknown;
      const event: StubFetchEvent = {
        request,
        respondWith: (value: unknown) => {
          // A real FetchEvent.respondWith rejects a non-Response, non-promise
          // argument; `undefined` is the exact latent TypeError this pins.
          if (value === null || value === undefined || typeof (value as Promise<Response>).then !== 'function') {
            throw new TypeError('FetchEvent.respondWith() expects a Response or a promise for one');
          }
          response = value as Promise<Response>;
        },
      };
      try {
        listener(event);
      } catch (error) {
        thrown = error;
      }
      return { respondWithCalled: response !== undefined, response, thrown };
    },
  };
}

/** Let the worker's fire-and-forget cache writes (`void caches.open(…)`) land. */
function settle(): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, 0);
  });
}

function navigate(path: string): StubRequest {
  return { url: `${ORIGIN}${path}`, method: 'GET', mode: 'navigate' };
}

function subresource(url: string, method = 'GET'): StubRequest {
  return { url, method, mode: 'cors' };
}

describe('app-shell service worker — behavioural pins (docs/17 row 378)', () => {
  it('(a) a navigate whose network response is 404 yields the CACHED SHELL, not the 404', async () => {
    const worker = makeWorker({
      cachedShell: html(SHELL_BODY),
      fetchImpl: () => Promise.resolve(new Response('Error response', { status: 404 })),
    });

    const { respondWithCalled, response } = worker.dispatch(navigate('/Campaigner/settings'));

    expect(respondWithCalled).toBe(true);
    const resolved = await response;
    expect(resolved?.status).toBe(200);
    expect(await resolved?.text()).toBe(SHELL_BODY);
  });

  it('(b) a navigate whose network response is OK yields THAT response and refreshes the cached shell', async () => {
    const worker = makeWorker({
      cachedShell: html(SHELL_BODY),
      fetchImpl: () => Promise.resolve(html(FRESH_BODY)),
    });

    const { respondWithCalled, response } = worker.dispatch(navigate('/Campaigner/settings'));

    expect(respondWithCalled).toBe(true);
    expect(worker.fetchCalls).toEqual([`${ORIGIN}/Campaigner/settings`]);
    // Network-first, never cache-first: the fresh document is what is returned
    // even though a shell is already cached.
    expect(await (await response)?.text()).toBe(FRESH_BODY);

    await settle();
    const shell = worker.cache.get(cacheKey('./'));
    expect(shell).toBeDefined();
    expect(await shell?.text()).toBe(FRESH_BODY);
  });

  it('(c) a rejected fetch yields the cached shell; with none it yields a defined, honest response — never undefined', async () => {
    const withShell = makeWorker({
      cachedShell: html(SHELL_BODY),
      fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    const cached = withShell.dispatch(navigate('/Campaigner/settings'));
    expect(cached.respondWithCalled).toBe(true);
    expect(cached.thrown).toBeUndefined();
    expect(await (await cached.response)?.text()).toBe(SHELL_BODY);

    const noShell = makeWorker({
      fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    const offline = noShell.dispatch(navigate('/Campaigner/settings'));
    expect(offline.respondWithCalled).toBe(true);
    expect(offline.thrown).toBeUndefined();
    const resolved = await offline.response;
    expect(resolved).toBeInstanceOf(Response);
    expect(resolved?.ok).toBe(false);
    expect(resolved?.status).toBeGreaterThanOrEqual(500);
    expect(await resolved?.text()).toMatch(/offline/i);
  });

  it('(d) /assets/ stays cache-first and is cached on a miss; non-GET and cross-origin are left alone', async () => {
    const assetUrl = `${SCOPE}assets/index-abc123.js`;

    const hitWorker = makeWorker({
      fetchImpl: () => Promise.reject(new Error('fetch must not run on a cache hit')),
    });
    hitWorker.cache.set(cacheKey(assetUrl), new Response('cached asset'));
    const hit = hitWorker.dispatch(subresource(assetUrl));
    expect(hit.respondWithCalled).toBe(true);
    expect(await (await hit.response)?.text()).toBe('cached asset');
    await settle();
    expect(hitWorker.fetchCalls).toEqual([]);

    const missWorker = makeWorker({
      fetchImpl: () => Promise.resolve(new Response('fresh asset')),
    });
    const miss = missWorker.dispatch(subresource(assetUrl));
    expect(miss.respondWithCalled).toBe(true);
    expect(await (await miss.response)?.text()).toBe('fresh asset');
    await settle();
    expect(await missWorker.cache.get(cacheKey(assetUrl))?.text()).toBe('fresh asset');

    const untouched = makeWorker({
      fetchImpl: () => Promise.resolve(new Response('should not be reached')),
    });
    expect(untouched.dispatch(subresource(assetUrl, 'POST')).respondWithCalled).toBe(false);
    expect(untouched.dispatch(subresource('https://api.openrouter.ai/v1/chat')).respondWithCalled).toBe(false);
    expect(untouched.dispatch(subresource(`${ORIGIN}/elsewhere/app.js`)).respondWithCalled).toBe(false);
    expect(untouched.fetchCalls).toEqual([]);
  });

  it('(e) the scope guard matches the ABSOLUTE registration scope, so in-scope GETs are handled at all', async () => {
    const worker = makeWorker({
      fetchImpl: () => Promise.resolve(new Response('asset')),
    });

    const inside = worker.dispatch(subresource(`${SCOPE}assets/app.js`));
    expect(inside.respondWithCalled).toBe(true);

    const outside = worker.dispatch(subresource(`${ORIGIN}/elsewhere/app.js`));
    expect(outside.respondWithCalled).toBe(false);
    await inside.response;

    expect(worker.fetchCalls).toEqual([`${SCOPE}assets/app.js`]);
  });
});
