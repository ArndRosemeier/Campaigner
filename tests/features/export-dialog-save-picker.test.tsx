import 'fake-indexeddb/auto';

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { ROUTES } from '@/app/routes';
import { CampaignPickerPage } from '@/features/campaign/CampaignPickerPage';
import { exportSingleArtifact } from '@/features/campaign/components/export-single-artifact';
import * as artifactRepo from '@/db/artifactRepo';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import * as exportImport from '@/lib/exportImport';
import { exportSuggestedName } from '@/lib/exportImport';
import { EXPORT_JSON_TYPES, EXPORT_ZIP_TYPES, openSaveTarget } from '@/lib/filePicker';
import * as toast from '@/lib/toast';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * Campaign export through the centralized native save picker (filePicker):
 * the destination is acquired FIRST inside the click handler (transient
 * user activation expires before a slow build finishes), the built blob is
 * written to it afterwards. Picker cancel builds nothing and toasts nothing
 * (the dialog stays open with the selection intact — backup precedent);
 * picker failure toasts loudly without building. The no-picker fallback
 * (showSaveFilePicker undefined → plain download) is covered by the
 * unmocked tests/features/export-dialog.test.tsx blob-URL seam tests.
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
const toastError = vi.mocked(toast.toastError);
const toastSuccess = vi.mocked(toast.toastSuccess);

function renderPicker(): void {
  render(
    <MemoryRouter initialEntries={[ROUTES.campaignPicker]}>
      <Routes>
        <Route path={ROUTES.campaignPicker} element={<CampaignPickerPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function openExportDialog(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await screen.findByText('Emberfall');
  await user.click(screen.getByRole('button', { name: 'Menu for Emberfall' }));
  await user.click(await screen.findByRole('menuitem', { name: /Export campaign/ }));
  await screen.findByRole('dialog');
}

beforeEach(clearDatabase);

beforeEach(() => {
  savePicker.mockReset();
  toastError.mockClear();
  toastSuccess.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExportCampaignDialog save-picker flow', () => {
  it('acquires the target before building, then writes the JSON blob with the suggested name', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Grix' });

    const order: string[] = [];
    const written: Blob[] = [];
    savePicker.mockImplementation((options) => {
      order.push('acquire');
      expect(options.suggestedName).toBe(exportSuggestedName('Emberfall', 'json'));
      return Promise.resolve({
        cancelled: false,
        write: (blob: Blob) => {
          order.push('write');
          written.push(blob);
          return Promise.resolve();
        },
      });
    });
    const realBuild = exportImport.buildCampaignExport;
    const buildSpy = vi
      .spyOn(exportImport, 'buildCampaignExport')
      .mockImplementation((...args) => {
        order.push('build');
        return realBuild(...args);
      });

    renderPicker();
    await openExportDialog(user);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Export 1 artifact(s)' }));

    await waitFor(() => {
      expect(written).toHaveLength(1);
    });
    // Gesture-first ordering: the picker ran before the build started.
    expect(order).toEqual(['acquire', 'build', 'write']);
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(savePicker).toHaveBeenCalledWith({
      suggestedName: exportSuggestedName('Emberfall', 'json'),
      types: EXPORT_JSON_TYPES,
    });

    const blob = written[0];
    if (blob === undefined) throw new Error('no export blob written');
    expect(blob.type).toBe('application/json');
    const exported = JSON.parse(await blob.text()) as { artifacts: { name: string }[] };
    expect(exported.artifacts.map((artifact) => artifact.name)).toEqual(['Grix']);

    expect(toastSuccess).toHaveBeenCalledWith('Exported 1 artifact(s)');
    expect(toastError).not.toHaveBeenCalled();
    // Success closes the dialog.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await flushAsyncUpdates();
  }, 20000);

  it('zip format acquires with the zip type and writes a zip blob', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Grix' });

    const written: Blob[] = [];
    savePicker.mockImplementation((options) => {
      expect(options.suggestedName).toBe(exportSuggestedName('Emberfall', 'zip'));
      return Promise.resolve({
        cancelled: false,
        write: (blob: Blob) => {
          written.push(blob);
          return Promise.resolve();
        },
      });
    });

    renderPicker();
    await openExportDialog(user);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Zip bundle' }));
    await user.click(within(dialog).getByRole('button', { name: 'Export 1 artifact(s)' }));

    await waitFor(() => {
      expect(written).toHaveLength(1);
    });
    expect(savePicker).toHaveBeenCalledWith({
      suggestedName: exportSuggestedName('Emberfall', 'zip'),
      types: EXPORT_ZIP_TYPES,
    });
    const blob = written[0];
    if (blob === undefined) throw new Error('no zip blob written');
    expect(blob.type).toBe('application/zip');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes[0]).toBe(0x50); // 'P'
    expect(bytes[1]).toBe(0x4b); // 'K'
    await flushAsyncUpdates();
  }, 20000);

  it('picker cancel builds nothing, toasts nothing, and leaves the dialog open', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Grix' });

    const write = vi.fn(() => Promise.resolve());
    savePicker.mockImplementation(() => Promise.resolve({ cancelled: true, write }));
    const buildSpy = vi.spyOn(exportImport, 'buildCampaignExport');

    renderPicker();
    await openExportDialog(user);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Export 1 artifact(s)' }));

    // The dialog stays open with the selection intact (backup precedent:
    // cancelling the OS dialog is not cancelling the export).
    await waitFor(() => {
      expect(savePicker).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(buildSpy).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Export 1 artifact(s)' }),
    ).toBeEnabled();
    await flushAsyncUpdates();
  }, 20000);

  it('picker failure toasts loudly without building', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Grix' });

    const failure = new TypeError('SecurityError-ish');
    savePicker.mockImplementation(() => Promise.reject(failure));
    const buildSpy = vi.spyOn(exportImport, 'buildCampaignExport');

    renderPicker();
    await openExportDialog(user);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Export 1 artifact(s)' }));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('Export failed', failure);
    });
    expect(buildSpy).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await flushAsyncUpdates();
  }, 20000);
});

