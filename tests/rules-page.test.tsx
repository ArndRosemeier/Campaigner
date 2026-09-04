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
import { baseNpc, encodeJson, folderDoc } from './ingest/packs/fixtures';

/**
 * Rules screen (T4): PDF import through the UI with the committed fixture,
 * then rename/delete flows — backed by the real Dexie database. The bestiary
 * pack import (12-BESTIARY-PACKS §6) runs the real adapter + Dexie flow with
 * fixture creature documents.
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

function packFile(name: string, doc: Record<string, unknown>): File {
  return new File([new Uint8Array(encodeJson(doc))], name, { type: 'application/json' });
}

function importPackFiles(files: File[]): void {
  const input = screen.getByTestId('pack-import-input');
  Object.defineProperty(input, 'files', { value: files });
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

    await screen.findByText('sample-rulebook', {}, { timeout: 10000 });
    await waitFor(() => {
      expect(screen.getByText('ready')).toBeInTheDocument();
    }, { timeout: 15000 });

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

    await screen.findByText('sample-rulebook', {}, { timeout: 10000 });
    await waitFor(() => {
      expect(screen.getByText('ready')).toBeInTheDocument();
    }, { timeout: 15000 });

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

    await screen.findByText('sample-rulebook', {}, { timeout: 10000 });
    await waitFor(() => {
      expect(screen.getByText('ready')).toBeInTheDocument();
    }, { timeout: 15000 });

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

  it('imports a bestiary pack through the dialog and lists it with the Pack badge', async () => {
    const user = userEvent.setup();
    renderAppAt(ROUTES.rules);

    await user.click(screen.getByTestId('import-pack'));
    const dialog = screen.getByTestId('pack-import-dialog');

    // The adapter select lists the registered adapters only.
    expect(within(dialog).getByLabelText('Pack source')).toHaveTextContent(
      'Pathfinder 2e (Foundry VTT PF2e system packs)',
    );
    importPackFiles([
      packFile('age-of-ashes-goblin.json', baseNpc('Goblin Warrior')),
      packFile('_folders.json', folderDoc()),
    ]);
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));

    // The import report names all three counts; the folder doc counts as skipped.
    const report = await within(dialog).findByTestId('pack-import-report', {}, { timeout: 15000 });
    expect(report).toHaveTextContent('1 imported');
    expect(report).toHaveTextContent('1 skipped');
    expect(report).toHaveTextContent('0 failed');

    // Close the dialog (it aria-hides the book list while open).
    await user.keyboard('{Escape}');

    const title = await screen.findByText('age-of-ashes-goblin', {}, { timeout: 15000 });
    await waitFor(() => {
      expect(within(title.closest('li') as HTMLElement).getByText('ready')).toBeInTheDocument();
    });
    const card = (await screen.findByText('age-of-ashes-goblin')).closest('li') as HTMLElement;
    expect(within(card).getByText('Pack')).toBeInTheDocument();
    expect(within(card).getByText('1 chunk')).toBeInTheDocument();

    // The license lives in the book menu, shown verbatim from the adapter.
    await user.click(within(card).getByRole('button', { name: 'Menu for age-of-ashes-goblin' }));
    await user.click(await screen.findByRole('menuitem', { name: 'License' }));
    expect(await screen.findByTestId('pack-license')).toHaveTextContent(/Pathfinder Second Edition/);
  }, 30000);

  it('marks the book error and toasts when a pack selection has zero valid entries', async () => {
    const user = userEvent.setup();
    renderAppAt(ROUTES.rules);

    await user.click(screen.getByTestId('import-pack'));
    const dialog = screen.getByTestId('pack-import-dialog');
    importPackFiles([packFile('only-folders.json', folderDoc())]);
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));

    // Loud failure: a toast names the reason, and the book lands as error —
    // never an empty ready book.
    expect(
      await screen.findByText(/Could not import the bestiary pack/, {}, { timeout: 15000 }),
    ).toBeInTheDocument();
    const title = await screen.findByText('only-folders', {}, { timeout: 15000 });
    const card = title.closest('li') as HTMLElement;
    await waitFor(() => {
      expect(within(card).getByText('error')).toBeInTheDocument();
    });
    expect(within(card).getByText(/no valid creature entries/)).toBeInTheDocument();
  }, 30000);
});
