import 'fake-indexeddb/auto';

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { modulesPath } from '@/app/routes';
import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { createModule, modulePartSchema, moduleSpineSchema, type Id } from '@/domain';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

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

beforeEach(clearDatabase);

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('ModulesListPage', () => {
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
    await flushAsyncUpdates();
  }, 20_000);
});
