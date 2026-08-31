import 'fake-indexeddb/auto';

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { ROUTES } from '@/app/routes';
import { CampaignPickerPage } from '@/features/campaign/CampaignPickerPage';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * Export dialog (08-TESTING matrix gap): the campaign card's ⋮ menu opens the
 * campaign-wide export dialog (M2: artifact selection + JSON/zip formats).
 * Downloads are captured at the blob-URL seam and decoded to verify the
 * payload. Import is exercised in lib/exportImport tests.
 */

function renderPicker(): void {
  render(
    <MemoryRouter initialEntries={[ROUTES.campaignPicker]}>
      <Routes>
        <Route path={ROUTES.campaignPicker} element={<CampaignPickerPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(clearDatabase);

describe('ExportCampaignDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports the selected artifacts as JSON through the download seam', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Grix' });
    await createArtifact({ campaignId: campaign.id, kind: 'location', name: 'Forge' });

    const blobs: Blob[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return 'blob:mock-export';
      }),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const clickSpy = vi.fn();
    HTMLAnchorElement.prototype.click = clickSpy;

    renderPicker();
    await screen.findByText('Emberfall');

    // The card menu opens the dialog (regression: the dialog was mounted but
    // unreachable — the menu downloaded JSON directly instead).
    await user.click(screen.getByRole('button', { name: 'Menu for Emberfall' }));
    await user.click(await screen.findByRole('menuitem', { name: /Export campaign/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Export “Emberfall”/)).toBeInTheDocument();
    expect(within(dialog).getByText('Grix')).toBeInTheDocument();
    expect(within(dialog).getByText('Forge')).toBeInTheDocument();

    // Deselect one artifact → export the remaining one.
    const forgeRow = within(dialog).getByText('Forge').closest('label');
    if (forgeRow === null) throw new Error('Forge row not found');
    await user.click(within(forgeRow).getByRole('checkbox'));
    expect(within(dialog).getByRole('button', { name: 'Export 1 artifact(s)' })).toBeEnabled();
    await user.click(within(dialog).getByRole('button', { name: 'Export 1 artifact(s)' }));

    await waitFor(() => {
      expect(clickSpy).toHaveBeenCalled();
    });
    expect(blobs).toHaveLength(1);
    const blob = blobs[0];
    if (blob === undefined) throw new Error('no export blob captured');
    const exported = JSON.parse(await blob.text()) as {
      campaign: { name: string };
      artifacts: { name: string }[];
    };
    expect(exported.campaign.name).toBe('Emberfall');
    expect(exported.artifacts.map((artifact) => artifact.name)).toEqual(['Grix']);
    await flushAsyncUpdates();
  }, 20000);

  it('select-all off disables the export; zip format produces a zip blob', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Grix' });

    const blobs: Blob[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return 'blob:mock-export';
      }),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    HTMLAnchorElement.prototype.click = vi.fn();

    renderPicker();
    await screen.findByText('Emberfall');
    await user.click(screen.getByRole('button', { name: 'Menu for Emberfall' }));
    await user.click(await screen.findByRole('menuitem', { name: /Export campaign/ }));

    const dialog = await screen.findByRole('dialog');

    // Unchecking "all artifacts" leaves nothing selected → export disabled.
    const selectAll = within(dialog).getByRole('checkbox', { name: 'All artifacts (1)' });
    await user.click(selectAll);
    expect(within(dialog).getByRole('button', { name: /Export 0 artifact\(s\)/ })).toBeDisabled();

    // Re-select, switch to zip, export: the blob is a real zip (PK magic).
    await user.click(selectAll);
    await user.click(within(dialog).getByRole('button', { name: 'Zip bundle' }));
    await user.click(within(dialog).getByRole('button', { name: 'Export 1 artifact(s)' }));

    await waitFor(() => {
      expect(blobs).toHaveLength(1);
    });
    const blob = blobs[0];
    if (blob === undefined) throw new Error('no zip blob captured');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes[0]).toBe(0x50); // 'P'
    expect(bytes[1]).toBe(0x4b); // 'K'
    await flushAsyncUpdates();
  }, 20000);

  it('cancel closes the dialog without downloading', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Grix' });

    const blobs: Blob[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return 'blob:mock-export';
      }),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });

    renderPicker();
    await screen.findByText('Emberfall');
    await user.click(screen.getByRole('button', { name: 'Menu for Emberfall' }));
    await user.click(await screen.findByRole('menuitem', { name: /Export campaign/ }));
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(blobs).toHaveLength(0);
    await flushAsyncUpdates();
  }, 20000);

  it('exports every artifact by default when nothing is deselected', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Grix' });
    await createArtifact({ campaignId: campaign.id, kind: 'location', name: 'Forge' });

    const blobs: Blob[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return 'blob:mock-export';
      }),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    HTMLAnchorElement.prototype.click = vi.fn();

    renderPicker();
    await screen.findByText('Emberfall');
    await user.click(screen.getByRole('button', { name: 'Menu for Emberfall' }));
    await user.click(await screen.findByRole('menuitem', { name: /Export campaign/ }));

    const dialog = await screen.findByRole('dialog');
    // All artifacts are preselected: the button offers the full count.
    const exportButton = within(dialog).getByRole('button', { name: 'Export 2 artifact(s)' });
    expect(exportButton).toBeEnabled();
    await user.click(exportButton);

    await waitFor(() => {
      expect(blobs).toHaveLength(1);
    });
    const blob = blobs[0];
    if (blob === undefined) throw new Error('no export blob captured');
    const exported = JSON.parse(await blob.text()) as {
      artifacts: { name: string; revisions: unknown[] }[];
    };
    expect(exported.artifacts.map((artifact) => artifact.name).sort()).toEqual([
      'Forge',
      'Grix',
    ]);
    // Each artifact carries its revision history (createArtifact writes rev 1).
    expect(exported.artifacts.every((artifact) => artifact.revisions.length >= 1)).toBe(true);
    await flushAsyncUpdates();
  }, 20000);
});
