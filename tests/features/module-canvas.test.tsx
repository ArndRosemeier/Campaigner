import 'fake-indexeddb/auto';

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { canvasPath } from '@/app/routes';
import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Id,
} from '@/domain';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';
import { activeCanvasView } from '@/features/modules/canvas/canvasView';

/**
 * Module canvas — page shell (08-MODULE-DESIGNER §Module canvas, commit 1):
 * route + header shell, the ONE-part scope (deep links via `?part=` and the
 * reader's `#part-<n>` hash), the read-only premise scope, manual saves
 * through THE one part-text save path, and the loud part-switch guard for
 * unsaved edits. AI proposal flows live in the commit-2 section below.
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

vi.mock('@/db/artifactAutoPromote', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  promoteSecondModuleUses: vi.fn(),
}));

const { promoteSecondModuleUses } = await import('@/db/artifactAutoPromote');
const promoteSpy = vi.mocked(promoteSecondModuleUses);
const { toastError, toastSuccess } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const toastSuccessMock = vi.mocked(toastSuccess);

const PART_0_TEXT = 'The party bargains with [[Keeper Ilse]] at the gate.';
const PART_1_TEXT = 'Below the tower, the flood rises.';

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

function renderAppAt(path: string): ReturnType<typeof render> {
  window.history.replaceState(null, '', path);
  return render(<RouterProvider router={createAppRouter()} />);
}

async function seedModule(): Promise<void> {
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
      premise: 'The premise promises a drowned [[Vault Door]].',
      themes: [],
      partPlan: [
        { title: 'The Gate Bargain', levelBand: '1', synopsis: '', levelUpTrigger: '' },
        { title: 'The Flooded Nave', levelBand: '2', synopsis: '', levelUpTrigger: '' },
      ],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: PART_0_TEXT,
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
      modulePartSchema.parse({
        planIndex: 1,
        markdown: PART_1_TEXT,
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
  world = { campaignId: campaign.id, moduleId: draft.id };
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  await seedModule();
});

/** One deterministic doc edit through the live editor view (act-wrapped —
 * the page mirrors the doc into React state on every change). */
function editDoc(from: number, to: number, insert: string): void {
  const view = activeCanvasView.current;
  if (view === null) throw new Error('canvas editor view not mounted');
  act(() => {
    view.dispatch({ changes: { from, to, insert } });
  });
}

describe('canvas shell + scope', () => {
  it('mounts on the default scope (first part) with the editor doc = the part markdown', async () => {
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    expect(await screen.findByTestId('module-canvas', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByTestId('canvas-module-title')).toHaveTextContent('The Drowned Vault');
    expect(screen.getByText('The Gate Bargain')).toBeInTheDocument();
    expect(activeCanvasView.current?.state.doc.toString()).toBe(PART_0_TEXT);
    // The editor renders wiki-link chips against the reader pool.
    await waitFor(() => {
      expect(document.querySelector('[data-wiki-name="Keeper Ilse"]')).not.toBeNull();
    });
    // No unsaved edits yet: Save disabled.
    expect(screen.getByTestId('canvas-save')).toBeDisabled();
    await flushAsyncUpdates();
  });

  it('deep-links via ?part= and honors the reader #part-<n> hash', async () => {
    const first = renderAppAt(canvasPath(world.campaignId, world.moduleId, 1));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await waitFor(() => {
      expect(screen.getByText('The Flooded Nave')).toBeInTheDocument();
    });
    expect(activeCanvasView.current?.state.doc.toString()).toBe(PART_1_TEXT);
    first.unmount();

    // Hash fallback (reader convention) — same surface, other part.
    const second = renderAppAt(`/c/${world.campaignId}/m/${world.moduleId}/canvas#part-0`);
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await waitFor(() => {
      expect(screen.getByText('The Gate Bargain')).toBeInTheDocument();
    });
    expect(activeCanvasView.current?.state.doc.toString()).toBe(PART_0_TEXT);
    second.unmount();
    await flushAsyncUpdates();
  });

  it('the premise scope is read-only (no editor, notice rendered)', async () => {
    renderAppAt(canvasPath(world.campaignId, world.moduleId, 'premise'));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    expect(screen.getByTestId('canvas-premise-notice')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-premise-body')).toHaveTextContent('drowned');
    expect(screen.queryByTestId('canvas-editor')).not.toBeInTheDocument();
    expect(screen.queryByTestId('canvas-save')).not.toBeInTheDocument();
    await flushAsyncUpdates();
  });

  it('manual save lands through the save path (edited:true + promote scan)', async () => {
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    editDoc(PART_0_TEXT.length, PART_0_TEXT.length, ' Dusk falls.');
    expect(screen.getByTestId('canvas-save')).toBeEnabled();

    act(() => {
      screen.getByTestId('canvas-save').click();
    });
    const next = PART_0_TEXT + ' Dusk falls.';
    await waitFor(() => {
      expect(promoteSpy).toHaveBeenCalledWith(world.moduleId, [next]);
    });
    await waitFor(async () => {
      const row = await getModule(world.moduleId);
      const part = row?.parts.find((entry) => entry.planIndex === 0);
      expect(part?.markdown).toBe(next);
      expect(part?.edited).toBe(true);
    });
    expect(toastSuccessMock).toHaveBeenCalledWith('Part saved');
    expect(toastErrorMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  });

  it('switching parts with unsaved edits demands an explicit loud confirm', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    editDoc(0, 3, 'XXX');

    await user.click(screen.getByTestId('canvas-part-select'));
    await user.click(await screen.findByRole('option', { name: /The Flooded Nave/ }));
    const guard = await screen.findByTestId('canvas-switch-guard');
    expect(within(guard).getByText(/discards them/)).toBeInTheDocument();

    // Cancel keeps the scope and the edits.
    await user.click(within(guard).getByRole('button', { name: 'Stay' }));
    await waitFor(() => {
      expect(screen.queryByTestId('canvas-switch-guard')).not.toBeInTheDocument();
    });
    expect(activeCanvasView.current?.state.doc.toString()).not.toBe(PART_0_TEXT);

    // Confirm switches; the row is untouched (session-only staging dies).
    await user.click(screen.getByTestId('canvas-part-select'));
    await user.click(await screen.findByRole('option', { name: /The Flooded Nave/ }));
    await user.click(await screen.findByTestId('canvas-switch-confirm'));
    await waitFor(() => {
      expect(screen.getByText('The Flooded Nave')).toBeInTheDocument();
    });
    expect(activeCanvasView.current?.state.doc.toString()).toBe(PART_1_TEXT);
    await waitFor(async () => {
      const row = await getModule(world.moduleId);
      const part = row?.parts.find((entry) => entry.planIndex === 0);
      expect(part?.markdown).toBe(PART_0_TEXT);
      expect(part?.edited).toBe(false);
    });
    await flushAsyncUpdates();
  });

  it('switching parts without pending work navigates directly (no guard)', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await user.click(screen.getByTestId('canvas-part-select'));
    await user.click(await screen.findByRole('option', { name: 'Premise (read-only)' }));
    await waitFor(() => {
      expect(screen.getByTestId('canvas-premise-notice')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('canvas-switch-guard')).not.toBeInTheDocument();
    await flushAsyncUpdates();
  });
});
