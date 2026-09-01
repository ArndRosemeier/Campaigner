import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { listPersonas } from '@/db/personaRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import {
  createArtifact as buildArtifact,
  createModule,
  moduleSchema,
  newId,
  type Artifact,
  type Autonomy,
  type Id,
  type Module,
  type Persona,
} from '@/domain';
import { EntityPanel, useModuleEntities } from '@/features/modules/entity-panel';
import { STUB_PERSONA_SLUGS } from '@/features/modules/persona-request';
import {
  type ChainState,
  type ChainStepInput,
} from '@/llm/chainRunner';
import { clearDatabase } from '../db/helpers';

/**
 * Entity panel (08-M4-C): useModuleEntities ordering (resolved first, then
 * total mentions desc), stub rows and per-kind batch buttons, and the batch
 * chain run (chainRunner mocked at the seam) tagging its produced artifacts
 * with the module tag.
 */

const chainMocks = vi.hoisted(() => ({
  run: vi.fn<
    (
      campaign: Parameters<typeof EntityPanel>[0]['campaign'],
      personas: readonly Persona[],
      steps: readonly ChainStepInput[],
      autonomy: Autonomy,
      pinnedChunkIds: readonly Id[],
    ) => Promise<ChainState>
  >(),
  getState: vi.fn<() => ChainState>(),
}));

vi.mock('@/llm/chainRunner', () => ({
  chainRunner: {
    run: chainMocks.run,
    getState: chainMocks.getState,
    on: vi.fn(() => () => undefined),
  },
}));

const PREMISE = [
  'The crypt of [[Mira]] looms over the shore.',
  'Mira guards the seal.',
  'It lies beneath the [[Undercroft]].',
  'The [[Undercroft]] door is locked.',
  '[[Kael]] watches the gate.',
  '[[Bram]] polls the tide table.',
  '[[The Tide Bell]] tolls at dusk.',
].join(' ');

/**
 * Kael + Bram are unresolved npcs, Undercroft an unresolved location — kinds
 * RECORDED BY THE GENERATOR (08 §M4-C). "The Tide Bell" has no record (the
 * user typed it later): it is not batchable, only stub-able per row.
 */
function moduleFixture(campaignId: Id): Module {
  const base = createModule({
    campaignId,
    title: 'Ember Crypt',
    concept: 'A crypt guarding an old seal.',
    levelMin: 1,
    levelMax: 4,
    sizeDial: 'standard',
  });
  return moduleSchema.parse({
    ...base,
    spine: {
      premise: PREMISE,
      themes: [],
      partPlan: [
        {
          title: 'The Seal',
          levelBand: '1–2',
          synopsis: 'Reach the seal beneath the crypt.',
          levelUpTrigger: 'The seal breaks.',
        },
      ],
    },
    parts: [],
    entityKinds: [
      { name: 'Undercroft', kind: 'location' },
      { name: 'Kael', kind: 'npc' },
      { name: 'Bram', kind: 'npc' },
    ],
  });
}

function EntriesHarness({
  module,
  artifacts,
}: {
  module: Module;
  artifacts: readonly Artifact[];
}) {
  const { entries } = useModuleEntities(module, artifacts);
  return (
    <ul>
      {entries.map((entry) => (
        <li
          key={entry.name}
          data-testid="hook-entry"
          data-resolved={String(entry.resolved)}
          data-total={String(entry.total)}
        >
          {entry.name}
        </li>
      ))}
    </ul>
  );
}

function completedChainState(produced: Artifact): ChainState {
  return {
    steps: [
      {
        runId: 'run-kael',
        status: 'completed',
        artifactId: produced.id,
        title: 'Detail: Kael',
      },
      {
        runId: 'run-bram',
        status: 'completed',
        artifactId: produced.id,
        title: 'Detail: Bram',
      },
    ],
    currentIndex: 2,
    status: 'completed',
  };
}

describe('useModuleEntities', () => {
  beforeEach(clearDatabase);
  afterEach(cleanup);

  it('lists resolved entities first, then unresolved ones by total mentions descending', () => {
    const campaignId = newId();
    const mira = buildArtifact({ campaignId, kind: 'npc', name: 'Mira' });

    render(<EntriesHarness module={moduleFixture(campaignId)} artifacts={[mira]} />);

    const rows = screen.getAllByTestId('hook-entry');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Mira',
      'Undercroft',
      'Kael',
      'Bram',
      'The Tide Bell',
    ]);
    expect(rows[0]).toHaveAttribute('data-resolved', 'true');
    expect(rows[0]).toHaveAttribute('data-total', '2');
    expect(rows[1]).toHaveAttribute('data-resolved', 'false');
    expect(rows[1]).toHaveAttribute('data-total', '2');
    expect(rows[2]).toHaveAttribute('data-total', '1');
    expect(rows[3]).toHaveAttribute('data-total', '1');
    expect(rows[4]).toHaveAttribute('data-total', '1');
  });
});

