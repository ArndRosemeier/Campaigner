import 'fake-indexeddb/auto';

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { modulesPath } from '@/app/routes';
import { createArtifact, getArtifact } from '@/db/artifactRepo';
import { createCampaign, getCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { createModule, modulePartSchema, moduleSpineSchema, type Id } from '@/domain';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';

/**
 * Module list (08-MODULE-DESIGNER M4-B): the campaign's modules with
 * status/progress badges, the "New Module" entry point (dialog opens, no LLM
 * path runs), and the confirmed delete flow (row gone from the DB).
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

// The whole generator is mocked: opening the New Module dialog must never
// start an LLM run. `moduleGenEvents` (imported by the reader page in the
// router graph) stays real via the spread.
vi.mock('@/llm/moduleGen', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    runSpine: vi.fn(),
    runParts: vi.fn(),
    approveSpineAndRun: vi.fn(),
    retrySpine: vi.fn(),
    discardSpine: vi.fn(),
    cancelModuleGen: vi.fn(),
    generateMissingParts: vi.fn(),
    rewritePart: vi.fn(),
    createModuleAndRun: vi.fn(),
  };
});

const { createModuleAndRun } = await import('@/llm/moduleGen');
const createModuleAndRunMock = vi.mocked(createModuleAndRun);
const { toastSuccess } = await import('@/lib/toast');
const toastSuccessMock = vi.mocked(toastSuccess);

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

async function seedModules(): Promise<{ campaignId: Id; draftId: Id; failedId: Id }> {
  await seedBuiltInPersonas();
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });

  // Draft with an approved spine and 2 of 3 parts written → "2/3 parts".
  const draft = createModule({
    campaignId: campaign.id,
    title: 'Vault of Whispers',
    concept: 'A whispering vault under the mill.',
    levelMin: 1,
    levelMax: 3,
    tone: '',
    sizeDial: 'standard',
  });
  const draftSaved = await saveModule({
    ...draft,
    status: 'draft',
    spine: moduleSpineSchema.parse({
      premise: 'The old mill hides a vault of whispers.',
      themes: ['secrets'],
      partPlan: [
        { title: 'The Mill', levelBand: '1', synopsis: 'The party arrives.', levelUpTrigger: 'Descend.' },
        { title: 'The Whisper Hall', levelBand: '2', synopsis: 'Voices bargain.', levelUpTrigger: 'The door opens.' },
        { title: 'The Vault', levelBand: '3', synopsis: 'The vault is opened.', levelUpTrigger: 'Escape.' },
      ],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: 'The party reaches the mill at dusk.',
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
      modulePartSchema.parse({
        planIndex: 1,
        markdown: 'Whispers answer the party’s questions.',
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
      modulePartSchema.parse({
        planIndex: 2,
        markdown: '',
        status: 'pending',
        errorMessage: '',
        edited: false,
      }),
    ],
  });

  // Failed during the spine draft: no spine, loud error message.
  const failed = createModule({
    campaignId: campaign.id,
    title: 'Sunken Cult',
    concept: 'A cult beneath the lake.',
    levelMin: 2,
    levelMax: 2,
    tone: '',
    sizeDial: 'sketch',
  });
  const failedSaved = await saveModule({
    ...failed,
    status: 'failed',
    errorMessage: 'the spine draft failed',
  });

  return { campaignId: campaign.id, draftId: draftSaved.id, failedId: failedSaved.id };
}

beforeEach(() => {
  useProgressStore.getState().reset();
  return clearDatabase();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('ModulesListPage', () => {
  it('shows the live forge detail on the row of a module that is generating', async () => {
    const { campaignId, draftId } = await seedModules();
    renderAppAt(modulesPath(campaignId));
    const draftTitle = await screen.findByText('Vault of Whispers', {}, { timeout: 10_000 });
    const draftRow = draftTitle.closest('li');
    if (draftRow === null) throw new Error('draft module row missing');
    expect(within(draftRow).queryByTestId('module-forge-detail')).not.toBeInTheDocument();

    // The module-forge progress job (started by runParts) surfaces on the row.
    act(() => {
      useProgressStore.getState().start(
        `module-parts-${draftId}`,
        'Writing 2 module parts',
        'Writing part 1 of 2: The Mill',
      );
    });

    await waitFor(() => {
      expect(
        within(draftRow).getByTestId('module-forge-detail'),
      ).toHaveTextContent('Writing part 1 of 2: The Mill');
    });
    act(() => {
      useProgressStore.getState().reset();
    });
    await flushAsyncUpdates();
  }, 20_000);

  it('renders both modules with their level/size/status badges', async () => {
    const { campaignId } = await seedModules();
    renderAppAt(modulesPath(campaignId));

    const draftTitle = await screen.findByText('Vault of Whispers', {}, { timeout: 10_000 });
    const draftRow = draftTitle.closest('li');
    if (draftRow === null) throw new Error('draft module row missing');
    expect(within(draftRow).getByTestId('module-progress')).toHaveTextContent('2/3 parts');
    expect(within(draftRow).getByText('1–3')).toBeInTheDocument();
    expect(within(draftRow).getByText('Standard')).toBeInTheDocument();

    const failedTitle = screen.getByText('Sunken Cult');
    const failedRow = failedTitle.closest('li');
    if (failedRow === null) throw new Error('failed module row missing');
    expect(within(failedRow).getByText('failed')).toBeInTheDocument();
    expect(within(failedRow).getByText('2–2')).toBeInTheDocument();
    expect(within(failedRow).getByText('Sketch')).toBeInTheDocument();
    // A failed module has no progress badge — the failed badge replaces it.
    expect(within(failedRow).queryByTestId('module-progress')).not.toBeInTheDocument();
    await flushAsyncUpdates();
  }, 20_000);

  it('opens the New Module dialog without starting a generation run', async () => {
    const user = userEvent.setup();
    const { campaignId } = await seedModules();
    renderAppAt(modulesPath(campaignId));
    await screen.findByText('Vault of Whispers', {}, { timeout: 10_000 });

    await user.click(screen.getByTestId('new-module'));
    const dialog = await screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });
    expect(within(dialog).getByRole('heading', { name: 'New Module' })).toBeInTheDocument();
    expect(createModuleAndRunMock).not.toHaveBeenCalled();

    // Cancel closes the dialog; still no generator call.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByTestId('new-module-dialog')).not.toBeInTheDocument();
    });
    expect(createModuleAndRunMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  }, 20_000);

  it('offers prior-module continuity and passes the opt-in to the generator', async () => {
    const user = userEvent.setup();
    // 'Vault of Whispers' carries a premise + written parts, so the opt-in
    // continuity checkbox is offered.
    const { campaignId } = await seedModules();
    renderAppAt(modulesPath(campaignId));
    await screen.findByText('Vault of Whispers', {}, { timeout: 10_000 });

    await user.click(screen.getByTestId('new-module'));
    const dialog = await screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });
    const checkbox = within(dialog).getByRole('checkbox', { name: 'Continue from previous modules' });
    await waitFor(() => {
      expect(checkbox).toBeEnabled();
    });

    await user.click(checkbox);
    expect(checkbox).toBeChecked();
    await user.type(within(dialog).getByLabelText('Concept'), 'A new chapter of the story.');
    createModuleAndRunMock.mockResolvedValue('00000000-0000-4000-8000-00000000feed');
    await user.click(within(dialog).getByTestId('start-module'));
    await waitFor(() => {
      expect(createModuleAndRunMock).toHaveBeenCalledTimes(1);
    });
    expect(createModuleAndRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ includePriorModules: true }),
    );
    await flushAsyncUpdates();
  }, 20_000);

  it('starts with continuity off and disables it when no prior module has text', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Barren', system: 'dnd5e' });
    renderAppAt(modulesPath(campaign.id));
    await screen.findByTestId('new-module', {}, { timeout: 10_000 });

    await user.click(screen.getByTestId('new-module'));
    const dialog = await screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });
    const checkbox = within(dialog).getByRole('checkbox', { name: 'Continue from previous modules' });
    // Base UI checkbox: the disabled state is aria-disabled, not [disabled].
    expect(checkbox).toHaveAttribute('aria-disabled', 'true');
    expect(
      within(dialog).getByText('No previous modules with text in this campaign yet.'),
    ).toBeInTheDocument();

    // Creation still works, and the flag is passed as off.
    await user.type(within(dialog).getByLabelText('Concept'), 'The very first chapter.');
    createModuleAndRunMock.mockResolvedValue('00000000-0000-4000-8000-00000000feed');
    await user.click(within(dialog).getByTestId('start-module'));
    await waitFor(() => {
      expect(createModuleAndRunMock).toHaveBeenCalledTimes(1);
    });
    expect(createModuleAndRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ includePriorModules: false }),
    );
    await flushAsyncUpdates();
  }, 20_000);

  it('passes the post-generation automation checkboxes to the generator', async () => {
    const user = userEvent.setup();
    const { campaignId } = await seedModules();
    renderAppAt(modulesPath(campaignId));
    await screen.findByText('Vault of Whispers', {}, { timeout: 10_000 });

    await user.click(screen.getByTestId('new-module'));
    const dialog = await screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });

    // Default: the pass automations off, battlemaps ON (owner request:
    // automated encounters map automatically with the campaign's defaults).
    expect(within(dialog).getByTestId('auto-generate-npc')).not.toBeChecked();
    expect(within(dialog).getByTestId('auto-image-npc')).not.toBeChecked();
    expect(within(dialog).getByTestId('auto-spine')).not.toBeChecked();
    expect(within(dialog).getByTestId('auto-battlemaps')).toBeChecked();

    // Tick: unattended spine, auto-generate npcs + locations, auto-image npcs;
    // untick battlemaps to keep this module's maps manual.
    await user.click(within(dialog).getByTestId('auto-spine'));
    await user.click(within(dialog).getByTestId('auto-generate-npc'));
    await user.click(within(dialog).getByTestId('auto-generate-location'));
    await user.click(within(dialog).getByTestId('auto-image-npc'));
    await user.click(within(dialog).getByTestId('auto-battlemaps'));

    await user.type(within(dialog).getByLabelText('Concept'), 'Automated chapter.');
    createModuleAndRunMock.mockResolvedValue('00000000-0000-4000-8000-00000000feed');
    await user.click(within(dialog).getByTestId('start-module'));
    await waitFor(() => {
      expect(createModuleAndRunMock).toHaveBeenCalledTimes(1);
    });
    expect(createModuleAndRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        autoApproveSpine: true,
        autoGenerateKinds: ['npc', 'location'],
        autoImageKinds: ['npc'],
        autoGenerateBattlemaps: false,
      }),
    );
    await flushAsyncUpdates();
  }, 20_000);

  it('deletes a module after confirmation and removes the row from the DB', async () => {
    const user = userEvent.setup();
    const { campaignId, failedId } = await seedModules();
    renderAppAt(modulesPath(campaignId));
    await screen.findByText('Sunken Cult', {}, { timeout: 10_000 });

    await user.click(screen.getByRole('button', { name: 'Delete Sunken Cult' }));
    const confirm = await screen.findByRole('alertdialog', {}, { timeout: 5_000 });
    expect(confirm).toHaveTextContent('Sunken Cult');
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    await waitFor(
      async () => {
        expect(await getModule(failedId)).toBeUndefined();
      },
      { timeout: 10_000 },
    );
    await waitFor(() => {
      expect(screen.queryByText('Sunken Cult')).not.toBeInTheDocument();
    });
    expect(toastSuccessMock).toHaveBeenCalledWith('Module deleted');
    // The in-flight generation cancel is triggered on delete (best-effort —
    // a parts pass must not keep writing into a removed module).
    const { cancelModuleGen } = await import('@/llm/moduleGen');
    expect(cancelModuleGen).toHaveBeenCalledWith(failedId);
    await flushAsyncUpdates();
  }, 20_000);

  it('an artifact that lands after the dialog opened is cascaded, not released', async () => {
    const user = userEvent.setup();
    const { campaignId, failedId } = await seedModules();
    renderAppAt(modulesPath(campaignId));
    await screen.findByText('Sunken Cult', {}, { timeout: 10_000 });

    await user.click(screen.getByRole('button', { name: 'Delete Sunken Cult' }));
    await screen.findByRole('alertdialog', {}, { timeout: 5_000 });
    // The dialog counted ZERO owned artifacts ("Delete", keep-branch on the
    // stale count). An owned artifact lands while the dialog is open.
    const lateLooter = await createArtifact({
      campaignId,
      moduleId: failedId,
      kind: 'npc',
      name: 'Late Looter',
    });

    // Confirming must recount at confirm time: the fresh count (1) picks the
    // cascade branch — deleting the late artifact, never releasing it.
    await user.click(within(await screen.findByRole('alertdialog')).getByTestId('delete-module-confirm'));

    await waitFor(
      async () => {
        expect(await getModule(failedId)).toBeUndefined();
        expect(await getArtifact(lateLooter.id)).toBeUndefined();
      },
      { timeout: 10_000 },
    );
    expect(toastSuccessMock).toHaveBeenCalledWith('Module deleted');
    await flushAsyncUpdates();
  }, 20_000);

  it('shows the campaign name and description in the landing header', async () => {
    const campaign = await createCampaign({
      name: 'Ember',
      description: 'A sunless sea beneath a dying star.',
      system: 'dnd5e',
    });
    renderAppAt(modulesPath(campaign.id));

    const context = await screen.findByTestId(
      'campaign-landing-context',
      {},
      { timeout: 10_000 },
    );
    expect(context).toHaveTextContent('Ember');
    expect(context).toHaveTextContent('A sunless sea beneath a dying star.');
    await flushAsyncUpdates();
  }, 20_000);

  it('drops the description from the landing header when it is empty', async () => {
    const campaign = await createCampaign({ name: 'Barren', system: 'dnd5e' });
    renderAppAt(modulesPath(campaign.id));

    const context = await screen.findByTestId(
      'campaign-landing-context',
      {},
      { timeout: 10_000 },
    );
    // Name only — no stray separator for the missing description.
    expect(context.textContent).toBe('Barren');
    await flushAsyncUpdates();
  }, 20_000);

  it('edits the campaign from the landing and refreshes the header', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({
      name: 'Ember',
      description: 'Old description.',
      system: 'dnd5e',
    });
    renderAppAt(modulesPath(campaign.id));
    await screen.findByTestId('edit-campaign', {}, { timeout: 10_000 });

    await user.click(screen.getByTestId('edit-campaign'));
    const dialog = await screen.findByTestId('edit-campaign-dialog', {}, { timeout: 5_000 });
    expect(within(dialog).getByLabelText('Campaign name')).toHaveValue('Ember');
    expect(within(dialog).getByLabelText('Campaign description')).toHaveValue('Old description.');
    // The system is fixed — shown disabled, not editable.
    expect(within(dialog).getByLabelText('Game system (fixed)')).toBeDisabled();

    await user.clear(within(dialog).getByLabelText('Campaign description'));
    await user.type(within(dialog).getByLabelText('Campaign description'), 'A drowned city.');
    await user.click(within(dialog).getByTestId('save-campaign'));

    // Persisted through the repo…
    await waitFor(async () => {
      expect((await getCampaign(campaign.id))?.description).toBe('A drowned city.');
    });
    // …and the liveQuery header picked it up.
    await waitFor(() => {
      expect(screen.getByTestId('campaign-landing-context')).toHaveTextContent('A drowned city.');
    });
    await flushAsyncUpdates();
  }, 20_000);

  it('clears the description and removes it from the landing header', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({
      name: 'Ember',
      description: 'Old description.',
      system: 'dnd5e',
    });
    renderAppAt(modulesPath(campaign.id));
    await screen.findByTestId('edit-campaign', {}, { timeout: 10_000 });

    await user.click(screen.getByTestId('edit-campaign'));
    const dialog = await screen.findByTestId('edit-campaign-dialog', {}, { timeout: 5_000 });
    await user.clear(within(dialog).getByLabelText('Campaign description'));
    await user.click(within(dialog).getByTestId('save-campaign'));

    await waitFor(() => {
      expect(screen.getByTestId('campaign-landing-context').textContent).toBe('Ember');
    });
    // Raw awaited read while the page + closing dialog are mounted —
    // actDrained closes the window the save write's liveQuery cascade and
    // the dialog exit chain used to leak through (docs/08 §Console guard);
    // the long trailing drain absorbs the exit transition's timed updates.
    expect(await actDrained(() => getCampaign(campaign.id))).toMatchObject({ description: '' });
    await flushAsyncUpdates(60);
  }, 20_000);
});
