import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import { createCampaign } from '@/db/campaignRepo';
import { createArtifact, getArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { getRun } from '@/db/runRepo';
import { chainRunner, type ChainStepInput } from '@/llm/chainRunner';
import { runEngine } from '@/llm/runEngine';
import { createPersona, type ArtifactKind, type Id, type Persona } from '@/domain';
import { buildEntityBrief } from '@/features/modules/persona-request';
import { resolveWikiLink } from '@/lib/wikilinks';
import { clearDatabase } from '../db/helpers';

/**
 * M2: remaining personas wired (worldbuilder → location, faction-designer →
 * faction, plot-architect → note) + writers'-room chaining.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

function personaOf(slug: string, name: string, producesKind: ArtifactKind): Persona {
  return createPersona({
    slug,
    name,
    description: '',
    systemPrompt: `You are ${name}.`,
    producesKind,
    builtIn: true,
  });
}

function campaignInput(campaignId: Id) {
  return {
    campaign: {
      id: campaignId,
      name: 'Emberfall',
      system: 'dnd5e' as const,
      description: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    brief: 'Do the thing.',
    autonomy: 'auto' as const,
    pinnedChunkIds: [],
  };
}

beforeEach(clearDatabase);
afterEach(() => {
  chatMock.mockReset();
  chainRunner.reset();
});

describe('remaining personas wired', () => {
  it('worldbuilder produces a location artifact from its draft', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const persona = personaOf('worldbuilder', 'Worldbuilder', 'location');
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({
        name: 'Emberfall Docks',
        summary: 'Smuggling hub.',
        suggestedTags: ['docks'],
        body: '# Emberfall Docks',
        locationType: 'district',
        inhabitants: 'Dockworkers, smugglers',
        pointsOfInterest: [{ name: 'The Sinking Gull', description: 'A tavern.' }],
        hooks: ['A crate of emberwine went missing.'],
      }), modelUsed: 'test-model', fallback: null });

    const input = { ...campaignInput(campaign.id), persona };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    const artifacts = await listArtifactsByCampaign(campaign.id);
    const artifact = artifacts[0];
    expect(artifact?.kind).toBe('location');
    if (artifact?.kind === 'location') {
      expect(artifact.data.locationType).toBe('district');
      expect(artifact.data.pointsOfInterest[0]?.name).toBe('The Sinking Gull');
    }
  }, 20000);

  it('faction-designer produces a faction artifact from its draft', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const persona = personaOf('faction-designer', 'Faction Designer', 'faction');
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({
        name: 'The Ember Guild',
        summary: 'Controls the emberwine trade.',
        suggestedTags: ['guild'],
        body: '# The Ember Guild',
        goals: 'Monopolize emberwine.',
        methods: 'Smuggling, bribery.',
        resources: 'Fleet of barges.',
        ranks: [{ title: 'Guildmaster', description: 'Runs everything.' }],
      }), modelUsed: 'test-model', fallback: null });

    const input = { ...campaignInput(campaign.id), persona };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    const artifact = (await listArtifactsByCampaign(campaign.id))[0];
    expect(artifact?.kind).toBe('faction');
    if (artifact?.kind === 'faction') {
      expect(artifact.data.ranks[0]?.title).toBe('Guildmaster');
    }
  }, 20000);

  it('plot-architect produces a note artifact from its draft', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const persona = personaOf('plot-architect', 'Plot Architect', 'note');
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({
        name: 'The Emberwine Conspiracy',
        summary: 'A smuggling plot.',
        suggestedTags: ['plot'],
        body: '# The Emberwine Conspiracy\nThree acts.',
      }), modelUsed: 'test-model', fallback: null });

    const input = { ...campaignInput(campaign.id), persona };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    const artifact = (await listArtifactsByCampaign(campaign.id))[0];
    expect(artifact?.kind).toBe('note');
    expect(artifact?.body).toContain('Three acts');
  }, 20000);

  it('npc batch retries a malformed statblock, persists the NPC, and resolves its wiki-link', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const persona = personaOf('npc-smith', 'NPC Smith', 'npc');
    const draft = {
      name: 'Kael',
      summary: 'The watchful keeper of the tide gate.',
      suggestedTags: ['warden'],
      body: '# Kael\nKael keeps the gate and knows who passed at dusk.',
      appearance: 'Weathered leathers and a brass key-ring.',
      personality: 'Quiet and observant.',
      needsStatBlock: true,
    };
    // This is the OLD prompt's exact shape: it is missing fields the real
    // statBlockSchema requires. The engine must repair it once, not discard
    // the already-valid NPC draft before finalize.
    const incompleteStatblock = {
      system: 'dnd5e',
      level: '3',
      ac: 15,
      acNote: 'leather armor',
      hp: 27,
      hpFormula: '5d8+5',
      speed: '30 ft.',
      abilities: { str: 12, dex: 14, con: 12, int: 11, wis: 15, cha: 10 },
      extras: {},
    };
    const validStatblock = {
      ...incompleteStatblock,
      size: 'Medium',
      creatureType: 'Humanoid',
      saves: 'Wis +4',
      skills: 'Insight +4, Perception +4',
      senses: 'passive Perception 14',
      languages: 'Common',
      traits: [{ name: 'Gatewatch', text: 'Kael has advantage on checks to notice intruders.' }],
      actions: [{ name: 'Spear', text: 'Melee Weapon Attack: +4 to hit.' }],
      reactions: [],
      legendary: [],
    };
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(draft), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(incompleteStatblock), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(validStatblock), modelUsed: 'test-model', fallback: null });

    const state = await chainRunner.run(
      campaign,
      [persona],
      [
        {
          personaId: persona.id,
          title: 'Detail: Kael',
          brief: buildEntityBrief('Kael', '[[Kael]] watches the tide gate.', ''),
          autonomy: 'auto',
        },
      ],
      'auto',
      [],
    );

    expect(state.status).toBe('completed');
    const step = state.steps[0];
    expect(step?.status).toBe('completed');
    expect(step?.artifactId).not.toBeNull();

    const artifacts = await listArtifactsByCampaign(campaign.id);
    expect(artifacts).toHaveLength(1);
    const artifact = artifacts[0];
    expect(artifact?.name).toBe('Kael');
    expect(artifact?.kind).toBe('npc');
    if (artifact?.kind === 'npc') {
      expect(artifact.data.statBlock?.ac).toBe(15);
      expect(artifact.data.statBlock?.traits[0]?.name).toBe('Gatewatch');
    }
    expect(resolveWikiLink('Kael', artifacts).status).toBe('resolved');

    const run = step?.runId === null ? undefined : await getRun(step?.runId ?? '');
    expect(run?.status).toBe('completed');
    expect(run?.resultArtifactId).toBe(artifact?.id);
    expect(run?.steps.map((runStep) => runStep.status)).toEqual([
      'done',
      'done',
      'done',
      'done',
    ]);
    expect(chatMock).toHaveBeenCalledTimes(3);
    const statblockMessages = chatMock.mock.calls[1]?.[0] ?? [];
    const statblockPrompt = statblockMessages.find((message) => message.role === 'user')?.content ?? '';
    expect(statblockPrompt).toContain('"traits"');
    expect(statblockPrompt).toContain('"legendary"');
    const repairMessages = chatMock.mock.calls[2]?.[0] ?? [];
    expect(repairMessages.find((message) => message.role === 'user')?.content).toContain(
      'previous statblock reply was invalid',
    );
  }, 20000);

  it('skips the statblock step when the draft marks the character as not needing one', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const persona = personaOf('npc-smith', 'NPC Smith', 'npc');
    // A contact/merchant: no stat block — the draft decides.
    const draft = {
      name: 'Ferryman Ollo',
      summary: 'Rows people across the bay and knows every rumour.',
      suggestedTags: ['contact'],
      body: '# Ferryman Ollo\nOllo takes coin and gossip in equal measure.',
      appearance: 'Salt-cured coat, endless grin.',
      personality: 'Chatty, cagey about prices.',
      needsStatBlock: false,
    };
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(draft), modelUsed: 'test-model', fallback: null });

    const state = await chainRunner.run(
      campaign,
      [persona],
      [
        {
          personaId: persona.id,
          title: 'Detail: Ferryman Ollo',
          brief: buildEntityBrief('Ferryman Ollo', 'The party hires [[Ferryman Ollo]].', ''),
          autonomy: 'auto',
        },
      ],
      'auto',
      [],
    );

    expect(state.status).toBe('completed');
    const step = state.steps[0];
    expect(step?.status).toBe('completed');

    const artifacts = await listArtifactsByCampaign(campaign.id);
    const artifact = artifacts.find((entry) => entry.name === 'Ferryman Ollo');
    expect(artifact?.kind).toBe('npc');
    if (artifact?.kind === 'npc') {
      expect(artifact.data.statBlock).toBeNull();
      expect(artifact.data.appearance).toContain('Salt-cured');
    }

    const run = step?.runId === null ? undefined : await getRun(step?.runId ?? '');
    expect(run?.steps.map((runStep) => runStep.status)).toEqual([
      'done',
      'done',
      'skipped',
      'done',
    ]);
    // Only ONE chat call happened — the statblock generation never ran.
    expect(chatMock).toHaveBeenCalledTimes(1);
  }, 20000);
});

describe('continuity editor persona', () => {
  it('reviews a target artifact and finalizes a report note linked to it', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    // Existing artifact that the target contradicts.
    const existing = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Grimm',
      summary: 'Died last winter.',
    });
    const target = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Vera',
      summary: 'Lieutenant under Grimm, who is alive and well.',
    });

    const persona = createPersona({
      slug: 'continuity-editor',
      name: 'Continuity Editor',
      description: '',
      systemPrompt: 'You are the Continuity Editor.',
      producesKind: 'note',
      mode: 'review',
      builtIn: true,
    });
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({
        verdict: 'issues_found',
        summary: 'Grimm is described as alive here but dead elsewhere.',
        issues: [
          {
            severity: 'major',
            message: 'Grimm is alive in this artifact but buried in the cemetery log.',
            relatedTo: 'Grimm',
          },
        ],
      }), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      campaign: {
        id: campaign.id,
        name: 'Emberfall',
        system: 'dnd5e',
        description: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      persona,
      autonomy: 'auto',
      brief: 'Focus on who is alive.',
      pinnedChunkIds: [],
      targetArtifactId: target.id,
    });

    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    const artifacts = await listArtifactsByCampaign(campaign.id);
    const report = artifacts.find((artifact) => artifact.tags.includes('continuity'));
    expect(report).toBeDefined();
    expect(report?.kind).toBe('note');
    expect(report?.name).toBe('Continuity report — Vera');
    expect(report?.body).toContain('[major]');
    expect(report?.links).toEqual([{ targetId: target.id, relation: 'continuity-check-of' }]);
    expect(existing).toBeDefined();
    const run = await getRun(runId);
    expect(run?.steps.map((step) => step.name)).toEqual(['gather', 'check', 'finalize']);
  }, 20000);
});

describe('writers\u2019 room chain', () => {
  it('runs steps in order, passing earlier artifacts as context', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const worldbuilder = personaOf('worldbuilder', 'Worldbuilder', 'location');
    const factionDesigner = personaOf('faction-designer', 'Faction Designer', 'faction');

    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify({
          name: 'Emberfall Docks',
          summary: 'Smuggling hub.',
          suggestedTags: [],
          body: 'Dock district.',
          locationType: 'district',
          inhabitants: '',
          pointsOfInterest: [],
          hooks: [],
        }), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify({
          name: 'The Ember Guild',
          summary: 'Rules the docks.',
          suggestedTags: [],
          body: 'A guild.',
          goals: '',
          methods: '',
          resources: '',
          ranks: [],
        }), modelUsed: 'test-model', fallback: null });

    const steps: ChainStepInput[] = [
      { personaId: worldbuilder.id, brief: 'Build a docks district.' },
      { personaId: factionDesigner.id, brief: 'Design the faction ruling it.' },
    ];

    const result = await chainRunner.run(
      campaign,
      [worldbuilder, factionDesigner],
      steps,
      'auto',
      [],
    );
    expect(result.status).toBe('completed');
    expect(result.steps.map((step) => step.status)).toEqual(['completed', 'completed']);

    // The second draft call must have received the first artifact as context.
    const secondCall = chatMock.mock.calls[1];
    const secondMessages = (secondCall?.[0] ?? []) as readonly { content: string }[];
    expect(JSON.stringify(secondMessages)).toContain('Emberfall Docks');

    const artifacts = await listArtifactsByCampaign(campaign.id);
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((artifact) => artifact.kind)).toEqual(['location', 'faction']);
  }, 30000);

  it('pauses the chain when a manual run awaits the user', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const persona = personaOf('worldbuilder', 'Worldbuilder', 'location');
    chatMock.mockResolvedValue({ text: JSON.stringify({
        name: 'Emberfall Docks',
        summary: '',
        suggestedTags: [],
        body: '',
        locationType: '',
        inhabitants: '',
        pointsOfInterest: [],
        hooks: [],
      }), modelUsed: 'test-model', fallback: null });

    const result = await chainRunner.run(
      campaign,
      [persona],
      [{ personaId: persona.id, brief: 'Build something.' }],
      'manual',
      [],
    );
    expect(result.status).toBe('paused');
    expect(result.steps[0]?.status).toBe('awaiting_user');

    // User approves via the Assistant tab → the run completes; the chain's
    // paused step reflects the finished run on the next state read.
    const runId = result.steps[0]?.runId;
    if (runId === null || runId === undefined) throw new Error('no run id');
    await runEngine.approve(runId, {
      campaign,
      persona,
      autonomy: 'manual',
      brief: 'Build something.',
      pinnedChunkIds: [],
    });
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const run = await getRun(runId);
    const reportId = run?.resultArtifactId;
    if (reportId === null || reportId === undefined) throw new Error('no report artifact');
    expect(await getArtifact(reportId)).toBeDefined();
  }, 30000);

  it('retry resumes a failed chain from the failed step, reusing prior artifacts as context', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const worldbuilder = personaOf('worldbuilder', 'Worldbuilder', 'location');
    const factionDesigner = personaOf('faction-designer', 'Faction Designer', 'faction');

    // Step 1 completes; step 2's reply is garbage twice (draft + the engine's
    // automatic JSON-fix retry) → the run fails → the chain stops.
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify({
          name: 'Emberfall Docks',
          summary: 'Smuggling hub.',
          suggestedTags: [],
          body: '# Emberfall Docks',
          locationType: 'district',
          inhabitants: 'Dockworkers',
          pointsOfInterest: [],
          hooks: [],
        }), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: 'this is not json', modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: 'still not json', modelUsed: 'test-model', fallback: null });

    const steps: ChainStepInput[] = [
      { personaId: worldbuilder.id, brief: 'Build a docks district.' },
      { personaId: factionDesigner.id, brief: 'Design the faction ruling it.' },
    ];
    const failed = await chainRunner.run(
      campaign,
      [worldbuilder, factionDesigner],
      steps,
      'auto',
      [],
    );
    expect(failed.status).toBe('failed');
    expect(failed.steps.map((step) => step.status)).toEqual(['completed', 'failed']);

    // The failed run stays in history with its error message (loud, per 00-OVERVIEW).
    const { listRunsByCampaign } = await import('@/db/runRepo');
    const runsAfterFailure = await listRunsByCampaign(campaign.id);
    expect(runsAfterFailure).toHaveLength(2);
    const failedRun = runsAfterFailure.find((run) => run.status === 'failed');
    expect(failedRun?.errorMessage ?? '').not.toBe('');

    // Retry: only the failed step re-runs, with a valid reply this time.
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({
        name: 'The Ember Guild',
        summary: 'Rules the docks.',
        suggestedTags: [],
        body: 'A guild.',
        goals: '',
        methods: '',
        resources: '',
        ranks: [],
      }), modelUsed: 'test-model', fallback: null });
    const retried = await chainRunner.retry();
    expect(retried.status).toBe('completed');
    expect(retried.steps.map((step) => step.status)).toEqual(['completed', 'completed']);

    // Prior work was never wasted: the retried step received the completed
    // step's artifact as context (its name appears in the retried prompt).
    const retryCall = chatMock.mock.calls.at(-1);
    const retryMessages = (retryCall?.[0] ?? []) as readonly { content: string }[];
    expect(JSON.stringify(retryMessages)).toContain('Emberfall Docks');

    const artifacts = await listArtifactsByCampaign(campaign.id);
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((artifact) => artifact.kind)).toEqual(['location', 'faction']);

    // History keeps the failed run (2 original + 1 retried).
    const runs = await listRunsByCampaign(campaign.id);
    expect(runs).toHaveLength(3);
    expect(runs.filter((run) => run.status === 'failed')).toHaveLength(1);
    expect(runs.filter((run) => run.status === 'completed')).toHaveLength(2);
  }, 30000);

  it('retry is a no-op when the chain is not failed', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const persona = personaOf('worldbuilder', 'Worldbuilder', 'location');
    // Never-run state: retry must not start anything.
    const state = await chainRunner.retry();
    expect(state.status).toBe('idle');
    expect(await listArtifactsByCampaign(campaign.id)).toHaveLength(0);
    expect(chatMock).not.toHaveBeenCalled();
    void persona;
  });
});
