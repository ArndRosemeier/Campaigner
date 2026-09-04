import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import type { Persona } from '@/domain';
import { createPersona } from '@/db/personaRepo';
import {
  createArtifact,
  getArtifact,
  listArtifactsByCampaign,
  publishToLibrary,
} from '@/db/artifactRepo';
import { updateSettings } from '@/db/settingsRepo';
import { getRun, listRunsByCampaign } from '@/db/runRepo';
import { runEngine } from '@/llm/runEngine';
import { BUILT_IN_PERSONAS } from '@/llm/personas/builtins';
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
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

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
      expect(artifact.data.personality).toBe('Manic, cheerful, volatile.');
    }
    expect(chatMock).toHaveBeenCalledTimes(2);
  }, 20000);

  it('retries invalid JSON once automatically, then succeeds', async () => {
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: 'this is not json at all', modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

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
    chatMock.mockResolvedValue({ text: 'still not json', modelUsed: 'test-model', fallback: null });

    const input = { ...INPUT(campaignId, persona), autonomy: 'review' as const };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('needs_review');
    });

    const run = await getRun(runId);
    expect(run?.steps[1]?.status).toBe('rejected');
    expect(chatMock).toHaveBeenCalledTimes(2);

    // The designed rescue path: the user EDITS the rejected draft step to
    // valid JSON (approve-without-edit now fails loudly in finalize — it
    // used to create an artifact named after the persona with empty data).
    chatMock.mockResolvedValue({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });
    await runEngine.editStep(runId, 1, { parsed: VALID_DRAFT }, input);
    await waitFor(async () => {
      const run2 = await getRun(runId);
      expect(run2?.status).toBe('completed');
    });
    const run2 = await getRun(runId);
    expect(run2?.resultArtifactId).not.toBeNull();
  }, 20000);

  it('auto mode with a never-parsing draft fails the run instead of saving an empty artifact', async () => {
    const { campaignId, persona } = await seed();
    chatMock.mockResolvedValue({ text: 'still not json', modelUsed: 'test-model', fallback: null });

    const input = { ...INPUT(campaignId, persona), autonomy: 'auto' as const };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
    });

    const run = await getRun(runId);
    expect(run?.errorMessage).toContain('Step "draft" rejected');
    expect(run?.steps[1]?.status).toBe('rejected');
    // Regression: this used to fall through to finalize and create an
    // artifact named after the persona ("NPC Smith") with empty content.
    expect(await listArtifactsByCampaign(campaignId)).toHaveLength(0);
    expect(chatMock).toHaveBeenCalledTimes(2); // one automatic JSON-fix retry
  }, 20000);

  it('auto NPC with a garbage statblock reply fails the run instead of dropping it silently', async () => {
    // Regression for the silent fallback: a rejected statblock step used to
    // be skipped and the NPC finalized WITHOUT its stat block.
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValue({ text: 'this is not a statblock', modelUsed: 'test-model', fallback: null });

    const input = { ...INPUT(campaignId, persona), autonomy: 'auto' as const };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
    });

    const run = await getRun(runId);
    expect(run?.errorMessage).toContain('Step "statblock" rejected');
    expect(await listArtifactsByCampaign(campaignId)).toHaveLength(0);
  }, 20000);

  it('reviews a global target with scope-gated global context and a campaign-anchored run', async () => {
    const editor = BUILT_IN_PERSONAS.find((persona) => persona.slug === 'continuity-editor');
    if (editor === undefined) throw new Error('continuity-editor persona missing');
    const campaign = await createCampaign({ name: 'Global Review', system: 'dnd5e' });
    const target = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Library Target',
      body: 'The target body.',
    });
    const context = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Library Context',
      body: 'The context body.',
    });
    await publishToLibrary(target.id);
    await publishToLibrary(context.id);
    await updateSettings({
      artifactScopes: {
        workspace: { global: true, campaign: true, module: true },
        moduleView: { global: true, campaign: true, module: true },
      },
    });
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({ verdict: 'consistent', summary: 'All consistent.', issues: [] }), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      campaign,
      persona: editor,
      autonomy: 'auto',
      brief: 'review the library target',
      pinnedChunkIds: [],
      targetArtifactId: target.id,
    });
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const run = await getRun(runId);
    expect(run?.campaignId).toBe(campaign.id);
    expect(JSON.stringify(chatMock.mock.calls[0])).toContain('Library Target');
    expect(JSON.stringify(chatMock.mock.calls[0])).toContain('Library Context');
    const report = (await listArtifactsByCampaign(campaign.id))[0];
    expect(report?.kind).toBe('note');
    expect(report?.links[0]?.targetId).toBe(target.id);
  });

  it('review finalize refuses placeholder output when step edits are garbage', async () => {
    // Editing the check step to garbage and approving used to produce a
    // 'no structured report' placeholder note naming an 'unknown artifact'.
    const editor = BUILT_IN_PERSONAS.find((persona) => persona.slug === 'continuity-editor');
    if (editor === undefined) throw new Error('continuity-editor persona missing');
    const fresh = await createCampaign({ name: 'Review Campaign', system: 'dnd5e' });
    const arc = await createArtifact({
      campaignId: fresh.id,
      kind: 'plotarc',
      name: 'The Drowned Bell',
      body: '# Arc',
    });

    const input = {
      campaign: fresh,
      persona: editor,
      autonomy: 'review' as const,
      brief: 'review the arc',
      pinnedChunkIds: [],
      targetArtifactId: arc.id,
    };
    chatMock.mockResolvedValue({ text: 'still not json', modelUsed: 'test-model', fallback: null });
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('needs_review');
    });

    // The user "edits" the check step to garbage and approves anyway.
    await runEngine.editStep(runId, 1, {}, input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
    });

    const run = await getRun(runId);
    expect(run?.errorMessage).toContain('no continuity report');
    // No placeholder report note was created.
    const artifacts = await listArtifactsByCampaign(fresh.id);
    expect(artifacts).toHaveLength(1); // just the target arc
  }, 20000);

  it('tolerates loose draft shapes (string list items, single-string tags)', async () => {
    const { campaignId } = await seed();
    const persona2 = await createPersona({
      slug: 'worldbuilder-test',
      name: 'Worldbuilder',
      description: 'test',
      systemPrompt: 'You are a test persona. Reply with JSON only.',
      producesKind: 'location',
      builtIn: true,
    });
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({
        name: 'Drowned Docks',
        summary: 'Flooded piers.',
        suggestedTags: 'harbour',
        body: '# Docks',
        locationType: 'district',
        inhabitants: 'Fishers',
        pointsOfInterest: ['Sunken bell tower', { name: 'Fish market', description: 'Stalls.' }],
        hooks: [{ title: 'Missing diver' }],
      }), modelUsed: 'test-model', fallback: null });

    const input = {
      ...INPUT(campaignId, persona2),
      brief: 'create a location',
      autonomy: 'auto' as const,
    };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });

    const run = await getRun(runId);
    const artifact = await getArtifact(run?.resultArtifactId ?? '');
    expect(artifact?.name).toBe('Drowned Docks');
    expect(artifact?.tags).toEqual(['harbour']);
    const data = artifact?.data as {
      pointsOfInterest?: { name: string; description: string }[];
      hooks?: string[];
    };
    expect(data.pointsOfInterest).toEqual([
      { name: 'Sunken bell tower', description: '' },
      { name: 'Fish market', description: 'Stalls.' },
    ]);
    expect(data.hooks).toEqual(['Missing diver']);
  }, 20000);

  it('auto mode runs to completion without pausing', async () => {
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

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
    chatMock.mockResolvedValue({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null });

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

  it('resumeRun resumes a failed run from the failed step, preserving prior completed steps', async () => {
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockRejectedValueOnce(new Error('Model timeout 504'));

    const input = { ...INPUT(campaignId, persona), autonomy: 'auto' as const };
    const runId = await runEngine.startRun(input);

    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
      expect(run?.errorMessage).toContain('Model timeout 504');
    });

    const failedRun = await getRun(runId);
    expect(failedRun?.steps[0]?.status).toBe('done'); // retrieve
    expect(failedRun?.steps[1]?.status).toBe('done'); // draft
    expect(failedRun?.steps[1]?.output).not.toBeNull();

    // Now model recovers: resume the run
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });
    await runEngine.resumeRun(runId);

    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });

    const completedRun = await getRun(runId);
    expect(completedRun?.resultArtifactId).not.toBeNull();
    const artifact = await getArtifact(completedRun?.resultArtifactId ?? '');
    expect(artifact?.name).toBe('Grix');
    // Chat was called 3 times total: draft (initial), statblock (failed), statblock (recovered retry).
    // Draft was NOT re-executed!
    expect(chatMock).toHaveBeenCalledTimes(3);
  }, 20000);

  it('passes persona reasoningEffort to chat calls and falls back to settings', async () => {
    const { campaignId, persona } = await seed();
    const customPersona: Persona = {
      ...persona,
      model: 'openai/o3-mini',
      reasoningEffort: 'high',
    };

    chatMock.mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaignId, customPersona));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.steps[1]?.status).toBe('done');
    });

    expect(chatMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        model: 'openai/o3-mini',
        reasoningEffort: 'high',
      }),
    );
  });
});
