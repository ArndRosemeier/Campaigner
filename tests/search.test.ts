import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRulebook, createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { putChunks } from '@/db/chunkRepo';
import { saveSettings } from '@/db/settingsRepo';
import { stampNewEntity } from '@/domain/entity';
import { sha256Hex } from '@/lib/hash';
import { invalidateKeywordIndex } from '@/search';
import { resetEmbeddingFailureNotice } from '@/search/embeddings';
import { db } from '@/db/db';
import { clearDatabase } from './db/helpers';

import type { Id, RuleChunk, StatBlock } from '@/domain';
import { statBlockSchema } from '@/domain';
import type { SearchHit } from '@/search/search';

/**
 * Hybrid retrieval tests (03-RETRIEVAL.md acceptance criteria): keyword-only
 * path with no key, RRF fusion with mocked embeddings, and silent fallback on
 * embedding failure. fix-02 adds the `hasStatBlock` citable-pool filter
 * (decision 3): unparsed chunks never enter the citable pool and never
 * consume a result slot.
 */

function validStatBlock(system: 'dnd5e' | 'pathfinder2e' = 'dnd5e'): StatBlock {
  return statBlockSchema.parse({
    system,
    level: '1',
    size: 'Small',
    creatureType: 'humanoid',
    ac: 12,
    hp: 7,
    speed: '30 ft.',
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    extras: {},
  });
}

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
    maxParallelRequests: 2,
    openRouterApiKey: 'test-key',
    defaultChatModel: 'm',
    defaultReasoningEffort: 'default' as const,
    embeddingModel: 'openai/text-embedding-3-small',
    embeddingsEnabled: true,
    imageModel: 'google/gemini-2.5-flash-image',
    imagesEnabled: false,
  fallbackChatModel: '',
  fallbackImageModel: '',
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

