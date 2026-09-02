import 'fake-indexeddb/auto';

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getArtifact, updateArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createImage, getImage } from '@/db/imageRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import { listPersonas } from '@/db/personaRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { updateSettings } from '@/db/settingsRepo';
import { db } from '@/db/db';
import {
  createArtifact as buildArtifact,
  createModule,
  moduleSchema,
  newId,
  type AnyArtifact,
  type Artifact,
  type Autonomy,
  type Id,
  type Module,
  type Persona,
} from '@/domain';
import { EntityPanel, useModuleEntities } from '@/features/modules/entity-panel';
import { useEntityImageQueue } from '@/features/modules/entity-image-queue';
import { STUB_PERSONA_SLUGS } from '@/features/modules/persona-request';
import { ProgressDock } from '@/features/progress/progress-dock';
import { useProgressStore } from '@/lib/progress';

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

// The image queue's LLM/image entry points — the panel test drives the queue
// with real Dexie rows but mocked generation.
vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
  fetchWithHeadersTimeout: vi.fn(),
}));
vi.mock('@/llm/imageGen', () => ({ generateImages: vi.fn() }));
vi.mock('@/lib/imageIntake', () => ({ intakeImage: vi.fn() }));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { generateImages } = await import('@/llm/imageGen');
const generateImagesMock = vi.mocked(generateImages);
const { intakeImage } = await import('@/lib/imageIntake');
const intakeImageMock = vi.mocked(intakeImage);

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
      { name: 'Undercroft', kind: 'location', absorbed: [] },
      { name: 'Kael', kind: 'npc', absorbed: [] },
      { name: 'Bram', kind: 'npc', absorbed: [] },
    ],
    entityNamesNormalized: true,
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

  it('lists entities in first-mention order (premise first, then parts by plan index)', () => {
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
    useEntityImageQueue.setState({ queued: [], active: null });
    chatMock.mockReset();
    generateImagesMock.mockReset();
    intakeImageMock.mockReset();
    toastErrorMock.mockClear();
  });
  afterEach(cleanup);

  it('seeds a module-anchored battle from an encounter row', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Battle campaign', system: 'dnd5e' });
    const base = moduleFixture(campaign.id);
    const module = moduleSchema.parse({
      ...base,
      spine: {
        ...base.spine,
        premise: 'Face [[Bridge Ambush]].',
      },
      entityKinds: [],
    });
    const encounter = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'encounter',
      name: 'Bridge Ambush',
    });
    render(
      <EntityPanel
        module={module}
        artifacts={[encounter]}
        campaign={campaign}
        onStub={vi.fn()}
        onOpenCard={vi.fn()}
      />,
    );

    expect(await screen.findByTestId('generate-encounter-maps')).toHaveTextContent(
      'Generate 1 encounter map',
    );
    await user.click(await screen.findByTestId('run-battle'));
    await waitFor(async () => {
      const battle = await db.battles.where('moduleId').equals(module.id).first();
      expect(battle?.encounterArtifactId).toBe(encounter.id);
    });
  });

  it('renders entity rows in mention order with kind badges, unresolved stub rows, and per-kind batch buttons', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const mira = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Mira' });
    const onStub = vi.fn<(name: string, anchor: { x: number; y: number }) => void>();
    const onOpenCard = vi.fn<(artifact: AnyArtifact) => void>();

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

    // Resolved rows open the entity card; unresolved rows open the stub
    // popover. (Star toggles have their own labels — pick rows by content.)
    const rowByName = (name: string): HTMLElement => {
      const row = screen
        .getAllByTestId('entity-row')
        .find((candidate) => candidate.textContent.includes(name));
      if (row === undefined) throw new Error(`No entity row for ${name}`);
      return row;
    };
    await user.click(rowByName('Mira'));
    expect(onOpenCard).toHaveBeenCalledTimes(1);
    expect(onOpenCard).toHaveBeenCalledWith(mira);
    await user.click(rowByName('Kael'));
    expect(onOpenCard).toHaveBeenCalledTimes(1);
    const stubCall = onStub.mock.calls.at(0);
    expect(stubCall?.[0]).toBe('Kael');
    expect(stubCall?.[1]?.x).toEqual(expect.any(Number));
    expect(stubCall?.[1]?.y).toEqual(expect.any(Number));
  });

  it('sorts alphabetically when the module says so; the sort button persists the toggle', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const mira = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Mira' });
    const base = moduleFixture(campaign.id);
    const module = moduleSchema.parse({ ...base, entitySort: 'alphabetical' });
    await saveModule(module);

    render(
      <EntityPanel
        module={module}
        artifacts={[mira]}
        campaign={campaign}
        onStub={vi.fn()}
        onOpenCard={vi.fn()}
      />,
    );

    const rows = screen.getAllByTestId('entity-row');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent('Bram');
    expect(rows[1]).toHaveTextContent('Kael');
    expect(rows[2]).toHaveTextContent('Mira');
    expect(rows[3]).toHaveTextContent('The Tide Bell');
    expect(rows[4]).toHaveTextContent('Undercroft');
    expect(screen.getByTestId('entity-sort')).toHaveTextContent('A–Z');

    // Toggling persists the OTHER mode on the module row.
    await user.click(screen.getByTestId('entity-sort'));
    const saved = await getModule(module.id);
    expect(saved?.entitySort).toBe('mention');
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('groups focused entities first (case-insensitive) and persists focus toggles', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const mira = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Mira' });
    const base = moduleFixture(campaign.id);
    // Stored lowercase on purpose: focus matching is case-insensitive, like
    // wiki-link resolution.
    const module = moduleSchema.parse({ ...base, focusedEntities: ['kael'] });
    await saveModule(module);

    const harness = (
      <EntityPanel
        module={module}
        artifacts={[mira]}
        campaign={campaign}
        onStub={vi.fn()}
        onOpenCard={vi.fn()}
      />
    );
    const view = render(harness);

    const focused = screen.getByTestId('focused-group');
    const focusedRows = within(focused).getAllByTestId('entity-row');
    expect(focusedRows).toHaveLength(1);
    expect(focusedRows[0]).toHaveTextContent('Kael');
    expect(
      within(focused).getByRole('button', { name: 'Unfocus Kael' }),
    ).toHaveAttribute('aria-pressed', 'true');

    // Unfocused keeps mention order minus the focused entity.
    const rest = within(screen.getByTestId('unfocused-group')).getAllByTestId('entity-row');
    expect(rest[0]).toHaveTextContent('Mira');
    expect(rest[1]).toHaveTextContent('Undercroft');
    expect(rest[2]).toHaveTextContent('Bram');
    expect(rest[3]).toHaveTextContent('The Tide Bell');

    // Unfocusing persists an empty list…
    await user.click(within(focused).getByRole('button', { name: 'Unfocus Kael' }));
    expect((await getModule(module.id))?.focusedEntities).toEqual([]);
    // …and focusing from a fresh render (the prop updates via live query).
    const updated = moduleSchema.parse({ ...base, focusedEntities: [] });
    await saveModule(updated);
    view.rerender(
      <EntityPanel
        module={updated}
        artifacts={[mira]}
        campaign={campaign}
        onStub={vi.fn()}
        onOpenCard={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Focus Bram' }));
    expect((await getModule(module.id))?.focusedEntities).toEqual(['Bram']);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('images mode: checkbox states queue generation, and deletion needs confirmation', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await seedBuiltInPersonas();
    await updateSettings({ imagesEnabled: true });
    chatMock.mockResolvedValue(
      JSON.stringify({ prompt: 'A portrait', negative: '', styleNotes: 'ink' }),
    );
    generateImagesMock.mockResolvedValue({ images: [new Blob(['gen'])], costUsd: 0.01, cappedToOne: false });
    intakeImageMock.mockResolvedValue({
      blob: new Blob(['intake']),
      mimeType: 'image/webp',
      width: 64,
      height: 64,
    });

    const miraStale = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Mira' });
    const undercroft = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Undercroft',
    });
    const existing = await createImage({
      campaignId: campaign.id,
      blob: new Blob(['mira-img'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 4,
      height: 4,
      source: 'uploaded',
    });
    const mira = await updateArtifact(miraStale.id, {
      imageIds: [existing.id],
      coverImageId: existing.id,
    });

    render(
      <EntityPanel
        module={moduleFixture(campaign.id)}
        artifacts={[mira, undercroft]}
        campaign={campaign}
        onStub={vi.fn()}
        onOpenCard={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId('entity-images'));


    // Mira has an image → checked; Undercroft is resolved without one;
    // Kael is unresolved → the checkbox is disabled (nothing to attach to).
    expect(
      screen.getByRole('checkbox', { name: 'Mira has an image — uncheck to delete it' }),
    ).toHaveAttribute('aria-checked', 'true');
    const undercroftCheck = screen.getByRole('checkbox', {
      name: 'Generate an image for Undercroft',
    });
    expect(undercroftCheck).not.toBeDisabled();
    expect(
      screen.getByRole('checkbox', { name: 'Generate an image for Kael' }),
    ).toHaveAttribute('aria-disabled', 'true');

    // Checking Undercroft enqueues it; the queue generates and attaches.
    await user.click(undercroftCheck);
    await waitFor(async () => {
      const saved = await getArtifact(undercroft.id);
      expect(saved?.imageIds).toHaveLength(1);
      expect(saved?.coverImageId).not.toBeNull();
    });
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).not.toHaveBeenCalled();

    // Unchecking the entity WITH an image asks before deleting…
    await user.click(
      screen.getByRole('checkbox', { name: 'Mira has an image — uncheck to delete it' }),
    );
    expect(screen.getByTestId('image-delete-dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByTestId('image-delete-dialog')).not.toBeInTheDocument();
    });
    expect((await getArtifact(mira.id))?.imageIds).toHaveLength(1);

    // …and confirming detaches it and deletes the now-unreferenced file.
    await user.click(
      screen.getByRole('checkbox', { name: 'Mira has an image — uncheck to delete it' }),
    );
    await user.click(screen.getByTestId('confirm-image-delete'));
    await waitFor(async () => {
      const saved = await getArtifact(mira.id);
      expect(saved?.imageIds).toHaveLength(0);
      expect(saved?.coverImageId).toBeNull();
    });
    // The deletion detaches first, then frees the blob — poll for both.
    await waitFor(async () => {
      expect(await getImage(existing.id)).toBeUndefined();
    });
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

    const module = moduleFixture(campaign.id);
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

    // After the chain completes, the produced artifacts gain the module tag
    // AND the owning module (10-MILESTONE-6 M6-B — ownership is written,
    // never inferred from the tag).
    await waitFor(async () => {
      const tagged = await getArtifact(produced.id);
      expect(tagged?.tags).toContain('module:Ember Crypt');
      expect(tagged?.moduleId).toBe(module.id);
    });
    const bramScoped = await getArtifact(bramProduced.id);
    expect(bramScoped?.moduleId).toBe(module.id);
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
      entityKinds: [...base.entityKinds, { name: 'Cora', kind: 'npc', absorbed: [] }],
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

describe('EntityPanel — normalization state (fix-01)', () => {
  beforeEach(clearDatabase);
  beforeEach(() => {
    chainMocks.run.mockReset();
    useProgressStore.getState().reset();
    chatMock.mockReset();
    toastErrorMock.mockClear();
  });
  afterEach(cleanup);

  /** The panel module, saved so the normalization pass can patch the row. */
  async function seedNormalizedModule(
    campaignId: Id,
    overrides: Partial<Module> = {},
  ): Promise<Module> {
    const module = moduleSchema.parse({ ...moduleFixture(campaignId), ...overrides });
    await saveModule(module);
    return module;
  }

  it('gates batch generation behind the normalization flag with a visible reason', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedNormalizedModule(campaign.id, { entityNamesNormalized: false });

    render(
      <EntityPanel
        module={module}
        artifacts={[]}
        campaign={campaign}
        onStub={vi.fn()}
        onOpenCard={vi.fn()}
      />,
    );

    const npcButton = screen.getByTestId('batch-npc');
    expect(npcButton).toBeDisabled();
    expect(screen.getByTestId('batch-gate-reason')).toHaveTextContent(
      'Entity names are not normalized yet',
    );
    // The manual pass trigger is available.
    expect(screen.getByTestId('entity-normalize')).toBeInTheDocument();
  });

  it('shows the failed-pass banner with the error, and Retry re-runs the pass successfully', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await updateSettings({ defaultChatModel: 'test/fixture-model' });
    const module = await seedNormalizedModule(campaign.id, {
      entityNamesNormalized: false,
      entityNormalizationError: 'the normalization reply violated its contract: omitted names',
    });

    render(
      <EntityPanel
        module={module}
        artifacts={[]}
        campaign={campaign}
        onStub={vi.fn()}
        onOpenCard={vi.fn()}
      />,
    );

    // The failed state is loud, and the reason names the gate.
    expect(screen.getByTestId('entity-normalize-error')).toHaveTextContent(
      'omitted names',
    );
    expect(screen.getByTestId('batch-gate-reason')).toHaveTextContent('normalization failed');

    // Retry runs the pass for real: every extracted name self-maps.
    chatMock.mockResolvedValueOnce(
      JSON.stringify({
        entities: [
          { name: 'Mira', canonical: 'Mira', kind: 'npc' },
          { name: 'Undercroft', canonical: 'Undercroft', kind: 'location' },
          { name: 'Kael', canonical: 'Kael', kind: 'npc' },
          { name: 'Bram', canonical: 'Bram', kind: 'npc' },
          { name: 'The Tide Bell', canonical: 'The Tide Bell', kind: 'note' },
        ],
      }),
    );
    await user.click(screen.getByTestId('entity-normalize-retry'));

    // The panel prop is a static snapshot here (no live query in this test),
    // so the row itself is the ground truth for the retry's effect.
    await waitFor(async () => {
      expect((await getModule(module.id))?.entityNamesNormalized).toBe(true);
    });
    const after = await getModule(module.id);
    expect(after?.entityNormalizationError).toBe('');
    expect(after?.entityKinds.map((entry) => entry.name)).toEqual([
      'Mira',
      'Undercroft',
      'Kael',
      'Bram',
      'The Tide Bell',
    ]);
  }, 20_000);

  it('applies stored proposals to the documents current text on confirm', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const fixtureSpine = moduleFixture(campaign.id).spine;
    if (fixtureSpine === null) throw new Error('fixture spine missing');
    const module = await seedNormalizedModule(campaign.id, {
      spine: { ...fixtureSpine, premise: `${PREMISE} [[Guard Mira]] was seen at dusk.` },
      entityRewriteProposals: [
        { planIndex: -1, replacements: [{ from: 'Guard Mira', to: 'Mira' }] },
        { planIndex: 0, replacements: [{ from: 'Guard Mira', to: 'Mira' }] },
      ],
      parts: [
        {
          planIndex: 0,
          status: 'ready' as const,
          errorMessage: '',
          edited: true,
          markdown: 'The tide rose. [[Guard Mira]] kept the watch.',
        },
      ],
    });

    render(
      <EntityPanel
        module={module}
        artifacts={[]}
        campaign={campaign}
        onStub={vi.fn()}
        onOpenCard={vi.fn()}
      />,
    );

    expect(screen.getByTestId('entity-proposals-banner')).toHaveTextContent(
      'Normalization wants to update hand-edited text',
    );
    await user.click(screen.getByTestId('entity-proposals-review'));
    const dialog = screen.getByTestId('entity-proposals-dialog');
    expect(within(dialog).getByTestId('entity-proposals-list')).toHaveTextContent('Premise');
    expect(within(dialog).getByTestId('entity-proposals-list')).toHaveTextContent('Part 1');
    await user.click(within(dialog).getByTestId('entity-proposals-apply'));

    const after = await getModule(module.id);
    expect(after?.entityRewriteProposals).toBeNull();
    // The premise took the proposal path and is now rewritten — display text
    // preserved, target canonical.
    expect(after?.spine?.premise).toContain('[[Mira|Guard Mira]]');
    expect(after?.parts[0]?.markdown).toContain('[[Mira|Guard Mira]]');
  }, 20_000);

  it('drops the proposals on decline — nothing is rewritten', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const fixtureSpine = moduleFixture(campaign.id).spine;
    if (fixtureSpine === null) throw new Error('fixture spine missing');
    const module = await seedNormalizedModule(campaign.id, {
      spine: { ...fixtureSpine, premise: `${PREMISE} [[Guard Mira]] was seen at dusk.` },
      entityRewriteProposals: [
        { planIndex: -1, replacements: [{ from: 'Guard Mira', to: 'Mira' }] },
      ],
      parts: [
        {
          planIndex: 0,
          status: 'ready' as const,
          errorMessage: '',
          edited: true,
          markdown: 'The tide rose. [[Guard Mira]] kept the watch.',
        },
      ],
    });

    render(
      <EntityPanel
        module={module}
        artifacts={[]}
        campaign={campaign}
        onStub={vi.fn()}
        onOpenCard={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId('entity-proposals-review'));
    await user.click(screen.getByTestId('entity-proposals-decline'));

    const after = await getModule(module.id);
    expect(after?.entityRewriteProposals).toBeNull();
    expect(after?.spine?.premise).toContain('[[Guard Mira]] was seen at dusk.');
    expect(after?.parts[0]?.markdown).toContain('[[Guard Mira]]');
  }, 20_000);
});
