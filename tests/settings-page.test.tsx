import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsPage } from '@/features/settings/SettingsPage';
import { db } from '@/db/db';
import { getSettings } from '@/db/settingsRepo';
import Dexie from 'dexie';
import { clearDatabase } from './db/helpers';

/**
 * Settings screen (T6): API key + "Test key" (mocked /models), embeddings
 * toggle persistence, and the typed-DELETE danger zone.
 */

beforeEach(clearDatabase);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SettingsPage', () => {
  it('saves the key, tests it against /models and toggles embeddings', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    const keyInput = await screen.findByLabelText('API key');
    await user.type(keyInput, 'sk-or-test');

    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: 'anthropic/claude-sonnet-4.5' }] }), {
          status: 200,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await user.click(screen.getByTestId('test-key'));
    expect(await screen.findByText(/Key works — 1 models? available/)).toBeInTheDocument();

    await waitFor(async () => {
      const settings = await getSettings();
      expect(settings.openRouterApiKey).toBe('sk-or-test');
    });

    const toggle = screen.getByRole('switch', { name: 'Semantic search (embeddings)' });
    await user.click(toggle);
    await waitFor(async () => {
      const settings = await getSettings();
      expect(settings.embeddingsEnabled).toBe(true);
    });
  }, 30000);

  it('deletes all data only when DELETE is typed', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    await user.click(await screen.findByTestId('delete-all-data'));

    const confirmInput = await screen.findByLabelText('Type DELETE');
    const confirmButton = screen.getByRole('button', { name: 'Delete everything' });
    expect(confirmButton).toBeDisabled();

    await user.type(confirmInput, 'DELETE');
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);

    await waitFor(async () => {
      await expect(Dexie.exists('campaigner')).resolves.toBe(false);
    });
    expect(localStorage.getItem('campaigner.pinned-chunks')).toBeNull();
    expect(db.isOpen()).toBe(false);
  }, 30000);
});
