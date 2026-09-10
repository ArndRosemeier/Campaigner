import 'fake-indexeddb/auto';

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { db } from '@/db/db';
import { updateSettings } from '@/db/settingsRepo';
import { NewModuleDialog } from '@/features/modules/new-module-dialog';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * The New Module dialog's Writing style select under the NEW product default
 * (docs/17 row 88): a fresh app preselects Freestyle, and an explicitly STORED
 * default is honored and shown instead.
 *
 * The select is data-driven — it reads `readPromptStyleCatalog`, which carries
 * the settings row's `defaultPromptStyleId` — so these pins are about the value
 * the two surfaces actually resolve, not about a hand-added option.
 *
 * Freestyle's PRESENCE in the list is the row-87 arc's pin
 * (`prompt-style-freestyle-ui.test.tsx`); nothing here duplicates it. The
 * stored-draft semantics (the choice, the app default resolved at creation, the
 * prefill) belong to `new-module-draft.test.tsx`.
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

// Creation must never start real LLM machinery here.
vi.mock('@/llm/moduleGen', () => ({
  createModuleAndRun: vi.fn(),
  cancelModuleGen: vi.fn(),
}));

/**
 * The select's closed trigger: the shadcn implementation renders the selected
 * VALUE plus a chevron, so the pin is containment on the id — an exact string
 * would be pinned to the trigger's chrome.
 */
function selectedStyleTrigger(dialog: HTMLElement): string {
  return within(dialog).getByTestId('module-prompt-style').textContent;
}

/** One dialog open against a fresh campaign, with the catalog read settled. */
async function openDialog(): Promise<HTMLElement> {
  const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
  render(
    <MemoryRouter>
      <NewModuleDialog campaign={campaign} open onOpenChange={() => undefined} />
    </MemoryRouter>,
  );
  const dialog = await screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });
  await flushAsyncUpdates(4);
  return dialog;
}

beforeEach(async () => {
  await db.open();
  await clearDatabase();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the Writing style select under the Freestyle product default', () => {
  it('preselects Freestyle for a fresh app', async () => {
    const dialog = await openDialog();
    // REVERT-PROOF: with the product default back at Classic (or with the
    // dialog's own fallback on Classic) this shows "classic".
    expect(selectedStyleTrigger(dialog)).toContain('freestyle');
    expect(selectedStyleTrigger(dialog)).not.toContain('classic');
    // …and the option really is the built-in Freestyle, not an id that happens
    // to resolve to nothing.
    await userEvent.setup().click(within(dialog).getByTestId('module-prompt-style'));
    const freestyle = await screen.findByRole('option', { name: /Freestyle/ }, { timeout: 5_000 });
    expect(freestyle).toBeTruthy();
  }, 30_000);

  it('preselects an EXPLICITLY STORED non-Freestyle default instead', async () => {
    // A stored value is data and is honored: nothing rewrites it to the product
    // default, and the dialog shows what the app will use.
    await updateSettings({ defaultPromptStyleId: 'story' });
    const dialog = await openDialog();
    expect(selectedStyleTrigger(dialog)).toContain('story');
    expect(selectedStyleTrigger(dialog)).not.toContain('freestyle');
  }, 30_000);

  it('a stored default pointing at a style that no longer exists is named, never silently swapped', async () => {
    // The product default must not become a hiding place for a broken stored
    // value: an id that resolves to nothing is reported in the dialog (AGENTS 1).
    await updateSettings({ defaultPromptStyleId: 'freestyle' });
    await db.settings.put({
      ...(await db.settings.get('settings')),
      defaultPromptStyleId: 'no-such-style',
    } as unknown as Parameters<typeof db.settings.put>[0]);
    const dialog = await openDialog();
    expect(within(dialog).getByTestId('module-prompt-style-missing').textContent).toContain(
      'no-such-style',
    );
  }, 30_000);
});
