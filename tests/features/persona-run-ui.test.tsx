import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { artifactPath } from '@/app/routes';
import { createArtifact, publishToLibrary } from '@/db/artifactRepo';
import { createCampaign, listCampaigns } from '@/db/campaignRepo';
import { createPersona } from '@/db/personaRepo';
import { createRun, getRun, listRunsByCampaign, updateRun } from '@/db/runRepo';
import type { Campaign, Persona } from '@/domain';
import { PersonaPanel } from '@/features/campaign/components/persona-panel';
import { runEngine } from '@/llm/runEngine';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';
import { useProgressStore } from '@/lib/progress';

/**
 * Persona panel run lifecycle UI (08-TESTING matrix gap): start a run through
 * the real panel with a mocked chat and drive the pause-state actions —
 * Approve, Edit (JSON step edit), Cancel, Retry, and the completed
 * "Open artifact" affordance. Engine semantics themselves are covered in
 * tests/llm/runEngine.test.ts; this file pins the UI around them.
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

vi.mock('@/llm/imageGen', () => ({
  generateImages: vi.fn(),
}));

vi.mock('@/lib/imageIntake', () => ({
  intakeImage: vi.fn(),
  blobToScaledDataUrl: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { generateImages } = await import('@/llm/imageGen');
const generateImagesMock = vi.mocked(generateImages);
const { intakeImage } = await import('@/lib/imageIntake');
const intakeImageMock = vi.mocked(intakeImage);

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

async function seed(): Promise<{ campaign: Campaign; persona: Persona }> {
  const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
  const persona = await createPersona({
    slug: 'npc-smith-ui',
    name: 'NPC Smith',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    producesKind: 'npc',
    builtIn: true,
  });
  return { campaign, persona };
}

/** Selects the persona in the combobox and starts a run with a brief. */
async function startRun(user: ReturnType<typeof userEvent.setup>, persona: Persona): Promise<void> {
  await user.click(await screen.findByRole('combobox', { name: 'Persona' }));
  await user.click(await screen.findByRole('option', { name: persona.name }));
  await user.type(screen.getByLabelText('Brief'), 'a goblin alchemist boss for a level 3 party');
  await user.click(screen.getByTestId('start-run'));
}

async function setAutonomy(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: 'Autonomy' }));
  await user.click(await screen.findByRole('option', { name: label }));
}

/** Each test seeds exactly one campaign and starts exactly one run. */
async function onlyRunId(): Promise<string> {
  const campaigns = await listCampaigns();
  const campaign = campaigns[0];
  if (campaigns.length !== 1 || campaign === undefined) {
    throw new Error(`expected one campaign, found ${campaigns.length}`);
  }
  const runs = await listRunsByCampaign(campaign.id);
  const run = runs[0];
  if (runs.length !== 1 || run === undefined) {
    throw new Error(`expected exactly one run, found ${runs.length}`);
  }
  return run.id;
}

beforeEach(async () => {
  await clearDatabase();
  useProgressStore.getState().reset();
});
afterEach(() => {
  useProgressStore.getState().reset();
  chatMock.mockReset();
  generateImagesMock.mockReset();
  intakeImageMock.mockReset();
  vi.restoreAllMocks();
});

