import 'fake-indexeddb/auto';

import { render, waitFor } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { defaultSettings } from '@/domain';
import { readSettings, saveSettings } from '@/db/settingsRepo';
import { clearDatabase } from '../db/helpers';
import { toastInfo } from '@/lib/toast';

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
});

it('shows and consumes the v11 retired-session notice once', async () => {
  // onboarding is seeded finished: this test exercises the migration notice,
  // not the first-run wizard's auto-open (fresh status + zero campaigns).
  await saveSettings({
    ...defaultSettings(),
    retiredSessionNotesRemoved: 2,
    onboarding: { status: 'complete' as const, stepState: [] },
  });
  window.history.replaceState(null, '', '/');
  render(<RouterProvider router={createAppRouter()} />);

  await waitFor(() => {
    expect(toastInfo).toHaveBeenCalledWith(
      '2 session notes from the retired play view were removed',
    );
  });
  await waitFor(async () => {
    expect((await readSettings()).retiredSessionNotesRemoved).toBe(0);
  });
});

it('clears the mob-copy journal once it has been said, and never re-notifies (docs/17 row 271, B4)', async () => {
  await saveSettings({
    ...defaultSettings(),
    onboarding: { status: 'complete' as const, stepState: [] },
    mobCopyRepair: {
      rosterMobsCopied: 2,
      npcCreaturesCopied: 0,
      unconverted: [],
      notified: false,
    },
  });
  window.history.replaceState(null, '', '/');
  const first = render(<RouterProvider router={createAppRouter()} />);

  await waitFor(() => {
    expect(toastInfo).toHaveBeenCalledWith(expect.stringContaining('Mobs now carry their own stats'));
  });
  // Nothing left to heal ⇒ the journal is GONE, not `notified: true`.
  await waitFor(async () => {
    expect((await readSettings()).mobCopyRepair).toBeNull();
  });

  first.unmount();
  vi.clearAllMocks();
  render(<RouterProvider router={createAppRouter()} />);
  await waitFor(async () => {
    expect((await readSettings()).mobCopyRepair).toBeNull();
  });
  expect(toastInfo).not.toHaveBeenCalled();
});

it('keeps only the retry worklist after notify, dropping the adoption library ids (docs/17 row 271, B4)', async () => {
  await saveSettings({
    ...defaultSettings(),
    onboarding: { status: 'complete' as const, stepState: [] },
    libraryAdopt: {
      adopted: [
        {
          globalId: crypto.randomUUID(),
          copyId: crypto.randomUUID(),
          name: 'Ghost',
          kind: 'npc',
          reused: false,
        },
      ],
      repointed: 1,
      unresolved: [
        {
          where: 'campaign “A”',
          name: 'Ghoul',
          reason: 'the library row is gone — re-import the pack',
          unexpected: false,
        },
      ],
      notified: false,
    },
  });
  window.history.replaceState(null, '', '/');
  render(<RouterProvider router={createAppRouter()} />);

  await waitFor(() => {
    expect(toastInfo).toHaveBeenCalledWith(
      expect.stringContaining('Library entries now travel with their campaigns'),
    );
  });
  // The retry worklist survives (it gates the heal); the library ids do not.
  await waitFor(async () => {
    const journal = (await readSettings()).libraryAdopt;
    expect(journal?.unresolved).toHaveLength(1);
    expect(journal?.adopted).toEqual([]);
    expect(journal?.repointed).toBe(0);
    expect(journal?.notified).toBe(true);
  });
});
