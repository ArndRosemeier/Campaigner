import 'fake-indexeddb/auto';

import { Component, useState, type JSX, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import {
  getSettings,
  readSettings,
  readStoredNewModuleDraft,
  updateSettings,
} from '@/db/settingsRepo';
import type * as SettingsRepo from '@/db/settingsRepo';
import { NewModuleDialog } from '@/features/modules/new-module-dialog';
import {
  defaultEncounterFloorGuardrail,
  defaultNewModuleDraft,
  newId,
  type Campaign,
  type NewModuleDraft,
} from '@/domain';
import { toastError } from '@/lib/toast';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';

/**
 * Persisted New Module draft (owner request, docs/17): the dialog's values —
 * concept included — survive a close/reopen so a module creation can be retried
 * after deleting an attempt, or restarted after a reset, without retyping.
 *
 * The drafts are TAGGED with their campaign: another campaign's draft is never
 * prefilled. The campaign WIPES ("Remove all generated content", "Clear
 * workspace") keep the draft on purpose; `deleteCampaign` clears it.
 *
 * A stored draft that no longer validates is SCOPED to the draft (docs/17): the
 * settings read stays readable, the value is never returned, and the dialog —
 * the one consumer that shows a draft — reports the failure LOUDLY and opens at
 * its own defaults instead of half-prefilling.
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

/**
 * The stored-draft read can be HELD OPEN by a test (`holdSettingsRead`), so the
 * prefill arrives while the user is already typing. That is the interleaving
 * the full suite hits under load — the read's value lands in the same React
 * commit as the keystrokes — and the one the "the user's typing always wins"
 * guarantee below is about. Tests that do not arm it get the real read.
 */
let heldSettingsRead: { promise: Promise<void>; release: () => void } | null = null;

/**
 * A settings WRITE can be held back by a test (`delayDraftWrites`): the close's
 * flush then needs a DB round trip, exactly like a loaded machine, so a reopen
 * can read the row BEFORE that write lands. Only writes are delayed — the read
 * stays the real call, because a querier that awaits before touching Dexie
 * never registers its range and its live query stops reacting (measured).
 */
let draftWriteDelayMs = 0;

function delayDraftWrites(ms: number): void {
  draftWriteDelayMs = ms;
}

function holdSettingsRead(): () => void {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  heldSettingsRead = { promise, release };
  return () => {
    heldSettingsRead = null;
    release();
  };
}

vi.mock('@/db/settingsRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof SettingsRepo>();
  return {
    ...actual,
    // Unarmed (every test but the pin below): the real read, unwrapped — the
    // same promise chain the app uses, so nothing else in this file shifts.
    // Armed: this read is held open until the test releases it.
    readSettings: () => {
      const held = heldSettingsRead;
      if (held === null) return actual.readSettings();
      return held.promise.then(() => actual.readSettings());
    },
    updateSettings: (patch: Parameters<typeof SettingsRepo.updateSettings>[0]) => {
      const delayMs = draftWriteDelayMs;
      if (delayMs === 0) return actual.updateSettings(patch);
      return new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      }).then(() => actual.updateSettings(patch));
    },
  };
});

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

