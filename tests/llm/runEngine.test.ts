import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { createModule as createModuleSchema, type Persona } from '@/domain';
import { createPersona } from '@/db/personaRepo';
import {
  createArtifact,
  getArtifact,
  listArtifactsByCampaign,
  publishToLibrary,
} from '@/db/artifactRepo';
import { updateSettings } from '@/db/settingsRepo';
import { getRun, listRunsByCampaign } from '@/db/runRepo';
import { createModule as createModuleRow, deleteModule } from '@/db/moduleRepo';
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


const VALID_ENCOUNTER_DRAFT = {
  name: 'Goblin Ambush at the Ford',
  summary: 'A goblin war band contests a river crossing.',
  suggestedTags: ['goblins', 'ambush'],
  body: '# Ambush at the ford',
  difficulty: 'easy',
  levelHint: '1-2',
  monsters: [
    {
      name: 'Goblin bully',
      count: 2,
      notes: 'lunges from the reeds',
      treasure: 'a pouch of teeth',
      statBlock: VALID_STATBLOCK,
    },
  ],
  terrain: 'shallow river ford',
  tactics: 'ambush from the reeds',
  treasure: 'none',
  locationKind: 'wilderness',
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

  it('escalates the contract-repair attempt to the fallback model and records it', async () => {
    const { campaignId, persona } = await seed();
    await updateSettings({ fallbackChatModel: 'potent/fallback' });
    const primary = 'anthropic/claude-sonnet-4.5'; // the seeded settings' default chat model
    chatMock
      .mockResolvedValueOnce({ text: 'this is not json at all', modelUsed: primary, fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'potent/fallback', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaignId, persona));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
    });

    // The repair attempt (the second call) went to the escalation tier.
    const models = chatMock.mock.calls.map(([, opts]) => (opts as { model: string }).model);
    expect(models).toEqual([primary, 'potent/fallback']);

    const run = await getRun(runId);
    const draft = run?.steps.find((step) => step.name === 'draft');
    expect((draft?.output as { notice?: string }).notice).toBe(
      `The reply contract failed on “${primary}” — the repair attempt ran on “potent/fallback”.`,
    );
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

  it('creates a module-placed artifact when the run carries placementModuleId', async () => {
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

    // A REAL module row — finalize re-checks existence loudly (AGENTS rule 1).
    const module = await createModuleRow(
      createModuleSchema({
        campaignId,
        title: 'Ember Crypt',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'sketch',
      }),
    );
    const input = { ...INPUT(campaignId, persona), autonomy: 'auto' as const, placementModuleId: module.id };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });

    const run = await getRun(runId);
    expect(run?.placementModuleId).toBe(module.id);
    const resultId = run?.resultArtifactId;
    if (resultId === null || resultId === undefined) throw new Error('run has no result artifact');
    const artifact = await getArtifact(resultId);
    expect(artifact?.moduleId).toBe(module.id);
  }, 20000);

  it('a targeted in-place run with placement set fails loudly (placement is fresh-create only)', async () => {
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null })
      .mockResolvedValue({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null });

    const target = await createArtifact({
      campaignId,
      kind: 'encounter',
      name: 'Ambush at the ford',
      summary: '',
      body: '',
      data: {
        difficulty: 'medium',
        levelHint: '3',
        monsters: [],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout: null,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      },
    });

    const input = {
      ...INPUT(campaignId, persona),
      autonomy: 'auto' as const,
      targetArtifactId: target.id,
      placementModuleId: '11111111-1111-4111-8111-111111111111',
    };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
    });
    const run = await getRun(runId);
    expect(run?.errorMessage).toContain('Module placement applies only to a newly created artifact');
  }, 20000);

  it('a run whose placement module is deleted mid-run fails loudly and leaves no dangling artifact', async () => {
    const { campaignId, persona } = await seed();
    const module = await createModuleRow(
      createModuleSchema({
        campaignId,
        title: 'Doomed Vault',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'sketch',
      }),
    );

    // Hold the statblock reply back so the delete lands while the run is
    // mid-pipeline — finalize (with the placement re-check) runs after it.
    type ChatReply = Awaited<ReturnType<typeof chat>>;
    let releaseStatblock: ((reply: ChatReply) => void) | undefined;
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockImplementationOnce(
        () =>
          new Promise<ChatReply>((resolve) => {
            releaseStatblock = resolve;
          }),
      );

    const input = { ...INPUT(campaignId, persona), autonomy: 'auto' as const, placementModuleId: module.id };
    const runId = await runEngine.startRun(input);
    await waitFor(() => {
      expect(chatMock).toHaveBeenCalledTimes(2);
    });
    if (releaseStatblock === undefined) throw new Error('the run never reached the statblock step');
    expect((await getRun(runId))?.status).toBe('running');

    // The module goes away while the run is in flight…
    await deleteModule(module.id, 'keep');
    // …the queued statblock reply lands, and finalize now hits the missing module.
    releaseStatblock({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    });
    const run = await getRun(runId);
    expect(run?.errorMessage).toContain('was deleted while the run was running');
    expect(run?.resultArtifactId).toBeNull();
    // Zero dangling rows: nothing owns the removed module id.
    const artifacts = await listArtifactsByCampaign(campaignId);
    expect(artifacts.filter((artifact) => artifact.moduleId === module.id)).toEqual([]);
    expect(artifacts).toHaveLength(0);
  }, 20000);

  it('resumeRun without explicit input rebuilds placement and extras from the run row', async () => {
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValue({ text: 'this is not a statblock', modelUsed: 'test-model', fallback: null });

    // A REAL module row — finalize re-checks existence loudly (AGENTS rule 1).
    const module = await createModuleRow(
      createModuleSchema({
        campaignId,
        title: 'Tide Gate',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'sketch',
      }),
    );
    const input = {
      ...INPUT(campaignId, persona),
      autonomy: 'auto' as const,
      placementModuleId: module.id,
      extras: { image: false, statBlock: false, mobPortraits: false, battlemap: false },
    };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
    });
    expect((await getRun(runId))?.placementModuleId).toBe(module.id);

    chatMock.mockReset();
    chatMock.mockResolvedValue({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

    await runEngine.resumeRun(runId);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });
    const resumed = await getRun(runId);
    const resumedId = resumed?.resultArtifactId;
    if (resumedId === null || resumedId === undefined) throw new Error('resumed run has no result artifact');
    const artifact = await getArtifact(resumedId);
    expect(artifact?.moduleId).toBe(module.id);
  }, 20000);

  it('resumeRun without explicit input rebuilds the unattended mode and chain grounding from the run row (F8)', async () => {
    const { campaignId, persona } = await seed();
    // An earlier chain step's produce — the draft prompt grounds on it.
    const contextArtifact = await createArtifact({
      campaignId,
      kind: 'npc',
      name: 'Kael',
      summary: 'The gate warden.',
      body: 'Kael keeps the gate at dusk.',
    });
    // Auto mode: the draft step rejects twice (initial + repair retry) and
    // fails the run — the resume then re-runs the DRAFT step, so its prompt
    // proves the context threading.
    chatMock
      .mockResolvedValueOnce({ text: 'not a draft at all', modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: 'still not a draft', modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      ...INPUT(campaignId, persona),
      autonomy: 'auto' as const,
      // F8: both fields used to be in-memory only — the row never carried
      // them, so a resume silently dropped the mode and the grounding.
      unattended: true,
      contextArtifactIds: [contextArtifact.id],
    });
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
    });
    const failed = await getRun(runId);
    expect(failed?.unattended).toBe(true);
    expect(failed?.contextArtifactIds).toEqual([contextArtifact.id]);

    chatMock.mockReset();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

    await runEngine.resumeRun(runId);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });
    // The resumed draft prompt carries the chain grounding ("Artifacts
    // created earlier in this pipeline") from the persisted ids.
    const resumedDraftCall = chatMock.mock.calls[0];
    if (resumedDraftCall === undefined) throw new Error('the resumed draft never called chat');
    const prompt = resumedDraftCall.map((part) => JSON.stringify(part)).join('\n');
    expect(prompt).toContain('Artifacts created earlier in this pipeline');
    expect(prompt).toContain('Kael');
    expect(prompt).toContain('The gate warden.');
    // The rebuilt input kept the run's mode: the row carries it through.
    const resumed = await getRun(runId);
    expect(resumed?.unattended).toBe(true);
    expect(resumed?.contextArtifactIds).toEqual([contextArtifact.id]);
  }, 20000);
  it('pilot (strict structured outputs): the encounter draft step sends a strict json_schema responseFormat', async () => {
    const { campaignId } = await seed();
    const encounterPersona = await createPersona({
      slug: 'encounter-smith-test',
      name: 'Encounter Smith',
      description: 'test',
      systemPrompt: 'You are a test persona. Reply with JSON only.',
      producesKind: 'encounter',
      builtIn: true,
    });
    chatMock.mockResolvedValue({
      text: JSON.stringify(VALID_ENCOUNTER_DRAFT),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun(INPUT(campaignId, encounterPersona));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
    });

    const run = await getRun(runId);
    expect(run?.steps.map((step) => step.name)).toEqual(['retrieve', 'draft']);
    expect(run?.steps[1]?.status).toBe('done');
    expect(chatMock).toHaveBeenCalledTimes(1);
    const opts = chatMock.mock.calls[0]?.[1] as {
      responseFormat?: { kind?: string; name?: string; jsonSchema?: Record<string, unknown> };
    };
    expect(opts.responseFormat).toMatchObject({ kind: 'schema', name: 'encounter-draft' });
    expect(opts.responseFormat?.jsonSchema?.additionalProperties).toBe(false);
    const required = opts.responseFormat?.jsonSchema?.required as string[] | undefined;
    expect(required).toContain('monsters');
    expect(required).toContain('locationKind');
  }, 20000);

  it('rollout: the npc draft and statblock steps send their strict json_schema responseFormats', async () => {
    const { campaignId, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaignId, persona));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
    });
    await runEngine.approve(runId, INPUT(campaignId, persona)); // draft approved -> statblock runs
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.steps.map((step) => step.name)).toContain('statblock');
    });

    const draftFormat = (chatMock.mock.calls[0]?.[1] as { responseFormat?: { kind?: string; name?: string } })
      .responseFormat;
    expect(draftFormat).toMatchObject({ kind: 'schema', name: 'npc-draft' });
    const statblockFormat = (chatMock.mock.calls[1]?.[1] as { responseFormat?: { kind?: string; name?: string } })
      .responseFormat;
    expect(statblockFormat).toMatchObject({ kind: 'schema', name: 'statblock' });
    // The statblock contract drops the free-form extras record (strict subset).
    const statblockSchema = (chatMock.mock.calls[1]?.[1] as {
      responseFormat?: { jsonSchema?: { properties?: Record<string, unknown> } };
    }).responseFormat?.jsonSchema;
    expect(statblockSchema?.properties?.extras).toBeUndefined();
  }, 20000);

  it('rollout: the continuity check step sends its strict json_schema responseFormat', async () => {
    const editor = BUILT_IN_PERSONAS.find((persona) => persona.slug === 'continuity-editor');
    if (editor === undefined) throw new Error('continuity-editor persona missing');
    const { campaignId, persona } = await seed();
    const editorPersona = persona.mode === 'review' ? persona : editor;
    chatMock.mockResolvedValueOnce({
      text: JSON.stringify({ verdict: 'consistent', summary: 'All consistent.', issues: [] }),
      modelUsed: 'test-model',
      fallback: null,
    });
    const target = await createArtifact({
      campaignId,
      kind: 'npc',
      name: 'Review Target',
      body: 'The target body.',
    });

    const input = { ...INPUT(campaignId, editorPersona), targetArtifactId: target.id, autonomy: 'auto' as const };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    const checkFormat = (chatMock.mock.calls[0]?.[1] as { responseFormat?: { kind?: string; name?: string } })
      .responseFormat;
    expect(checkFormat).toMatchObject({ kind: 'schema', name: 'continuity-report' });
  }, 20000);

});
