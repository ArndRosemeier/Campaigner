import 'fake-indexeddb/auto';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { db } from '@/db/db';
import { getModule, saveModule } from '@/db/moduleRepo';
import { duplicatePromptStyle, readPromptStyleCatalog } from '@/db/promptStyleRepo';
import { getSettings, updateSettings } from '@/db/settingsRepo';
import { createModule, type PromptStyle } from '@/domain';
import { PromptStylesSection } from '@/features/settings/prompt-styles-section';
import { builtinPromptStyle, modulePromptStyleOf } from '@/llm/promptStyles';
import { toastError, toastSuccess } from '@/lib/toast';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * Settings → Module writing styles (docs/17 row 86, 05-UI.md §Settings): the
 * authoring editor.
 *
 * What is pinned here: the built-ins are read-only but duplicable, a user style
 * is editable with its version tracking the TEMPLATE, an invalid template is
 * refused LOUDLY and nothing is written, the preview separates the author's text
 * from the contract clauses, deleting a style leaves modules intact, and an
 * unreadable styles blob is reported rather than shown as "no styles".
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

function story(): PromptStyle {
  const value = builtinPromptStyle('story');
  if (value === undefined) throw new Error('missing story style');
  return value;
}

/** Expands one style row by its id and returns its body. */
async function openRow(id: string): Promise<HTMLElement> {
  const row = await screen.findByTestId(`prompt-style-row-${id}`);
  await userEvent.click(within(row).getByRole('button'));
  return screen.findByTestId(`prompt-style-body-${id}`);
}

