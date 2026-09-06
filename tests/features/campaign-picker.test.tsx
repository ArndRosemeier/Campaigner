import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ROUTES } from '@/app/routes';
import { CampaignPickerPage } from '@/features/campaign/CampaignPickerPage';
import { createCampaign, getCampaign } from '@/db/campaignRepo';
import { clearDatabase } from '../db/helpers';

function renderPicker(): void {
  render(
    <MemoryRouter initialEntries={[ROUTES.campaignPicker]}>
      <Routes>
        <Route path={ROUTES.campaignPicker} element={<CampaignPickerPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(clearDatabase);
afterEach(cleanup);

describe('CampaignPickerPage', () => {
  it('shows the empty-state hero when there are no campaigns', async () => {
    renderPicker();
    expect(await screen.findByText('No campaigns yet')).toBeDefined();
  });

  it('lists campaigns with system badge and artifact count', async () => {
    await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    renderPicker();

    expect(await screen.findByText('Emberfall')).toBeDefined();
    expect(screen.getByText('D&D 5e')).toBeDefined();
    expect(screen.getByText(/0 artifacts/)).toBeDefined();
  });

  it('creates a campaign through the dialog', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(await screen.findByTestId('new-campaign'));
    await user.type(screen.getByLabelText('Campaign name'), 'The Sunless Sea');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('The Sunless Sea')).toBeDefined();
    // The dialog closes (after its exit transition) and resets its fields.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
    });
  });

  it('shows the description snippet on the card only when it is non-empty', async () => {
    await createCampaign({ name: 'Emberfall', description: 'A sunless sea.', system: 'dnd5e' });
    await createCampaign({ name: 'Barren', system: 'dnd5e' });
    renderPicker();

    const describedCard = (await screen.findByText('Emberfall')).closest('li');
    const bareCard = screen.getByText('Barren').closest('li');
    if (describedCard === null || bareCard === null) throw new Error('campaign card missing');
    expect(within(describedCard).getByText('A sunless sea.')).toBeInTheDocument();
    // An empty description renders no snippet — not even a placeholder.
    expect(within(bareCard).queryByText('A sunless sea.')).toBeNull();
  });

  it('edits name and description from the card menu and persists both', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    renderPicker();
    await screen.findByText('Emberfall');

    await user.click(screen.getByRole('button', { name: 'Menu for Emberfall' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit campaign…' }));
    const dialog = await screen.findByTestId('edit-campaign-dialog');
    // The game system is shown read-only: battles/stat blocks depend on it.
    expect(within(dialog).getByLabelText('Game system (fixed)')).toBeDisabled();

    await user.clear(within(dialog).getByLabelText('Campaign name'));
    await user.type(within(dialog).getByLabelText('Campaign name'), 'Emberfall II');
    await user.type(within(dialog).getByLabelText('Campaign description'), 'A sunless sea.');
    await user.click(within(dialog).getByTestId('save-campaign'));

    // The card refreshes via the live summaries query…
    expect(await screen.findByText('Emberfall II')).toBeDefined();
    expect(await screen.findByText('A sunless sea.')).toBeDefined();
    // …and the row is updated in the DB.
    await waitFor(async () => {
      expect((await getCampaign(campaign.id))?.description).toBe('A sunless sea.');
    });
  });
});
