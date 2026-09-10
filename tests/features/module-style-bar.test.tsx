import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { db } from '@/db/db';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { duplicatePromptStyle, savePromptStyle } from '@/db/promptStyleRepo';
import { createModule, type Campaign, type Id, type PromptStyle } from '@/domain';
import { ModuleStyleBar } from '@/features/modules/canvas/module-style-bar';
import { builtinPromptStyle, modulePromptStyleOf } from '@/llm/promptStyles';
import { toastError, toastSuccess } from '@/lib/toast';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * The "the style has moved on" bar (docs/17 row 86).
 *
 * A module RECORDS the style text it was written in — that is what makes editing
 * a style safe. This bar is the explicit way to move an EXISTING module onto the
 * style's current text, and the test pins the three states that matter: silent
 * when the module is in step (including every pre-styles module, which resolves
 * to the immutable Classic), offering the adopt with the consequence spelled out
 * when the style changed, and merely explaining itself when the style is gone.
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

function story(): NonNullable<ReturnType<typeof builtinPromptStyle>> {
  const value = builtinPromptStyle('story');
  if (value === undefined) throw new Error('missing story style');
  return value;
}

/**
 * A module that RECORDED a style (or none at all: the pre-styles shape, which
 * resolves to the immutable Classic).
 */
async function moduleWith(style: PromptStyle | null): Promise<{ campaign: Campaign; id: Id }> {
  const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
  const saved = await saveModule(
    createModule({
      campaignId: campaign.id,
      title: 'The Drowned Bell',
      concept: 'A harbor bell.',
      levelMin: 1,
      levelMax: 1,
      tone: '',
      sizeDial: 'standard',
    }),
  );
  if (style !== null) {
    await patchModule(saved.id, { promptStyle: modulePromptStyleOf(style) });
  }
  return { campaign, id: saved.id };
}

beforeEach(async () => {
  await db.open();
  await db.delete();
  await db.open();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('module style bar', () => {

  it('renders nothing for a module written before styles existed (Classic, in step)', async () => {
    const { id } = await moduleWith(null);
    const row = await getModule(id);
    if (row === undefined) throw new Error('missing module');
    const view = render(<ModuleStyleBar module={row} />);
    await flushAsyncUpdates(6);
    expect(view.container.innerHTML).toBe('');
  }, 30000);

  it('renders nothing while the module matches the style current text', async () => {
    const { id } = await moduleWith(story());
    const row = await getModule(id);
    if (row === undefined) throw new Error('missing module');
    const view = render(<ModuleStyleBar module={row} />);
    await flushAsyncUpdates(6);
    expect(view.container.innerHTML).toBe('');
  }, 30000);

  it('offers the adopt when the style text changed, and adopting re-records the module', async () => {
    const source = story();
    const own = await duplicatePromptStyle(source, 'House Voice');
    const { id } = await moduleWith(own);
    const edited = await savePromptStyle(own.id, {
      templateText: `${own.templateText}\n\nHOUSE-VOICE-V2: keep the prose cold.`,
    });
    expect(edited.version).toBe(2);
    const row = await getModule(id);
    if (row === undefined) throw new Error('missing module');
    render(<ModuleStyleBar module={row} />);
    await flushAsyncUpdates(8);
    const bar = screen.getByTestId('module-style-bar');
    expect(bar.getAttribute('data-state')).toBe('updated');
    expect(bar.textContent).toContain('v1');
    expect(bar.textContent).toContain('v2');

    await userEvent.click(screen.getByTestId('module-style-adopt'));
    await flushAsyncUpdates(2);
    const dialog = screen.getByRole('alertdialog');
    // The consequence is stated BEFORE the click, not discovered afterwards.
    expect(dialog.textContent).toContain('Parts already written keep the text they have');
    await userEvent.click(screen.getByRole('button', { name: 'Adopt v2' }));
    await flushAsyncUpdates(8);
    const updated = await getModule(id);
    expect(updated?.promptStyle?.version).toBe(2);
    expect(updated?.promptStyle?.templateText).toContain('HOUSE-VOICE-V2');
    expect(toastSuccess).toHaveBeenCalled();
  }, 30000);

  it('can be dismissed for the session without changing anything', async () => {
    const own = await duplicatePromptStyle(story(), 'House Voice');
    const { id } = await moduleWith(own);
    await savePromptStyle(own.id, { templateText: `${own.templateText}\n\nV2` });
    const row = await getModule(id);
    if (row === undefined) throw new Error('missing module');
    render(<ModuleStyleBar module={row} />);
    await flushAsyncUpdates(8);
    screen.getByTestId('module-style-bar');
    await userEvent.click(screen.getByTestId('module-style-keep'));
    await flushAsyncUpdates(4);
    expect(screen.queryByTestId('module-style-bar')).toBeNull();
    const unchanged = await getModule(id);
    expect(unchanged?.promptStyle).toEqual(modulePromptStyleOf(own));
  }, 30000);

  it('explains a DELETED style and offers no adopt', async () => {
    const own = await duplicatePromptStyle(story(), 'House Voice');
    const { id } = await moduleWith(own);
    const { deletePromptStyle } = await import('@/db/promptStyleRepo');
    await deletePromptStyle(own.id);
    const row = await getModule(id);
    if (row === undefined) throw new Error('missing module');
    render(<ModuleStyleBar module={row} />);
    const bar = await screen.findByTestId('module-style-bar');
    expect(bar.getAttribute('data-state')).toBe('deleted');
    expect(bar.textContent).toContain('no longer exists');
    expect(bar.textContent).toContain('recorded on the module');
    expect(screen.queryByTestId('module-style-adopt')).toBeNull();
    await waitFor(() => {
      expect(toastError).not.toHaveBeenCalled();
    });
  }, 30000);
});
