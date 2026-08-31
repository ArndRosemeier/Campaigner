import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAppRouter } from '@/app/router';
import { ROUTES } from '@/app/routes';
import { clearDatabase } from './db/helpers';
import { flushAsyncUpdates } from './helpers/flush';

/**
 * Rules screen (T4): PDF import through the UI with the committed fixture,
 * then rename/delete flows — backed by the real Dexie database.
 */

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

const fixturePath = join(import.meta.dirname, 'fixtures', 'sample-rulebook.pdf');
const fixtureBytes = readFileSync(fixturePath);

function fixtureFile(): File {
  return new File([new Uint8Array(fixtureBytes)], 'sample-rulebook.pdf', {
    type: 'application/pdf',
  });
}

function importFixture(): void {
  const input = screen.getByTestId('import-input');
  Object.defineProperty(input, 'files', { value: [fixtureFile()] });
  fireEvent.change(input);
}

beforeEach(clearDatabase);
afterEach(cleanup);

describe('rules screen', () => {
  it('imports a PDF through the UI and lists the ready book with chunks', async () => {
    renderAppAt(ROUTES.rules);

    expect(await screen.findByText('No rulebooks yet')).toBeInTheDocument();
    importFixture();

    const title = await screen.findByText('sample-rulebook');
    const card = title.closest('li') as HTMLElement;
    await waitFor(() => {
      expect(within(card).getByText('ready')).toBeInTheDocument();
    });
    expect(within(card).getByText(/\d+ chunks?/)).toBeInTheDocument();
    expect(await screen.findByText(/Imported “sample-rulebook”/)).toBeInTheDocument();
  }, 30000);

  it('renames a book from the card menu', async () => {
    const user = userEvent.setup();
    renderAppAt(ROUTES.rules);
    importFixture();

    await screen.findByText('sample-rulebook');
    await waitFor(() => {
      expect(screen.getByText('ready')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Menu for sample-rulebook' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));

    const titleInput = await screen.findByLabelText('Rulebook title');
    await user.clear(titleInput);
    await user.type(titleInput, 'Core Rulebook');
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    expect(await screen.findByText('Core Rulebook')).toBeInTheDocument();
    expect(screen.queryByText('sample-rulebook')).not.toBeInTheDocument();
  }, 30000);

  it('deletes a book after confirming, removing it from the list', async () => {
    const user = userEvent.setup();
    renderAppAt(ROUTES.rules);
    importFixture();

    await screen.findByText('sample-rulebook');
    await waitFor(() => {
      expect(screen.getByText('ready')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Menu for sample-rulebook' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.queryByText('sample-rulebook')).not.toBeInTheDocument();
    });
    expect(await screen.findByText('No rulebooks yet')).toBeInTheDocument();
  }, 30000);

  it('deletes a book from the visible card button, removing its chunks', async () => {
    const user = userEvent.setup();
    renderAppAt(ROUTES.rules);
    importFixture();

    await screen.findByText('sample-rulebook');
    await waitFor(() => {
      expect(screen.getByText('ready')).toBeInTheDocument();
    });

    // The card carries its own visible delete affordance (no menu needed).
    await user.click(screen.getByRole('button', { name: 'Delete sample-rulebook' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.queryByText('sample-rulebook')).not.toBeInTheDocument();
    });
    // Drain the delete's live-query cascade inside act before plain reads.
    await flushAsyncUpdates();
    // The chunks are gone with the book, not orphaned.
    const { db } = await import('@/db/db');
    const { listRulebooks } = await import('@/db/rulebookRepo');
    expect(await listRulebooks()).toHaveLength(0);
    expect(await db.chunks.count()).toBe(0);
    await flushAsyncUpdates();
  }, 30000);
});
