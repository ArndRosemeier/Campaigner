import 'fake-indexeddb/auto';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackupSection } from '@/features/settings/backup-section';
import { createCampaign } from '@/db/campaignRepo';
import { db } from '@/db/db';
import { isQuotaExceededError } from '@/lib/errors';
import * as backupModule from '@/lib/backup';
import { noteBackupSettled, type BackupProgress } from '@/lib/backup';
import * as filePicker from '@/lib/filePicker';
import { useProgressStore } from '@/lib/progress';
import { toastError, toastErrorPersistent, toastSuccess } from '@/lib/toast';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * The backup surface after docs/17 row 265: a chunked, progress-reporting save
 * that cannot block the tab, the browser's own storage-usage figure (with its
 * unsupported and probe-failure arms told apart), an actionable quota-failure
 * toast, the pre-session nudge and the interrupted-run note.
 *
 * The toast seam is mocked so the assertions are about WHICH sentence the user
 * gets, not about sonner's DOM. jsdom can prove none of the real-device
 * behaviour this slice exists for (memory pressure, a killed tab, an actual
 * quota): the pins here are the wiring and the copy, and docs/18 §5 says so.
 */
vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastErrorPersistent: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

const IN_FLIGHT_KEY = 'campaigner.backup-in-flight';

/** Installs (or removes) the platform's StorageManager, as tablet-shell does. */
function stubStorageManager(manager: unknown): void {
  if (manager === undefined) {
    Reflect.deleteProperty(navigator, 'storage');
    return;
  }
  Object.defineProperty(navigator, 'storage', { value: manager, configurable: true });
}

beforeEach(async () => {
  await db.open();
  await clearDatabase();
  vi.clearAllMocks();
  localStorage.removeItem(IN_FLIGHT_KEY);
  useProgressStore.getState().reset();
  Reflect.deleteProperty(navigator, 'storage');
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'storage');
  localStorage.removeItem(IN_FLIGHT_KEY);
  noteBackupSettled();
  useProgressStore.getState().reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('backup storage usage (row 265)', () => {
  it('shows bytes used of the browser-reported quota, names the figure as an estimate, and refreshes on demand', async () => {
    const user = userEvent.setup();
    const estimate = vi.fn().mockResolvedValue({
      usage: 512 * 1024 * 1024,
      quota: 2 * 1024 * 1024 * 1024,
    });
    stubStorageManager({ estimate });

    render(<BackupSection />);

    const usage = await screen.findByTestId('storage-usage');
    await waitFor(() => {
      expect(usage).toHaveTextContent('512 MB of 2 GB available (25%)');
    });
    // The honest caveat rides the same line, not a tooltip nobody opens.
    expect(usage).toHaveTextContent('Browsers report these figures roughly.');
    expect(estimate).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId('storage-refresh'));
    await waitFor(() => {
      expect(estimate).toHaveBeenCalledTimes(2);
    });
    await flushAsyncUpdates();
  });

  it('reads "not available" — never an error — when the platform has no estimate API', async () => {
    Reflect.deleteProperty(navigator, 'storage');
    render(<BackupSection />);

    const usage = await screen.findByTestId('storage-usage');
    await waitFor(() => {
      expect(usage).toHaveTextContent('does not report how much space is left');
    });
    expect(toastError).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  });

  it('toasts when a PRESENT probe throws, and still falls back to the unavailable line', async () => {
    stubStorageManager({ estimate: vi.fn().mockRejectedValue(new Error('estimate exploded')) });
    render(<BackupSection />);

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        'Could not read how much storage is in use',
        expect.any(Error),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('storage-usage')).toHaveTextContent(
        'does not report how much space is left',
      );
    });
    await flushAsyncUpdates();
  });
});

