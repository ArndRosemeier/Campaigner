import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { createPersona, type Persona } from '@/domain';
import { getArtifact } from '@/db/artifactRepo';
import { getRun, listRunsByCampaign } from '@/db/runRepo';
import { runEngine } from '@/llm/runEngine';
import { waitFor } from '@testing-library/react';
import { clearDatabase } from '../db/helpers';

import type { Id } from '@/domain';

/**
 * Run engine (04-LLM-PERSONAS.md) with a mocked chat: happy manual path,
 * invalid-JSON retry, needs_review, auto mode, cancel.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {
    constructor() {
      super('No OpenRouter API key configured');
      this.name = 'MissingApiKeyError';
    }
  },
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const VALID_DRAFT = {
  name: 'Grix',
  summary: 'A goblin alchemist boss.',
  suggestedTags: ['goblin', 'alchemist'],
  body: '# Grix\nShe brews. She throws.',
  role: 'Boss',
  appearance: 'Small, soot-stained, goggles.',
  personality: 'Manic, cheerful, volatile.',
  motivation: 'Prove her elixirs work.',
  secrets: 'She is out of the good reagents.',
  voiceNotes: 'Fast, cackling.',
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
  const persona = createPersona({
    slug: 'npc-smith-test',
    name: 'NPC Smith',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    producesKind: 'npc',
    builtIn: true,
  });
  return { campaignId: campaign.id, persona };
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
  autonomy: 'manual' as const,
  brief: 'a goblin alchemist boss for a level 3 party',
  pinnedChunkIds: [],
});

beforeEach(clearDatabase);
afterEach(() => {
  chatMock.mockReset();
  vi.restoreAllMocks();
});

describe('runEngine', () => {
  it('manual happy path: pauses after each step and completes on approval', async () => {
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce(JSON.stringify(VALID_DRAFT))
      .mockResolvedValueOnce(JSON.stringify(VALID_STATBLOCK));

    const runId = await runEngine.startRun(INPUT(campaignId, persona));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
    });

    let run = await getRun(runId);
    expect(run?.steps.map((step) => step.name)).toEqual(['retrieve', 'draft']);
    expect(run?.steps[0]?.status).toBe('done');
    expect(run?.steps[1]?.status).toBe('done');

    await runEngine.approve(runId, INPUT(campaignId, persona));
    await waitFor(async () => {
      run = await getRun(runId);
      expect(run?.steps).toHaveLength(3);
      expect(run?.status).toBe('awaiting_user');
    });
    expect(run?.steps[2]?.name).toBe('statblock');

    await runEngine.approve(runId, INPUT(campaignId, persona));
    await waitFor(async () => {
      run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });
    expect(run?.resultArtifactId).not.toBeNull();
    const resultId = run?.resultArtifactId;
    if (resultId === null || resultId === undefined) throw new Error('run has no result artifact');

    const artifact = await getArtifact(resultId);
    expect(artifact?.kind).toBe('npc');
    expect(artifact?.name).toBe('Grix');
    if (artifact?.kind === 'npc') {
      expect(artifact.data.statBlock?.hp).toBe(22);
      expect(artifact.data.role).toBe('Boss');
    }
    expect(chatMock).toHaveBeenCalledTimes(2);
  }, 20000);

  it('retries invalid JSON once automatically, then succeeds', async () => {
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce('this is not json at all')
      .mockResolvedValueOnce(JSON.stringify(VALID_DRAFT))
      .mockResolvedValueOnce(JSON.stringify(VALID_STATBLOCK));

    const runId = await runEngine.startRun(INPUT(campaignId, persona));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
    });

    const run = await getRun(runId);
    expect(run?.steps[1]?.status).toBe('done');
    expect(chatMock).toHaveBeenCalledTimes(2);
  }, 20000);

  it('marks the step needs_review after a second JSON failure (review autonomy)', async () => {
    const { campaignId, persona } = await seed();
    chatMock.mockResolvedValue('still not json');

    const input = { ...INPUT(campaignId, persona), autonomy: 'review' as const };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('needs_review');
    });

    const run = await getRun(runId);
    expect(run?.steps[1]?.status).toBe('rejected');
    expect(chatMock).toHaveBeenCalledTimes(2);

    // Approving continues: finalize runs with an empty draft.
    chatMock.mockResolvedValue(JSON.stringify(VALID_STATBLOCK));
    await runEngine.approve(runId, input);
    await waitFor(async () => {
      const run2 = await getRun(runId);
      expect(run2?.status).toBe('completed');
    });
  }, 20000);

  it('auto mode runs to completion without pausing', async () => {
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce(JSON.stringify(VALID_DRAFT))
      .mockResolvedValueOnce(JSON.stringify(VALID_STATBLOCK));

    const input = { ...INPUT(campaignId, persona), autonomy: 'auto' as const };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });
    expect(chatMock).toHaveBeenCalledTimes(2);
    const runs = await listRunsByCampaign(campaignId);
    expect(runs[0]?.resultArtifactId).not.toBeNull();
  }, 20000);

  it('cancel stops the run and no artifact is created', async () => {
    const { campaignId, persona } = await seed();
    chatMock.mockResolvedValue(JSON.stringify(VALID_DRAFT));

    const runId = await runEngine.startRun(INPUT(campaignId, persona));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
    });

    await runEngine.cancel(runId);
    const run = await getRun(runId);
    expect(run?.status).toBe('cancelled');
    expect(run?.resultArtifactId).toBeNull();
  }, 20000);
});
