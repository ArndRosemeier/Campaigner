import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IMAGE_HEADERS_TIMEOUT_MS, generateImages } from '@/llm/imageGen';
import { defaultSettings } from '@/domain';

/**
 * Image headers timeout (M4-C): the image API is not streaming — it sends no
 * response headers until the picture is fully rendered — so the shared 60s
 * chat headers timeout aborted most generations. Images get 5 minutes.
 */

vi.mock('@/db/settingsRepo', () => ({
  getSettings: vi.fn(() =>
    Promise.resolve({
      ...defaultSettings(),
      openRouterApiKey: 'test-key',
      imageModel: 'test-image-model',
    }),
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('image generation timeout', () => {
  it('budgets 5 minutes for the image request', () => {
    expect(IMAGE_HEADERS_TIMEOUT_MS).toBe(300_000);
  });

  it('does not abort before the budget elapses, then aborts loudly', async () => {
    vi.useFakeTimers();
    // A fetch that never resolves on its own; the abort must be what ends it.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const reason = init.signal?.reason as Error | undefined;
              if (reason !== undefined) reject(reason);
              else reject(new Error('aborted'));
            });
          }),
      ),
    );

    const pending = generateImages('a painting of a tower', 1, { model: 'test-image-model' });
    const expectation = expect(pending).rejects.toThrow();

    // Just before the budget: still waiting (no abort fired).
    await vi.advanceTimersByTimeAsync(IMAGE_HEADERS_TIMEOUT_MS - 1_000);
    // Crossing the budget aborts the request with the loud timeout message.
    await vi.advanceTimersByTimeAsync(1_001);
    await expectation;
    await expect(pending).rejects.toThrow('timed out');
  });
});
