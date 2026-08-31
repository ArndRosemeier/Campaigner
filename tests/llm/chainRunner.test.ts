import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import { createCampaign } from '@/db/campaignRepo';
import { createArtifact, getArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { getRun } from '@/db/runRepo';
import { chainRunner, type ChainStepInput } from '@/llm/chainRunner';
import { runEngine } from '@/llm/runEngine';
import { createPersona, type ArtifactKind, type Id, type Persona } from '@/domain';
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
    chatMock.mockResolvedValueOnce(
      JSON.stringify({
        name: 'Emberfall Docks',
        summary: 'Smuggling hub.',
        suggestedTags: ['docks'],
        body: '# Emberfall Docks',
        locationType: 'district',
        inhabitants: 'Dockworkers, smugglers',
        pointsOfInterest: [{ name: 'The Sinking Gull', description: 'A tavern.' }],
        hooks: ['A crate of emberwine went missing.'],
      }),
    );

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
    chatMock.mockResolvedValueOnce(
      JSON.stringify({
        name: 'The Ember Guild',
        summary: 'Controls the emberwine trade.',
        suggestedTags: ['guild'],
        body: '# The Ember Guild',
        goals: 'Monopolize emberwine.',
        methods: 'Smuggling, bribery.',
        resources: 'Fleet of barges.',
        ranks: [{ title: 'Guildmaster', description: 'Runs everything.' }],
      }),
    );

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
    chatMock.mockResolvedValueOnce(
      JSON.stringify({
        name: 'The Emberwine Conspiracy',
        summary: 'A smuggling plot.',
        suggestedTags: ['plot'],
        body: '# The Emberwine Conspiracy\nThree acts.',
      }),
    );

    const input = { ...campaignInput(campaign.id), persona };
    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    const artifact = (await listArtifactsByCampaign(campaign.id))[0];
    expect(artifact?.kind).toBe('note');
    expect(artifact?.body).toContain('Three acts');
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
    chatMock.mockResolvedValueOnce(
      JSON.stringify({
        verdict: 'issues_found',
        summary: 'Grimm is described as alive here but dead elsewhere.',
        issues: [
          {
            severity: 'major',
            message: 'Grimm is alive in this artifact but buried in the cemetery log.',
            relatedTo: 'Grimm',
          },
        ],
      }),
    );

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
      .mockResolvedValueOnce(
        JSON.stringify({
          name: 'Emberfall Docks',
          summary: 'Smuggling hub.',
          suggestedTags: [],
          body: 'Dock district.',
          locationType: 'district',
          inhabitants: '',
          pointsOfInterest: [],
          hooks: [],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          name: 'The Ember Guild',
          summary: 'Rules the docks.',
          suggestedTags: [],
          body: 'A guild.',
          goals: '',
          methods: '',
          resources: '',
          ranks: [],
        }),
      );

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
    chatMock.mockResolvedValue(
      JSON.stringify({
        name: 'Emberfall Docks',
        summary: '',
        suggestedTags: [],
        body: '',
        locationType: '',
        inhabitants: '',
        pointsOfInterest: [],
        hooks: [],
      }),
    );

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
});
