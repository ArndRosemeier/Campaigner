import 'fake-indexeddb/auto';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrientationGate } from '@/app/layout/orientation-gate';
import { InstallHint } from '@/app/layout/install-hint';
import {
  dismissInstallHint,
  ensurePersistentStorage,
  installHintDismissed,
  isStandalone,
  mediaMatches,
  shouldShowInstallHint,
  storagePersistedStatus,
} from '@/lib/deviceCapabilities';
import { clearDatabase } from './db/helpers';

/**
 * Tablet/PWA shell (05-UI.md §Tablet): the CSS-only orientation gates are
 * present, the install-hint logic reacts to pointer/standalone state, and
 * the storage-persistence probe respects the platform's feature detection.
 */

beforeEach(async () => {
  await clearDatabase();
  localStorage.removeItem('campaigner.install-hint-dismissed');
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('orientation gate', () => {
  it('renders both hard-block overlays (media queries decide visibility in CSS)', () => {
    render(<OrientationGate />);
    expect(screen.getByTestId('orientation-gate-rotate')).toBeInTheDocument();
    expect(screen.getByTestId('orientation-gate-narrow')).toBeInTheDocument();
  });
});

describe('device capabilities', () => {
  it('treats a missing matchMedia as "does not match" (jsdom)', () => {
    expect(mediaMatches('(pointer: coarse)')).toBe(false);
    expect(isStandalone()).toBe(false);
    expect(shouldShowInstallHint()).toBe(false);
  });

  it('shows the install hint only for touch browser tabs, once', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('coarse'),
        media: query,
      })),
    );

    // Touch device, plain browser tab → hint shows exactly once.
    expect(shouldShowInstallHint()).toBe(true);
    dismissInstallHint();
    expect(installHintDismissed()).toBe(true);
    expect(shouldShowInstallHint()).toBe(false);

    // Installed (standalone) → never.
    localStorage.removeItem('campaigner.install-hint-dismissed');
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('coarse') || query.includes('standalone'),
        media: query,
      })),
    );
    expect(isStandalone()).toBe(true);
    expect(shouldShowInstallHint()).toBe(false);
  });

  it('renders and dismisses the install hint banner', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('coarse'),
        media: query,
      })),
    );

    const { rerender } = render(<InstallHint />);
    expect(screen.getByTestId('install-hint')).toBeInTheDocument();
    expect(screen.getByText(/add Campaigner to your home screen/)).toBeInTheDocument();

    await user.click(screen.getByTestId('install-hint-dismiss'));
    expect(installHintDismissed()).toBe(true);

    rerender(<InstallHint />);
    expect(screen.queryByTestId('install-hint')).not.toBeInTheDocument();
  });

  it('hides the install hint for a missing matchMedia', () => {
    render(<InstallHint />);
    expect(screen.queryByTestId('install-hint')).not.toBeInTheDocument();
  });
});

describe('storage persistence', () => {
  function stubStorage(manager: Partial<StorageManager> | undefined): void {
    if (manager === undefined) {
      Reflect.deleteProperty(navigator, 'storage');
      return;
    }
    Object.defineProperty(navigator, 'storage', {
      value: manager,
      configurable: true,
    });
  }

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'storage');
  });

  it('requests persistence only when not already persistent', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const persisted = vi.fn().mockResolvedValue(false);
    stubStorage({ persist, persisted });

    await ensurePersistentStorage();
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('skips the request when already persistent', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    stubStorage({ persist, persisted: vi.fn().mockResolvedValue(true) });

    await ensurePersistentStorage();
    expect(persist).not.toHaveBeenCalled();
  });

  it('is a no-op and reports null without the StorageManager API', async () => {
    stubStorage(undefined);
    await expect(ensurePersistentStorage()).resolves.toBeUndefined();
    await expect(storagePersistedStatus()).resolves.toBeNull();
  });

  it('propagates a persist() failure to the caller', async () => {
    stubStorage({
      persist: vi.fn().mockRejectedValue(new Error('denied')),
      persisted: vi.fn().mockResolvedValue(false),
    });
    await expect(ensurePersistentStorage()).rejects.toThrow('denied');
  });
});
