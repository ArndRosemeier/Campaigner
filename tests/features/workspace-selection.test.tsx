import 'fake-indexeddb/auto';

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCampaignExport } from '@/lib/exportImport';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { db } from '@/db/db';
import * as toast from '@/lib/toast';
import { openSaveTarget } from '@/lib/filePicker';
import { clearDatabase } from '../db/helpers';
import { actDrained } from '../helpers/flush';
import { renderWorkspace } from '../helpers/workspace';

/**
 * The workspace's artifact SELECTION surface (owner request, 2026-09-22;
 * docs/17 row 322): campaign-level rows carry checkboxes, a small action bar
 * exports the selection (selection-only — the source campaign's tables do NOT
 * ride along), removes it through the ONE shared confirm (the live census the
 * per-region rung uses) and imports a file INTO this campaign. The Party is
 * selectable (it must be exportable between campaigns) but never bulk-removable:
 * the bar says so and the confirm shows the seam's own refusal with the action
 * disabled.
 */

vi.mock('@/lib/filePicker', () => ({
  EXPORT_JSON_TYPES: [
    { description: 'Campaigner export (JSON)', accept: { 'application/json': ['.json'] } },
  ],
  EXPORT_ZIP_TYPES: [
    { description: 'Campaigner export (zip)', accept: { 'application/zip': ['.zip'] } },
  ],
  EXPORT_PDF_TYPES: [
    { description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } },
  ],
  openSaveTarget: vi.fn(),
  supportsFilePickers: vi.fn(() => true),
  pickBackupFile: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastErrorPersistent: vi.fn(),
}));

const savePicker = vi.mocked(openSaveTarget);
const toastSuccessMock = vi.mocked(toast.toastSuccess);
const toastErrorMock = vi.mocked(toast.toastError);

function uploadInto(input: HTMLElement, json: string): void {
  Object.defineProperty(input, 'files', {
    value: [new File([json], 'selection.json', { type: 'application/json' })],
  });
  fireEvent.change(input);
}

beforeEach(clearDatabase);
beforeEach(() => {
  savePicker.mockReset();
  toastSuccessMock.mockClear();
  toastErrorMock.mockClear();
});
afterEach(cleanup);