describe('backup save after row 265', () => {
  it('explains a quota failure on write with the mitigation, and keeps the notice up', async () => {
    const user = userEvent.setup();
    await createCampaign({ name: 'Quota Ember', system: 'dnd5e' });
    // The raw platform error is deliberately written to the console; a spy is
    // not console noise (tests/setup.ts), and the assertion below it is real.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(filePicker, 'openSaveTarget').mockResolvedValue({
      cancelled: false,
      write: () => Promise.reject(new DOMException('the disk is full', 'QuotaExceededError')),
    });

    render(<BackupSection />);
    await flushAsyncUpdates();
    await user.click(screen.getByTestId('backup-save'));

    await waitFor(() => {
      expect(toastErrorPersistent).toHaveBeenCalledTimes(1);
    });
    const [title, reason] = vi.mocked(toastErrorPersistent).mock.calls[0] ?? [];
    expect(title).toContain('Not enough space to save the backup');
    expect(reason).toBeInstanceOf(Error);
    expect((reason as Error).message).toMatch(/Nothing was saved/);
    expect((reason as Error).message).toMatch(/delete unused images/);
    expect((reason as Error).message).toMatch(/try again/);
    // …and the platform's own text is preserved for diagnosis, never as the
    // sentence the user reads.
    expect(consoleSpy).toHaveBeenCalled();
    await flushAsyncUpdates();
  }, 30000);

  it('surfaces a non-quota build failure loudly, with the underlying error', async () => {
    const user = userEvent.setup();
    vi.spyOn(filePicker, 'openSaveTarget').mockResolvedValue({
      cancelled: false,
      write: () => Promise.resolve(),
    });
    vi.spyOn(backupModule, 'buildBackup').mockRejectedValue(
      new Error('Image row abc has no binary payload'),
    );

    render(<BackupSection />);
    await flushAsyncUpdates();
    await user.click(screen.getByTestId('backup-save'));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledTimes(1);
    });
    const [title, error] = vi.mocked(toastError).mock.calls[0] ?? [];
    expect(title).toBe('Could not save the backup');
    expect((error as Error).message).toMatch(/no binary payload/);
    await flushAsyncUpdates();
  }, 30000);

  it('reports build progress through the app-wide progress dock', async () => {
    const user = userEvent.setup();
    let report: ((progress: BackupProgress) => void) | undefined;
    vi.spyOn(filePicker, 'openSaveTarget').mockResolvedValue({
      cancelled: false,
      write: () => Promise.resolve(),
    });
    // Never resolves: the arm needs the build IN FLIGHT to read the dock.
    vi.spyOn(backupModule, 'buildBackup').mockImplementation((options) => {
      report = options?.onProgress;
      return new Promise<backupModule.BackupFile>(() => undefined);
    });

    render(<BackupSection />);
    await flushAsyncUpdates();
    await user.click(screen.getByTestId('backup-save'));
    await waitFor(() => {
      expect(report).toBeDefined();
    });

    act(() => {
      report?.({ detail: 'Packing images (2 of 9)…', progress: 0.5 });
    });
    const job = useProgressStore.getState().jobs.find((entry) => entry.id === 'app-backup');
    expect(job?.detail).toBe('Packing images (2 of 9)…');
    expect(job?.progress).toBe(0.5);
    await flushAsyncUpdates();
  }, 30000);

  it('nudges before a session and names an interrupted previous backup, clearing it on a completed save', async () => {
    const user = userEvent.setup();
    localStorage.setItem(IN_FLIGHT_KEY, String(Date.now()));
    vi.spyOn(filePicker, 'openSaveTarget').mockResolvedValue({
      cancelled: false,
      write: () => Promise.resolve(),
    });

    render(<BackupSection />);
    expect(await screen.findByTestId('backup-session-prompt')).toHaveTextContent(
      /Before your next session, save a backup/,
    );
    expect(screen.getByTestId('backup-interrupted')).toHaveTextContent(/did not finish/);

    // The REAL build runs here (empty database) and the write succeeds.
    await user.click(screen.getByTestId('backup-save'));
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('Backup saved');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('backup-interrupted')).toBeNull();
    });
    expect(localStorage.getItem(IN_FLIGHT_KEY)).toBeNull();
    await flushAsyncUpdates();
  }, 30000);
});

describe('isQuotaExceededError (row 265)', () => {
  it('recognizes every spelling of the platform refusal and rejects everything else', () => {
    expect(isQuotaExceededError(new DOMException('full', 'QuotaExceededError'))).toBe(true);

    const legacy = new Error('full');
    Object.assign(legacy, { code: 22 });
    expect(isQuotaExceededError(legacy)).toBe(true);

    const firefox = new Error('full');
    firefox.name = 'NS_ERROR_DOM_QUOTA_REACHED';
    expect(isQuotaExceededError(firefox)).toBe(true);

    // Dexie wraps an error thrown inside a transaction.
    expect(
      isQuotaExceededError({ name: 'AbortError', inner: new DOMException('x', 'QuotaExceededError') }),
    ).toBe(true);

    expect(isQuotaExceededError(new Error('a normal failure'))).toBe(false);
    expect(isQuotaExceededError(null)).toBe(false);
    expect(isQuotaExceededError('QuotaExceededError')).toBe(false);
  });
});
