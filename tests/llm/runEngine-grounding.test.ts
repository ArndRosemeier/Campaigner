import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import { createCampaign } from '@/db/campaignRepo';
import { createPersona } from '@/db/personaRepo';
import { createRulebook, updateRulebook } from '@/db/rulebookRepo';
import { putChunks } from '@/db/chunkRepo';
import { getRun } from '@/db/runRepo';
import { runEngine } from '@/llm/runEngine';
import { sha256Hex } from '@/lib/hash';
import type { Id, Persona, RuleChunk } from '@/domain';
import { newId, ruleChunkSchema } from '@/domain';
import { clearDatabase } from '../db/helpers';

/**
 * Grounding reuse (run pipeline): the draft and statblock steps consume the
 * retrieve step's PERSISTED chunk selection — the retrieval (search +
 * query embedding) runs exactly once per run, and the excerpts the model
 * sees are the ones the retrieve step selected, rendered identically
 * (valid-mobs roster/citation flow included).
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

vi.mock('@/search', () => ({
  searchRules: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { searchRules } = await import('@/search');
const searchMock = vi.mocked(searchRules);

const NOTE_DRAFT = {
  name: 'The Ember Ledger',
  summary: 'A smugglers\u2019 ledger.',
  suggestedTags: [],
  body: '# The Ember Ledger\nRecovered from the docks.',
};

async function chunkOf(bookId: Id, text: string, pageStart: number): Promise<RuleChunk> {
  return ruleChunkSchema.parse({
    id: newId(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    bookId,
    pageStart,
    pageEnd: pageStart,
    chunkType: 'section',
    headingPath: ['Chapter 9: Docks', 'Smuggling'],
    text,
    statBlock: null,
    contentHash: await sha256Hex(text),
  });
}

async function seedGrounding(): Promise<{ campaignId: Id; persona: Persona; chunk: RuleChunk; bookTitle: string }> {
  const campaign = await createCampaign({ name: 'Test Campaign', system: 'dnd5e' });
  const persona = await createPersona({
    slug: 'plot-architect-test',
    name: 'Plot Architect',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    producesKind: 'note',
    builtIn: true,
  });
  const bookTitle = 'Sails & Smoke';
  const book = await createRulebook({
    title: bookTitle,
    system: 'dnd5e',
    filename: 'sails-and-smoke.pdf',
  });
  await updateRulebook(book.id, { status: 'ready', pageCount: 10 });
  const chunk = await chunkOf(book.id, 'Emberwine crates move through the docks at midnight.', 3);
  await putChunks([chunk]);
  return { campaignId: campaign.id, persona, chunk, bookTitle };
}

const INPUT = (campaignId: Id, persona: Persona) => ({
  campaign: {
    id: campaignId,
    name: 'Test Campaign',
    system: 'dnd5e' as const,
    description: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  persona,
  autonomy: 'auto' as const,
  brief: 'a smugglers\u2019 note about the emberwine trade',
  pinnedChunkIds: [],
});

beforeEach(async () => {
  await clearDatabase();
  searchMock.mockReset();
  searchMock.mockResolvedValue([]);
  chatMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('retrieve grounding reuse', () => {
  it('searches once per run; the draft prompt grounds in the stored retrieve output', async () => {
    const { campaignId, persona, chunk, bookTitle } = await seedGrounding();
    searchMock.mockResolvedValue([{ chunk, score: 1, source: 'keyword' }]);
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(NOTE_DRAFT), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaignId, persona));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    // Exactly ONE retrieval pass: the retrieve step. The draft no longer
    // re-runs the search + query embedding.
    expect(searchMock).toHaveBeenCalledTimes(1);

    // The retrieve step stored the selection…
    const run = await getRun(runId);
    const retrieveStep = run?.steps.find((step) => step.name === 'retrieve');
    expect((retrieveStep?.output as { chunkIds?: Id[] }).chunkIds).toEqual([chunk.id]);

    // …and the draft prompt renders the SAME chunk as the excerpt, exactly
    // the way retrieveContext rendered it: `[title p.page] heading\ntext`.
    const draftCall = chatMock.mock.calls[0];
    const draftMessages = draftCall?.[0] ?? [];
    const userMessage = draftMessages
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .join('\n');
    expect(userMessage).toContain(`[${bookTitle} p.3] Chapter 9: Docks > Smuggling`);
    expect(userMessage).toContain('Emberwine crates move through the docks at midnight.');
  }, 20000);

  it('pinned chunks stay first and grounded (pinnedChunkIds flow through the stored output)', async () => {
    const { campaignId, persona, chunk, bookTitle } = await seedGrounding();
    const pinned = await chunkOf(chunk.bookId, 'Grappling rules pin the crackdown scene.', 7);
    await putChunks([chunk, pinned]);
    // The real retrieve step merges pinned chunks first, then search hits.
    searchMock.mockImplementation(() => Promise.resolve([{ chunk, score: 1, source: 'keyword' }]));
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(NOTE_DRAFT), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      ...INPUT(campaignId, persona),
      pinnedChunkIds: [pinned.id],
    });
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    const run = await getRun(runId);
    const retrieveStep = run?.steps.find((step) => step.name === 'retrieve');
    expect((retrieveStep?.output as { chunkIds?: Id[] }).chunkIds).toEqual([pinned.id, chunk.id]);

    const draftCall = chatMock.mock.calls[0];
    const userMessage = (draftCall?.[0] ?? [])
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .join('\n');
    // Pinned excerpt comes first — the draft sees the merged order.
    expect(userMessage.indexOf(`[${bookTitle} p.7]`)).toBeLessThan(userMessage.indexOf(`[${bookTitle} p.3]`));
    expect(userMessage).toContain('Grappling rules pin the crackdown scene.');
  }, 20000);
});
