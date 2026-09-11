import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { ROUTES } from '@/app/routes';
import type * as IngestFiles from '@/ingest/ingestFiles';
import { defaultSettings, newId, type RuleChunk } from '@/domain';
import { saveSettings } from '@/db/settingsRepo';
import { createRulebook, updateRulebook } from '@/db/rulebookRepo';
import { putChunks } from '@/db/chunkRepo';
import { clearDatabase } from './db/helpers';
import { expectBlockedReason, expectBlockedReasonMenuItem } from './helpers/blocked-reason';
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

vi.mock('@/ingest/ingestFiles', async (importOriginal) => {
  // A passthrough mock: the four import tests in this file drive the REAL
  // ingest; the reason pins hold one call with `mockImplementationOnce`.
  const actual = await importOriginal<typeof IngestFiles>();
  return { ...actual, ingestPdf: vi.fn(actual.ingestPdf) };
});
vi.mock('@/search', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  embeddingsActive: vi.fn(() => Promise.resolve(true)),
  ensureEmbeddings: vi.fn(),
}));

const { ingestPdf } = await import('@/ingest/ingestFiles');
const { ensureEmbeddings } = await import('@/search');
const ingestMock = vi.mocked(ingestPdf);
const ensureMock = vi.mocked(ensureEmbeddings);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A minimal valid chunk row for the ready book (the embed path needs one). */
function chunk(bookId: string): RuleChunk {
  const hash = 'a'.repeat(64);
  return {
    id: newId(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    bookId,
    pageStart: 1,
    pageEnd: 1,
    chunkType: 'section',
    headingPath: ['Chapter 1'],
    text: 'The bell tolls over the drowned quarter.',
    statBlock: null,
    contentHash: hash,
  };
}

beforeEach(async () => {
  await clearDatabase();
  ingestMock.mockClear();
  ensureMock.mockClear();
  // These tests exercise the Rules screen, not the first-run wizard — seed
  // the onboarding state as finished so the wizard's one-time auto-open
  // (fresh status + zero campaigns) never overlays the page here. The
  // wizard's own auto-open behavior is covered in
  // tests/features/onboarding-wizard.test.tsx.
  await saveSettings({
    ...defaultSettings(),
    onboarding: { status: 'complete' as const, stepState: [] },
  });
});
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

  it('states why the import/embed controls are held: the page-wide import, the per-book embed, the delete icon and both menu items', async () => {
    const user = userEvent.setup();
    await saveSettings({
      ...defaultSettings(),
      onboarding: { status: 'complete' as const, stepState: [] },
      embeddingsEnabled: true,
      openRouterApiKey: 'test-key',
    });
    const ready = await createRulebook({
      title: 'emberfall-core',
      system: 'generic-d20',
      filename: 'core.pdf',
    });
    await updateRulebook(ready.id, { status: 'ready' });
    await putChunks([chunk(ready.id)]);
    const broken = await createRulebook({
      title: 'torn-scan',
      system: 'generic-d20',
      filename: 'torn.pdf',
    });
    await updateRulebook(broken.id, { status: 'error', errorMessage: 'No extractable text' });

    const pendingImport = deferred<never>();
    ingestMock.mockImplementationOnce(() => pendingImport.promise);
    renderAppAt(ROUTES.rules);
    await screen.findByText('emberfall-core', {}, { timeout: 10000 });

    // A PDF import in flight — the real input, a real .pdf file, a held ingest.
    const input = screen.getByTestId('import-input');
    Object.defineProperty(input, 'files', {
      value: [new File(['%PDF-1.4'], 'core.pdf', { type: 'application/pdf' })],
    });
    fireEvent.change(input);
    await waitFor(() => {
      expect(screen.getByTestId('import-pdfs')).toBeDisabled();
    });

    const IMPORT_REASON =
      'A PDF import is running right now — one import runs at a time here; wait for it to finish.';
    await expectBlockedReason(user, 'import-pdfs', IMPORT_REASON);
    await expectBlockedReason(user, 'import-pack', IMPORT_REASON);
    // The card's delete icon is held by the same page-wide flag, and says so.
    await expectBlockedReason(user, `delete-book-${ready.id}`, IMPORT_REASON);
    // The failed book's "Retry…" starts ANOTHER import — same flag, same reason.
    await user.click(screen.getByRole('button', { name: 'Menu for torn-scan' }));
    await screen.findByTestId(`retry-book-${broken.id}`, {}, { timeout: 10000 });
    await expectBlockedReasonMenuItem(user, `retry-book-${broken.id}`, IMPORT_REASON);
    await user.keyboard('{Escape}');

    // The import lands: both the hold and its reason go with it.
    pendingImport.resolve({ book: ready, chunkCount: 0, emptyPages: 0 } as never);
    await waitFor(() => {
      expect(screen.getByTestId('import-pdfs')).toBeEnabled();
    });
    expect(screen.queryByTestId('import-pdfs-reason')).toBeNull();

    // Embedding is THIS book's own run, so its menu item states the embed.
    const pendingEmbed = deferred<never>();
    // The run has to report its first progress tick BEFORE it is held: only a
    // tick populates `embedProgress[book.id]`, which is the flag the item's own
    // gate reads (`embedding === embed !== undefined`).
    ensureMock.mockImplementation((_chunks, onProgress) => {
      onProgress?.(1, 1);
      return pendingEmbed.promise;
    });
    await user.click(screen.getByRole('button', { name: 'Menu for emberfall-core' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Embed whole book' }));
    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalled();
    });
    await user.click(screen.getByRole('button', { name: 'Menu for emberfall-core' }));
    await screen.findByTestId(`embed-book-${ready.id}`, {}, { timeout: 10000 });
    await expectBlockedReasonMenuItem(
      user,
      `embed-book-${ready.id}`,
      'This book is being embedded right now — wait for it to finish.',
    );
    pendingEmbed.resolve(undefined as never);
    await flushAsyncUpdates();
  }, 40_000);
});
