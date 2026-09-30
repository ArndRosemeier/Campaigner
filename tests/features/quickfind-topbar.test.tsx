import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { createAppRouter } from '@/app/router';
import { workspacePath } from '@/app/routes';
import { createCampaign } from '@/db/campaignRepo';
import { clearDatabase } from '../db/helpers';

/**
 * Quick find's touch entry point (05-UI.md §Tablet): the Ctrl/Cmd+K palette
 * is unreachable from an on-screen keyboard, so the top bar carries a Find
 * button on every campaign route that opens the same dialog as the hotkey.
 */

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

beforeEach(async () => {
  await clearDatabase();
});

describe('quick find top-bar button', () => {
  it('is absent outside campaign routes (matches the hotkey gating)', () => {
    renderAppAt('/');

    expect(screen.queryByTestId('quick-find-button')).not.toBeInTheDocument();
  });

  it('opens the quick find dialog on click', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    renderAppAt(workspacePath(campaign.id));

    await user.click(await screen.findByTestId('quick-find-button', {}, { timeout: 10_000 }));

    expect(screen.getByTestId('quickfind-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('quickfind-input')).toHaveFocus();
  });
});
