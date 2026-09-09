import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EditCampaignDialog } from '@/features/campaign/components/edit-campaign-dialog';
import { createCampaign } from '@/db/campaignRepo';
import { createArtifact, getArtifact } from '@/db/artifactRepo';
import { createModule } from '@/db/moduleRepo';
import { createModule as buildModule, type Campaign } from '@/domain';
import { db } from '@/db/db';
import { clearDatabase } from '../db/helpers';

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

// The wipe aborts in-flight module passes first — that dynamic import must
// never start real LLM machinery in this test.
vi.mock('@/llm/moduleGen', () => ({ cancelModuleGen: vi.fn() }));

const { toastError, toastSuccess } = await import('@/lib/toast');
const toastSuccessMock = vi.mocked(toastSuccess);
const toastErrorMock = vi.mocked(toastError);

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
});
afterEach(cleanup);

/**
 * Fresh-generation wipe UI (campaign settings surface): the Edit campaign
 * dialog carries the danger-zone action (never the tree or a high-traffic
 * spot); the two-step confirm lists live counts by kind + module/battle
 * counts; confirming wipes through the repo (PCs survive) and toasts what
 * was removed with counts. Failures surface via toastError, never a success
 * toast.
 */
describe('EditCampaignDialog — remove all generated content', () => {
  async function seed(): Promise<Campaign> {
    const campaign = await createCampaign({ name: 'Wipe UI', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'pc', name: 'Serren' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Goblin' });
    const module = await createModule(
      buildModule({
        campaignId: campaign.id,
        title: 'Ember Vault',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'sketch',
      }),
    );
    await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'note',
      name: 'Module note',
    });
    return campaign;
  }

  function renderDialog(campaign: Campaign): void {
    // The dialog now navigates after destructive actions (clear-workspace
    // arc), so it needs router context even for the wipe-only tests.
    render(
      <MemoryRouter initialEntries={['/']}>
        <EditCampaignDialog campaign={campaign} open={true} onOpenChange={vi.fn()} />
      </MemoryRouter>,
    );
  }

  it('lists live counts in the confirm and wipes on confirm, keeping the Party', async () => {
    const user = userEvent.setup();
    const campaign = await seed();
    renderDialog(campaign);

    await user.click(await screen.findByTestId('remove-all-generated'));
    const confirm = await screen.findByTestId('remove-all-confirm-dialog');
    // Counts by kind + module count, with the Party-kept line.
    expect(await within(confirm).findByText(/2 artifacts \(1 note, 1 npc\)/)).toBeDefined();
    expect(within(confirm).getByText(/1 module/)).toBeDefined();
    expect(within(confirm).getByText(/1 PC.*stays untouched/)).toBeDefined();

    await user.click(within(confirm).getByTestId('remove-all-confirm'));

    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith(
        expect.stringContaining('Removed 2 artifacts'),
      );
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
    // The generated rows are gone; the Party row survives.
    await waitFor(async () => {
      expect(await db.artifacts.where('campaignId').equals(campaign.id).count()).toBe(1);
    });
    const survivors = await db.artifacts.where('campaignId').equals(campaign.id).toArray();
    expect(survivors.map((row) => row.kind)).toEqual(['pc']);
    expect(await getArtifact(survivors[0]?.id ?? '')).toBeDefined();
    expect(await db.modules.where('campaignId').equals(campaign.id).count()).toBe(0);
  });

  it('says so when there is nothing generated to remove', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Bare', system: 'dnd5e' });
    renderDialog(campaign);

    await user.click(await screen.findByTestId('remove-all-generated'));
    const confirm = await screen.findByTestId('remove-all-confirm-dialog');
    expect(await within(confirm).findByText(/no generated content/)).toBeDefined();
  });
});
