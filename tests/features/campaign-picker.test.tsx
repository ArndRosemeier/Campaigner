import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ROUTES } from '@/app/routes';
import { CampaignPickerPage } from '@/features/campaign/CampaignPickerPage';
import { createCampaign } from '@/db/campaignRepo';
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
});