describe('EntityPanel', () => {
  beforeEach(clearDatabase);
  beforeEach(() => {
    chainMocks.run.mockReset();
    chainMocks.getState.mockReset();
  });
  afterEach(cleanup);

  it('renders resolved rows first with kind badges, unresolved stub rows, and per-kind batch buttons', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const mira = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Mira' });
    const onStub = vi.fn<(name: string, anchor: { x: number; y: number }) => void>();
    const onScrollTo = vi.fn<(name: string) => void>();

    render(
      <EntityPanel
        module={moduleFixture(campaign.id)}
        artifacts={[mira]}
        campaign={campaign}
        onStub={onStub}
        onScrollTo={onScrollTo}
      />,
    );

    expect(screen.getByText('1 detailed · 5 mentioned')).toBeInTheDocument();

    const rows = screen.getAllByTestId('entity-row');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent('Mira');
    expect(rows[0]).toHaveAttribute('data-resolved', 'true');
    expect(rows[1]).toHaveTextContent('Undercroft');
    expect(rows[1]).not.toHaveAttribute('data-resolved');
    // Unresolved rows show the kind the GENERATOR recorded (08 §M4-C) —
    // never the client heuristic; a name without a record shows 'stub'.
    expect(rows[1]).toHaveTextContent('location');
    expect(rows[1]).toHaveTextContent('×2');
    expect(rows[2]).toHaveTextContent('Kael');
    expect(rows[2]).toHaveTextContent('npc');
    expect(rows[3]).toHaveTextContent('Bram');
    expect(rows[4]).toHaveTextContent('The Tide Bell');
    expect(rows[4]).toHaveTextContent('stub');

    expect(screen.getByTestId('batch-npc')).toHaveTextContent('Generate 2 npc');
    expect(screen.getByTestId('batch-location')).toHaveTextContent('Generate 1 location');
    // Names without a recorded kind are not batchable — no guessed buckets.
    expect(screen.queryByTestId('batch-faction')).not.toBeInTheDocument();
    expect(screen.queryByTestId('batch-note')).not.toBeInTheDocument();
    expect(screen.getAllByTestId(/batch-/)).toHaveLength(2);

    // Resolved rows scroll the reader; unresolved rows open the stub popover.
    await user.click(screen.getByRole('button', { name: /Mira/ }));
    expect(onScrollTo).toHaveBeenCalledTimes(1);
    expect(onScrollTo).toHaveBeenCalledWith('Mira');
    await user.click(screen.getByRole('button', { name: /Kael/ }));
    expect(onScrollTo).toHaveBeenCalledTimes(1);
    const stubCall = onStub.mock.calls.at(0);
    expect(stubCall?.[0]).toBe('Kael');
    expect(stubCall?.[1]?.x).toEqual(expect.any(Number));
    expect(stubCall?.[1]?.y).toEqual(expect.any(Number));
  });

  it('runs one batch chain for an unresolved kind with the stub persona and tags the produced artifact', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await seedBuiltInPersonas();
    const mira = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Mira' });
    const produced = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Kael the Watcher',
    });

    const chainState = completedChainState(produced);
    chainMocks.run.mockResolvedValue(chainState);
    chainMocks.getState.mockReturnValue(chainState);

    render(
      <EntityPanel
        module={moduleFixture(campaign.id)}
        artifacts={[mira]}
        campaign={campaign}
        onStub={vi.fn()}
        onScrollTo={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId('batch-npc'));

    const personas = await listPersonas();
    const npcSmith = personas.find(
      (candidate) => candidate.slug === STUB_PERSONA_SLUGS.npc,
    );
    expect(npcSmith).toBeDefined();
    expect(chainMocks.run).toHaveBeenCalledTimes(1);

    // One chain over all unresolved npcs of the kind, built from the stub
    // persona slug, with the chain-wide 'auto' autonomy and no pinned chunks.
    const runCall = chainMocks.run.mock.calls.at(0);
    expect(runCall?.[0]?.id).toBe(campaign.id);
    expect(runCall?.[1]).toContainEqual(npcSmith);
    expect(runCall?.[2]).toHaveLength(2);
    expect(runCall?.[2]?.[0]).toMatchObject({
      personaId: npcSmith?.id,
      title: 'Detail: Kael',
      autonomy: 'auto',
    });
    expect(runCall?.[2]?.[0]?.brief).toContain('Detail the entity "Kael"');
    // Brief context keeps the module's wiki tokens intact.
    expect(runCall?.[2]?.[0]?.brief).toContain('[[Kael]] watches the gate.');
    expect(runCall?.[2]?.[1]).toMatchObject({
      personaId: npcSmith?.id,
      title: 'Detail: Bram',
      autonomy: 'auto',
    });
    expect(runCall?.[3]).toBe('auto');
    expect(runCall?.[4]).toEqual([]);

    // After the chain completes, the produced artifacts gain the module tag.
    await waitFor(async () => {
      const tagged = await getArtifact(produced.id);
      expect(tagged?.tags).toContain('module:Ember Crypt');
    });
  });
});
