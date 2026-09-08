import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import { createCampaign } from '@/db/campaignRepo';
import { createPersona } from '@/db/personaRepo';
import { getRun } from '@/db/runRepo';
import { runEngine } from '@/llm/runEngine';
import { MissingApiKeyError, OpenRouterError } from '@/llm/openrouterErrors';
import { clearDatabase } from '../db/helpers';

import type { Id, Persona } from '@/domain';
import type * as OpenRouterModule from '@/llm/openrouter';

/**
 * Failure-classification persistence (docs/05 run views): when the engine
 * marks a run failed, the row carries BOTH the raw errorMessage (verbatim —
 * the classification never replaces or truncates it) AND the failureKind
 * annotation. Resuming a run drops the stale classification.
 *
 * Unlike runEngine.test.ts, the openrouter mock keeps the REAL error classes
 * (importOriginal spread) so the pinned failures carry the structured kinds
 * `failureKindOf` reads.
 */

vi.mock('@/llm/openrouter', async (importOriginal) => {
  const actual = await importOriginal<typeof OpenRouterModule>();
  return { ...actual, chat: vi.fn(), listModels: vi.fn() };
});

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const VALID_DRAFT = {
  name: 'Grix',
  summary: 'A goblin alchemist boss.',
  suggestedTags: ['goblin', 'alchemist'],
  body: '# Grix\nShe brews. She throws.',
  appearance: 'Small, soot-stained, goggles.',
  personality: 'Manic, cheerful, volatile.',
  needsStatBlock: true,
};

const VALID_STATBLOCK = {
  system: 'dnd5e',
  level: '3',
  size: 'Small',
  creatureType: 'humanoid (goblinoid)',
  ac: 14,
  acNote: 'leather armor',
  hp: 22,
  hpFormula: '5d6 + 5',
  speed: '30 ft.',
  abilities: { str: 8, dex: 16, con: 13, int: 14, wis: 10, cha: 12 },
  saves: '',
  skills: '',
  senses: '',
  languages: 'Common, Goblin',
  traits: [],
  actions: [],
  reactions: [],
  legendary: [],
  extras: { CR: '1' },
};

async function seed(): Promise<{ campaignId: Id; persona: Persona }> {
  const campaign = await createCampaign({ name: 'Test Campaign', system: 'dnd5e' });
  const persona = await createPersona({
    slug: 'npc-smith-failure-kind',
    name: 'NPC Smith',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    producesKind: 'npc',
    builtIn: true,
  });
  return { campaignId: campaign.id, persona };
}

const INPUT = (campaignId: Id, persona: Persona, autonomy: 'manual' | 'auto' = 'manual') => ({
  campaign: {
    id: campaignId,
    name: 'Test Campaign',
    system: 'dnd5e' as const,
    description: '',
    coverImageId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  persona,
  autonomy,
  brief: 'a goblin alchemist boss for a level 3 party',
  pinnedChunkIds: [],
});

beforeEach(clearDatabase);
afterEach(() => {
  chatMock.mockReset();
  vi.restoreAllMocks();
});

describe('runEngine failure classification', () => {
  it('a congestion-class provider failure persists failureKind congestion next to the verbatim message', async () => {
    const { campaignId, persona } = await seed();
    chatMock.mockRejectedValueOnce(new OpenRouterError('http', 504, 'gateway timeout'));

    const runId = await runEngine.startRun(INPUT(campaignId, persona));

    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
    });
    const run = await getRun(runId);
    expect(run?.failureKind).toBe('congestion');
    // The message is the OpenRouterError's own text — untruncated, unedited.
    expect(run?.errorMessage).toBe('OpenRouter request failed (504): gateway timeout');
  }, 20000);

  it('a missing API key fails with the raw message and the unknown kind', async () => {
    const { campaignId, persona } = await seed();
    chatMock.mockRejectedValueOnce(new MissingApiKeyError());

    const runId = await runEngine.startRun(INPUT(campaignId, persona));

    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
    });
    const run = await getRun(runId);
    expect(run?.failureKind).toBe('unknown');
    expect(run?.errorMessage).toBe('No OpenRouter API key configured');
  }, 20000);

  it('an auto-autonomy rejected draft persists the invalid-output kind', async () => {
    const { campaignId, persona } = await seed();
    chatMock.mockResolvedValue({ text: 'still not json', modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaignId, persona, 'auto'));

    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
    });
    const run = await getRun(runId);
    expect(run?.failureKind).toBe('invalid-output');
    expect(run?.errorMessage).toContain('Step "draft" rejected');
  }, 20000);

  it('resuming a classified failed run clears the stale classification', async () => {
    const { campaignId, persona } = await seed();
    chatMock.mockRejectedValueOnce(new OpenRouterError('http', 503, 'provider overloaded'));

    const runId = await runEngine.startRun(INPUT(campaignId, persona, 'auto'));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
    });
    expect((await getRun(runId))?.failureKind).toBe('congestion');

    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });
    await runEngine.resumeRun(runId);

    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });
    const run = await getRun(runId);
    expect(run?.failureKind).toBeNull();
    expect(run?.errorMessage).toBe('');
  }, 30000);
});
