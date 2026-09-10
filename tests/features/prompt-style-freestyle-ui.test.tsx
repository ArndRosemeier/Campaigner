import 'fake-indexeddb/auto';

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { db } from '@/db/db';
import { NewModuleDialog } from '@/features/modules/new-module-dialog';
import { PromptStylesSection } from '@/features/settings/prompt-styles-section';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * Freestyle is SELECTABLE, on both surfaces that offer a writing style
 * (docs/17 row 87).
 *
 * Both surfaces are data-driven — `PromptStylesSection` and the New Module
 * dialog's Writing style select each map `catalogStyles(catalog)`, which is
 * `BUILTIN_PROMPT_STYLES` plus the user's own — so these pins are deliberately
 * about the DATA reaching the two lists a user actually picks from, not about
 * any hand-added entry. REVERT-PROOF: removing the freestyle entry from
 * `BUILTIN_PROMPT_STYLES` makes both fail (the row and the option disappear),
 * which is exactly the failure a "the third style exists" claim must catch.
 *
 * The dialog's own selection semantics (the draft field, the app default, the
 * unresolvable id) belong to the row-86 arc and are pinned by
 * `new-module-draft.test.tsx`; nothing here duplicates or softens them.
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

// Creation must never start real LLM machinery here.
vi.mock('@/llm/moduleGen', () => ({
  createModuleAndRun: vi.fn(),
  cancelModuleGen: vi.fn(),
}));

beforeEach(async () => {
  await db.open();
  await clearDatabase();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Freestyle is offered like the other built-ins', () => {
  it('appears in the Settings → Module writing styles list', async () => {
    render(<PromptStylesSection />);
    await flushAsyncUpdates(4);
    const row = await screen.findByTestId('prompt-style-row-freestyle');
    expect(within(row).getByText('Freestyle')).toBeTruthy();
    // Read-only like the others: ships in code, duplicated to be edited.
    expect(within(row).getByText('built-in')).toBeTruthy();
    // …and the list it comes from still carries Classic and Story.
    expect(screen.getByTestId('prompt-style-row-classic')).toBeTruthy();
    expect(screen.getByTestId('prompt-style-row-story')).toBeTruthy();
  });

  it('appears in the New Module dialog Writing style select', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    render(
      <MemoryRouter>
        <NewModuleDialog campaign={campaign} open onOpenChange={() => undefined} />
      </MemoryRouter>,
    );
    const dialog = await screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });
    await flushAsyncUpdates(4);

    await user.click(within(dialog).getByTestId('module-prompt-style'));
    const freestyle = await screen.findByRole('option', { name: /Freestyle/ }, { timeout: 5_000 });
    expect(freestyle).toBeTruthy();
    // The select is the whole catalog, not a one-off addition.
    expect(screen.getByRole('option', { name: /Classic/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Story/ })).toBeTruthy();

    // Choosing it is a real selection, not a decorative list entry: the closed
    // trigger carries the selected style. (Radix's `SelectValue` renders the
    // selected VALUE in this shadcn setup — the item's label is only in the
    // closed collection — so the pin is the changed selection itself, and
    // "Freestyle (built-in) — v1" is what the option offers.)
    await user.click(freestyle);
    await flushAsyncUpdates(4);
    expect(within(dialog).getByTestId('module-prompt-style').textContent).toContain('freestyle');
  }, 30_000);
});
