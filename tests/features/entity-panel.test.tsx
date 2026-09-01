import 'fake-indexeddb/auto';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
import { ProgressDock } from '@/features/progress/progress-dock';
import { useProgressStore } from '@/lib/progress';

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
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
  /** Subscribed listeners, so tests can drive chain state like the real runner. */
  listeners: [] as ((state: ChainState) => void)[],
}));

vi.mock('@/llm/chainRunner', () => ({
  chainRunner: {
    run: chainMocks.run,
    getState: chainMocks.getState,
    on: vi.fn((listener: (state: ChainState) => void) => {
      chainMocks.listeners.push(listener);
      return () => {
        chainMocks.listeners = chainMocks.listeners.filter((registered) => registered !== listener);
      };
    }),
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

function completedChainState(kaelProduced: Artifact, bramProduced: Artifact): ChainState {
  return {
    steps: [
      {
        runId: 'run-kael',
        status: 'completed',
        artifactId: kaelProduced.id,
        title: 'Detail: Kael',
      },
      {
        runId: 'run-bram',
        status: 'completed',
        artifactId: bramProduced.id,
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
    chainMocks.listeners.length = 0;
    useProgressStore.getState().reset();
    toastErrorMock.mockClear();
  });
  afterEach(cleanup);

  it('renders resolved rows first with kind badges, unresolved stub rows, and per-kind batch buttons', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const mira = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Mira' });
    const onStub = vi.fn<(name: string, anchor: { x: number; y: number }) => void>();
    const onOpenCard = vi.fn<(artifact: Artifact) => void>();

    render(
      <EntityPanel
        module={moduleFixture(campaign.id)}
        artifacts={[mira]}
        campaign={campaign}
        onStub={onStub}
        onOpenCard={onOpenCard}
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

    // Resolved rows open the entity card; unresolved rows open the stub popover.
    await user.click(screen.getByRole('button', { name: /Mira/ }));
    expect(onOpenCard).toHaveBeenCalledTimes(1);
    expect(onOpenCard).toHaveBeenCalledWith(mira);
    await user.click(screen.getByRole('button', { name: /Kael/ }));
    expect(onOpenCard).toHaveBeenCalledTimes(1);
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
    const bramProduced = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Bram of the Tide',
    });

    const chainState = completedChainState(produced, bramProduced);
    chainMocks.run.mockResolvedValue(chainState);
    chainMocks.getState.mockReturnValue(chainState);

    render(
      <EntityPanel
        module={moduleFixture(campaign.id)}
        artifacts={[mira]}
        campaign={campaign}
        onStub={vi.fn()}
        onOpenCard={vi.fn()}
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
    // Drain the batch to its end so no trailing state update (the
    // finally-block setBatching) leaks into the next test.
    await waitFor(() => {
      expect(screen.getByTestId('batch-npc')).toHaveTextContent('Generate 2 npc');
    });
    // The artifact is aligned to the EXACT entity name so [[Kael]] resolves;
    // the model's invented name survives as an alias.
    const aligned = await getArtifact(produced.id);
    expect(aligned?.name).toBe('Kael');
    expect(aligned?.aliases).toContain('Kael the Watcher');
    const bramAligned = await getArtifact(bramProduced.id);
    expect(bramAligned?.name).toBe('Bram');
  });

  it('reports entities whose runs failed instead of finishing silently', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await seedBuiltInPersonas();
    const mira = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Mira' });
    const bramProduced = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Bram of the Tide',
    });

    // First chain: Kael's run fails. Second chain (the loop retries with the
    // remaining names): Bram completes.
    chainMocks.run
      .mockResolvedValueOnce({
        steps: [
          { runId: 'run-kael', status: 'failed', artifactId: null, title: 'Detail: Kael' },
        ],
        currentIndex: 1,
        status: 'failed',
      })
      .mockResolvedValueOnce({
        steps: [
          {
            runId: 'run-bram',
            status: 'completed',
            artifactId: bramProduced.id,
            title: 'Detail: Bram',
          },
        ],
        currentIndex: 1,
        status: 'completed',
      });

    render(
      <EntityPanel
        module={moduleFixture(campaign.id)}
        artifacts={[mira]}
        campaign={campaign}
        onStub={vi.fn()}
        onOpenCard={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId('batch-npc'));

    // Kael is named loudly; Bram was still generated on the retry chain.
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        '1 of 2 npcs failed to generate — see the Runs tab (Kael)',
      );
    });
    expect(chainMocks.run).toHaveBeenCalledTimes(2);
    await waitFor(async () => {
      const saved = await getArtifact(bramProduced.id);
      expect(saved?.name).toBe('Bram');
      expect(saved?.tags).toContain('module:Ember Crypt');
    });
    // Drain to the batch end — no trailing updates for the next test.
    await waitFor(() => {
      expect(screen.getByTestId('batch-npc')).toHaveTextContent('Generate 2 npc');
    });
  });

  it('does not count not-yet-run steps as failures when a chain stops early', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await seedBuiltInPersonas();
    const mira = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Mira' });
    const kaelProduced = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Kael the Watcher',
    });
    const coraProduced = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Cora of the Crypt',
    });
    const base = moduleFixture(campaign.id);
    const module = moduleSchema.parse({
      ...base,
      spine: {
        ...base.spine,
        premise: `${PREMISE} [[Cora]] tends the graves.`,
      },
      entityKinds: [...base.entityKinds, { name: 'Cora', kind: 'npc' }],
    });

    // The REAL chain runner pre-fills every step as 'pending' and stops at
    // the first failure. Counting non-completed steps said "12 of 9 failed"
    // when 2 runs died — every retry round recounted the pending tail.
    chainMocks.run
      .mockResolvedValueOnce({
        steps: [
          {
            runId: 'run-kael',
            status: 'completed',
            artifactId: kaelProduced.id,
            title: 'Detail: Kael',
          },
          { runId: 'run-bram', status: 'failed', artifactId: null, title: 'Detail: Bram' },
          { runId: null, status: 'pending', artifactId: null, title: 'Detail: Cora' },
        ],
        currentIndex: 2,
        status: 'failed',
      })
      .mockResolvedValueOnce({
        steps: [
          {
            runId: 'run-cora',
            status: 'completed',
            artifactId: coraProduced.id,
            title: 'Detail: Cora',
          },
        ],
        currentIndex: 1,
        status: 'completed',
      });

    render(
      <EntityPanel
        module={module}
        artifacts={[mira]}
        campaign={campaign}
        onStub={vi.fn()}
        onOpenCard={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId('batch-npc'));

    // Exactly the entities without a produced artifact — no pending recount.
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        '1 of 3 npcs failed to generate — see the Runs tab (Bram)',
      );
    });
    expect(chainMocks.run).toHaveBeenCalledTimes(2);
    await waitFor(async () => {
      const cora = await getArtifact(coraProduced.id);
      expect(cora?.name).toBe('Cora');
      expect(cora?.tags).toContain('module:Ember Crypt');
    });
    await waitFor(() => {
      expect(screen.getByTestId('batch-npc')).toHaveTextContent('Generate 3 npc');
    });
  });

  it('reports batch progress to the app-wide dock while the chain runs', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await seedBuiltInPersonas();
    const mira = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Mira' });
    const produced = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Kael the Watcher',
    });
    const bramProduced = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Bram of the Tide',
    });

    // Deferred chain: the batch hangs until the test releases it, so the
    // mid-run dock state is observable.
    let releaseChain!: (state: ChainState) => void;
    const chainDone = new Promise<ChainState>((resolve) => {
      releaseChain = resolve;
    });
    chainMocks.run.mockImplementation(() => chainDone);

    render(
      <>
        <EntityPanel
          module={moduleFixture(campaign.id)}
          artifacts={[mira]}
          campaign={campaign}
          onStub={vi.fn()}
          onOpenCard={vi.fn()}
        />
        {/* The dock mounts app-wide from AppShell; the store is the seam. */}
        <ProgressDock />
      </>,
    );
    await user.click(screen.getByTestId('batch-npc'));

    // The dock shows the batch job once the batch starts — a bare disabled
    // button is not a progress experience (00-OVERVIEW).
    await waitFor(() => {
      expect(screen.getByTestId('progress-label')).toHaveTextContent('Generating 2 npcs');
    });

    // Chain running on the first step: the detail names the entity being
    // detailed and the bar sits at that entity's coarse fraction.
    act(() => {
      for (const listener of chainMocks.listeners) {
        listener({
          steps: [
            { runId: 'run-kael', status: 'running', artifactId: null, title: 'Detail: Kael' },
            { runId: null, status: 'pending', artifactId: null, title: 'Detail: Bram' },
          ],
          currentIndex: 0,
          status: 'running',
        });
      }
    });
    expect(screen.getByTestId('progress-detail')).toHaveTextContent('Generating Kael…');
    expect(screen.getByTestId('progress-bar')).toHaveAttribute('aria-valuenow', '0');

    // Release the chain: completed steps advance the bar; when the batch
    // ends the dock disappears and the store is drained.
    act(() => {
      releaseChain(completedChainState(produced, bramProduced));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('progress-dock')).not.toBeInTheDocument();
    });
    expect(useProgressStore.getState().jobs).toEqual([]);
  });
});