beforeEach(async () => {
  await db.open();
  await clearDatabase();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('module writing styles section', () => {
  it('lists the built-ins as read-only with a duplicate affordance', async () => {
    render(<PromptStylesSection />);
    await waitFor(() => {
      expect(screen.getByTestId('prompt-styles-section')).toBeTruthy();
    });
    await flushAsyncUpdates(4);
    expect(screen.getByText('Classic')).toBeTruthy();
    expect(screen.getByText('Story')).toBeTruthy();

    await openRow('classic');
    expect(screen.getByText(/Built-in styles ship with the app/)).toBeTruthy();
    // No template textarea for a built-in: it cannot be edited at all.
    expect(screen.queryByTestId('prompt-style-template-classic')).toBeNull();
    expect(screen.getByTestId('prompt-style-duplicate-classic')).toBeTruthy();
  });

  it('duplicating makes an editable user style and saves name + template with a version bump', async () => {
    render(<PromptStylesSection />);
    await flushAsyncUpdates(4);
    await openRow('story');
    await userEvent.click(screen.getByTestId('prompt-style-duplicate-story'));
    await flushAsyncUpdates(6);

    expect(toastSuccess).toHaveBeenCalled();
    const catalog = await readPromptStyleCatalog('classic');
    expect(catalog.user).toHaveLength(1);
    const copy = catalog.user[0];
    expect(copy?.name).toBe('Story (copy)');
    expect(copy?.basedOn).toBe('story');

    await openRow(copy?.id ?? '');
    const field = await screen.findByTestId(`prompt-style-template-${copy?.id ?? ''}`);
    // A sectioned template (the markers are part of the shape) carrying one
    // unknown placeholder.
    const broken = [
      '--- SPINE ---',
      '{{campaign}}',
      '{{contract.replyFormat}}',
      '{{contract.floor}}',
      '{{contract.entityKinds}}',
      '{{contract.sceneKinds}}',
      '{{contract.wikiLinks}}',
      '{{nope}}',
      '',
      '--- PARTS ---',
      '{{partHeading}}',
      '{{contract.replyFormat}}',
      '{{contract.gmAddress}}',
      '{{contract.wikiLinks}}',
      '{{contract.lengthTarget}}',
      '{{contract.floor}}',
      '{{contract.mechanics}}',
      '{{contract.encounterCasting}}',
    ].join('\n');
    // Bulk edit through a change event: typing ten KB of template would only
    // measure userEvent.
    fireEvent.change(field, { target: { value: broken } });
    await flushAsyncUpdates(4);
    // An invalid template is refused LOUDLY, with the problem named.
    expect(await screen.findByTestId(`prompt-style-problems-${copy?.id ?? ''}`)).toBeTruthy();
    expect(screen.getByText(/Unknown placeholder \{\{nope\}\}/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await flushAsyncUpdates(4);
    expect(toastError).toHaveBeenCalled();
    const untouched = await readPromptStyleCatalog('classic');
    expect(untouched.user[0]?.templateText).toBe(copy?.templateText);
    expect(untouched.user[0]?.version).toBe(1);

    // A valid edit saves and bumps the version.
    // A valid edit saves and bumps the version. Bulk edit for the same
    // reason as above — and the text is ten KB, so typing it would measure
    // nothing but userEvent.
    const successesBefore = vi.mocked(toastSuccess).mock.calls.length;
    fireEvent.change(field, { target: { value: story().templateText + '\n\nEXTRA-LINE' } });
    await flushAsyncUpdates(2);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await flushAsyncUpdates(6);
    expect(vi.mocked(toastSuccess).mock.calls.length).toBeGreaterThan(successesBefore);
    expect(toastError).toHaveBeenCalledTimes(1);
    const saved = await readPromptStyleCatalog('classic');
    expect(saved.user[0]?.version).toBe(2);
    expect(saved.user[0]?.templateText).toContain('EXTRA-LINE');
    expect(saved.user[0]?.templateText).toContain('--- SPINE ---');
  }, 30000);

  it('previews both surfaces and marks the contract lines', async () => {
    await duplicatePromptStyle(story(), 'House Voice');
    render(<PromptStylesSection />);
    await flushAsyncUpdates(6);
    await openRow((await readPromptStyleCatalog('classic')).user[0]?.id ?? '');
    const preview = await screen.findByTestId('prompt-style-preview-parts');
    // The composed preview carries the contract text the app injects…
    expect(within(preview).getAllByText(/Target length for this part/).length).toBeGreaterThan(0);
    // …and the contract segments are tagged for the author.
    expect(preview.querySelectorAll('[data-segment-layer="contract"]').length).toBeGreaterThan(0);
    expect(preview.querySelectorAll('[data-segment-layer="style"]').length).toBeGreaterThan(0);
    // Switching surfaces shows the spine planner's own composition.
    await userEvent.click(screen.getByRole('button', { name: 'Spine planner' }));
    await flushAsyncUpdates(2);
    expect(screen.getByTestId('prompt-style-preview-spine')).toBeTruthy();
  }, 30000);

  it('makes a style the app default', async () => {
    await duplicatePromptStyle(story(), 'House Voice');
    render(<PromptStylesSection />);
    await flushAsyncUpdates(6);
    const copy = (await readPromptStyleCatalog('classic')).user[0];
    await openRow(copy?.id ?? '');
    await userEvent.click(
      screen.getByTestId(`prompt-style-make-default-${copy?.id ?? ''}`),
    );
    await flushAsyncUpdates(6);
    expect((await getSettings()).defaultPromptStyleId).toBe(copy?.id);
    expect(toastSuccess).toHaveBeenCalled();
  }, 30000);

  it('deleting a style leaves modules that recorded it untouched', async () => {
    const own = await duplicatePromptStyle(story(), 'House Voice');
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const saved = await saveModule(
      createModule({
        campaignId: campaign.id,
        title: 'The Drowned Bell',
        concept: 'A bell.',
        levelMin: 1,
        levelMax: 1,
        tone: '',
        sizeDial: 'standard',
      }),
    );
    const { patchModule } = await import('@/db/moduleRepo');
    await patchModule(saved.id, { promptStyle: modulePromptStyleOf(own) });

    render(<PromptStylesSection />);
    await flushAsyncUpdates(6);
    await openRow(own.id);
    await userEvent.click(screen.getByTestId(`prompt-style-delete-${own.id}`));
    await flushAsyncUpdates(2);
    // The consequence is stated BEFORE it happens, not discovered afterwards.
    expect(screen.getByText(/Modules already written with it are NOT affected/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Delete the style' }));
    await flushAsyncUpdates(8);
    const catalog = await readPromptStyleCatalog('classic');
    expect(catalog.user).toHaveLength(0);
    const row = await getModule(saved.id);
    expect(row?.promptStyle?.templateText).toBe(own.templateText);
  }, 30000);

  it('reports an unreadable styles blob instead of showing no styles', async () => {
    // A settings row must exist before it can be corrupted into the shape a bad
    // import leaves behind.
    await updateSettings({ promptStyles: [] });
    // The corrupt write is deliberate and typed around: Dexie does not
    // validate, which is exactly how a bad import lands in the row.
    await db.settings.update('settings', {
      promptStyles: 'not-an-array',
    } as unknown as Partial<{ promptStyles: never }>);
    render(<PromptStylesSection />);
    const error = await screen.findByTestId('prompt-styles-error');
    expect(within(error).getByText(/could not be read/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard unreadable styles' })).toBeTruthy();
    await flushAsyncUpdates(4);
    // The built-ins are still listed: they ship in code, not in the row.
    expect(screen.getByText('Classic')).toBeTruthy();
    expect(screen.getByText('Story')).toBeTruthy();
    await updateSettings({ promptStyles: [] });
  }, 30000);
});