describe('PersonaPanel run lifecycle', () => {
  it('manual run pauses with Approve; approving runs the statblock step', async () => {
    const user = userEvent.setup();
    const { campaign, persona } = await seed();
    chatMock
      .mockResolvedValueOnce(JSON.stringify(VALID_DRAFT))
      .mockResolvedValueOnce(JSON.stringify(VALID_STATBLOCK));
    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await startRun(user, persona);

    // The ActiveRun view shows the pause state with the step log.
    const active = await screen.findByTestId('active-run', {}, { timeout: 10_000 });
    expect(await within(active).findByText('awaiting you')).toBeInTheDocument();
    expect(within(active).getByText('retrieve')).toBeInTheDocument();
    expect(within(active).getByText('draft')).toBeInTheDocument();
    expect(within(active).getByTestId('approve-step')).toBeInTheDocument();
    expect(within(active).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(active).getByRole('button', { name: 'Cancel run' })).toBeInTheDocument();

    // Approve drives the engine to the statblock step, which pauses again.
    await user.click(within(active).getByTestId('approve-step'));
    await waitFor(
      async () => {
        const run = await getRun(await onlyRunId());
        expect(run?.steps.map((step) => step.name)).toEqual(['retrieve', 'draft', 'statblock']);
        expect(run?.status).toBe('awaiting_user');
      },
      { timeout: 10_000 },
    );
    await flushAsyncUpdates();
  }, 30000);

  it('edit mode pre-fills the step JSON and Save & continue completes the run', async () => {
    const user = userEvent.setup();
    const { campaign, persona } = await seed();
    chatMock
      .mockResolvedValueOnce(JSON.stringify(VALID_DRAFT))
      .mockResolvedValueOnce(JSON.stringify(VALID_STATBLOCK));
    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await startRun(user, persona);
    const active = await screen.findByTestId('active-run', {}, { timeout: 10_000 });
    await within(active).findByText('awaiting you');

    await user.click(within(active).getByRole('button', { name: 'Edit' }));
    const edit = await screen.findByLabelText('Edited step output (JSON)');
    // The textarea is pre-filled with the step's raw output as JSON.
    expect((edit as HTMLTextAreaElement).value).toContain('"Grix"');

    // Save & continue re-validates the edited JSON and runs the next step.
    await user.click(screen.getByRole('button', { name: 'Save & continue' }));
    await waitFor(
      async () => {
        const run = await getRun(await onlyRunId());
        expect(run?.status).toBe('awaiting_user');
        expect(run?.steps.map((step) => step.name)).toEqual(['retrieve', 'draft', 'statblock']);
      },
      { timeout: 10_000 },
    );

    // Approve the statblock: the run completes and offers the artifact link.
    await user.click(screen.getByTestId('approve-step'));
    await waitFor(
      async () => {
        const run = await getRun(await onlyRunId());
        if (run?.status !== 'completed') throw new Error('run not completed yet');
        const resultId = run.resultArtifactId;
        if (resultId === null) throw new Error('completed run has no result artifact');
        const link = screen.getByRole('button', { name: 'Open artifact' });
        expect(link).toHaveAttribute('href', artifactPath(campaign.id, resultId));
      },
      { timeout: 10_000 },
    );
    await flushAsyncUpdates();
  }, 30000);

  it('cancel from the paused view marks the run cancelled', async () => {
    const user = userEvent.setup();
    const { campaign, persona } = await seed();
    chatMock.mockResolvedValue(JSON.stringify(VALID_DRAFT));
    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await startRun(user, persona);
    const active = await screen.findByTestId('active-run', {}, { timeout: 10_000 });
    await within(active).findByText('awaiting you');

    await user.click(within(active).getByRole('button', { name: 'Cancel run' }));
    await waitFor(
      async () => {
        const run = await getRun(await onlyRunId());
        expect(run?.status).toBe('cancelled');
        expect(run?.resultArtifactId).toBeNull();
      },
      { timeout: 10_000 },
    );
    // The badge lags the DB write by one live-query tick — never sync-assert.
    expect(await screen.findByText('cancelled', {}, { timeout: 5_000 })).toBeInTheDocument();
    await flushAsyncUpdates();
  }, 30000);

  it('a rejected draft pauses with a needs-review badge; the edit rescue path works', async () => {
    const user = userEvent.setup();
    const { campaign, persona } = await seed();
    chatMock
      .mockResolvedValueOnce('this is not json at all')
      .mockResolvedValueOnce('still not json at all') // the automatic JSON-fix retry
      .mockResolvedValueOnce(JSON.stringify(VALID_STATBLOCK));
    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await startRun(user, persona);
    const active = await screen.findByTestId('active-run', {}, { timeout: 10_000 });
    await within(active).findByText('awaiting you');
    // The rejected step is flagged in the step log; manual autonomy pauses as
    // awaiting_user while keeping the raw reply for editing.
    expect(within(active).getAllByText('needs review').length).toBeGreaterThan(0);

    // The rescue path: edit the rejected step's raw output to valid JSON.
    // (fireEvent.change — userEvent.type parses { } as key syntax.)
    await user.click(within(active).getByRole('button', { name: 'Edit' }));
    const edit = await screen.findByLabelText('Edited step output (JSON)');
    fireEvent.change(edit, { target: { value: JSON.stringify({ parsed: VALID_DRAFT }) } });
    await user.click(screen.getByRole('button', { name: 'Save & continue' }));

    await waitFor(
      async () => {
        const run = await getRun(await onlyRunId());
        expect(run?.steps.map((step) => step.name)).toEqual(['retrieve', 'draft', 'statblock']);
        expect(run?.status).toBe('awaiting_user');
      },
      { timeout: 10_000 },
    );
    await flushAsyncUpdates();
  }, 30000);

  it('review autonomy shows the needs_review status with the Retry action', async () => {
    const user = userEvent.setup();
    const { campaign, persona } = await seed();
    chatMock
      .mockResolvedValueOnce('not json one')
      .mockResolvedValueOnce('not json two') // the automatic JSON-fix retry
      .mockResolvedValueOnce(JSON.stringify(VALID_DRAFT)) // consumed by Retry
      .mockResolvedValueOnce(JSON.stringify(VALID_STATBLOCK)); // the statblock step
    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await setAutonomy(user, 'Review');
    await startRun(user, persona);

    const active = await screen.findByTestId('active-run', {}, { timeout: 10_000 });
    // The status badge and the rejected step's badge both read 'needs review'.
    expect((await within(active).findAllByText('needs review')).length).toBeGreaterThan(0);
    expect(within(active).getByPlaceholderText('Optional extra instruction…')).toBeInTheDocument();
    expect(within(active).getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    // Retrying re-runs the step; a valid reply keeps a review run going (no
    // pause on success) — it drives to completion and offers the artifact.
    await user.click(within(active).getByRole('button', { name: 'Retry' }));
    await waitFor(
      async () => {
        const run = await getRun(await onlyRunId());
        if (run?.status !== 'completed') throw new Error('run not completed yet');
        expect(run.steps[1]?.status).toBe('done');
        expect(run.resultArtifactId).not.toBeNull();
      },
      { timeout: 15_000 },
    );
    // The link lags the DB write by one live-query tick — find, don't get.
    expect(
      await screen.findByRole('button', { name: 'Open artifact' }, { timeout: 5_000 }),
    ).toBeInTheDocument();
    await flushAsyncUpdates();
  }, 30000);

  it('auto autonomy runs to completion and offers Open artifact', async () => {
    const user = userEvent.setup();
    const { campaign, persona } = await seed();
    chatMock
      .mockResolvedValueOnce(JSON.stringify(VALID_DRAFT))
      .mockResolvedValueOnce(JSON.stringify(VALID_STATBLOCK));
    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await setAutonomy(user, 'Auto');
    await startRun(user, persona);

    await waitFor(
      async () => {
        const run = await getRun(await onlyRunId());
        if (run?.status !== 'completed') throw new Error('run not completed yet');
      },
      { timeout: 15_000 },
    );
    // Capture the final live-query emission inside act before raw DB reads.
    await flushAsyncUpdates();
    const run = await getRun(await onlyRunId());
    const resultId = run?.resultArtifactId;
    if (resultId === null || resultId === undefined) throw new Error('no result artifact');
    // Badge + link lag the DB write by one live-query tick — find, don't get.
    expect(await screen.findByText('completed', {}, { timeout: 5_000 })).toBeInTheDocument();
    const link = await screen.findByRole('button', { name: 'Open artifact' });
    expect(link).toHaveAttribute('href', artifactPath(campaign.id, resultId));
    await flushAsyncUpdates();
  }, 30000);

  it('Encounter Cartographer exposes aspect selection and a layout review checkpoint', async () => {
    const user = userEvent.setup();
    const { campaign } = await seed();
    const cartographer = await createPersona({
      slug: 'encounter-cartographer-ui',
      name: 'Encounter Cartographer',
      description: '',
      systemPrompt: 'Return encounter JSON.',
      mode: 'encounter',
      producesKind: 'encounter',
      builtIn: true,
    });
    chatMock.mockResolvedValueOnce(JSON.stringify({
      name: 'Ash Gate', summary: '', body: '', difficulty: 'medium', levelHint: '3',
      terrain: '', tactics: '', treasure: '', theme: 'ash temple', styleNotes: '', negative: '',
      monsters: [{ name: 'Cultist', count: 1, notes: '', statBlock: VALID_STATBLOCK }],
      rooms: [
        { name: 'Entry', description: '', size: 'small', monsterIndexes: [], adjacentRoomIndexes: [1] },
        { name: 'Shrine', description: '', size: 'medium', monsterIndexes: [0], adjacentRoomIndexes: [0] },
      ],
      entryRoomIndex: 0,
    }));
    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await startRun(user, cartographer);
    expect(screen.getByRole('combobox', { name: 'Map aspect' })).toBeInTheDocument();
    expect(await screen.findByTestId('encounter-run-actions')).toBeInTheDocument();
    await user.click(await screen.findByTestId('approve-step'));
    expect(await screen.findByTestId('encounter-layout-preview')).toBeInTheDocument();
    expect(screen.getByTestId('regenerate-layout')).toBeInTheDocument();
    await runEngine.cancel(await onlyRunId());
    await flushAsyncUpdates();
  }, 30000);

  it('image run: a candidate-count cap shows a visible notice next to the pick', async () => {
    const user = userEvent.setup();
    const { campaign } = await seed();
    const settings = await import('@/db/settingsRepo');
    const { defaultSettings } = await import('@/domain');
    await settings.saveSettings({
      ...defaultSettings(),
      openRouterApiKey: 'test-key',
      imagesEnabled: true,
      imageModel: 'cap-test/panel-model',
    });
    const illustrator = await createPersona({
      slug: 'illustrator-ui',
      name: 'Illustrator',
      description: 'test',
      systemPrompt: 'You draft image prompts.',
      mode: 'image',
      builtIn: true,
    });
    const lighthouse = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'The Lighthouse',
    });
    await publishToLibrary(lighthouse.id);
    chatMock.mockResolvedValueOnce(
      JSON.stringify({
        prompt: 'A storm-lashed lighthouse',
        negative: 'text',
        styleNotes: 'oil painting',
      }),
    );
    // The model capped n at 1 (imageGen reports it; the engine persists the
    // notice) — the panel must SHOW it, not quietly present one candidate.
    generateImagesMock.mockResolvedValue({
      images: [new Blob(['one'], { type: 'image/webp' })],
      costUsd: 0.01,
      cappedToOne: true,
    });
    intakeImageMock.mockImplementation((blob: Blob) =>
      Promise.resolve({ blob, width: 64, height: 64, mimeType: 'image/webp' }),
    );

    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('combobox', { name: 'Persona' }));
    await user.click(await screen.findByRole('option', { name: illustrator.name }));
    const targetSelect = await screen.findByRole('combobox', { name: 'Artifact to illustrate' });
    await user.click(targetSelect);
    await user.click(await screen.findByRole('option', { name: 'The Lighthouse — Global' }));
    await user.click(screen.getByTestId('start-run'));
    expect(await screen.findByTestId('run-global-badge')).toHaveTextContent('Global');

    // The draft pauses; continue with the drafted prompt.
    const edit = await screen.findByTestId('image-prompt-edit', {}, { timeout: 10_000 });
    await user.click(within(edit).getByTestId('continue-image'));

    // Pick pause: the cap notice is on the page and the pick holds 1 candidate.
    const pick = await screen.findByTestId('image-pick', {}, { timeout: 10_000 });
    await flushAsyncUpdates(); // settle the candidates' async ImageThumb loads
    expect(screen.getByTestId('image-cap-notice').textContent).toContain('single candidate');
    expect(within(pick).getAllByRole('button', { name: /Candidate / })).toHaveLength(1);
    const run = await getRun(await onlyRunId());
    expect((run?.steps[1]?.output as { notice: string | null }).notice).toContain('single candidate');
    await flushAsyncUpdates();
  }, 30000);

  it('runs tab shows scrollable report with copy button when a run is selected', async () => {
    const user = userEvent.setup();
    const { campaign, persona } = await seed();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true,
    });

    const run = await createRun({
      campaignId: campaign.id,
      personaId: persona.id,
      autonomy: 'auto',
      userBrief: 'A test failed run',
      pinnedChunkIds: [],
      targetArtifactId: null,
      encounterMapAspect: null,
    });
    await updateRun(run.id, {
      status: 'failed',
      errorMessage: 'Sample failure reason',
      steps: [
        {
          index: 0,
          name: 'draft',
          status: 'rejected',
          input: {},
          output: { error: 'Sample failure reason' },
          userEdit: null,
        },
      ],
    });

    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('tab', { name: 'Runs' }));
    const runItem = await screen.findByText('A test failed run');
    await user.click(runItem);

    const report = await screen.findByTestId('open-run-report');
    expect(report).toBeInTheDocument();
    expect(within(report).getAllByText(/Sample failure reason/).length).toBeGreaterThanOrEqual(1);

    const copyBtn = within(report).getByRole('button', { name: 'Copy report to clipboard' });
    await user.click(copyBtn);
    expect(writeText).toHaveBeenCalled();

    const closeBtn = within(report).getByRole('button', { name: 'Close report' });
    await user.click(closeBtn);
    expect(screen.queryByTestId('open-run-report')).not.toBeInTheDocument();
  });
});
