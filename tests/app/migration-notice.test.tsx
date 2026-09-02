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
  await saveSettings({ ...defaultSettings(), retiredSessionNotesRemoved: 2 });
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
