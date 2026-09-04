import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_RETRY_AFTER_MS, fetchWithRetries, retryAfterMs } from '@/llm/openrouter';

/**
 * 429 retry hardening for parallel workers (parallelization feature): the
 * Retry-After hint (OpenRouter sends it when every attempted provider
 * returned a retry hint) overrides the backoff and is capped, and plain
 * backoffs carry ±25% jitter so concurrent retriers don't sync up.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('retryAfterMs', () => {
  it('parses seconds and HTTP-date forms, capped', () => {
    expect(retryAfterMs(new Response('', { status: 429, headers: { 'Retry-After': '5' } }))).toBe(5000);
    expect(
      retryAfterMs(new Response('', { status: 429, headers: { 'Retry-After': '120' } })),
    ).toBe(MAX_RETRY_AFTER_MS);
    const future = new Date(Date.now() + 10_000).toUTCString();
    const parsed = retryAfterMs(new Response('', { status: 429, headers: { 'Retry-After': future } }));
    expect(parsed).toBeGreaterThan(9_000);
    expect(parsed).toBeLessThanOrEqual(10_000);
    expect(retryAfterMs(new Response('', { status: 429 }))).toBeNull();
    expect(retryAfterMs(new Response('', { status: 429, headers: { 'Retry-After': 'soon' } }))).toBeNull();
  });
});

describe('fetchWithRetries retry timing', () => {
  it('honors Retry-After over the configured backoff', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'Retry-After': '5' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchWithRetries('https://x', {}, [0, 0]);
    // The hint (5s) replaced the zero backoff: nothing resolves before it.
    await vi.advanceTimersByTimeAsync(4_999);
    let done = false;
    void pending.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(2);
    await pending;
    expect(done).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caps an oversized Retry-After hint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'Retry-After': '600' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchWithRetries('https://x', {}, [0, 0]);
    let done = false;
    void pending.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(MAX_RETRY_AFTER_MS - 1);
    expect(done).toBe(false); // still waiting — capped at 30s, not 600
    await vi.advanceTimersByTimeAsync(2);
    await pending;
    expect(done).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('jitters plain backoffs within ±25% so parallel retriers desync', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('gateway timeout', { status: 502 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchWithRetries('https://x', {}, [1000, 0]);
    let done = false;
    void pending.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(700);
    expect(done).toBe(false); // below the 750ms floor — jitter applied
    await vi.advanceTimersByTimeAsync(600);
    await pending; // 1300ms total > the 1250ms ceiling
    expect(done).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
