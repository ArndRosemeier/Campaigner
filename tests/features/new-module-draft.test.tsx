import 'fake-indexeddb/auto';

import { Component, useState, type JSX, type ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCampaign,
  deleteCampaign,
  removeAllGeneratedContent,
} from '@/db/campaignRepo';
import { deleteCampaignWorkspace } from '@/db/maintenance';
import { db } from '@/db/db';
import { getSettings, readSettings, updateSettings } from '@/db/settingsRepo';
import { NewModuleDialog } from '@/features/modules/new-module-dialog';
import {
  defaultEncounterFloorGuardrail,
  defaultNewModuleDraft,
  newId,
  type Campaign,
  type NewModuleDraft,
} from '@/domain';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';

/**
 * Persisted New Module draft (owner request, docs/17): the dialog's values —
 * concept included — survive a close/reopen so a module creation can be retried
 * after deleting an attempt, or restarted after a reset, without retyping.
 *
 * The drafts are TAGGED with their campaign: another campaign's draft is never
 * prefilled. The campaign WIPES ("Remove all generated content", "Clear
 * workspace") keep the draft on purpose; `deleteCampaign` clears it. A stored
 * draft that no longer validates fails the settings read LOUDLY.
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

// Creation must never start real LLM machinery here.
vi.mock('@/llm/moduleGen', () => ({
  createModuleAndRun: vi.fn(),
  cancelModuleGen: vi.fn(),
}));

const { createModuleAndRun } = await import('@/llm/moduleGen');
const createModuleAndRunMock = vi.mocked(createModuleAndRun);

/**
 * The app-level error boundary's stand-in: a rejected settings read must
 * surface LOUDLY (the corrupt-draft contract), never degrade into defaults.
 */
class Boundary extends Component<{ children: ReactNode }, { message: string | null }> {
  override state: { message: string | null } = { message: null };

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override render(): ReactNode {
    if (this.state.message !== null) {
      return <div data-testid="dialog-failed">{this.state.message}</div>;
    }
    return this.props.children;
  }
}

/** A harness that can close and REOPEN the dialog (the prefill contract). */
function Harness({ campaign }: { campaign: Campaign }): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <MemoryRouter>
      <button
        type="button"
        data-testid="reopen"
        onClick={() => {
          setOpen(true);
        }}
      >
        reopen
      </button>
      <Boundary>
        <NewModuleDialog campaign={campaign} open={open} onOpenChange={setOpen} />
      </Boundary>
    </MemoryRouter>
  );
}

async function seedCampaign(name = 'Ember'): Promise<Campaign> {
  return createCampaign({ name, system: 'dnd5e' });
}

async function openDialog(campaign: Campaign): Promise<HTMLElement> {
  render(<Harness campaign={campaign} />);
  return screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });
}

