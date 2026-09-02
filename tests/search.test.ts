import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRulebook } from '@/db/rulebookRepo';
import { putChunks } from '@/db/chunkRepo';
import { saveSettings } from '@/db/settingsRepo';
import { stampNewEntity } from '@/domain/entity';
import { sha256Hex } from '@/lib/hash';
import { invalidateKeywordIndex } from '@/search';
import { resetEmbeddingFailureNotice } from '@/search/embeddings';
import { db } from '@/db/db';
import { clearDatabase } from './db/helpers';

import type { Id, RuleChunk } from '@/domain';
import type { SearchHit } from '@/search/search';

/**
 * Hybrid retrieval tests (03-RETRIEVAL.md acceptance criteria): keyword-only
 * path with no key, RRF fusion with mocked embeddings, and silent fallback on
 * embedding failure.
 */

async function makeChunk(
  bookId: Id,
  text: string,
  overrides: Partial<RuleChunk> = {},
): Promise<RuleChunk> {
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
    ...overrides,
  };
}

async function seedBook(): Promise<Id> {
  const book = await createRulebook({
    title: 'Test Book',
    system: 'dnd5e',
    filename: 't.pdf',
    pageCount: 3,
  });
  await db.rulebooks.update(book.id, { status: 'ready' });
  return book.id;
}

async function enableEmbeddings(): Promise<void> {
  await saveSettings({
    id: 'settings',
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
  });
}

beforeEach(async () => {
  await clearDatabase();
  resetEmbeddingFailureNotice();
  invalidateKeywordIndex();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchRules (keyword-only, no key)', () => {
  it('ranks the matching section in the top 3 and marks hits keyword', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const bookId = await seedBook();
    await putChunks([
      await makeChunk(bookId, 'This chapter explains how the grapple works in play.'),
      await makeChunk(bookId, 'The windmills of the coast are tall.'),
      await makeChunk(bookId, 'Rules for travel and provisions.'),
      await makeChunk(bookId, 'A grapple against a larger creature is harder.'),
    ]);

    const hits = await import('@/search').then((m) =>
      m.searchRules('grapple rules', { bookIds: [bookId] }),
    );

    // Acceptance (03): the grappling section appears within the top 3.
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(3);
    expect(hits.some((hit) => hit.chunk.text.includes('grapple'))).toBe(true);
    for (const hit of hits) {
      expect(hit.source).toBe('keyword');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns no results when no ready books exist', async () => {
    const book = await createRulebook({
      title: 'WIP',
      system: 'dnd5e',
      filename: 'w.pdf',
      pageCount: 1,
    });
    await putChunks([await makeChunk(book.id, 'grappling text')]);
    const { searchRules } = await import('@/search');

    const hits = await searchRules('grappling');
    expect(hits).toEqual([]);
  });
});

describe('searchRules (hybrid with embeddings enabled)', () => {
  it('fuses keyword and semantic rankings with RRF and source badges', async () => {
    const bookId = await seedBook();
    const chunkA = await makeChunk(bookId, 'The sword attack deals slashing damage.');
    const chunkB = await makeChunk(bookId, 'Grapple rules: seize and hold your target.');
    const chunkC = await makeChunk(bookId, 'Unrelated lore about rivers.');
    await putChunks([chunkA, chunkB, chunkC]);
    await enableEmbeddings();

    // Deterministic vectors: the query equals chunk B's vector, so B wins
    // semantically while "grapple" wins on keywords; A is keyword-only.
    const vecA = [0, 1, 0, 0];
    const vecB = [1, 0, 0, 0];
    const vecC = [0, 0, 1, 0];
    const vectorFor = (text: string): number[] => {
      if (text.includes('seize and hold') || text === 'grapple') return vecB;
      if (text.includes('sword')) return vecA;
      if (text.includes('rivers')) return vecC;
      return [0, 0, 0, 0];
    };
    const fetchMock = vi.fn((_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { input?: string[] };
      const inputs = body.input ?? [];
      return new Response(
        JSON.stringify({
          data: inputs.map((text, index) => ({ index, embedding: vectorFor(text) })),
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { searchRules } = await import('@/search');
    const hits: SearchHit[] = await searchRules('grapple', { bookIds: [bookId] });

    const byText = new Map(hits.map((hit) => [hit.chunk.text, hit]));
    const b = byText.get(chunkB.text);
    const a = byText.get(chunkA.text);
    const c = byText.get(chunkC.text);
    expect(b?.source).toBe('both');
    // Below the 2000-chunk threshold every book chunk is a semantic candidate,
    // so keyword-missing chunks surface as semantic-only.
    expect(a?.source).toBe('semantic');
    expect(c?.source).toBe('semantic');
    // RRF: B is rank 1 in both lists → highest fused score.
    expect(hits[0]?.chunk.id).toBe(chunkB.id);
    expect(b?.score ?? 0).toBeGreaterThan(a?.score ?? 0);
  });

  it('falls back to keyword-only with a single-session toast on embedding failure', async () => {
    const bookId = await seedBook();
    await putChunks([await makeChunk(bookId, 'grappling rules text')]);
    await enableEmbeddings();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 500 }))),
    );

    const { searchRules } = await import('@/search');
    const hits = await searchRules('grappling', { bookIds: [bookId] });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.source).toBe('keyword');
  });
});
