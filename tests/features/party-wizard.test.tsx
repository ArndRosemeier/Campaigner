import 'fake-indexeddb/auto';

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn() },
}));

import { toast } from 'sonner';

import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import {
  ARTIFACT_KIND_LABELS,
  ARTIFACT_KIND_SINGULAR,
  blankArtifactData,
  pcDataSchema,
  type Id,
  type PcArtifact,
} from '@/domain';
import { clearDatabase } from '../db/helpers';
import { renderWorkspace } from '../helpers/workspace';

/**
 * THE PARTY WIZARD (owner-directed, docs/17 row 334, verbatim: *"i would like
 * to have a party wizard to quickly add a party to a campaign. It should ask 2
 * questions per character. Name and initiative bonus, with a done button that
 * stops adding more characters, to quickly onboard a party. Give every
 * character 20 hp and no stat block."*).
 *
 * These pins drive the REAL campaign workspace (never a helper): the wizard's
 * control lives in the tree's Party region, and every character it creates is
 * a real `pc` row. The row-308 rule is re-asserted at this NEW entry point —
 * each created player's data must equal the ONE blank-data seam with ONLY
 * `initiativeOverride` replaced, so the wizard cannot grow into a second way to
 * create a 0-HP or statful player.
 */

/** The campaign's `pc` rows, as the DB holds them (the wizard's own output). */
async function partyRows(campaignId: Id): Promise<PcArtifact[]> {
  const rows = await listArtifactsByCampaign(campaignId);
  return rows.filter((row): row is PcArtifact => row.kind === 'pc');
}

/** The Party region's own header row — where the wizard's control lives. */
function partyRegionHeader(): HTMLElement {
  const header = screen.getByText(ARTIFACT_KIND_LABELS.pc).parentElement;
  if (header === null) throw new Error('The Party region header was not rendered.');
  return header;
}

/**
 * Renders the real workspace and waits for the tree: the campaign and its
 * artifacts load through live queries, so a query issued on the first paint
 * would meet the page's own "Loading…" instead of the tree.
 */
async function renderTree(campaignId: Id): Promise<void> {
  renderWorkspace(campaignId);
  await screen.findByLabelText('Campaign tree');
}

/** Opens the wizard from the tree's Party region control. */
async function openPartyWizard(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByTestId('party-wizard-open'));
  return screen.findByTestId('party-wizard-dialog');
}

/** Fills both questions and presses "Add character". */
async function addCharacter(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  name: string,
  initiative: string,
): Promise<void> {
  fireEvent.change(within(dialog).getByLabelText('Character name'), { target: { value: name } });
  fireEvent.change(within(dialog).getByLabelText('Initiative bonus'), {
    target: { value: initiative },
  });
  await user.click(within(dialog).getByRole('button', { name: 'Add character' }));
}

describe('party wizard (row 334)', () => {
  beforeEach(async () => {
    // The toast mock is module-level, so its call log must not leak between
    // tests: a "creates nothing" pin reads the log to prove nothing succeeded.
    vi.clearAllMocks();
    await clearDatabase();
  });
  afterEach(cleanup);

  it('onboards two characters in a row — HP 20, no stat block, and the typed initiative', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await renderTree(campaign.id);

    const dialog = await openPartyWizard(user);
    await addCharacter(user, dialog, 'Alice', '3');
    // The player appears in the tree straight away (feedback that THIS write
    // landed), and the fields clear with the caret back on Name.
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    await waitFor(() => {
      expect(within(dialog).getByLabelText('Character name')).toHaveValue('');
    });
    expect(within(dialog).getByLabelText('Initiative bonus')).toHaveValue(null);
    expect(within(dialog).getByLabelText('Character name')).toHaveFocus();

    await addCharacter(user, dialog, 'Bob', '-1');
    expect(await screen.findByText('Bob')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByTestId('party-wizard-dialog')).toBeNull();
    });

    await waitFor(async () => {
      const rows = await partyRows(campaign.id);
      expect(rows.map((row) => row.name)).toEqual(['Alice', 'Bob']);
      // ONLY the second question differs from the ONE blank-data seam: HP 20
      // and `statBlock: null` are the seam's (owner's row-308 rule), never
      // re-typed by the wizard.
      const blank = pcDataSchema.parse(blankArtifactData('pc'));
      expect(rows[0]?.data).toEqual({ ...blank, initiativeOverride: 3 });
      expect(rows[1]?.data).toEqual({ ...blank, initiativeOverride: -1 });
    });
  }, 20000);

  it('refuses a blank name loudly and creates NOTHING (never a placeholder row)', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await renderTree(campaign.id);

    const dialog = await openPartyWizard(user);
    await addCharacter(user, dialog, '   ', '4');

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('A character needs a name — nothing was created.');
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(await partyRows(campaign.id)).toHaveLength(0);
    // The dialog stays open on the refusal, so the fix is one field away.
    expect(screen.getByTestId('party-wizard-dialog')).toBeInTheDocument();
  }, 20000);

  it('refuses a bonus that is not a whole number, creating nothing either', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await renderTree(campaign.id);

    const dialog = await openPartyWizard(user);
    await addCharacter(user, dialog, 'Cleo', '1.5');
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'The initiative bonus must be a whole number (a negative one is fine) — nothing was created.',
      );
    });

    // A BLANK bonus is the same refusal, not a silent 0.
    await addCharacter(user, dialog, 'Cleo', '');
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(toast.success).not.toHaveBeenCalled();
    expect(await partyRows(campaign.id)).toHaveLength(0);
  }, 20000);

  it('Done creates no row — and neither does closing the dialog', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await renderTree(campaign.id);

    const dialog = await openPartyWizard(user);
    await addCharacter(user, dialog, 'Dana', '2');
    expect(await screen.findByText('Dana')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByTestId('party-wizard-dialog')).toBeNull();
    });

    // Reopen: Done left nothing half-typed behind, and closing the dialog with
    // two answers on screen still creates no third (or first) row.
    const reopened = await openPartyWizard(user);
    expect(within(reopened).getByLabelText('Character name')).toHaveValue('');
    fireEvent.change(within(reopened).getByLabelText('Character name'), {
      target: { value: 'Erik' },
    });
    fireEvent.change(within(reopened).getByLabelText('Initiative bonus'), {
      target: { value: '5' },
    });
    await user.click(within(reopened).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByTestId('party-wizard-dialog')).toBeNull();
    });

    const rows = await partyRows(campaign.id);
    expect(rows.map((row) => row.name)).toEqual(['Dana']);
  }, 20000);

  it('reaches it from the Party region of the tree, beside that region’s own +', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await renderTree(campaign.id);

    const header = partyRegionHeader();
    // The header IS the Party region's: the per-kind `+` that creates a single
    // pc is its sibling, and the wizard's own control is beside it.
    expect(within(header).getByLabelText(`New ${ARTIFACT_KIND_SINGULAR.pc}`)).toBeInTheDocument();
    const control = within(header).getByTestId('party-wizard-open');
    expect(control).toBeVisible();

    await user.click(control);
    expect(await screen.findByTestId('party-wizard-dialog')).toBeInTheDocument();
  }, 20000);
});
