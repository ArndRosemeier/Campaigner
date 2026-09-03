import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsPage } from '@/features/settings/SettingsPage';
import { db } from '@/db/db';
import { getSettings, updateSettings } from '@/db/settingsRepo';
import { unzipSync } from 'fflate';
import { buildBackup } from '@/lib/backup';
import * as filePicker from '@/lib/filePicker';
import { createCampaign } from '@/db/campaignRepo';
import Dexie from 'dexie';
import { clearDatabase } from './db/helpers';
import { flushAsyncUpdates } from './helpers/flush';

/**
 * Settings screen (T6): API key + "Test key" (mocked /models), embeddings
 * toggle persistence, and the typed-DELETE danger zone.
 */

beforeEach(async () => {
  // The danger-zone test closes the database; Dexie does not auto-reopen
  // after an explicit close(), so every test starts by opening it.
  await db.open();
  await clearDatabase();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

  it('updates default reasoning effort when model supports reasoning', async () => {
    await updateSettings({ defaultChatModel: 'openai/o3-mini' });
    const user = userEvent.setup();
    render(<SettingsPage />);

    const select = await screen.findByTestId('chat-reasoning-effort');
    expect(select).toBeEnabled();
    expect(screen.getByText('Supported')).toBeInTheDocument();

    await user.click(select);
    const highOption = await screen.findByRole('option', { name: 'High' });
    await user.click(highOption);

    await waitFor(async () => {
      const settings = await getSettings();
      expect(settings.defaultReasoningEffort).toBe('high');
    });
  });

  it('disables reasoning effort when model does not support reasoning', async () => {
    await updateSettings({ defaultChatModel: 'openai/gpt-4o' });
    render(<SettingsPage />);

    const select = await screen.findByTestId('chat-reasoning-effort');
    expect(select).toBeDisabled();
    expect(screen.getByText('Not supported by this model')).toBeInTheDocument();
  });

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

  it('saves and restores a full backup zip with a fallback file picker', async () => {
    const user = userEvent.setup();
    // The danger-zone test above closed the database; Dexie will not
    // auto-reopen after an explicit close().
    await db.open();
    // jsdom cannot spy on location.reload (non-configurable); stub the whole
    // location global with a recording reload instead.
    const reloadMock = vi.fn();
    // jsdom's Location is a class instance — copy its own properties instead of
    // spreading (spreading would drop the prototype).
    const locationStub = Object.fromEntries(
      Object.getOwnPropertyNames(window.location).map((key) => [
        key,
        (window.location as unknown as Record<string, unknown>)[key],
      ]),
    ) as unknown as Location;
    locationStub.reload = reloadMock;
    vi.stubGlobal('location', locationStub);
    const saveSpy = vi.spyOn(filePicker, 'saveBlobToDisk').mockResolvedValue('saved');
    // jsdom has no FS Access API — the fallback path must be used.
    expect(filePicker.supportsFilePickers()).toBe(false);

    // A campaign to back up…
    const campaign = await createCampaign({ name: 'Backed Up', system: 'dnd5e' });
    await updateSettings({ openRouterApiKey: 'sk-must-not-travel' });
    const { bytes, manifest } = await buildBackup();
    expect(manifest.tableCounts.campaigns).toBe(1);
    expect(manifest.tableCounts.settings).toBe(1);
    // The API key never enters the backup file.
    const manifestText = new TextDecoder().decode(
      unzipSync(bytes)['campaigner-backup.json'] ?? new Uint8Array(),
    );
    expect(manifestText).not.toContain('sk-must-not-travel');

    const rendered = render(<SettingsPage />);

    // SAVE: the zip reaches the fallback (download) with the right name.
    await user.click(await screen.findByTestId('backup-save'));
    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledTimes(1);
    });
    await flushAsyncUpdates();
    const [blob, filename] = saveSpy.mock.calls[0] ?? [];
    expect(filename).toBe(`campaigner-backup-${new Date(manifest.exportedAt).toISOString().slice(0, 10)}.zip`);
    // The written blob is a valid backup containing the campaign.
    const savedManifest = JSON.parse(
      new TextDecoder().decode(unzipSync(new Uint8Array(await (blob ?? new Blob()).arrayBuffer()))['campaigner-backup.json'] ?? new TextEncoder().encode('{}')),
    ) as { format?: string; data?: { campaigns?: { name?: string }[] } };
    expect(savedManifest.format).toBe('campaigner-backup');
    expect(savedManifest.data?.campaigns?.[0]?.name).toBe('Backed Up');

    // LOAD: unmount settings before the raw database wipe so its live-query
    // controls cannot receive teardown updates outside act, then remount for
    // the actual restore interaction.
    rendered.unmount();
    await clearDatabase();
    expect(await db.campaigns.get(campaign.id)).toBeUndefined();
    render(<SettingsPage />);
    vi
      .spyOn(filePicker, 'pickBackupFile')
      .mockResolvedValue(new File([bytes as BlobPart], 'backup.zip', { type: 'application/zip' }));

    await user.click(screen.getByTestId('backup-load'));
    expect(await screen.findByTestId('backup-restore-dialog')).toBeInTheDocument();
    await user.click(screen.getByTestId('backup-confirm-restore'));

    await waitFor(async () => {
      const restored = await db.campaigns.get(campaign.id);
      expect(restored?.name).toBe('Backed Up');
    });
    expect(reloadMock).toHaveBeenCalled();
    // Drain the restore flow's trailing setRestoring/setPendingFile updates.
    await flushAsyncUpdates();
  }, 30000);
});