describe('searchRules hasStatBlock citable pool (fix-02 decision 3)', () => {
  it('never returns an unparsed statblock chunk when hasStatBlock is set', async () => {
    const bookId = await seedBook();
    await putChunks([
      // A 'statblock' chunk whose best-effort parse gave up (statBlock null).
      await makeChunk(bookId, 'Goblin king lore without stats.', {
        chunkType: 'statblock',
        headingPath: ['Goblin King'],
      }),
      await makeChunk(bookId, 'Goblin warrior stats.', {
        chunkType: 'statblock',
        headingPath: ['Goblin'],
        statBlock: validStatBlock(),
      }),
    ]);
    const { searchRules } = await import('@/search');

    const hits = await searchRules('goblin', { bookIds: [bookId], hasStatBlock: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.chunk.headingPath[0]).toBe('Goblin');
    // Without the filter the unparsed chunk is still searchable (other
    // surfaces rely on full-text search).
    const unfiltered = await searchRules('goblin', { bookIds: [bookId] });
    expect(unfiltered).toHaveLength(2);
  });

  it('does not let an unparsed chunk consume a limit slot', async () => {
    const bookId = await seedBook();
    await putChunks([
      // The unparsed chunk outranks the valid one on term frequency — under
      // a post-slice filter it would take the single slot and hide the
      // citable chunk entirely.
      await makeChunk(bookId, 'Troll troll troll regenerates.', {
        chunkType: 'statblock',
        headingPath: ['Troll Hollow'],
      }),
      await makeChunk(bookId, 'Troll stats.', {
        chunkType: 'statblock',
        headingPath: ['Troll'],
        statBlock: validStatBlock(),
      }),
    ]);
    const { searchRules } = await import('@/search');

    const hits = await searchRules('troll', { bookIds: [bookId], hasStatBlock: true, limit: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.chunk.headingPath[0]).toBe('Troll');
  });

  it('excludes unparsed chunks from the semantic candidate set (hybrid path)', async () => {
    const bookId = await seedBook();
    const parsed = await makeChunk(bookId, 'Ogre stats with real numbers.', {
      chunkType: 'statblock',
      headingPath: ['Ogre'],
      statBlock: validStatBlock(),
    });
    await putChunks([
      parsed,
      await makeChunk(bookId, 'Ogre hill lore, parse gave up.', {
        chunkType: 'statblock',
        headingPath: ['Ogre Hill'],
      }),
    ]);
    await enableEmbeddings();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? '{}') as { input?: string[] };
        const inputs = body.input ?? [];
        return new Response(
          JSON.stringify({
            data: inputs.map((text, index) => ({
              index,
              embedding: text.includes('Ogre') ? [1, 0, 0, 0] : [0, 0, 0, 0],
            })),
          }),
          { status: 200 },
        );
      }),
    );
    const { searchRules } = await import('@/search');

    const hits = await searchRules('ogre', { bookIds: [bookId], hasStatBlock: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.chunk.id).toBe(parsed.id);
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

describe('searchRules system filter (campaign-scoped citable pool)', () => {
  it('never lists a chunk of another game system when `system` is set — pack books included', async () => {
    const dnd5eBook = await seedBook();
    const pf2eBook = await seedPackBook();
    await putChunks([
      await makeChunk(dnd5eBook, 'Hill Giant stats.', {
        chunkType: 'statblock',
        headingPath: ['Hill Giant'],
        statBlock: validStatBlock(),
      }),
      await makeChunk(pf2eBook, 'Kobold Warrior stats.', {
        chunkType: 'statblock',
        headingPath: ['Kobold Warrior'],
        statBlock: validStatBlock('pathfinder2e'),
      }),
    ]);
    const { searchRules } = await import('@/search');

    // A dnd5e campaign never sees the pf2e pack creature…
    const dnd5e = await searchRules('stats', { hasStatBlock: true, system: 'dnd5e' });
    expect(dnd5e.map((hit) => hit.chunk.headingPath[0])).toEqual(['Hill Giant']);
    // …and a pf2e campaign never sees the dnd5e one (vice versa).
    const pf2e = await searchRules('stats', { hasStatBlock: true, system: 'pathfinder2e' });
    expect(pf2e.map((hit) => hit.chunk.headingPath[0])).toEqual(['Kobold Warrior']);
  });

  it('keeps same-system behavior unchanged and cross-system browsing without `system`', async () => {
    const dnd5eBook = await seedBook();
    const pf2eBook = await seedPackBook();
    const giant = await makeChunk(dnd5eBook, 'Hill Giant stats.', {
      chunkType: 'statblock',
      headingPath: ['Hill Giant'],
      statBlock: validStatBlock(),
    });
    const kobold = await makeChunk(pf2eBook, 'Kobold Warrior stats.', {
      chunkType: 'statblock',
      headingPath: ['Kobold Warrior'],
      statBlock: validStatBlock('pathfinder2e'),
    });
    await putChunks([giant, kobold]);
    const { searchRules } = await import('@/search');

    // Same-system search behaves exactly as before the filter existed.
    const sameSystem = await searchRules('stats', { system: 'dnd5e' });
    expect(sameSystem.map((hit) => hit.chunk.id)).toEqual([giant.id]);
    // No system (the global Rules browser) stays cross-system on purpose.
    const allSystems = await searchRules('stats');
    expect(new Set(allSystems.map((hit) => hit.chunk.id))).toEqual(new Set([giant.id, kobold.id]));
    // Explicit bookIds still win over the system filter.
    const explicit = await searchRules('stats', { bookIds: [kobold.bookId], system: 'dnd5e' });
    expect(explicit.map((hit) => hit.chunk.id)).toEqual([kobold.id]);
  });
});

/** Seeds a ready pathfinder2e pack book (12-BESTIARY-PACKS) for the system filter. */
async function seedPackBook(): Promise<Id> {
  const book = await createPackBook({
    title: 'PF2e Monster Core',
    system: 'pathfinder2e',
    filename: 'pf2e.zip',
  });
  await finalizePackBook(book.id, {
    sourceId: 'foundry-pf2e',
    license: 'Community Use Policy',
    entriesImported: 1,
    entriesSkipped: 0,
    entriesFailed: 0,
  });
  return book.id;
}
