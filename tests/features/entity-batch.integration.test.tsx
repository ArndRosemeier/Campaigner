import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { createModule, moduleSchema, type Campaign, type Module } from '@/domain';
import { useArtifacts } from '@/features/campaign/hooks';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import { EntityPanel } from '@/features/modules/entity-panel';
import { ProgressDock } from '@/features/progress/progress-dock';
import { chainRunner } from '@/llm/chainRunner';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

function moduleFixture(campaignId: string): Module {
  const base = createModule({
    campaignId,
    title: 'Ember Crypt',
    concept: 'A drowned crypt beneath the harbor.',
    levelMin: 1,
    levelMax: 4,
    sizeDial: 'sketch',
  });
  return moduleSchema.parse({
    ...base,
    status: 'ready',
    entityKinds: [{ name: 'Kael', kind: 'npc' }],
    spine: {
      premise: 'The gate of [[Ember Crypt]] opens at dusk.',
      themes: [],
      partPlan: [
        {
          title: 'The Tide Gate',
          levelBand: '1–4',
          synopsis: 'The party meets [[Kael]] at the sealed gate.',
          levelUpTrigger: 'The gate opens.',
        },
      ],
    },
    parts: [
      {
        planIndex: 0,
        status: 'ready',
        markdown: '## The Tide Gate\n\n[[Kael]] watches the gate and counts every visitor.',
        edited: false,
        errorMessage: '',
      },
    ],
  });
}

function Harness({ campaign, module }: { campaign: Campaign; module: Module }) {
  const artifacts = useArtifacts(campaign.id);
  if (artifacts === undefined) return <p>Loading…</p>;
  return (
    <>
      <WikiMarkdown value={module.parts[0]?.markdown ?? ''} artifacts={artifacts} />
      <EntityPanel
        module={module}
        artifacts={artifacts}
        campaign={campaign}
        onStub={vi.fn()}
        onOpenCard={vi.fn()}
      />
      <ProgressDock />
    </>
  );
}

const draft = {
  // Deliberately embellished: the batch alignment must still make [[Kael]]
  // resolve while preserving this authored title as an alias.
  name: 'Kael Ashbound, Warden of the Gate',
  summary: 'The watchful keeper of the tide gate.',
  suggestedTags: ['warden'],
  body: '# Kael\nKael keeps the gate and knows who passed at dusk.',
  role: 'Gate warden',
  appearance: 'Weathered leathers and a brass key-ring.',
  personality: 'Quiet and observant.',
  motivation: 'Keep the crypt sealed.',
  secrets: 'He heard the bell beneath the sea.',
  voiceNotes: 'Short sentences; counts exits while speaking.',
  needsStatBlock: true,
};

const statblock = {
  system: 'dnd5e',
  level: '3',
  size: 'Medium',
  creatureType: 'Humanoid',
  ac: 15,
  acNote: 'leather armor',
  hp: 27,
  hpFormula: '5d8+5',
  speed: '30 ft.',
  abilities: { str: 12, dex: 14, con: 12, int: 11, wis: 15, cha: 10 },
  saves: 'Wis +4',
  skills: 'Insight +4, Perception +4',
  senses: 'passive Perception 14',
  languages: 'Common',
  traits: [{ name: 'Gatewatch', text: 'Advantage on checks to notice intruders.' }],
  actions: [{ name: 'Spear', text: 'Melee Weapon Attack: +4 to hit.' }],
  reactions: [],
  legendary: [],
  extras: {},
};

describe('entity batch — real chain persistence and live resolution', () => {
  beforeEach(async () => {
    await clearDatabase();
    await seedBuiltInPersonas();
    chatMock.mockReset();
    toastErrorMock.mockReset();
    chainRunner.reset();
    useProgressStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
    chainRunner.reset();
    useProgressStore.getState().reset();
  });

  it('batch click saves one NPC and changes [[Kael]] from unresolved to resolved', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = moduleFixture(campaign.id);
    chatMock
      .mockResolvedValueOnce(JSON.stringify(draft))
      .mockResolvedValueOnce(JSON.stringify(statblock));

    render(<Harness campaign={campaign} module={module} />);

    expect(await screen.findByTitle('Kael — not detailed yet')).toBeInTheDocument();
    await user.click(screen.getByTestId('batch-npc'));
    expect(await screen.findByTestId('progress-dock')).toBeInTheDocument();

    await waitFor(
      () => {
        expect(screen.queryByTitle('Kael — not detailed yet')).not.toBeInTheDocument();
        expect(screen.getByTestId('wiki-chip')).toHaveAttribute('data-wiki-name', 'Kael');
      },
      { timeout: 10_000 },
    );
    await waitFor(
      () => {
        expect(screen.queryByTestId('progress-dock')).not.toBeInTheDocument();
      },
      { timeout: 10_000 },
    );

    const artifacts = await listArtifactsByCampaign(campaign.id);
    expect(artifacts).toHaveLength(1);
    const artifact = artifacts[0];
    expect(artifact?.name).toBe('Kael');
    expect(artifact?.aliases).toContain('Kael Ashbound, Warden of the Gate');
    expect(artifact?.kind).toBe('npc');
    if (artifact?.kind === 'npc') {
      expect(artifact.data.statBlock?.ac).toBe(15);
    }
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 20_000);
});
