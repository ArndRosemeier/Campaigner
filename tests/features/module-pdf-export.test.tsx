import 'fake-indexeddb/auto';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { canvasPath } from '@/app/routes';
import { createCampaign } from '@/db/campaignRepo';
import { saveModule } from '@/db/moduleRepo';
import { createModule, modulePartSchema, moduleSpineSchema, type Id } from '@/domain';
import type * as ModulePdfModule from '@/lib/modulePdf';
import type * as FilePickerModule from '@/lib/filePicker';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * The module PDF's EXPORT SURFACE (docs/17 row 108): the module IS the
 * document, so printing it lives where the module lives — the canvas header
 * (and the campaign tree's module group, the same component). This file pins
 * the WIRING; the document itself is pinned by `tests/lib/modulePdf.test.ts`,
 * which renders real PDFs (including one carrying a real image).
 *
 * What this file proves and nothing else does:
 * - GM and PLAYER are TWO items on ONE control, and each passes its own
 *   `audience` into the ONE renderer (a second builder could not exist here
 *   without this test noticing);
 * - the destination is acquired BEFORE the build (the click's gesture window)
 *   and the built blob is what gets written;
 * - a problem the renderer reports is TOASTED, never swallowed.
 */
const openSaveTargetMock = vi.fn();
const writeMock = vi.fn();
const buildModulePdfMock = vi.fn();

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('@/lib/filePicker', async (importOriginal) => ({
  ...(await importOriginal<typeof FilePickerModule>()),
  openSaveTarget: (...args: unknown[]) => openSaveTargetMock(...args) as unknown,
}));

vi.mock('@/lib/modulePdf', async (importOriginal) => ({
  ...(await importOriginal<typeof ModulePdfModule>()),
  buildModulePdf: (...args: unknown[]) => buildModulePdfMock(...args) as unknown,
}));

const { toastInfo, toastError, toastSuccess } = await import('@/lib/toast');

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  openSaveTargetMock.mockResolvedValue({ cancelled: false, write: writeMock });
  writeMock.mockResolvedValue(undefined);
  buildModulePdfMock.mockResolvedValue({
    blob: new Blob(['%PDF-fake'], { type: 'application/pdf' }),
    problems: [],
  });

  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Vault',
    concept: 'concept',
    levelMin: 1,
    levelMax: 2,
    tone: '',
    sizeDial: 'standard',
    includePriorModules: false,
  });
  await saveModule({
    ...draft,
    spine: moduleSpineSchema.parse({
      premise: 'A drowned vault.',
      themes: [],
      partPlan: [{ title: 'The Gate', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: 'The party rows out.',
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
  world = { campaignId: campaign.id, moduleId: draft.id };
});

async function openMenu(): Promise<void> {
  renderAppAt(canvasPath(world.campaignId, world.moduleId));
  await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
  await flushAsyncUpdates();
}

describe('the module PDF lives on the module surface', () => {
  it('the canvas header offers GM and player documents on ONE control', async () => {
    const user = userEvent.setup();
    await openMenu();

    const trigger = screen.getByTestId('module-pdf-menu');
    expect(trigger).toHaveTextContent('Module PDF');
    expect(trigger).toBeEnabled();
    await user.click(trigger);

    expect(await screen.findByTestId('module-pdf-gm')).toHaveTextContent('GM document');
    expect(screen.getByTestId('module-pdf-player')).toHaveTextContent('Player document');
  });

  it('the GM item prints the GM document at its own filename', async () => {
    const user = userEvent.setup();
    await openMenu();
    await user.click(screen.getByTestId('module-pdf-menu'));
    await user.click(await screen.findByTestId('module-pdf-gm'));

    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledTimes(1);
    });
    // The ONE renderer, with the audience as an explicit option.
    const [moduleArg, artifactsArg, generateArg, optionsArg] = buildModulePdfMock.mock.calls[0] as [
      { title: string },
      unknown[],
      unknown,
      { audience: string },
    ];
    expect(moduleArg.title).toBe('The Drowned Vault');
    expect(Array.isArray(artifactsArg)).toBe(true);
    expect(typeof generateArg).toBe('function');
    expect(optionsArg.audience).toBe('gm');
    expect(openSaveTargetMock).toHaveBeenCalledWith({
      suggestedName: 'the-drowned-vault-gm.pdf',
      types: expect.anything() as unknown,
    });
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('the player item asks the SAME renderer for the player document', async () => {
    const user = userEvent.setup();
    await openMenu();
    await user.click(screen.getByTestId('module-pdf-menu'));
    await user.click(await screen.findByTestId('module-pdf-player'));

    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledTimes(1);
    });
    const optionsArg = (buildModulePdfMock.mock.calls[0] as unknown[])[3] as {
      audience: string;
    };
    expect(optionsArg.audience).toBe('player');
    expect(openSaveTargetMock).toHaveBeenCalledWith({
      suggestedName: 'the-drowned-vault-player.pdf',
      types: expect.anything() as unknown,
    });
  });

  it('reports the renderer’s problems instead of swallowing them', async () => {
    const user = userEvent.setup();
    buildModulePdfMock.mockResolvedValue({
      blob: new Blob(['%PDF-fake'], { type: 'application/pdf' }),
      problems: [{ where: 'the map of “Pier Ambush”', reason: 'decode failed' }],
    });
    await openMenu();
    await user.click(screen.getByTestId('module-pdf-menu'));
    await user.click(await screen.findByTestId('module-pdf-gm'));

    await waitFor(() => {
      expect(toastInfo).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(toastInfo).mock.calls[0]?.[0]).toContain('the map of “Pier Ambush”');
    // The document still lands: a broken image never costs the owner the book.
    expect(writeMock).toHaveBeenCalledTimes(1);
  });

  it('a failed save is loud and reports no success', async () => {
    const user = userEvent.setup();
    writeMock.mockRejectedValue(new Error('disk full'));
    await openMenu();
    await user.click(screen.getByTestId('module-pdf-menu'));
    await user.click(await screen.findByTestId('module-pdf-gm'));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalled();
    });
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('a cancelled picker writes nothing (and is not an error)', async () => {
    const user = userEvent.setup();
    openSaveTargetMock.mockResolvedValue({ cancelled: true });
    await openMenu();
    await user.click(screen.getByTestId('module-pdf-menu'));
    await user.click(await screen.findByTestId('module-pdf-gm'));

    await waitFor(() => {
      expect(openSaveTargetMock).toHaveBeenCalledTimes(1);
    });
    expect(buildModulePdfMock).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});