describe('workspace artifact selection', () => {
  async function seedTarget(): Promise<{ campaignId: string; npc: string; other: string; pc: string }> {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const npc = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Goblin' });
    const other = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Hobgoblin' });
    const pc = await createArtifact({ campaignId: campaign.id, kind: 'pc', name: 'Serren' });
    return { campaignId: campaign.id, npc: npc.id, other: other.id, pc: pc.id };
  }

  it('exports EXACTLY the selected rows, without the source campaign tables', async () => {
    const user = userEvent.setup();
    const { campaignId, npc, other } = await seedTarget();
    const written: Blob[] = [];
    savePicker.mockImplementation(() =>
      Promise.resolve({
        cancelled: false,
        write: (blob: Blob) => {
          written.push(blob);
          return Promise.resolve();
        },
      }),
    );

    renderWorkspace(campaignId);
    await screen.findByText('Goblin');
    await user.click(screen.getByLabelText('Select Goblin'));
    await user.click(screen.getByLabelText('Select Hobgoblin'));
    expect(screen.getByTestId('tree-selection-count')).toHaveTextContent('2 selected');

    await user.click(screen.getByTestId('export-selection-json'));

    await waitFor(() => {
      expect(written).toHaveLength(1);
    });
    const blob = written[0];
    if (blob === undefined) throw new Error('no export blob written');
    const exported = JSON.parse(await blob.text()) as {
      artifacts: { id: string }[];
      modules?: unknown;
      battles?: unknown;
      runs?: unknown;
    };
    expect(exported.artifacts.map((artifact) => artifact.id).sort()).toEqual([npc, other].sort());
    // Selection-only: the campaign's whole-campaign tables are ABSENT.
    expect(exported.modules).toBeUndefined();
    expect(exported.battles).toBeUndefined();
    expect(exported.runs).toBeUndefined();
    expect(toastSuccessMock).toHaveBeenCalledWith('Exported 2 artifact(s)');
  });

  it('removes the selection through the shared confirm, with the live census', async () => {
    const user = userEvent.setup();
    const { campaignId, npc, other } = await seedTarget();
    renderWorkspace(campaignId);
    await screen.findByText('Goblin');

    await user.click(screen.getByLabelText('Select Goblin'));
    await user.click(screen.getByLabelText('Select Hobgoblin'));
    await user.click(screen.getByTestId('remove-selection'));

    const confirm = await screen.findByTestId('remove-selection-confirm');
    const counts = within(confirm).getByTestId('remove-selection-counts');
    await waitFor(() => {
      expect(counts).toHaveTextContent(/permanently deletes 2 artifacts/);
    });
    expect(counts).toHaveTextContent(/no undo for artifacts/);
    expect(counts).toHaveTextContent(/global library are never touched/);
    const action = within(confirm).getByTestId('remove-selection-confirm-action');
    await waitFor(() => {
      expect(action).not.toBeDisabled();
    });
    await user.click(action);

    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith(expect.stringContaining('Removed 2 artifacts'));
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(await actDrained(() => db.artifacts.get(npc))).toBeUndefined();
    expect(await actDrained(() => db.artifacts.get(other))).toBeUndefined();
    // The selection that named them is gone with them.
    expect(screen.getByTestId('tree-selection-count')).toHaveTextContent('0 selected');
  });

  it('selecting the Party and pressing Remove is refused with the Party sentence, deleting nothing', async () => {
    const user = userEvent.setup();
    const { campaignId, npc, pc } = await seedTarget();
    renderWorkspace(campaignId);
    await screen.findByText('Serren');

    await user.click(screen.getByLabelText('Select Serren'));
    // Visibly non-removable BEFORE the press (docs/17 row 322).
    expect(screen.getByTestId('party-not-removable')).toBeInTheDocument();
    await user.click(screen.getByTestId('remove-selection'));

    const confirm = await screen.findByTestId('remove-selection-confirm');
    await waitFor(() => {
      expect(within(confirm).getByTestId('remove-selection-counts')).toHaveTextContent(
        /Party is protected content/,
      );
    });
    expect(within(confirm).getByTestId('remove-selection-counts')).toHaveTextContent(
      /Clear workspace/,
    );
    expect(within(confirm).getByTestId('remove-selection-counts')).toHaveTextContent(/"Serren"/);
    // A selection that can only be refused offers no confirm action.
    expect(within(confirm).getByTestId('remove-selection-confirm-action')).toBeDisabled();
    // The Party row is selectable precisely because it must stay EXPORTABLE.
    expect(await actDrained(() => db.artifacts.get(pc))).toBeDefined();
    expect(await actDrained(() => db.artifacts.get(npc))).toBeDefined();
  });

  it('imports a selection file INTO this campaign (not as a new campaign)', async () => {
    // A source campaign's two players, exported selection-only.
    const source = await createCampaign({ name: 'Source', system: 'dnd5e' });
    await createArtifact({ campaignId: source.id, kind: 'pc', name: 'Serren' });
    await createArtifact({ campaignId: source.id, kind: 'pc', name: 'Bel' });
    const sourceRows = await db.artifacts.where('campaignId').equals(source.id).toArray();
    const selection = await buildCampaignExport(
      source.id,
      sourceRows.map((row) => row.id),
      { selectionOnly: true },
    );

    const target = await createCampaign({ name: 'Target', system: 'dnd5e' });
    renderWorkspace(target.id);
    await screen.findByTestId('workspace-import');

    uploadInto(screen.getByTestId('workspace-import-input'), JSON.stringify(selection));

    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith('Imported 2 artifact(s) into this campaign');
    });
    const imported = await actDrained(() =>
      db.artifacts.where('campaignId').equals(target.id).toArray(),
    );
    expect(imported.map((row) => row.name).sort()).toEqual(['Bel', 'Serren']);
    expect(imported.every((row) => row.moduleId === null)).toBe(true);
    // No new campaign was minted: the source and the target are still the only
    // two, and the source's rows are untouched.
    expect(await actDrained(() => db.campaigns.count())).toBe(2);
    expect(await actDrained(() => db.artifacts.where('campaignId').equals(source.id).count())).toBe(2);
  });
});