/** Closes the dialog (Cancel flushes the draft) and reopens it. */
async function reopenDialog(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const dialog = await screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => {
    expect(screen.queryByTestId('new-module-dialog')).not.toBeInTheDocument();
  });
  const reopen = await screen.findByTestId('reopen', {}, { timeout: 5_000 });
  await user.click(reopen);
  return screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  createModuleAndRunMock.mockResolvedValue('00000000-0000-4000-8000-00000000feed');
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('the draft round-trips through the settings row', () => {
  it('prefills every value it holds after the dialog is closed and reopened', async () => {
    const user = userEvent.setup();
    const campaign = await seedCampaign();
    let dialog = await openDialog(campaign);

    await user.type(within(dialog).getByLabelText('Concept'), 'A harbor bell rings underwater.');
    await user.click(within(dialog).getByTestId('auto-spine'));
    await user.type(within(dialog).getByLabelText('Tone (optional)'), 'eerie');
    await user.click(within(dialog).getByRole('button', { name: 'Detailed' }));
    // The Advanced floor is part of the draft too. `<details>` toggles open on
    // a click on its summary; jsdom needs the element non-null to click it.
    const summary = within(dialog)
      .getByTestId('module-guardrails-advanced')
      .querySelector('summary');
    if (summary === null) throw new Error('Advanced disclosure summary missing');
    await user.click(summary);
    const perLevel = within(dialog).getByTestId('guardrail-floor-per-level');
    await user.clear(perLevel);
    await user.type(perLevel, '2');

    dialog = await reopenDialog(user);

    expect(within(dialog).getByLabelText('Concept')).toHaveValue(
      'A harbor bell rings underwater.',
    );
    expect(within(dialog).getByLabelText('Tone (optional)')).toHaveValue('eerie');
    expect(within(dialog).getByTestId('auto-spine')).toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Detailed' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const reopenedFloor = within(dialog).getByTestId('guardrail-floor-per-level');
    expect(reopenedFloor).toHaveValue(2);
    await flushAsyncUpdates();
  }, 30_000);

  it('does not prefill another campaign’s draft, and does not overwrite it', async () => {
    const other = await seedCampaign('Other');
    const mine = await seedCampaign('Mine');
    const otherDraft = {
      ...defaultNewModuleDraft(other.id),
      concept: 'Belongs to the other campaign.',
      tone: 'grim',
    };
    await updateSettings({ newModuleDraft: otherDraft });

    const dialog = await openDialog(mine);

    // This dialog opens at its defaults — no leak from the other campaign.
    expect(within(dialog).getByLabelText('Concept')).toHaveValue('');
    expect(within(dialog).getByLabelText('Tone (optional)')).toHaveValue('');
    expect(within(dialog).getByTestId('guardrail-floor-per-level')).toHaveValue(1);

    // And the other campaign's stored draft is left untouched.
    const settings = await actDrained(() => readSettings());
    expect(settings.newModuleDraft?.campaignId).toBe(other.id);
    expect(settings.newModuleDraft?.concept).toBe('Belongs to the other campaign.');
    await flushAsyncUpdates();
  }, 30_000);

  it('keeps an edit typed before the stored prefill lands (the prefill never clobbers it)', async () => {
    const user = userEvent.setup();
    const campaign = await seedCampaign();
    await updateSettings({
      newModuleDraft: {
        ...defaultNewModuleDraft(campaign.id),
        concept: 'Stored concept',
      },
    });

    render(<Harness campaign={campaign} />);
    const dialog = await screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });
    // Type IMMEDIATELY: the settings liveQuery may resolve mid-typing, and the
    // arriving prefill must not overwrite what is already in the field (the
    // first keystroke used to be lost this way).
    await user.type(within(dialog).getByLabelText('Concept'), 'ZZ');

    expect(within(dialog).getByLabelText<HTMLInputElement>('Concept').value).toMatch(/ZZ$/);
    await flushAsyncUpdates();
  }, 30_000);

  it('persists the newest edit after the debounce window', async () => {
    const user = userEvent.setup();
    const campaign = await seedCampaign();
    const dialog = await openDialog(campaign);

    await user.type(within(dialog).getByLabelText('Concept'), 'First');
    await user.clear(within(dialog).getByLabelText('Concept'));
    await user.type(within(dialog).getByLabelText('Concept'), 'Final wording');

    await waitFor(
      async () => {
        const settings = await readSettings();
        expect(settings.newModuleDraft?.concept).toBe('Final wording');
      },
      { timeout: 5_000 },
    );
    const settings = await readSettings();
    expect(settings.newModuleDraft?.campaignId).toBe(campaign.id);
    await flushAsyncUpdates();
  }, 30_000);

  it('persists immediately when the run starts, inside the debounce window', async () => {
    const user = userEvent.setup();
    const campaign = await seedCampaign();
    const dialog = await openDialog(campaign);

    await user.type(within(dialog).getByLabelText('Concept'), 'Started straight away.');
    // The draft must not depend on the debounce surviving the navigation.
    await user.click(within(dialog).getByTestId('start-module'));

    await waitFor(() => {
      expect(createModuleAndRunMock).toHaveBeenCalledTimes(1);
    });
    await flushAsyncUpdates();
    const settings = await actDrained(() => readSettings());
    expect(settings.newModuleDraft?.concept).toBe('Started straight away.');
    expect(settings.newModuleDraft?.campaignId).toBe(campaign.id);
    // The floor the dialog held rides along on the creation input.
    expect(createModuleAndRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ encounterFloorGuardrail: defaultEncounterFloorGuardrail() }),
    );
    await flushAsyncUpdates();
  }, 30_000);

  it('Reset to defaults clears the edits (the prefill’s escape hatch)', async () => {
    const user = userEvent.setup();
    const campaign = await seedCampaign();
    await updateSettings({
      newModuleDraft: {
        ...defaultNewModuleDraft(campaign.id),
        concept: 'An old idea I no longer want.',
        tone: 'grim',
      },
    });
    let dialog = await openDialog(campaign);

    await waitFor(() => {
      expect(within(dialog).getByLabelText('Concept')).toHaveValue(
        'An old idea I no longer want.',
      );
    });
    await user.click(within(dialog).getByTestId('new-module-reset'));

    expect(within(dialog).getByLabelText('Concept')).toHaveValue('');
    expect(within(dialog).getByLabelText('Tone (optional)')).toHaveValue('');

    // A reopen no longer brings the discarded text back either.
    dialog = await reopenDialog(user);
    expect(within(dialog).getByLabelText('Concept')).toHaveValue('');
    const settings = await readSettings();
    expect(settings.newModuleDraft?.concept ?? '').toBe('');
    await flushAsyncUpdates();
  }, 30_000);
});

