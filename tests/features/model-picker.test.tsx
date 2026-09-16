import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { ROUTES, workspacePath } from '@/app/routes';
import { createCampaign } from '@/db/campaignRepo';
import { readSettings, saveSettings } from '@/db/settingsRepo';
import { defaultSettings, type Settings } from '@/domain';
import { listModels } from '@/llm/openrouter';
import type * as OpenRouterModule from '@/llm/openrouter';
import { toastError } from '@/lib/toast';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';
import { clearDatabase } from '../db/helpers';

/**
 * The top-bar GLOBAL chat-model picker (docs/17 row 193, docs/05 §Top bar).
 * Every pin here names row 193; the recent-ordering rule itself is pinned in
 * `tests/domain/recent-chat-models.test.ts` and the recording seam in
 * `tests/db/settingsRepo.test.ts`. This file drives the REAL top bar on the
 * real router, on a route with no campaign and on a campaign route.
 */

vi.mock('@/llm/openrouter', async (importOriginal) => {
  const actual = await importOriginal<typeof OpenRouterModule>();
  return { ...actual, listModels: vi.fn() };
});

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastErrorPersistent: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

const listModelsMock = vi.mocked(listModels);
const toastErrorMock = vi.mocked(toastError);

/** A settled install (no first-run wizard) with optional settings overrides. */
async function seedSettings(overrides: Partial<Settings> = {}): Promise<void> {
  await saveSettings({
    ...defaultSettings(),
    onboarding: { status: 'complete', stepState: [] },
    ...overrides,
  });
}

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

/** The settings row as a settled read (docs/08 §Console guard: the raw read is
 *  wrapped and the pending liveQuery cascade is drained inside act). */
async function readSettled(): Promise<Settings> {
  await flushAsyncUpdates();
  return actDrained(() => readSettings());
}

beforeEach(async () => {
  await clearDatabase();
  listModelsMock.mockReset();
  toastErrorMock.mockReset();
});

describe('the top-bar model picker (docs/17 row 193)', () => {
  it('renders on every route immediately beside Settings — with no campaign and with one', async () => {
    await seedSettings();

    renderAppAt(ROUTES.campaignPicker);
    const settingsLink = await screen.findByRole('link', { name: 'Settings' });
    const trigger = await screen.findByTestId('model-picker-trigger');
    expect(screen.getByRole('banner')).toContainElement(trigger);
    // Document order: the picker FOLLOWS the Settings entry (adjacent to it).
    expect(
      settingsLink.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The trigger carries the current model, legibly. The settings liveQuery is
    // asynchronous, so the barrier waits for the FIELD it asserts (docs/17 row
    // 132): finding the element alone can resolve on its first, model-less
    // render.
    await waitFor(() => {
      expect(trigger).toHaveTextContent('anthropic/claude-sonnet-4.5');
    });
    cleanup();

    const campaign = await createCampaign({ name: 'Picker Campaign', system: 'dnd5e' });
    renderAppAt(workspacePath(campaign.id));
    expect(await screen.findByTestId('model-picker-trigger')).toBeInTheDocument();
    expect(screen.getByRole('banner')).toContainElement(
      screen.getByTestId('model-picker-trigger'),
    );
  });

  it('shows Recently used in stored recency order (never re-sorted) and picking writes the setting AND lands the model at the front', async () => {
    await seedSettings({
      openRouterApiKey: 'test-key',
      defaultChatModel: 'a/first',
      // b/second is the LEAST recent; picking it must move it to the FRONT.
      recentChatModels: ['a/first', 'b/second'],
    });
    listModelsMock.mockResolvedValue([{ id: 'listed/model' }]);

    renderAppAt(ROUTES.campaignPicker);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('model-picker-trigger'));

    const recents = await screen.findByTestId('model-picker-recents');
    const order = within(recents)
      .getAllByRole('option')
      .map((item) => item.textContent);
    expect(order).toEqual(['a/first', 'b/second']);

    await user.click(within(recents).getByText('b/second'));

    // The trigger follows the liveQuery re-read of the setting it edits.
    await waitFor(() => {
      expect(screen.getByTestId('model-picker-trigger')).toHaveTextContent('b/second');
    });
    const after = await readSettled();
    expect(after.defaultChatModel).toBe('b/second');
    expect(after.recentChatModels).toEqual(['b/second', 'a/first']);
    await flushAsyncUpdates();
  });

  it('keeps free-form entry: a typed id that is NOT in the account list is settable', async () => {
    await seedSettings({
      openRouterApiKey: 'test-key',
      defaultChatModel: 'a/first',
      recentChatModels: [],
    });
    listModelsMock.mockResolvedValue([{ id: 'listed/model' }]);

    renderAppAt(ROUTES.campaignPicker);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('model-picker-trigger'));

    // The account list really loaded, so the free-form arm is not standing in
    // for a failed fetch.
    expect(await screen.findByText('listed/model')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/type a model id/), 'brand/new-model');
    await user.click(await screen.findByTestId('model-picker-use-custom'));

    await waitFor(() => {
      expect(screen.getByTestId('model-picker-trigger')).toHaveTextContent('brand/new-model');
    });
    const after = await readSettled();
    expect(after.defaultChatModel).toBe('brand/new-model');
    expect(after.recentChatModels).toEqual(['brand/new-model']);
    await flushAsyncUpdates();
  });

  it('with no API key the browse group SAYS why it is empty, while recents and a typed id still work', async () => {
    await seedSettings({
      openRouterApiKey: '',
      defaultChatModel: 'a/first',
      recentChatModels: ['b/second'],
    });

    renderAppAt(ROUTES.campaignPicker);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('model-picker-trigger'));

    // Loud, in words — never a silent empty "Account models" group.
    expect(await screen.findByTestId('model-picker-no-key')).toHaveTextContent(/API key/i);
    // No fetch is even attempted without a key.
    expect(listModelsMock).not.toHaveBeenCalled();

    // Recents still work.
    const recents = screen.getByTestId('model-picker-recents');
    await user.click(within(recents).getByText('b/second'));
    await waitFor(() => {
      expect(screen.getByTestId('model-picker-trigger')).toHaveTextContent('b/second');
    });
    await flushAsyncUpdates();

    // …and so does a typed id.
    await user.click(screen.getByTestId('model-picker-trigger'));
    await user.type(screen.getByPlaceholderText(/type a model id/), 'brand/typed');
    await user.click(await screen.findByTestId('model-picker-use-custom'));
    await waitFor(() => {
      expect(screen.getByTestId('model-picker-trigger')).toHaveTextContent('brand/typed');
    });
    const after = await readSettled();
    expect(after.defaultChatModel).toBe('brand/typed');
    expect(after.recentChatModels).toEqual(['brand/typed', 'b/second']);
    await flushAsyncUpdates();
  });

  it('a failed fetch is LOUD: a visible panel state AND toastError — never an empty list', async () => {
    await seedSettings({
      openRouterApiKey: 'bad-key',
      defaultChatModel: 'a/first',
      recentChatModels: [],
    });
    listModelsMock.mockRejectedValue(new Error('401 Unauthorized'));

    renderAppAt(ROUTES.campaignPicker);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('model-picker-trigger'));

    expect(await screen.findByTestId('model-picker-load-error')).toHaveTextContent(
      '401 Unauthorized',
    );
    expect(toastErrorMock).toHaveBeenCalled();
  });
});