describe('exportSingleArtifact save-picker flow', () => {
  it('acquires first, then writes the artifact JSON with the slug-date name', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Grix the Bold',
    });

    const seenNames: string[] = [];
    const written: Blob[] = [];
    savePicker.mockImplementation((options) => {
      seenNames.push(options.suggestedName);
      return Promise.resolve({
        cancelled: false,
        write: (blob: Blob) => {
          written.push(blob);
          return Promise.resolve();
        },
      });
    });
    const revisionsSpy = vi.spyOn(artifactRepo, 'listRevisions');

    await exportSingleArtifact(artifact);

    expect(savePicker).toHaveBeenCalledTimes(1);
    expect(seenNames[0]).toBe(`grix-the-bold-${new Date(Date.now()).toISOString().slice(0, 10)}.json`);
    expect(revisionsSpy).toHaveBeenCalledWith(artifact.id);
    expect(written).toHaveLength(1);
    const blob = written[0];
    if (blob === undefined) throw new Error('no artifact blob written');
    expect(blob.type).toBe('application/json');
    const exported = JSON.parse(await blob.text()) as { artifacts: { name: string }[] };
    expect(exported.artifacts.map((entry) => entry.name)).toEqual(['Grix the Bold']);
    expect(toastSuccess).toHaveBeenCalledWith('Artifact exported');
    expect(toastError).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  }, 20000);

  it('picker cancel reads nothing and toasts nothing', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Grix',
    });

    const write = vi.fn(() => Promise.resolve());
    savePicker.mockImplementation(() => Promise.resolve({ cancelled: true, write }));
    const revisionsSpy = vi.spyOn(artifactRepo, 'listRevisions');

    await exportSingleArtifact(artifact);

    expect(revisionsSpy).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  });

  /**
   * The FALLBACK half of the one slug seam (docs/17 row 130): `fileSlug` was
   * hand-rolled four times and the only thing that ever differed was the word
   * for a name that reduces to nothing. This path said `'artifact'` — pinned
   * here BYTE-EXACT, through the real flow, because the regex pin above cannot
   * see the fallback at all (it only ever matches a sluggable name).
   */
  it('a name with nothing sluggable still emits a real filename stem', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: '???',
    });

    const seenNames: string[] = [];
    savePicker.mockImplementation((options) => {
      seenNames.push(options.suggestedName);
      return Promise.resolve({
        cancelled: false,
        write: () => Promise.resolve(),
      });
    });

    await exportSingleArtifact(artifact);

    const today = new Date(Date.now()).toISOString().slice(0, 10);
    expect(seenNames[0]).toBe(`artifact-${today}.json`);
    await flushAsyncUpdates();
  });

  it('picker failure toasts loudly without reading', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Grix',
    });

    const failure = new TypeError('SecurityError-ish');
    savePicker.mockImplementation(() => Promise.reject(failure));
    const revisionsSpy = vi.spyOn(artifactRepo, 'listRevisions');

    await exportSingleArtifact(artifact);

    expect(revisionsSpy).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('Artifact export failed', failure);
    expect(toastSuccess).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  });
});