describe('draft lifecycle across the campaign delete paths', () => {
  it('is KEPT by both wipes and CLEARED by deleteCampaign', async () => {
    const campaign = await seedCampaign();
    const draft: NewModuleDraft = {
      ...defaultNewModuleDraft(campaign.id),
      concept: 'Retry me after the reset.',
    };
    await updateSettings({ newModuleDraft: draft });

    // "Remove all generated content" — the draft is the point of the retry.
    await removeAllGeneratedContent(campaign.id);
    expect((await readSettings()).newModuleDraft?.concept).toBe('Retry me after the reset.');

    // "Clear workspace" — a full reset keeps authored input too.
    await deleteCampaignWorkspace(campaign.id);
    expect((await readSettings()).newModuleDraft?.concept).toBe('Retry me after the reset.');

    // Deleting the campaign clears the draft tagged with it.
    await deleteCampaign(campaign.id);
    expect((await readSettings()).newModuleDraft).toBeNull();
    await flushAsyncUpdates();
  }, 30_000);
});

describe('a corrupt stored draft fails loudly (no silent fallback)', () => {
  it('rejects on the settings read instead of half-prefilling the dialog', async () => {
    const campaign = await seedCampaign();
    await updateSettings({ newModuleDraft: defaultNewModuleDraft(campaign.id) });
    // Write a draft that no longer validates (levelMax below levelMin, and a
    // count the schema refuses) straight into the row.
    await actDrained(async () => {
      await getSettings();
      const row = await db.settings.get('settings');
      if (row === undefined) throw new Error('settings row missing');
      await db.settings.put({
        ...row,
        newModuleDraft: {
          ...defaultNewModuleDraft(campaign.id),
          levelMin: 5,
          levelMax: 2,
          encounterFloorGuardrail: { enabled: true, perLevel: 0 },
        },
      });
    });

    await actDrained(async () => {
      await expect(readSettings()).rejects.toThrow();
    });
  }, 30_000);

  it('surfaces a rejected read instead of half-prefilling the dialog', async () => {
    const campaign = await seedCampaign();
    // Corrupt the stored draft, then open the dialog on it.
    await actDrained(async () => {
      await getSettings();
      const row = await db.settings.get('settings');
      if (row === undefined) throw new Error('settings row missing');
      await db.settings.put({
        ...row,
        newModuleDraft: {
          ...defaultNewModuleDraft(campaign.id),
          levelMin: 5,
          levelMax: 2,
        },
      });
    });

    render(<Harness campaign={campaign} />);

    // LOUD: the failure reaches the error boundary — the dialog never renders
    // with a silently-defaulted draft.
    const failed = await screen.findByTestId('dialog-failed', {}, { timeout: 5_000 });
    expect(failed.textContent).toMatch(/levelMax must be >= levelMin/);
    expect(screen.queryByTestId('new-module-dialog')).not.toBeInTheDocument();
    await flushAsyncUpdates();
  }, 30_000);
});

describe('draft schema', () => {
  it('defaults carry today’s dialog values and the default floor', () => {
    const id = newId();
    expect(defaultNewModuleDraft(id)).toEqual({
      campaignId: id,
      concept: '',
      levelMin: 1,
      levelMax: 3,
      tone: '',
      sizeDial: 'standard',
      includePriorModules: false,
      autoApproveSpine: false,
      autoGenerateKinds: [],
      autoImageKinds: [],
      autoGenerateBattlemaps: true,
      autoGenerateMobImages: false,
      encounterFloorGuardrail: { enabled: true, perLevel: 1 },
    });
  });

  it('refuses a stored draft with an inverted level range', async () => {
    const campaign = await seedCampaign();
    await actDrained(async () => {
      await updateSettings({ newModuleDraft: defaultNewModuleDraft(campaign.id) });
      await getSettings();
      const row = await db.settings.get('settings');
      if (row === undefined) throw new Error('settings row missing');
      await db.settings.put({
        ...row,
        newModuleDraft: { ...defaultNewModuleDraft(campaign.id), levelMin: 4, levelMax: 1 },
      });
      await expect(readSettings()).rejects.toThrow(/levelMax must be >= levelMin/);
    });
  });
});
