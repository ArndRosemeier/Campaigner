import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveSettings } from '@/db/settingsRepo';
import { embedQuery } from '@/search/embeddings';
import { clearDatabase } from '../db/helpers';

/**
 * Embedding requests must not be able to hang the pipeline forever: a fetch
 * that never receives response headers has to REJECT (the timeout surfaces
 * through tryEmbeddings as the keyword-only fallback + one toast) — a plain
 * fetch used to black-hole runEngine's retrieve/draft steps ("drafting…"
 * forever, 04-LLM-PERSONAS / 03-RETRIEVAL).
 */

const SETTINGS = {
  id: 'settings' as const,
  openRouterApiKey: 'test-key',
  defaultChatModel: 'anthropic/claude-sonnet-4.5',
  defaultReasoningEffort: 'default' as const,
  embeddingModel: 'openai/text-embedding-3-small',
  embeddingsEnabled: true,
  imageModel: 'google/gemini-2.5-flash-image',
  imagesEnabled: false,
  artifactScopes: {
    workspace: { global: false, campaign: true, module: true },
    moduleView: { global: true, campaign: true, module: true },
  },
  encounterMapAspect: '4:3' as const,
  encounterVerifyModel: '',
  retiredSessionNotesRemoved: 0,
  language: 'en' as const,
};

beforeEach(async () => {
  await clearDatabase();
  await saveSettings(SETTINGS);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('embeddings headers timeout', () => {
  it('rejects when response headers never arrive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal.addEventListener('abort', () => {
            const reason: unknown = init.signal.reason;
            reject(reason instanceof Error ? reason : new Error(String(reason)));
          });
        }),
      ),
    );
    vi.useFakeTimers();
    try {
      const pending = embedQuery('haunted keep');
      const assertion = expect(pending).rejects.toThrow(/timed out.*no response headers/iu);
      // The 60s headers timeout fires under simulated time.
      await vi.advanceTimersByTimeAsync(60_500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves normally when the embeddings endpoint answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2], index: 0 }] }), {
            status: 200,
          }),
        ),
      ),
    );

    const vector = await embedQuery('haunted keep');
    expect(vector[0]).toBeCloseTo(0.1);
    expect(vector[1]).toBeCloseTo(0.2);
  });
});
