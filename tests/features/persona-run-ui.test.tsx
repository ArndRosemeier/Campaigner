import 'fake-indexeddb/auto';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { artifactPath } from '@/app/routes';
import { createArtifact, publishToLibrary } from '@/db/artifactRepo';
import { createCampaign, listCampaigns } from '@/db/campaignRepo';
import { createPersona } from '@/db/personaRepo';
import { createRun, getRun, listRunsByCampaign, updateRun } from '@/db/runRepo';
import { db } from '@/db/db';
import { newId, type Campaign, type Persona } from '@/domain';
import { PersonaPanel } from '@/features/campaign/components/persona-panel';
import { runEngine } from '@/llm/runEngine';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';
import { useProgressStore } from '@/lib/progress';
import { FAILURE_KIND_GUIDANCE } from '@/domain';
import { Toaster } from 'sonner';

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
async function startRun(
  user: ReturnType<typeof userEvent.setup>,
  persona: Persona,
  autonomy?: string,
): Promise<void> {
  if (autonomy !== undefined) {
    await setAutonomy(user, autonomy);
  }
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
  const { encounterRunAdapters } = await import('@/llm/runEngine');
  vi.spyOn(encounterRunAdapters, 'renderSchematic').mockReturnValue({
    dataUrl: 'data:image/png;base64,schematic',
    width: 2304,
    height: 1728,
  });
  vi.spyOn(encounterRunAdapters, 'normalizeImageAspect').mockImplementation((blob) =>
    Promise.resolve({ blob, width: 1200, height: 900, action: 'none' }),
  );
  intakeImageMock.mockImplementation((blob: Blob) =>
    Promise.resolve({ blob, width: 64, height: 64, mimeType: 'image/webp' }),
  );
});
afterEach(() => {
  useProgressStore.getState().reset();
  chatMock.mockReset();
  generateImagesMock.mockReset();
  intakeImageMock.mockReset();
  vi.restoreAllMocks();
});

