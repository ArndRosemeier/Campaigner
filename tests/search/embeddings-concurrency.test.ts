import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveSettings } from '@/db/settingsRepo';
import { db } from '@/db/db';
import { createRulebook } from '@/db/rulebookRepo';
import { putChunks } from '@/db/chunkRepo';
import { clearDatabase } from '../db/helpers';
import { EMBED_CONCURRENCY, ensureEmbeddings } from '@/search/embeddings';
import { invalidateKeywordIndex } from '@/search/keywordIndex';
import type { RuleChunk } from '@/domain';
import { sha256Hex } from '@/lib/hash';
import { stampNewEntity } from '@/domain';

/**
 * The lazy semantic backfill used to embed whole books strictly sequentially
 * with up to ~100k tokens per request — the first search after enabling
 * embeddings stalled every run for minutes BEFORE the first LLM call, with no
 * user-visible activity. The pool now runs small requests concurrently; these
 * tests pin the concurrency bound, the request size bound, the cache, and the
 * progress reporting.
 */

async function makeChunk(bookId: string, text: string): Promise<RuleChunk> {
  return {
    ...stampNewEntity(),
    id: crypto.randomUUID(),
    bookId,
    pageStart: 1,
    pageEnd: 1,
    chunkType: 'section',
    headingPath: [],
    text,
    statBlock: null,
    contentHash: await sha256Hex(text),
  };
}

async function seedChunks(count: number): Promise<RuleChunk[]> {
  const book = await createRulebook({
    title: 'Book',
    system: 'dnd5e',
    filename: 'b.pdf',
    pageCount: 1,
  });
  await db.rulebooks.update(book.id, { status: 'ready' });
  const chunks: RuleChunk[] = [];
  for (let i = 0; i < count; i += 1) {
    chunks.push(await makeChunk(book.id, `chunk text ${String(i)} — unique words ${String(i * 7919)}`));
  }
  await putChunks(chunks);
  return chunks;
}

const SETTINGS = {
  id: 'settings' as const,
  openRouterApiKey: 'test-key',
  defaultChatModel: 'm',
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
  invalidateKeywordIndex();
  await saveSettings(SETTINGS);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ensureEmbeddings request pool', () => {
  it('runs small requests concurrently within the bound and caches every vector', async () => {
    const chunks = await seedChunks(50); // 4 batches of 16 (last one of 2)
    let inFlight = 0;
    let maxInFlight = 0;
    const requestInputSizes: number[] = [];
    const fetchMock = vi.fn(
      (_url: unknown, init?: { body?: string }) =>
        new Promise<Response>((resolve) => {
          const body = JSON.parse(init?.body ?? '{}') as { input?: string[] };
          const inputs = body.input ?? [];
          requestInputSizes.push(inputs.length);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          // Stay in flight until the pool saturates (4 workers) or settles.
          setTimeout(() => {
            inFlight -= 1;
            resolve(
              new Response(
                JSON.stringify({
                  data: inputs.map((_text, index) => ({
                    index,
                    embedding: [inputs.length, index, 0, 0],
                  })),
                }),
                { status: 200 },
              ),
            );
          }, 20);
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const vectors = await ensureEmbeddings(chunks);

    expect(maxInFlight).toBe(EMBED_CONCURRENCY); // saturated, never exceeded
    expect(requestInputSizes).toHaveLength(4);
    for (let i = 0; i < 3; i += 1) expect(requestInputSizes[i]).toBe(16);
    expect(requestInputSizes[3]).toBe(2);
    expect(vectors.size).toBe(50);
    // Every vector is cached under the model-scoped key.
    const rows = await db.embeddings.toArray();
    expect(rows).toHaveLength(50);

    // A second call is fully served from the cache: zero requests.
    fetchMock.mockClear();
    const again = await ensureEmbeddings(chunks);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(again.size).toBe(50);
  });

  it('reports progress through searchRules after every batch', async () => {
    await seedChunks(18); // 2 batches: 16 + 2
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? '{}') as { input?: string[] };
        const inputs = body.input ?? [];
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: inputs.map((_text, index) => ({ index, embedding: [0, 0, 0, 1] })),
            }),
            { status: 200 },
          ),
        );
      }),
    );
    const ticks: [number, number][] = [];
    const { searchRules } = await import('@/search');
    await searchRules('chunk text', { onEmbeddingProgress: (done, total) => {
      ticks.push([done, total]);
    } });
    // Query embedding + 2 backfill batches; only the backfill ticks.
    expect(ticks).toEqual([
      [16, 18],
      [18, 18],
    ]);
  });
});
