import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAppRouter } from '@/app/router';
import { ROUTES } from '@/app/routes';
import { usePinnedChunksStore } from '@/features/rules/pinStore';
import { clearDatabase } from './db/helpers';

/**
 * Rules search browser (T5): search over the imported fixture, expand a hit,
 * pin it to the Assistant.
 */

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

const fixturePath = join(import.meta.dirname, 'fixtures', 'sample-rulebook.pdf');
const fixtureBytes = readFileSync(fixturePath);

beforeEach(clearDatabase);
afterEach(cleanup);

describe('rules search browser', () => {
  it('searches imported books, expands a hit and pins it to the Assistant', async () => {
    const user = userEvent.setup();
    renderAppAt(ROUTES.rules);

    // Import the fixture PDF through the real UI path.
    const input = screen.getByTestId('import-input');
    Object.defineProperty(input, 'files', {
      value: [
        new File([new Uint8Array(fixtureBytes)], 'sample-rulebook.pdf', {
          type: 'application/pdf',
        }),
      ],
    });
    fireEvent.change(input);
    await waitFor(() => {
      expect(screen.getByText('ready')).toBeInTheDocument();
    }, { timeout: 15000 });

    const search = screen.getByTestId('rules-search');
    await user.type(search, 'grapple');
    fireEvent.keyDown(search, { key: 'Enter' });

    const hit = await screen.findByTestId('search-hit', {}, { timeout: 5000 });
    expect(hit.textContent).toContain('grapple');

    // Expand shows the full chunk text (the card's expand toggle button).
    const expandToggle = within(hit).getAllByRole('button')[0];
    if (expandToggle === undefined) throw new Error('expand toggle missing');
    await user.click(expandToggle);
    expect(screen.getByTestId('expanded-chunk')).toBeInTheDocument();

    // Pin to Assistant → zustand pin list + button flips to Unpin.
    await user.click(within(hit).getByRole('button', { name: 'Pin to Assistant' }));
    await waitFor(() => {
      expect(usePinnedChunksStore.getState().chunks).toHaveLength(1);
    });
    expect(within(hit).getByRole('button', { name: 'Unpin' })).toBeInTheDocument();
  }, 30000);
});