describe('PersonaPanel run lifecycle', () => {
  it('deep-links a run via initialRunId without navigating through the Runs tab', async () => {
    const user = userEvent.setup();
    const { campaign, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });
    const { rerender } = render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await startRun(user, persona, 'Manual');
    const runId = await waitFor(async () => {
      return onlyRunId();
    });

    // The progress dock's "Open" navigates to workspacePath?run=<id>; the
    // panel receives the run id as a prop and focuses it directly.
    rerender(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey initialRunId={runId} />
      </MemoryRouter>,
    );

    const active = await screen.findByTestId('active-run', {}, { timeout: 10_000 });
    expect(await within(active).findByText('awaiting you')).toBeInTheDocument();
  }, 30000);

  it('manual run pauses with Approve; approving runs the statblock step', async () => {
    const user = userEvent.setup();
    const { campaign, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });
    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await startRun(user, persona, 'Manual');

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
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });
    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await startRun(user, persona, 'Manual');
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
    chatMock.mockResolvedValue({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null });
    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await startRun(user, persona, 'Manual');
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
      .mockResolvedValueOnce({ text: 'this is not json at all', modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: 'still not json at all', modelUsed: 'test-model', fallback: null }) // the automatic JSON-fix retry
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });
    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await startRun(user, persona, 'Manual');
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
      .mockResolvedValueOnce({ text: 'not json one', modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: 'not json two', modelUsed: 'test-model', fallback: null }) // the automatic JSON-fix retry
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null }) // consumed by Retry
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null }); // the statblock step
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
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });
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
    const run = await actDrained(async () => getRun(await onlyRunId()));
    const resultId = run?.resultArtifactId;
    if (resultId === null || resultId === undefined) throw new Error('no result artifact');
    // Badge + link lag the DB write by one live-query tick — find, don't get.
    expect(await screen.findByText('completed', {}, { timeout: 5_000 })).toBeInTheDocument();
    const link = await screen.findByRole('button', { name: 'Open artifact' });
    expect(link).toHaveAttribute('href', artifactPath(campaign.id, resultId));
    await flushAsyncUpdates();
  }, 30000);

  it('Encounter Cartographer advances directly to map pick without intermediate layout candidates', async () => {
    const user = userEvent.setup();
    const { campaign } = await seed();
    const { saveSettings } = await import('@/db/settingsRepo');
    const { defaultSettings } = await import('@/domain');
    await saveSettings({
      ...defaultSettings(),
      openRouterApiKey: 'test-key',
      imagesEnabled: true,
    });
    const cartographer = await createPersona({
      slug: 'encounter-cartographer-ui',
      name: 'Encounter Cartographer',
      description: '',
      systemPrompt: 'Return encounter JSON.',
      mode: 'encounter',
      producesKind: 'encounter',
      builtIn: true,
    });
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({
        name: 'Ash Gate',
        // Minimum-content contract: summary/body carry substance (an empty
        // Cartographer brief is a rejected draft, not a mappable one).
        summary: 'Cultists guard a ruined gate.',
        body: '# Ash Gate\nA room-by-room battle.',
        difficulty: 'medium',
        levelHint: '3',
        terrain: '',
        tactics: '',
        treasure: '',
        theme: 'ash temple',
        styleNotes: '',
        negative: '',
        monsters: [{ name: 'Cultist', count: 1, notes: '', statBlock: VALID_STATBLOCK }],
        rooms: [
          {
            name: 'Entry',
            description: '',
            size: 'medium',
            monsterIndexes: [0],
            adjacentRoomIndexes: [],
          },
        ],
        entryRoomIndex: 0,
      }), modelUsed: 'test-model', fallback: null });
    generateImagesMock.mockResolvedValue({
      images: [new Blob(['one'], { type: 'image/webp' })],
      costUsd: 0.01,
      cappedToOne: true, modelUsed: 'test-image-model', fallback: null, filteredCount: 0,
    });
    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await startRun(user, cartographer, 'Manual');
    // The global map defaults live on the Settings page now — the panel
    // holds per-run steering only, so none of the three selects render here.
    expect(screen.queryByRole('combobox', { name: 'Map aspect' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Preset' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Dungeon map path' })).toBeNull();
    expect(await screen.findByTestId('encounter-run-actions')).toBeInTheDocument();
    await user.click(await screen.findByTestId('approve-step'));
    expect(
      await screen.findByTestId('encounter-map-pick', {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    // The owner's correction path (docs/11 D14): the pick view carries a
    // "Regenerate candidates" button — clicking re-runs the stylize step
    // only and the run pauses at pick again with the fresh batch. The
    // click → engine-settle window drains inside ONE act (docs/08 §Console
    // guard): the engine's step writes drive liveQuery cascades while the
    // run views are mounted. Timer polling instead of RTL waitFor inside
    // act — waitFor toggles IS_REACT_ACT_ENVIRONMENT mid-act, which itself
    // leaks the act warning.
    const generateCallsAfterFirstBatch = generateImagesMock.mock.calls.length;
    await user.click(await screen.findByTestId('regenerate-map-candidates'));
    await actDrained(async () => {
      for (let round = 0; round < 400; round += 1) {
        if (screen.queryByTestId('encounter-map-pick') !== null) break;
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      expect(screen.queryByTestId('encounter-map-pick')).not.toBeNull();
    });
    expect(generateImagesMock.mock.calls.length).toBeGreaterThan(generateCallsAfterFirstBatch);
    await flushAsyncUpdates();
    // The cancel is a DB write while the run views are mounted — actDrained
    // keeps its liveQuery cascade inside act (docs/08 §Console guard).
    await actDrained(async () => {
      await runEngine.cancel(await onlyRunId());
    });
    await flushAsyncUpdates();
  }, 30000);

  it('encounter panel renders no global map defaults (Settings owns them)', async () => {
    const user = userEvent.setup();
    const { campaign } = await seed();
    const cartographer = await createPersona({
      slug: 'encounter-no-globals-ui',
      name: 'Encounter Cartographer',
      description: '',
      systemPrompt: 'Return encounter JSON.',
      mode: 'encounter',
      producesKind: 'encounter',
      builtIn: true,
    });
    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await setAutonomy(user, 'Manual');
    await user.click(await screen.findByRole('combobox', { name: 'Persona' }));
    await user.click(await screen.findByRole('option', { name: cartographer.name }));
    // The global Map aspect / Preset / Dungeon map path defaults moved to
    // the Settings page (one home for globals) — the panel renders none of
    // them, and a fresh run still starts Auto (null preset) from Settings.
    expect(screen.queryByRole('combobox', { name: 'Map aspect' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Preset' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Dungeon map path' })).toBeNull();
    expect(
      screen.queryByText(/each encounter's own location kind decides/),
    ).toBeNull();
    expect(screen.queryByText(/locates each room's plaque by sight/)).toBeNull();
    await flushAsyncUpdates();
  }, 30000);

  it('Encounter Cartographer runs to completion in default auto mode with no prompts', async () => {
    const user = userEvent.setup();
    const { campaign } = await seed();
    const { saveSettings } = await import('@/db/settingsRepo');
    const { defaultSettings } = await import('@/domain');
    await saveSettings({
      ...defaultSettings(),
      openRouterApiKey: 'test-key',
      imagesEnabled: true,
    });
    const cartographer = await createPersona({
      slug: 'encounter-cartographer-auto',
      name: 'Encounter Cartographer Auto',
      description: '',
      systemPrompt: 'Return encounter JSON.',
      mode: 'encounter',
      producesKind: 'encounter',
      builtIn: true,
    });
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({
        name: 'Ash Gate',
        // Minimum-content contract: summary/body carry substance.
        summary: 'Cultists guard a ruined gate.',
        body: '# Ash Gate\nA room-by-room battle.',
        difficulty: 'medium',
        levelHint: '3',
        terrain: '',
        tactics: '',
        treasure: '',
        theme: 'ash temple',
        styleNotes: '',
        negative: '',
        monsters: [{ name: 'Cultist', count: 1, notes: '', statBlock: VALID_STATBLOCK }],
        rooms: [
          {
            name: 'Entry',
            description: '',
            size: 'medium',
            monsterIndexes: [0],
            adjacentRoomIndexes: [],
          },
        ],
        entryRoomIndex: 0,
      }), modelUsed: 'test-model', fallback: null });
    generateImagesMock.mockResolvedValue({
      images: [new Blob(['one'], { type: 'image/webp' })],
      costUsd: 0.01,
      cappedToOne: true, modelUsed: 'test-image-model', fallback: null, filteredCount: 0,
    });
    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    // Default autonomy is Auto: starting the run requires no intermediate approval clicks
    await startRun(user, cartographer);
    expect(screen.queryByTestId('approve-step')).not.toBeInTheDocument();

    await waitFor(
      async () => {
        const run = await getRun(await onlyRunId());
        if (run?.status !== 'completed') {
          throw new Error(
            `run not completed yet: status=${run?.status} error=${run?.errorMessage} steps=${JSON.stringify(run?.steps.map((s) => [s.name, s.status]))}`,
          );
        }
      },
      { timeout: 15_000 },
    );

    expect(
      await screen.findByRole('button', { name: 'Open encounter' }, { timeout: 5_000 }),
    ).toBeInTheDocument();

    // Clicking navigates to the encounter's artifact page — the button then
    // swaps to an "already open" statement instead of staying a dead link
    // (clicking a link to the URL the browser already shows does nothing).
    // Raw awaited read while the panel is mounted — actDrained closes the
    // leak window (the run's map/extras queue may still be writing).
    const completedRun = await actDrained(async () => getRun(await onlyRunId()));
    expect(completedRun?.resultArtifactId).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open encounter' }));
    expect(await screen.findByTestId('run-result-open', {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open encounter' })).not.toBeInTheDocument();
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
      summary: 'A storm-lashed beacon on a black cliff.',
      body: 'Windswept rocks, gulls, one tower of black stone.',
    });
    await publishToLibrary(lighthouse.id);
    // The prompt draft is deterministic (buildImagePrompt) — the run never
    // calls chat; the draft pauses with the assembled prompt for editing.
    // The model capped n at 1 (imageGen reports it; the engine persists the
    // notice) — the panel must SHOW it, not quietly present one candidate.
    generateImagesMock.mockResolvedValue({
      images: [new Blob(['one'], { type: 'image/webp' })],
      costUsd: 0.01,
      cappedToOne: true, modelUsed: 'test-image-model', fallback: null, filteredCount: 0,
    });
    intakeImageMock.mockImplementation((blob: Blob) =>
      Promise.resolve({ blob, width: 64, height: 64, mimeType: 'image/webp' }),
    );

    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await setAutonomy(user, 'Manual');
    await user.click(await screen.findByRole('combobox', { name: 'Persona' }));
    await user.click(await screen.findByRole('option', { name: illustrator.name }));
    const targetSelect = await screen.findByRole('combobox', { name: 'Artifact to illustrate' });
    await user.click(targetSelect);
    await user.click(await screen.findByRole('option', { name: 'The Lighthouse — Global' }));
    await user.click(screen.getByTestId('start-run'));
    expect(await screen.findByTestId('run-global-badge')).toHaveTextContent('Library');

    // The draft pauses; continue with the drafted prompt.
    const edit = await screen.findByTestId('image-prompt-edit', {}, { timeout: 10_000 });
    await user.click(within(edit).getByTestId('continue-image'));

    // Pick pause: the cap notice is on the page and the pick holds 1 candidate.
    const pick = await screen.findByTestId('image-pick', {}, { timeout: 10_000 });
    await flushAsyncUpdates(); // settle the candidates' async ImageThumb loads
    expect(screen.getByTestId('image-cap-notice').textContent).toContain('single candidate');
    expect(within(pick).getAllByRole('button', { name: /Candidate / })).toHaveLength(1);
    // Raw awaited read while the pick view is mounted — actDrained closes the
    // leak window (docs/08 §Console guard).
    const run = await actDrained(async () => getRun(await onlyRunId()));
    expect((run?.steps[1]?.output as { notice: string | null }).notice).toContain('single candidate');

    // Inspect button opens the large candidate preview dialog
    const pickStep = run?.steps.find((s) => s.name === 'pick');
    const candidateId = ((pickStep?.output as { candidates?: string[] }).candidates ?? [])[0] ?? '';
    const inspectBtn = screen.getByTestId(`inspect-candidate-${candidateId}`);
    expect(inspectBtn).toBeInTheDocument();
    await user.click(inspectBtn);

    const dialog = await screen.findByTestId('candidate-preview-dialog');
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByTestId('zoomable-image')).toBeInTheDocument();

    // Select candidate from within the preview dialog
    const selectBtn = within(dialog).getByTestId('preview-select-btn');
    await user.click(selectBtn);
    expect(selectBtn).toHaveTextContent('Selected');

    // Close preview dialog
    await user.click(within(dialog).getByTestId('preview-close-btn'));
    await waitFor(() => {
      expect(screen.queryByTestId('candidate-preview-dialog')).not.toBeInTheDocument();
    });

    // The candidate is now selected in the main pick view
    const keepBtn = screen.getByTestId('keep-selected');
    expect(keepBtn).toHaveTextContent('Keep 1 selected');
    await user.click(keepBtn);

    await waitFor(
      async () => {
        const finishedRun = await getRun(await onlyRunId());
        expect(finishedRun?.status).toBe('completed');
      },
      { timeout: 10_000 },
    );

    await flushAsyncUpdates();
  }, 30000);

  it('shows the no-pack notice for encounter runs only when no ready pack exists (fix-02 decision 6)', async () => {
    const user = userEvent.setup();
    const { campaign } = await seed();
    const { createPackBook, finalizePackBook } = await import('@/db/rulebookRepo');
    const smith = await createPersona({
      slug: 'encounter-smith-notice',
      name: 'Encounter Smith Notice',
      description: '',
      systemPrompt: 'Design encounters.',
      mode: 'encounter',
      producesKind: 'encounter',
      builtIn: true,
    });
    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    // Selecting an encounter persona reveals the run section: no ready pack
    // for dnd5e → one lightweight, non-blocking notice.
    await user.click(await screen.findByRole('combobox', { name: 'Persona' }));
    await user.click(await screen.findByRole('option', { name: smith.name }));
    expect(await screen.findByTestId('no-pack-notice', {}, { timeout: 5_000 })).toHaveTextContent(
      'No bestiary pack for D&D 5e installed',
    );

    // A processing pack book is not ready — the notice stays. The write is
    // actDrained so its liveQuery cascade stays inside act (docs/08).
    const processing = await actDrained(() =>
      createPackBook({ title: 'WIP Pack', system: 'dnd5e', filename: 'wip.zip' }),
    );
    await flushAsyncUpdates();
    expect(screen.getByTestId('no-pack-notice')).toBeInTheDocument();

    // Finalizing it makes the book ready — the notice disappears.
    await actDrained(() =>
      finalizePackBook(processing.id, {
        sourceId: 'foundry-dnd5e-srd',
        license: 'CC-BY-4.0',
        entriesImported: 1,
        entriesSkipped: 0,
        entriesFailed: 0,
      }),
    );
    await waitFor(
      () => {
        expect(screen.queryByTestId('no-pack-notice')).not.toBeInTheDocument();
      },
      { timeout: 5_000 },
    );
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

  it('renders a persisted escalation notice on the run step list', async () => {
    const user = userEvent.setup();
    const { campaign, persona } = await seed();
    const run = await createRun({
      campaignId: campaign.id,
      personaId: persona.id,
      autonomy: 'manual',
      userBrief: 'A noticed run',
      pinnedChunkIds: [],
      targetArtifactId: null,
      encounterMapAspect: null,
    });
    await updateRun(run.id, {
      status: 'awaiting_user',
      steps: [
        {
          index: 0,
          name: 'retrieve',
          status: 'done',
          input: {},
          output: { excerpts: '' },
          userEdit: null,
        },
        {
          index: 1,
          name: 'draft',
          status: 'done',
          input: {},
          output: {
            parsed: { name: 'Grix', personality: '', appearance: '', quote: '', hooks: [] },
            notice: 'The reply contract failed on “cheap/primary” — the repair attempt ran on “potent/fallback”.',
          },
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
    await user.click(await screen.findByText('A noticed run'));

    // The run report shows the persisted step outputs, escalation included.
    const report = await screen.findByTestId('open-run-report');
    expect(within(report).getAllByText(/repair attempt ran on “potent\/fallback”/).length).toBeGreaterThanOrEqual(1);
  });

  it('a failed run offers Resume generation in ActiveRun, which continues to completion', async () => {
    const user = userEvent.setup();
    const { campaign, persona } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockRejectedValueOnce(new Error('Gateway timeout 504'));

    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await startRun(user, persona);
    const failedActions = await screen.findByTestId('failed-run-actions', {}, { timeout: 10_000 });
    expect(within(failedActions).getByText(/Generation interrupted or encountered an error/)).toBeInTheDocument();
    expect(within(failedActions).getByTestId('resume-failed-run')).toBeInTheDocument();

    // Now model is back online
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });
    await user.click(within(failedActions).getByTestId('resume-failed-run'));

    await waitFor(
      async () => {
        const run = await getRun(await onlyRunId());
        if (run?.status !== 'completed') throw new Error('run not completed yet');
      },
      { timeout: 10_000 },
    );

    expect(await screen.findByRole('button', { name: 'Open artifact' }, { timeout: 5_000 })).toBeInTheDocument();
    await flushAsyncUpdates();
  }, 30000);

  it('clicking Resume in the Runs tab switches to Assistant and resumes the run', async () => {
    const user = userEvent.setup();
    const { campaign, persona } = await seed();
    const run = await createRun({
      campaignId: campaign.id,
      personaId: persona.id,
      autonomy: 'auto',
      userBrief: 'A test failed run to resume',
      pinnedChunkIds: [],
      targetArtifactId: null,
      encounterMapAspect: null,
    });
    await updateRun(run.id, {
      status: 'failed',
      errorMessage: 'Temporary service outage',
      steps: [
        {
          index: 0,
          name: 'retrieve',
          status: 'done',
          input: {},
          output: { chunkIds: [], titles: [] },
          userEdit: null,
        },
        {
          index: 1,
          name: 'draft',
          status: 'done',
          input: {},
          output: { parsed: VALID_DRAFT },
          userEdit: null,
        },
        {
          index: 2,
          name: 'statblock',
          status: 'running',
          input: {},
          output: null,
          userEdit: null,
        },
      ],
    });

    chatMock.mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('tab', { name: 'Runs' }));
    const resumeBtn = await screen.findByTestId(`resume-run-${run.id}`);
    expect(resumeBtn).toBeInTheDocument();

    await user.click(resumeBtn);

    // Clicking resume should activate the run and switch back to the Assistant tab
    const active = await screen.findByTestId('active-run', {}, { timeout: 5000 });
    expect(active).toBeInTheDocument();

    await waitFor(
      async () => {
        const updatedRun = await getRun(run.id);
        if (updatedRun?.status !== 'completed') {
          throw new Error(
            `run not completed yet: ${updatedRun?.status} err: ${updatedRun?.errorMessage} steps: ${JSON.stringify(updatedRun?.steps.map((s) => [s.name, s.status]))}`,
          );
        }
      },
      { timeout: 10_000 },
    );

    expect(await screen.findByRole('button', { name: 'Open artifact' })).toBeInTheDocument();
    await flushAsyncUpdates(60);
  }, 30000);
});

describe('PersonaPanel failed-run details', () => {
  const RAW_ERROR = 'OpenRouter request failed (504): gateway timeout between models';

  /**
   * Seeds a FAILED run row directly (docs/05 run views): retrieve done, the
   * draft step the run died on left 'running', optional failureKind — omit it
   * to reproduce a legacy row (parses to failureKind null).
   */
  async function seedFailedRun(
    campaign: Campaign,
    persona: Persona,
    failureKind?: 'congestion' | 'filter',
    errorMessage: string = RAW_ERROR,
  ): Promise<string> {
    const run = await createRun({
      campaignId: campaign.id,
      personaId: persona.id,
      autonomy: 'manual',
      userBrief: 'A failed run with details',
      pinnedChunkIds: [],
      targetArtifactId: null,
      encounterMapAspect: null,
    });
    await updateRun(run.id, {
      status: 'failed',
      errorMessage,
      ...(failureKind === undefined ? {} : { failureKind }),
      steps: [
        {
          index: 0,
          name: 'retrieve',
          status: 'done',
          input: {},
          output: { chunkIds: [], titles: [] },
          userEdit: null,
        },
        { index: 1, name: 'draft', status: 'running', input: {}, output: null, userEdit: null },
      ],
    });
    return run.id;
  }

  function stubClipboard(writeText: ((text: string) => Promise<void>) | undefined): void {
    Object.defineProperty(navigator, 'clipboard', {
      value: writeText === undefined ? undefined : { writeText },
      writable: true,
      configurable: true,
    });
  }

  afterEach(() => {
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it('Details expands the classification, guidance, raw error, step and timestamps; recovery stays put', async () => {
    const user = userEvent.setup();
    const { campaign, persona } = await seed();
    const runId = await seedFailedRun(campaign, persona, 'congestion');

    render(
      <MemoryRouter>
        <Toaster />
        <PersonaPanel campaign={campaign} hasApiKey initialRunId={runId} />
      </MemoryRouter>,
    );

    const failedActions = await screen.findByTestId('failed-run-actions');
    // Recovery affordances before expanding…
    expect(within(failedActions).getByTestId('resume-failed-run')).toBeInTheDocument();
    expect(within(failedActions).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    // …and the section is collapsed until asked for (disclosure, not a modal).
    expect(screen.queryByTestId('failed-run-details')).not.toBeInTheDocument();

    const toggle = within(failedActions).getByTestId('failed-run-details-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const details = screen.getByTestId('failed-run-details');
    expect(within(details).getByTestId('failure-kind-badge')).toHaveTextContent(
      'Provider congestion or timeout',
    );
    expect(within(details).getByTestId('failure-kind-guidance')).toHaveTextContent(
      FAILURE_KIND_GUIDANCE.congestion,
    );
    // The FULL raw message is shown verbatim next to the classification.
    expect(within(details).getByTestId('failed-run-raw-error')).toHaveTextContent(RAW_ERROR);
    expect(within(details).getByText(/Failed at step:/)).toHaveTextContent(/draft/);
    // One timestamps line: "Started <ts> · Failed <ts>".
    expect(within(details).getByText(/· Failed /)).toBeInTheDocument();
    expect(within(details).getByTestId('copy-error-details')).toBeInTheDocument();

    // Recovery affordances untouched AFTER expanding.
    expect(within(failedActions).getByTestId('resume-failed-run')).toBeInTheDocument();
    expect(within(failedActions).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();

    // It is a disclosure: toggling again collapses it.
    await user.click(toggle);
    expect(screen.queryByTestId('failed-run-details')).not.toBeInTheDocument();
    await flushAsyncUpdates();
  }, 20000);

  it('a legacy failed row (failureKind null) shows the unknown guidance with the raw message', async () => {
    const user = userEvent.setup();
    const { campaign, persona } = await seed();
    const runId = await seedFailedRun(campaign, persona);

    // Raw awaited read wrapped in actDrained (docs/18 §3): the panel is not
    // mounted yet, but keep the file's leak discipline uniform.
    const stored = await actDrained(() => getRun(runId));
    expect(stored?.failureKind).toBeNull();

    render(
      <MemoryRouter>
        <Toaster />
        <PersonaPanel campaign={campaign} hasApiKey initialRunId={runId} />
      </MemoryRouter>,
    );

    await user.click(
      within(await screen.findByTestId('failed-run-actions')).getByTestId(
        'failed-run-details-toggle',
      ),
    );

    const details = screen.getByTestId('failed-run-details');
    expect(within(details).getByTestId('failure-kind-badge')).toHaveTextContent(
      'Unclassified failure',
    );
    expect(within(details).getByTestId('failure-kind-guidance')).toHaveTextContent(
      FAILURE_KIND_GUIDANCE.unknown,
    );
    expect(within(details).getByTestId('failed-run-raw-error')).toHaveTextContent(RAW_ERROR);
    await flushAsyncUpdates();
  }, 20000);

  it('Copy writes the FULL raw error to the clipboard and confirms with a toast', async () => {
    const user = userEvent.setup();
    const { campaign, persona } = await seed();
    const runId = await seedFailedRun(campaign, persona, 'congestion');
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    render(
      <MemoryRouter>
        <Toaster />
        <PersonaPanel campaign={campaign} hasApiKey initialRunId={runId} />
      </MemoryRouter>,
    );

    await user.click(
      within(await screen.findByTestId('failed-run-actions')).getByTestId(
        'failed-run-details-toggle',
      ),
    );
    await user.click(screen.getByTestId('copy-error-details'));

    expect(writeText).toHaveBeenCalledWith(RAW_ERROR);
    expect(await screen.findByText('Error copied to clipboard')).toBeInTheDocument();
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    await flushAsyncUpdates();
  }, 20000);

  it('without a clipboard the Copy button fails loudly with a manual-select note', async () => {
    const user = userEvent.setup();
    const { campaign, persona } = await seed();
    const runId = await seedFailedRun(campaign, persona, 'congestion');
    stubClipboard(undefined);

    render(
      <MemoryRouter>
        <Toaster />
        <PersonaPanel campaign={campaign} hasApiKey initialRunId={runId} />
      </MemoryRouter>,
    );

    await user.click(
      within(await screen.findByTestId('failed-run-actions')).getByTestId(
        'failed-run-details-toggle',
      ),
    );
    await user.click(screen.getByTestId('copy-error-details'));

    expect(screen.getByTestId('clipboard-note')).toHaveTextContent(
      /select the error text above and copy it manually/i,
    );
    expect(await screen.findByText(/Clipboard unavailable/)).toBeInTheDocument();
    // The raw error stays selectable (the manual fallback path).
    expect(screen.getByTestId('failed-run-raw-error')).toHaveClass('select-text');
    await flushAsyncUpdates();
  }, 20000);

  it('the Runs tab report shows the same details section for a failed run', async () => {
    const user = userEvent.setup();
    const { campaign, persona } = await seed();
    await seedFailedRun(campaign, persona, 'filter', 'I cannot help with that request');

    render(
      <MemoryRouter>
        <Toaster />
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('tab', { name: 'Runs' }));
    await user.click(await screen.findByText('A failed run with details'));
    const report = await screen.findByTestId('open-run-report');

    expect(within(report).getByTestId('failure-kind-badge')).toHaveTextContent('Model refusal');
    expect(within(report).getByTestId('failure-kind-guidance')).toHaveTextContent(
      FAILURE_KIND_GUIDANCE.filter,
    );
    expect(within(report).getByTestId('failed-run-raw-error')).toHaveTextContent(
      'I cannot help with that request',
    );
    expect(within(report).getByTestId('copy-error-details')).toBeInTheDocument();
    await flushAsyncUpdates(60);
  }, 20000);

  it('a failed Runs-tab row shows the failure-kind badge inline and a Details affordance that opens the report', async () => {
    const user = userEvent.setup();
    const { campaign, persona } = await seed();
    const failedRunId = await seedFailedRun(campaign, persona, 'congestion');
    // A completed sibling row: the badge is a FAILED-row affordance and must
    // not appear on it.
    const completed = await createRun({
      campaignId: campaign.id,
      personaId: persona.id,
      autonomy: 'manual',
      userBrief: 'A completed run',
      pinnedChunkIds: [],
      targetArtifactId: null,
      encounterMapAspect: null,
    });
    await updateRun(completed.id, {
      status: 'completed',
      resultArtifactId: null,
      steps: [
        {
          index: 0,
          name: 'retrieve',
          status: 'done',
          input: {},
          output: { chunkIds: [], titles: [] },
          userEdit: null,
        },
      ],
    });

    render(
      <MemoryRouter>
        <Toaster />
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('tab', { name: 'Runs' }));
    // The rows lag the runs-list container by one live-query tick — find,
    // don't get.
    expect(
      await screen.findByTestId(`failure-kind-${failedRunId}`, {}, { timeout: 5_000 }),
    ).toHaveTextContent('Provider congestion or timeout');
    // Completed rows carry no failure-kind badge.
    expect(
      within(screen.getByTestId('runs-list')).queryByTestId(`failure-kind-${completed.id}`),
    ).not.toBeInTheDocument();

    // The explicit Details affordance opens the report panel (same toggle
    // the row's text button drives)…
    const detailsBtn = screen.getByTestId(`details-run-${failedRunId}`);
    expect(detailsBtn).toHaveAttribute('aria-label', expect.stringContaining('Run details'));
    await user.click(detailsBtn);
    const report = await screen.findByTestId('open-run-report');
    expect(within(report).getByTestId('failure-kind-badge')).toHaveTextContent(
      'Provider congestion or timeout',
    );
    // …and toggling it again closes the report.
    await user.click(screen.getByTestId(`details-run-${failedRunId}`));
    expect(screen.queryByTestId('open-run-report')).not.toBeInTheDocument();
    await flushAsyncUpdates();
  }, 20000);
});

describe('PersonaPanel creation dialog (module placement + extras)', () => {
  it('offers the module select and the persona-derived extras for a fresh NPC run', async () => {
    const user = userEvent.setup();
    const { campaign, persona } = await seed();
    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('combobox', { name: 'Persona' }));
    await user.click(await screen.findByRole('option', { name: persona.name }));

    // Derived fallback (custom npc persona, no declared field): image + statBlock.
    expect(screen.getByLabelText('Module')).toBeInTheDocument();
    expect(screen.getByTestId('run-extras')).toBeInTheDocument();
    expect(screen.getByTestId('extra-image')).toBeInTheDocument();
    expect(screen.getByTestId('extra-statblock')).toBeInTheDocument();
    expect(screen.queryByTestId('extra-mob-portraits')).not.toBeInTheDocument();
    expect(screen.queryByTestId('extra-battlemap')).not.toBeInTheDocument();
  }, 30000);

  it('offers no battlemap extra for the content-only Encounter Smith (battlemaps are automatic)', async () => {
    const user = userEvent.setup();
    const { campaign } = await seed();
    const smith = await createPersona({
      slug: 'encounter-smith-extras-ui',
      name: 'Encounter Smith',
      description: '',
      systemPrompt: 'Reply with JSON.',
      mode: 'generate',
      producesKind: 'encounter',
      builtIn: true,
    });
    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('combobox', { name: 'Persona' }));
    await user.click(await screen.findByRole('option', { name: smith.name }));
    // The former one-off "Generate a battlemap" checkbox is gone: every
    // freshly created encounter maps automatically via the unattended queue.
    expect(screen.getByTestId('extra-image')).toBeInTheDocument();
    expect(screen.getByTestId('extra-mob-portraits')).toBeInTheDocument();
    expect(screen.queryByTestId('extra-battlemap')).not.toBeInTheDocument();
  }, 30000);

  it('starts a run into the chosen module and ticks extras through to the run row', async () => {
    const user = userEvent.setup();
    const { campaign, persona } = await seed();
    const { createModule } = await import('@/db/moduleRepo');
    const { createModule: buildModule } = await import('@/domain');
    const module = await createModule(
      buildModule({
        campaignId: campaign.id,
        title: 'The Drowned Vault',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'standard',
      }),
    );
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null })
      .mockResolvedValue({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null });

    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('combobox', { name: 'Persona' }));
    await user.click(await screen.findByRole('option', { name: persona.name }));

    await user.click(screen.getByRole('combobox', { name: 'Module' }));
    await user.click(await screen.findByRole('option', { name: 'The Drowned Vault' }));
    expect(screen.getByTestId('placement-note')).toHaveTextContent('The Drowned Vault');

    await user.click(within(screen.getByTestId('extra-statblock')).getByRole('checkbox'));
    await user.type(screen.getByLabelText('Brief'), 'a goblin alchemist boss');
    await user.click(screen.getByTestId('start-run'));

    await waitFor(async () => {
      const runs = await listRunsByCampaign(campaign.id);
      expect(runs).toHaveLength(1);
    });
    // Raw awaited reads between act-wrapped steps — wrapped in actDrained
    // (docs/08 §Console guard): the engine is still writing the run row
    // during these awaits, and each updateRun re-fires ActiveRun's live
    // query on fake-indexeddb's timed queue (the act-leak the console guard
    // caught in this test).
    const runs = await actDrained(() => listRunsByCampaign(campaign.id));
    const run = await actDrained(() => getRun(runs[0]?.id ?? ''));
    expect(run?.placementModuleId).toBe(module.id);
    // The battlemap extra is gone (battlemaps run automatically for freshly
    // created encounters) — the remembered set no longer carries the key.
    expect(run?.runExtras).toEqual({ image: false, statBlock: true, mobPortraits: false });
    // Drain the run pipeline fully — a still-running ActiveRun leaks state
    // updates (and its updateRun rejects once the next test clears the DB).
    await waitFor(async () => {
      const finished = await getRun(runs[0]?.id ?? '');
      expect(finished?.status).toBe('completed');
    });
    await flushAsyncUpdates();
  }, 30000);

  it('shows the cartographer without a regenerate target (fresh creates only — the editor buttons start their own runs)', async () => {
    const { campaign } = await seed();
    // The encounter editor no longer hands runs off to this panel (the two
    // buttons start their own Cartographer/Smith runs directly) — selecting
    // the Encounter Cartographer here is always a fresh create: no target,
    // so placement and extras apply and the regenerate-target notice stays
    // hidden.
    await createPersona({
      slug: 'encounter-cartographer',
      name: 'Encounter Cartographer',
      description: 'test',
      systemPrompt: 'test',
      producesKind: 'encounter',
      mode: 'encounter',
      builtIn: true,
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('combobox', { name: 'Persona' }));
    await user.click(await screen.findByRole('option', { name: 'Encounter Cartographer' }));
    expect(screen.queryByTestId('encounter-regenerate-target')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Module' })).toBeInTheDocument();
    await flushAsyncUpdates();
  }, 30000);

  it('prefills the smith refill from the artifact editor request', async () => {
    const { campaign } = await seed();
    const { useContentRefillRequest } = await import('@/features/campaign/contentRefillRequest');
    // The smith kinds' canonical persona resolves by slug first; this seed
    // pins the producesKind fallback (its slug is not the canonical one).
    const target = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Grix',
      summary: '',
      body: '',
      data: { appearance: '', personality: '', statBlock: null },
    });

    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );
    // The artifact editor's "Generate with AI" affordance: selects the smith
    // persona producing the kind, targets the artifact, words the brief as
    // the first generation it is (the body is empty).
    act(() => {
      useContentRefillRequest.getState().request(target.id, 'npc', false);
    });

    // The persona select shows the smith (the combobox holds its name) and
    // the target selector is labeled for refills with the notice visible.
    expect(await screen.findByTestId('refill-target-notice')).toHaveTextContent(
      'grounded in that module',
    );
    expect(screen.getByRole('combobox', { name: 'Artifact to refill' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Focus for the refill, e.g. emphasize her role in the finale')).toHaveValue(
      'Generate the full content of this npc: summary, body and details. Its name, relations and images are preserved.',
    );
    // Placement + extras do not apply to a targeted refill.
    expect(screen.queryByRole('combobox', { name: 'Module' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-extras')).not.toBeInTheDocument();
    // The request store is file-global: clear it so later tests don't react.
    act(() => {
      useContentRefillRequest.getState().clear();
    });
    await flushAsyncUpdates();
  }, 30000);

  it('encounter smith starts a fresh run with no target (the editor buttons start targeted runs themselves)', async () => {
    const { campaign } = await seed();
    // The Encounter Smith seeds mode 'generate' — starting it from the panel
    // with no target takes the fresh-create branch (targetArtifactId null).
    // Targeted Smith fills are started by the editor's own buttons, not by a
    // panel hand-off anymore.
    await createPersona({
      slug: 'encounter-smith',
      name: 'Encounter Smith',
      description: 'test',
      systemPrompt: 'test',
      producesKind: 'encounter',
      builtIn: true,
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('combobox', { name: 'Persona' }));
    await user.click(await screen.findByRole('option', { name: 'Encounter Smith' }));
    await user.type(screen.getByLabelText('Brief'), 'A gate ambush');
    await waitFor(() => {
      expect(screen.getByTestId('start-run')).toBeEnabled();
    });
    await user.click(screen.getByTestId('start-run'));
    await waitFor(async () => {
      const runs = await listRunsByCampaign(campaign.id);
      expect(runs.length).toBeGreaterThan(0);
      const run = await getRun(runs[0]?.id ?? '');
      expect(run?.targetArtifactId).toBeNull();
    });
    // Drain the pipeline fully — the run must not outlive this test.
    await waitFor(async () => {
      const runs = await listRunsByCampaign(campaign.id);
      const run = await getRun(runs[0]?.id ?? '');
      expect(run?.status === 'completed' || run?.status === 'failed').toBe(true);
    });
    await flushAsyncUpdates();
  }, 30000);
});

/**
 * REWRITTEN (ledger row 106, docs/11 D3/D4). This block used to pin a REFUSAL:
 * an `npc` carrying a hidden `monsterChunkId` was "really" a bestiary creature,
 * so the refill picker hid it and a held-over selection was refused with
 * "bestiary creature … not an authored NPC". That classification is gone — the
 * row it described is now a CAST npc (an authored row whose stat block is
 * derived from a library creature) — and the guard went with it, so the
 * refusal was not relaxed: THERE IS NO REFUSAL SEAM. Retiring the guard is the
 * owner's Aunt Agatha path (*"she will have zombie stats but with prose"*): a
 * cast npc's prose is exactly what a refill is for.
 *
 * The distinction that remains, and is pinned elsewhere: `changeArtifact`
 * REFUSES a cast npc, because an arbitrary instruction can RENAME it and the
 * name is the cast's citation (`features/modules/change-artifact`). A refill
 * rewrites prose in place and preserves the name, so it is allowed. The one
 * thing neither may touch is `data.creatureRef`.
 */
describe('PersonaPanel refill targets (bestiary creature rows are ordinary rows now)', () => {
  /** The reported pair: a CAST bestiary creature row beside an authored NPC. */
  async function seedCreatureAndNpc(campaign: Campaign): Promise<void> {
    await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Goblin Warrior',
      summary: '',
      body: '',
      data: { appearance: '', personality: '', statBlock: null, creatureRef: { chunkId: newId() } },
    });
    await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Grix',
      summary: '',
      body: '',
      data: { appearance: '', personality: '', statBlock: null },
    });
  }

  async function seedIllustrator(slug: string): Promise<Persona> {
    return createPersona({
      slug,
      name: 'Illustrator',
      description: 'test',
      systemPrompt: 'test',
      mode: 'image',
      builtIn: true,
    });
  }

  it('offers the cast npc to BOTH pickers — a cast row is refillable and illustratable', async () => {
    const { campaign } = await seed();
    const user = userEvent.setup();
    await seedCreatureAndNpc(campaign);
    await seedIllustrator('illustrator-guard-offer');

    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    // The Illustrator lists BOTH rows — a creature row is a legitimate
    // portrait target (its portrait is cached per creature).
    await user.click(await screen.findByRole('combobox', { name: 'Persona' }));
    await user.click(await screen.findByRole('option', { name: 'Illustrator' }));
    await user.click(await screen.findByRole('combobox', { name: 'Artifact to illustrate' }));
    expect(await screen.findByRole('option', { name: 'Goblin Warrior' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Grix' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Goblin Warrior' }));

    // Switching to the smith (a generate persona that refills in place) keeps
    // that artifact selected — and the refill picker lists BOTH rows, the cast
    // npc included: its prose is its own, and refilling it is the path the
    // owner asked for. Nothing narrows this list any more.
    await user.click(screen.getByRole('combobox', { name: 'Persona' }));
    await user.click(await screen.findByRole('option', { name: 'NPC Smith' }));
    await user.click(await screen.findByRole('combobox', { name: 'Artifact to refill' }));
    expect(await screen.findByRole('option', { name: 'Grix' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Goblin Warrior' })).toBeInTheDocument();
    await flushAsyncUpdates();
  }, 30000);

  it('keeps a held-over cast npc as a STARTABLE refill target, with no refusal notice', async () => {
    const { campaign } = await seed();
    const user = userEvent.setup();
    await seedCreatureAndNpc(campaign);
    await seedIllustrator('illustrator-guard-refused');

    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('combobox', { name: 'Persona' }));
    await user.click(await screen.findByRole('option', { name: 'Illustrator' }));
    await user.click(await screen.findByRole('combobox', { name: 'Artifact to illustrate' }));
    await user.click(await screen.findByRole('option', { name: 'Goblin Warrior' }));

    // Switching to the smith KEEPS the selected artifact (only the Encounter
    // mode clears a target) — and that is now a legal target rather than a
    // reachable dead end.
    await user.click(screen.getByRole('combobox', { name: 'Persona' }));
    await user.click(await screen.findByRole('option', { name: 'NPC Smith' }));

    const start = await screen.findByTestId('start-run');
    await waitFor(() => {
      expect(start).toBeEnabled();
    });
    expect(start.getAttribute('title') ?? '').not.toContain('bestiary creature');
    // Nothing was started: the pin is that the control is OFFERED, not that a
    // run happened.
    expect(await actDrained(() => listRunsByCampaign(campaign.id))).toHaveLength(0);
    await flushAsyncUpdates();
  }, 30000);
});

/**
 * Owner production crash (parse-on-read, caa40b0): a pre-M6-E DB keeps the
 * retired `session-chronicler` row (personas are global, seeding skips
 * existing slugs) with `producesKind: 'session'` — the only artifact kind
 * the enum ever dropped (M2 cd8e751 → removed a670751) — and every workspace
 * render threw a ZodError from listPersonas. The personaSchema boundary now
 * normalizes the git-proven value (docs/01 §Persona), so the panel renders
 * the row as a note-producing persona.
 */
describe('PersonaPanel legacy persona rows', () => {
  it('renders the persona list with a pre-M6-E session-chronicler row instead of crashing', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    await db.personas.put({
      id: newId(),
      createdAt: 1,
      updatedAt: 1,
      slug: 'session-chronicler',
      name: 'Session Chronicler',
      description: 'Ready-to-run session plans',
      systemPrompt: 'You are the Session Chronicler, a table-ready session planner.',
      model: '',
      temperature: 0.8,
      producesKind: 'session',
      mode: 'generate',
      builtIn: true,
    } as unknown as Persona);

    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('combobox', { name: 'Persona' }));
    expect(await screen.findByRole('option', { name: 'Session Chronicler' })).toBeInTheDocument();
  });
});
