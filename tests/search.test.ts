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
    wikiGroundingEnabled: true,
    strictOutputs: true,
    imageModel: 'google/gemini-2.5-flash-image',
    imagesEnabled: false,
  fallbackChatModel: '',
  fallbackImageModel: '',
    artifactScopes: {
      workspace: { global: false, campaign: true, module: true },
      moduleView: { global: true, campaign: true, module: true },
    },
    encounterMapAspect: '4:3' as const,
    encounterPreset: 'standard' as const,
    dungeonMapPath: 'classic' as const,
  runExtras: { image: false, statBlock: false, mobPortraits: false },
    retiredSessionNotesRemoved: 0,
  deliverablesRemoved: 0,
    creatureCitationRepair: null,
    language: 'en' as const,
    onboarding: { status: 'fresh' as const, stepState: [] },
  lastModule: null,
  newModuleDraft: null,
  defaultPromptStyleId: 'classic',
  promptStyles: [],
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

describe('searchRules exact-heading promotion', () => {
  /**
   * Seeds the owner-observed "fireball" scenario: one literal "Fireball"
   * chunk plus several related chunks that merely mention the word (repeated
   * for term frequency, so MiniSearch alone can rank them ahead of it).
   */
  async function seedFireballBook(): Promise<{ bookId: Id; exact: RuleChunk }> {
    const bookId = await seedBook();
    const exact = await makeChunk(
      bookId,
      'A bright streak flashes from your pointing finger. This is the Fireball spell, a 3rd-level evocation.',
      { headingPath: ['Spells', 'Fireball'] },
    );
    const headings = [
      'Elemental Adept',
      'Sculpt Spells',
      'Fire Resistance',
      'Delayed Blast',
      'Flammable Objects',
    ];
    const related = await Promise.all(
      headings.map((heading, index) =>
        makeChunk(
          bookId,
          `${heading} lore: fireball fireball fireball fireball fireball relates to rule ${index}.`,
          { headingPath: ['Rules', heading] },
        ),
      ),
    );
    await putChunks([exact, ...related]);
    return { bookId, exact };
  }

  it('ranks the exact-heading chunk FIRST in keyword-only mode', async () => {
    const { bookId, exact } = await seedFireballBook();
    const { searchRules } = await import('@/search');

    const hits = await searchRules('fireball', { bookIds: [bookId] });

    expect(hits.length).toBeGreaterThan(1);
    expect(hits[0]?.chunk.id).toBe(exact.id);
    for (const hit of hits) {
      expect(hit.source).toBe('keyword');
    }
  });

  it('matches the last heading case-insensitively after trimming', async () => {
    const { bookId, exact } = await seedFireballBook();
    const { searchRules } = await import('@/search');

    const hits = await searchRules('  FIREBALL  ', { bookIds: [bookId] });

    expect(hits.length).toBeGreaterThan(1);
    expect(hits[0]?.chunk.id).toBe(exact.id);
  });

  it('ranks the exact-heading chunk FIRST in fused mode even when semantic demotes it', async () => {
    const { bookId, exact } = await seedFireballBook();
    await enableEmbeddings();
    // Hostile semantic ranking: every related mention aligns with the query
    // vector while the exact chunk is orthogonal, so fusion alone buries it.
    const vectorFor = (text: string): number[] => {
      if (text.includes('bright streak')) return [0, 1, 0, 0];
      if (text.toLowerCase().includes('fireball')) return [1, 0, 0, 0];
      return [0, 0, 1, 0];
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? '{}') as { input?: string[] };
        const inputs = body.input ?? [];
        return new Response(
          JSON.stringify({
            data: inputs.map((text, index) => ({ index, embedding: vectorFor(text) })),
          }),
          { status: 200 },
        );
      }),
    );
    const { searchRules } = await import('@/search');

    const hits = await searchRules('fireball', { bookIds: [bookId] });

    expect(hits.length).toBeGreaterThan(1);
    expect(hits[0]?.chunk.id).toBe(exact.id);
  });

  it('orders exact before starts-with before the rest', async () => {
    const bookId = await seedBook();
    const exact = await makeChunk(bookId, 'Open flame rules for campfires and torches.', {
      headingPath: ['Rules', 'Fire'],
    });
    const prefix = await makeChunk(
      bookId,
      'Fireball fireball fireball fireball fireball spell text.',
      { headingPath: ['Spells', 'Fireball'] },
    );
    const other = await makeChunk(
      bookId,
      'fire fire fire fire fire safety notes for the campsite.',
      { headingPath: ['Rules', 'Campfire Safety'] },
    );
    // Hostile insertion order: promotion, not recency, must decide.
    await putChunks([other, prefix, exact]);
    const { searchRules } = await import('@/search');

    const hits = await searchRules('fire', { bookIds: [bookId] });

    expect(hits.map((hit) => hit.chunk.id)).toEqual([exact.id, prefix.id, other.id]);
  });

  it('keeps existing relative order for ties within a tier (stable)', async () => {
    const bookId = await seedBook();
    const exactA = await makeChunk(bookId, 'Fireball spell details, first copy.', {
      headingPath: ['Spells', 'Fireball'],
    });
    const exactB = await makeChunk(
      bookId,
      'Fireball spell details, second copy with extra fireball fireball mentions.',
      { headingPath: ['Lore', 'Fireball'] },
    );
    const otherA = await makeChunk(
      bookId,
      'Sculpt Spells lore: fireball fireball fireball fireball.',
      { headingPath: ['Rules', 'Sculpt Spells'] },
    );
    const otherB = await makeChunk(bookId, 'A short fireball mention here.', {
      headingPath: ['Rules', 'Elemental Adept'],
    });
    await putChunks([otherA, exactA, otherB, exactB]);
    const { searchRules, searchKeyword } = await import('@/search');

    // The keyword ranking is the pre-promotion oracle for the keyword-only
    // path: scores derive monotonically from it, so each tier must preserve it.
    const keywordOrder = (await searchKeyword('fireball', { bookIds: [bookId] }, 100)).map(
      (hit) => hit.chunk.id,
    );
    const hits = await searchRules('fireball', { bookIds: [bookId] });

    const isExact = (hit: SearchHit): boolean =>
      hit.chunk.headingPath[hit.chunk.headingPath.length - 1]?.trim().toLowerCase() ===
      'fireball';
    const exactIds = hits.filter(isExact).map((hit) => hit.chunk.id);
    const restIds = hits.filter((hit) => !isExact(hit)).map((hit) => hit.chunk.id);
    expect(exactIds.length).toBe(2);
    expect(restIds.length).toBe(2);
    expect(exactIds).toEqual(keywordOrder.filter((id) => exactIds.includes(id)));
    expect(restIds).toEqual(keywordOrder.filter((id) => restIds.includes(id)));
    // And the exact tier as a whole still outranks the rest.
    expect(hits.map((hit) => hit.chunk.id)).toEqual([...exactIds, ...restIds]);
  });

  it('matches multi-word queries against the full last-heading string', async () => {
    const bookId = await seedBook();
    const exact = await makeChunk(
      bookId,
      'A beam of crackling energy streaks toward a creature. Details of the delayed blast fireball follow.',
      { headingPath: ['Spells', 'Delayed Blast Fireball'] },
    );
    const partial = await makeChunk(
      bookId,
      'delayed blast fireball delayed blast fireball related metamagic notes.',
      { headingPath: ['Rules', 'Delayed Blast'] },
    );
    await putChunks([partial, exact]);
    const { searchRules } = await import('@/search');

    const hits = await searchRules('delayed blast fireball', { bookIds: [bookId] });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.chunk.id).toBe(exact.id);
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
