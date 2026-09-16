import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readSettings, saveSettings } from '@/db/settingsRepo';
import { defaultSettings, type Settings } from '@/domain';
import { listModels } from '@/llm/openrouter';
import type * as OpenRouterModule from '@/llm/openrouter';
import { ModelWidget } from '@/features/settings/model-widget';
import { toastError } from '@/lib/toast';
import { clearDatabase } from '../db/helpers';

/**
 * The ONE model-picking widget, both surface variants (docs/17 row 199,
 * extending row 193's option/recency seams). Every pin names row 199 except the
 * recents-order ones, which name row 193 (the ordering rule itself lives in
 * `tests/domain/recent-chat-models.test.ts`).
 *
 * The whole point of this file is the PER-VARIANT contract: the field variant
 * renders a label + free-form input + browse, the trigger variant renders the
 * compact button, and BOTH own the same account list, the same free-form entry,
 * the same loud no-key/failed-fetch states and the same recents gate.
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

async function seedSettings(overrides: Partial<Settings> = {}): Promise<void> {
  await saveSettings({ ...defaultSettings(), ...overrides });
}

type Variant = 'field' | 'trigger';

interface WidgetOverrides {
  value?: string;
  onChange?: (value: string) => unknown;
  canBrowse?: boolean;
  recentModels?: readonly string[];
  fetchOptions?: () => Promise<string[]>;
}

function renderWidget(variant: Variant, overrides: WidgetOverrides = {}): void {
  const common = {
    value: overrides.value ?? 'current/model',
    onChange: overrides.onChange ?? vi.fn(),
    canBrowse: overrides.canBrowse ?? true,
    fetchOptions: overrides.fetchOptions,
    recentModels: overrides.recentModels,
  };
  if (variant === 'field') {
    render(
      <ModelWidget variant="field" id="test-model" label="Test model" placeholder="default/model" {...common} />,
    );
    return;
  }
  render(<ModelWidget variant="trigger" {...common} />);
}

function openPanel(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  if (screen.queryByTestId('model-picker-trigger') !== null) {
    return user.click(screen.getByTestId('model-picker-trigger'));
  }
  return user.click(screen.getByRole('button', { name: 'Browse Test models' }));
}

const VARIANTS: Variant[] = ['field', 'trigger'];

beforeEach(async () => {
  await clearDatabase();
  listModelsMock.mockReset();
  toastErrorMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('the ONE model-picking widget (docs/17 row 199)', () => {
  it('the field variant renders a label + input + browse, the trigger variant renders the trigger', () => {
    renderWidget('field');
    expect(screen.getByLabelText('Test model')).toHaveValue('current/model');
    expect(screen.getByRole('button', { name: 'Browse Test models' })).toBeInTheDocument();
    cleanup();

    renderWidget('trigger');
    expect(screen.getByTestId('model-picker-trigger')).toHaveAttribute(
      'aria-label',
      'Chat model: current/model',
    );
    expect(screen.queryByLabelText('Test model')).toBeNull();
  });

  it.each(VARIANTS)(
    'the %s variant offers the account models through the ONE option seam',
    async (variant) => {
      await seedSettings();
      listModelsMock.mockResolvedValue([{ id: 'listed/model' }]);
      const user = userEvent.setup();
      renderWidget(variant);

      await openPanel(user);
      expect(await screen.findByText('listed/model')).toBeInTheDocument();
      expect(listModelsMock).toHaveBeenCalledTimes(1);
      // The account group is the shared one, in both shapes.
      expect(screen.getByTestId('model-picker-account')).toBeInTheDocument();
    },
  );

  it.each(VARIANTS)(
    'the %s variant honours free-form entry for a typed id the account list does not contain',
    async (variant) => {
      await seedSettings();
      listModelsMock.mockResolvedValue([{ id: 'listed/model' }]);
      const onChange = vi.fn();
      const user = userEvent.setup();
      renderWidget(variant, { onChange });

      await openPanel(user);
      // The account list really loaded, so the free-form arm is not standing in
      // for a failed fetch.
      expect(await screen.findByText('listed/model')).toBeInTheDocument();

      await user.type(screen.getByPlaceholderText(/type a model id/), 'brand/new-model');
      await user.click(await screen.findByTestId('model-picker-use-custom'));

      expect(onChange).toHaveBeenCalledWith('brand/new-model');
    },
  );

  it.each(VARIANTS)(
    'the %s variant is LOUD with no API key: it says why, and attempts no fetch',
    async (variant) => {
      await seedSettings();
      const user = userEvent.setup();
      renderWidget(variant, { canBrowse: false });

      await openPanel(user);
      expect(await screen.findByTestId('model-picker-no-key')).toHaveTextContent(/API key/i);
      expect(listModelsMock).not.toHaveBeenCalled();
    },
  );

  it.each(VARIANTS)(
    'the %s variant is LOUD on a failed fetch: the reason in the panel AND toastError',
    async (variant) => {
      await seedSettings();
      listModelsMock.mockRejectedValue(new Error('401 Unauthorized'));
      const user = userEvent.setup();
      renderWidget(variant, { canBrowse: true });

      await openPanel(user);
      expect(await screen.findByTestId('model-picker-load-error')).toHaveTextContent(
        '401 Unauthorized',
      );
      expect(toastErrorMock).toHaveBeenCalled();
      // Never an empty list masquerading as "no models".
      expect(screen.queryByText(/returned no models/)).toBeNull();
    },
  );

  it('honours a fetchOptions override instead of forking a second fetch', async () => {
    await seedSettings();
    const fetchOptions = vi.fn().mockResolvedValue(['image/one', 'image/two']);
    const user = userEvent.setup();
    renderWidget('field', { fetchOptions });

    await openPanel(user);
    expect(await screen.findByText('image/one')).toBeInTheDocument();
    expect(fetchOptions).toHaveBeenCalledTimes(1);
    // The default seam is not touched when an override is given.
    expect(listModelsMock).not.toHaveBeenCalled();
  });

  it('shows recents ONLY when the instance passes them, in stored order (docs/17 row 193)', async () => {
    await seedSettings();
    listModelsMock.mockResolvedValue([{ id: 'listed/model' }]);
    const user = userEvent.setup();
    renderWidget('field', { recentModels: ['a/first', 'b/second'] });

    await openPanel(user);
    const recents = await screen.findByTestId('model-picker-recents');
    expect(
      within(recents)
        .getAllByRole('option')
        .map((item) => item.textContent),
    ).toEqual(['a/first', 'b/second']);
  });

  it('shows NO recents group without the prop — the other tiers must not display them', async () => {
    await seedSettings({ recentChatModels: ['a/first', 'b/second'] });
    listModelsMock.mockResolvedValue([{ id: 'listed/model' }]);
    const user = userEvent.setup();
    renderWidget('field');

    await openPanel(user);
    expect(await screen.findByText('listed/model')).toBeInTheDocument();
    expect(screen.queryByTestId('model-picker-recents')).toBeNull();
  });

  it('records a chosen model through the ONE seam only for a recents-offering instance', async () => {
    await seedSettings();
    listModelsMock.mockResolvedValue([{ id: 'listed/model' }]);
    const user = userEvent.setup();
    renderWidget('field', { recentModels: [] });

    await openPanel(user);
    await user.click(await screen.findByText('listed/model'));
    await waitFor(async () => {
      expect((await readSettings()).recentChatModels).toEqual(['listed/model']);
    });
    cleanup();

    // A non-recents instance (the fallback/embedding/image/persona tiers) edits
    // its own setting and must NOT record the global chat recents.
    await saveSettings({ ...defaultSettings() });
    renderWidget('field');
    await openPanel(user);
    await user.click(await screen.findByText('listed/model'));
    await waitFor(() => {
      expect(screen.queryByTestId('model-picker-recents')).toBeNull();
    });
    expect((await readSettings()).recentChatModels).toEqual([]);
  });
});