/** A harness that can close and REOPEN the dialog (the prefill contract), and
 * can SWITCH the campaign under a mounted dialog (the campaign-identity
 * contract: the draft is tagged, so the dialog is mounted per campaign). */
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
  heldSettingsRead?.release();
  heldSettingsRead = null;
  draftWriteDelayMs = 0;
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

    // Wait for the value the row SETTLES on, not for the first frame after the
    // reopen: the close's flushed write reaches the settings live query a DB
    // round trip after the dialog is back, so the reopen can prefill from the
    // snapshot taken BEFORE that write and correct itself only when the write
    // lands (the dialog re-applies a newer snapshot for as long as the form is
    // untouched). This is the app's own settled state — never a fixed sleep,
    // never a widened timeout (docs/08-TESTING.md, the census precedent).
    await waitFor(() => {
      expect(within(dialog).getByLabelText('Concept')).toHaveValue(
        'A harbor bell rings underwater.',
      );
    });
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

  it('re-prefills when the campaign changes under a MOUNTED dialog', async () => {
    const other = await seedCampaign('Other');
    const mine = await seedCampaign('Mine');
    await updateSettings({
      newModuleDraft: {
        ...defaultNewModuleDraft(mine.id),
        concept: 'Mine, and only mine.',
        tone: 'grim',
      },
    });

    // Opened in the WRONG campaign first: the other campaign's tag means
    // nothing is prefilled (the dialog sits at its own defaults).
    const { rerender } = render(<Harness campaign={other} />);
    await screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });
    expect(screen.getByLabelText('Concept')).toHaveValue('');

    // The campaign changes while the dialog stays open: the new campaign's
    // (matching) draft lands — a mounted dialog never keeps showing the
    // campaign it was opened in. (The dialog is mounted PER CAMPAIGN, so this
    // is a REMOUNT: re-find the dialog instead of holding the old node.)
    rerender(<Harness campaign={mine} />);
    const switched = await screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });
    await waitFor(() => {
      expect(within(switched).getByLabelText('Concept')).toHaveValue('Mine, and only mine.');
    });
    expect(within(switched).getByLabelText('Tone (optional)')).toHaveValue('grim');
    await flushAsyncUpdates();
  }, 30_000);

  it('never re-tags the previous campaign’s draft when the campaign changes', async () => {
    const mine = await seedCampaign('Mine');
    const other = await seedCampaign('Other');
    await updateSettings({
      newModuleDraft: {
        ...defaultNewModuleDraft(mine.id),
        concept: 'Mine, and only mine.',
      },
    });

    const { rerender } = render(<Harness campaign={mine} />);
    const dialog = await screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });
    await waitFor(() => {
      expect(within(dialog).getByLabelText('Concept')).toHaveValue('Mine, and only mine.');
    });

    // Switch away: the shown values belong to `mine` and must not follow the
    // dialog into `other` (they would otherwise be re-tagged and prefilled as
    // the other campaign's draft on the next open). The remount shows the new
    // campaign's own defaults.
    rerender(<Harness campaign={other} />);
    const switched = await screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });
    expect(within(switched).getByLabelText('Concept')).toHaveValue('');

    // Past the debounce window: the switch itself writes nothing, and the
    // stored draft still belongs to the campaign that authored it.
    await actDrained(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 700);
      });
    });
    const settings = await readSettings();
    expect(settings.newModuleDraft?.campaignId).toBe(mine.id);
    expect(settings.newModuleDraft?.concept).toBe('Mine, and only mine.');
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

  it('keeps the typing that lands in the same commit as the arriving prefill', async () => {
    const user = userEvent.setup();
    const campaign = await seedCampaign();
    const releaseSettings = holdSettingsRead();
    const dialog = await openDialog(campaign);
    const concept = within(dialog).getByLabelText<HTMLTextAreaElement>('Concept');

    // The prefill's value and the user's first keystrokes in ONE React commit:
    // what that commit renders already holds the typed text, so the prefill must
    // not write over it. Measured on the old code (a probe with this very delay,
    // 6/6 runs): the seed applied the stored (empty) draft in that commit, wiped
    // the two characters, and the rest of the typing was appended to the wiped
    // field — the assertion below received "harbor bell rings underwater.".
    await act(async () => {
      releaseSettings();
      // Let the held read reach React's queue inside this act, so its value and
      // the keystroke are applied together.
      await new Promise((resolve) => {
        setTimeout(resolve, 40);
      });
      fireEvent.input(concept, { target: { value: 'A ' } });
    });
    expect(concept).toHaveValue('A ');

    await user.type(concept, 'harbor bell rings underwater.');
    expect(concept).toHaveValue('A harbor bell rings underwater.');
    await flushAsyncUpdates();
  }, 30_000);

  it('ends the reopen on the draft the close saved, not on an older snapshot', async () => {
    const user = userEvent.setup();
    const campaign = await seedCampaign();
    let dialog = await openDialog(campaign);
    const concept = within(dialog).getByLabelText<HTMLTextAreaElement>('Concept');
    await user.type(concept, 'A harbor bell rings underwater.');
    expect(concept).toHaveValue('A harbor bell rings underwater.');

    // The close's flush needs a DB round trip, held back here: the reopen below
    // reads the row as it was BEFORE that write, so it prefills the OLDER
    // snapshot first — and only then does the write land and reach the settings
    // live query. The reopen may start on the older value; it may not END there
    // (the row is the source of truth for as long as the form is untouched).
    // On the old code the first snapshot latched (the seed ran once per open),
    // so the reopen stayed on the empty pre-draft value and the close after it
    // wrote that value back over the row: the draft was destroyed.
    delayDraftWrites(300);
    dialog = await reopenDialog(user);
    await waitFor(() => {
      expect(within(dialog).getByLabelText('Concept')).toHaveValue(
        'A harbor bell rings underwater.',
      );
    });
    expect((await readSettings()).newModuleDraft?.concept).toBe(
      'A harbor bell rings underwater.',
    );
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

describe('a corrupt stored draft: scoped to the draft, reported loudly', () => {
  /** Writes a draft the schema refuses straight into the row (as a hand-edited
   * or restored settings row would). */
  async function storeCorruptDraft(campaignId: string, overrides: object): Promise<void> {
    await actDrained(async () => {
      await getSettings();
      const row = await db.settings.get('settings');
      if (row === undefined) throw new Error('settings row missing');
      await db.settings.put({
        ...row,
        newModuleDraft: { ...defaultNewModuleDraft(campaignId), ...overrides },
      });
    });
  }

  it('never fails the settings read, and reports the draft instead', async () => {
    const campaign = await seedCampaign();
    // A load-bearing setting that the corrupt draft must not take down with it.
    await updateSettings({ newModuleDraft: defaultNewModuleDraft(campaign.id) });
    const before = await readSettings();
    await storeCorruptDraft(campaign.id, {
      levelMin: 5,
      levelMax: 2,
      encounterFloorGuardrail: { enabled: true, perLevel: 0 },
    });

    // The READ is whole: every other setting is still there, and the draft that
    // no longer validates is simply not returned as a value.
    const settings = await readSettings();
    expect(settings.newModuleDraft).toBeNull();
    expect(settings.defaultChatModel).toBe(before.defaultChatModel);
    expect(settings.imagesEnabled).toBe(before.imagesEnabled);
    expect(settings.embeddingModel).toBe(before.embeddingModel);

    // The draft's own seam carries the failure, so the one consumer that cares
    // reports it instead of silently prefilling nothing.
    const stored = await readStoredNewModuleDraft();
    expect(stored.draft).toBeNull();
    expect(stored.error?.message).toMatch(/levelMax must be >= levelMin/);
  }, 30_000);

  it('opens the dialog at its defaults and toasts instead of half-prefilling', async () => {
    const campaign = await seedCampaign();
    await storeCorruptDraft(campaign.id, { levelMin: 5, levelMax: 2 });

    render(<Harness campaign={campaign} />);

    // Nothing of the unreadable draft reaches the form: the levels are the
    // dialog's own defaults, not the stored 5/2.
    const dialog = await screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });
    expect(within(dialog).getByLabelText('Level from')).toHaveValue(1);
    expect(within(dialog).getByLabelText('Level to')).toHaveValue(3);
    expect(within(dialog).getByLabelText('Concept')).toHaveValue('');

    // LOUD (AGENTS 2): the user is told the stored draft could not be read —
    // and the dialog itself is NOT broken by a field the app cannot parse.
    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        'The stored New Module draft could not be read',
        expect.any(Error),
      );
    });
    const reported = vi.mocked(toastError).mock.calls.at(-1);
    expect(String(reported?.[1])).toMatch(/levelMax must be >= levelMin/);
    expect(screen.queryByTestId('dialog-failed')).not.toBeInTheDocument();
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
      const stored = await readStoredNewModuleDraft();
      expect(stored.draft).toBeNull();
      expect(stored.error?.message).toMatch(/levelMax must be >= levelMin/);
      // The row's load-bearing settings are unaffected by the bad draft.
      await expect(readSettings()).resolves.toMatchObject({ newModuleDraft: null });
    });
  });
});
