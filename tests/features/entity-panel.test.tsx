import 'fake-indexeddb/auto';

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getArtifact, listArtifactsByCampaign, updateArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createImage, getImage } from '@/db/imageRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import { listPersonas } from '@/db/personaRepo';
import { listRunsByCampaign } from '@/db/runRepo';
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
  type Id,
  type Module,
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
import { clearDatabase } from '../db/helpers';

/**
 * Entity panel (08-M4-C): useModuleEntities ordering (resolved first, then
 * total mentions desc), stub rows and per-kind batch buttons, and the batch
 * run (chat mocked at the seam — the batch drives real runEngine runs)
 * tagging its produced artifacts with the module tag.
 */

/** A valid npc draft reply — one per run; alignment renames to the entity. */
const BATCH_DRAFT = {
  name: 'Watcher of the Crypt',
  summary: 'A quiet warden of the seal.',
  suggestedTags: ['warden'],
  body: '# Watcher\nKeeps the seal and counts visitors.',
  appearance: 'Weathered leathers and a brass key-ring.',
  personality: 'Quiet and observant.',
  needsStatBlock: true,
};

const BATCH_STATBLOCK = {
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

/** Batch chat responder: statblock calls are told apart by their prompt. The
 * override receives the PLAIN user content (the stringified form escapes the
 * quotes around entity names). */
function respondToBatch(
  override?: (
    content: string,
  ) => Promise<{ text: string; modelUsed: string; fallback: null }> | undefined,
): (messages: unknown[]) => Promise<{ text: string; modelUsed: string; fallback: null }> {
  return async (messages) => {
    const chatMessages = messages as { role: string; content: string }[];
    const content = chatMessages.map((message) => message.content).join('\n');
    const raw = JSON.stringify(messages);
    if (raw.includes('Fill the StatBlock for')) {
      return { text: JSON.stringify(BATCH_STATBLOCK), modelUsed: 'test-model', fallback: null };
    }
    const overridden = override?.(content);
    if (overridden !== undefined) return overridden;
    return { text: JSON.stringify(BATCH_DRAFT), modelUsed: 'test-model', fallback: null };
  };
}

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
    chatMock.mockResolvedValue({ text: JSON.stringify({ prompt: 'A portrait', negative: '', styleNotes: 'ink' }), modelUsed: 'test-model', fallback: null });
    generateImagesMock.mockResolvedValue({ images: [new Blob(['gen'])], costUsd: 0.01, cappedToOne: false, modelUsed: 'test-image-model' });
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

  it('runs a batch for an unresolved kind with the stub persona and tags the produced artifacts', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await seedBuiltInPersonas();
    const mira = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Mira' });

    const draftTexts: string[] = [];
    chatMock.mockImplementation(async (messages) => {
      const result = respondToBatch()(messages);
      const text = JSON.stringify(messages);
      if (!text.includes('Fill the StatBlock for')) {
        // Collect the plain user content (the stringified form escapes the
        // quotes inside `Detail the entity "Kael"`).
        const chatMessages = messages as { role: string; content: string }[];
        draftTexts.push(chatMessages.map((message) => message.content).join('\n'));
      }
      return result;
    });

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

    // One run per unresolved entity: each draft prompt is the prebuilt brief
    // (module text around the wiki-link), built from the stub persona slug.
    await waitFor(() => {
      expect(draftTexts).toHaveLength(2);
    });
    expect(draftTexts.some((text) => text.includes('Detail the entity "Kael"'))).toBe(true);
    expect(draftTexts.some((text) => text.includes('Detail the entity "Bram"'))).toBe(true);
    expect(draftTexts.some((text) => text.includes('[[Kael]] watches the gate.'))).toBe(true);

    // The runs are real PersonaRuns driven by the stub persona in auto mode.
    const personas = await listPersonas();
    const npcSmith = personas.find((candidate) => candidate.slug === STUB_PERSONA_SLUGS.npc);
    const runs = await listRunsByCampaign(campaign.id);
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.personaId === npcSmith?.id)).toBe(true);
    expect(runs.every((run) => run.autonomy === 'auto')).toBe(true);

    // Produced artifacts gain the module tag AND the owning module
    // (10-MILESTONE-6 M6-B — ownership is written, never inferred), are
    // aligned to the EXACT entity name ([[Kael]] resolves), and keep the
    // model's invented name as an alias.
    await waitFor(async () => {
      const artifacts = await listArtifactsByCampaign(campaign.id);
      expect(artifacts.map((artifact) => artifact.name).sort()).toEqual(['Bram', 'Kael', 'Mira']);
    });
    const artifacts = await listArtifactsByCampaign(campaign.id);
    const kael = artifacts.find((artifact) => artifact.name === 'Kael');
    expect(kael?.aliases).toContain('Watcher of the Crypt');
    expect(kael?.tags).toContain('module:Ember Crypt');
    expect(kael?.moduleId).toBe(module.id);
    const bram = artifacts.find((artifact) => artifact.name === 'Bram');
    expect(bram?.moduleId).toBe(module.id);
    if (kael?.kind === 'npc') {
      expect(kael.data.statBlock?.ac).toBe(15);
    }
    // Drain the batch to its end so no trailing state update leaks into the
    // next test.
    await waitFor(() => {
      expect(screen.getByTestId('batch-npc')).toHaveTextContent('Generate 2 npc');
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('reports entities whose runs failed instead of finishing silently', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await seedBuiltInPersonas();
    const mira = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Mira' });

    // Kael's draft call fails; Bram's run completes.
    chatMock.mockImplementation(async (messages) =>
      respondToBatch((text) => {
        if (text.includes('Detail the entity "Kael"')) {
          return Promise.reject(new Error('gateway down'));
        }
        return undefined;
      })(messages),
    );

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

    // Kael is named loudly; Bram was still generated in parallel.
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        '1 of 2 npcs failed to generate — see the Runs tab (Kael)',
      );
    });
    await waitFor(async () => {
      const bram = (await listArtifactsByCampaign(campaign.id)).find(
        (artifact) => artifact.name === 'Bram',
      );
      expect(bram?.tags).toContain('module:Ember Crypt');
    });
    // Drain to the batch end — no trailing updates for the next test.
    await waitFor(() => {
      expect(screen.getByTestId('batch-npc')).toHaveTextContent('Generate 2 npc');
    });
  });

  it('counts every entity without a produced artifact exactly once', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await seedBuiltInPersonas();
    const mira = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Mira' });

    // Both runs fail: the failed list is the produced-artifact diff, not a
    // run-status tally — one entry per entity, never doubled.
    chatMock.mockImplementation(() => {
      throw new Error('gateway down');
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

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        '2 of 2 npcs failed to generate — see the Runs tab (Kael, Bram)',
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('batch-npc')).toHaveTextContent('Generate 2 npc');
    });
  });

  it('reports exactly the entities without a produced artifact when some runs fail', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await seedBuiltInPersonas();
    const mira = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Mira' });
    const base = moduleFixture(campaign.id);
    const module = moduleSchema.parse({
      ...base,
      spine: {
        ...base.spine,
        premise: `${PREMISE} [[Cora]] tends the graves.`,
      },
      entityKinds: [...base.entityKinds, { name: 'Cora', kind: 'npc', absorbed: [] }],
    });

    // Bram's draft call fails; Kael and Cora complete in parallel. The
    // failed list is the produced-artifact diff, not a run-status tally —
    // under the old chain it recounted the pending tail ("12 of 9 failed").
    chatMock.mockImplementation(async (messages) =>
      respondToBatch((text) => {
        if (text.includes('Detail the entity "Bram"')) {
          return Promise.reject(new Error('gateway down'));
        }
        return undefined;
      })(messages),
    );

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

    // Exactly the entities without a produced artifact.
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        '1 of 3 npcs failed to generate — see the Runs tab (Bram)',
      );
    });
    await waitFor(async () => {
      const artifacts = await listArtifactsByCampaign(campaign.id);
      expect(artifacts.map((artifact) => artifact.name).sort()).toEqual(['Cora', 'Kael', 'Mira']);
    });
    const cora = (await listArtifactsByCampaign(campaign.id)).find(
      (artifact) => artifact.name === 'Cora',
    );
    expect(cora?.tags).toContain('module:Ember Crypt');
    await waitFor(() => {
      expect(screen.getByTestId('batch-npc')).toHaveTextContent('Generate 3 npc');
    });
  });

  it('reports batch progress to the app-wide dock while the runs execute', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await seedBuiltInPersonas();
    const mira = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Mira' });

    // Deferred DRAFT calls: both pool slots stay busy, so the mid-run dock
    // state is observable.
    let releaseDrafts!: () => void;
    const draftGate = new Promise<void>((resolve) => {
      releaseDrafts = resolve;
    });
    chatMock.mockImplementation(async (messages) => {
      const text = JSON.stringify(messages);
      if (text.includes('Fill the StatBlock for')) {
        return { text: JSON.stringify(BATCH_STATBLOCK), modelUsed: 'test-model', fallback: null };
      }
      await draftGate;
      return { text: JSON.stringify(BATCH_DRAFT), modelUsed: 'test-model', fallback: null };
    });

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

    // Both entities are in flight (parallel pool, limit 2): the detail names
    // them, and the bar has not advanced yet.
    await waitFor(() => {
      const detail = screen.getByTestId('progress-detail').textContent;
      expect(detail).toContain('Kael');
      expect(detail).toContain('Bram');
    });
    expect(screen.getByTestId('progress-bar')).toHaveAttribute('aria-valuenow', '0');

    // Release the drafts: runs complete, the dock disappears and the store
    // is drained.
    act(() => {
      releaseDrafts();
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
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({
        entities: [
          { name: 'Mira', canonical: 'Mira', kind: 'npc' },
          { name: 'Undercroft', canonical: 'Undercroft', kind: 'location' },
          { name: 'Kael', canonical: 'Kael', kind: 'npc' },
          { name: 'Bram', canonical: 'Bram', kind: 'npc' },
          { name: 'The Tide Bell', canonical: 'The Tide Bell', kind: 'note' },
        ],
      }), modelUsed: 'test-model', fallback: null });
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
