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
import {
  canvasLedgerKey,
  useCanvasLedgerStore,
} from '@/features/modules/canvas/canvasStore';
import { patchModule } from '@/db/moduleRepo';

/**
 * Module canvas — page flows (08-MODULE-DESIGNER §Module canvas): the shell
 * and scope (commit 1) plus the AI proposal flows (commit 2) — selection
 * refine and whole-part rewrite through the canvasRefine contract (chat is
 * mocked; the zod boundary, debris scan and busy rule run for real), accept =
 * persistence through THE one part-text save path + session ledger, reject /
 * discard leave the doc untouched, typing inside a proposal invalidates it
 * loudly, and Restore re-proposes an older ledger version.
 */

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('@/llm/openrouter', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chat: vi.fn(),
}));

vi.mock('@/db/artifactAutoPromote', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  promoteSecondModuleUses: vi.fn(),
}));

const { promoteSecondModuleUses } = await import('@/db/artifactAutoPromote');
const promoteSpy = vi.mocked(promoteSecondModuleUses);
const { toastError, toastSuccess } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const toastSuccessMock = vi.mocked(toastSuccess);
const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

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
  useCanvasLedgerStore.setState({ ownerModuleId: null, byPart: {} });
  await seedModule();
});

/** The mocked chat: streams the JSON reply in two raw content chunks (the
 * canvasRefine extractor sees exactly what OpenRouter streams) and settles
 * with the full text. */
function mockChatReply(replacement: string): void {
  chatMock.mockImplementation((_messages, opts) => {
    const raw = JSON.stringify({ replacement });
    const mid = Math.max(1, Math.floor(raw.length / 2));
    opts.onToken?.(raw.slice(0, mid));
    opts.onToken?.(raw.slice(mid));
    return Promise.resolve({ text: raw, modelUsed: 'test-model', fallback: null });
  });
}

/** Runs the instruction dialog for the given AI action. */
async function runInstruction(
  user: ReturnType<typeof userEvent.setup>,
  actionTestId: string,
  text: string,
): Promise<void> {
  await user.click(screen.getByTestId(actionTestId));
  const dialog = await screen.findByTestId('canvas-instruction-dialog');
  await user.type(within(dialog).getByTestId('canvas-instruction-input'), text);
  await user.click(within(dialog).getByTestId('canvas-instruction-confirm'));
  // The refine chain runs detached (propose → chat → seal/drop): drain it
  // inside act so its state updates never leak outside act.
  await flushAsyncUpdates();
}

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

const REFINE_TEXT = 'The party bargains harder than ever.';
// A span replacement over 'party' ([4, 9)) composes with the surrounding text.
const REFINED_DOC = `${PART_0_TEXT.slice(0, 4)}${REFINE_TEXT}${PART_0_TEXT.slice(9)}`;

async function renderCanvasPart0(): Promise<ReturnType<typeof render>> {
  const page = renderAppAt(canvasPath(world.campaignId, world.moduleId));
  await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
  await flushAsyncUpdates();
  return page;
}

function selectSpan(from: number, to: number): void {
  act(() => {
    activeCanvasView.current?.dispatch({ selection: { anchor: from, head: to } });
  });
}

describe('canvas AI proposals', () => {
  it('selection refine: propose → stream → accept lands through the save path + ledger', async () => {
    const user = userEvent.setup();
    mockChatReply(REFINE_TEXT);
    await renderCanvasPart0();
    selectSpan(4, 9); // "party"

    await runInstruction(user, 'canvas-refine-selection', 'make the bargain harder');
    const ghost = await screen.findByTestId('canvas-suggestion-ghost', {}, { timeout: 5_000 });
    await waitFor(() => {
      expect(ghost).toHaveTextContent('The party bargains harder than ever.');
    });
    // The proposal is a decoration: the doc is untouched until accept.
    expect(activeCanvasView.current?.state.doc.toString()).toBe(PART_0_TEXT);

    // Accept via the in-editor widget.
    await user.click(await screen.findByTestId('canvas-suggestion-accept'));
    await flushAsyncUpdates();
    const next = REFINED_DOC;
    await waitFor(() => {
      expect(promoteSpy).toHaveBeenCalledWith(world.moduleId, [next]);
    });
    await waitFor(async () => {
      const row = await getModule(world.moduleId);
      const part = row?.parts.find((entry) => entry.planIndex === 0);
      expect(part?.markdown).toBe(next);
      expect(part?.edited).toBe(true);
      expect(part?.status).toBe('ready');
    });
    expect(toastSuccessMock).toHaveBeenCalledWith('Proposal applied');
    // Session ledger appended with the AI entry (label carries the instruction).
    const ledger = useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 0)];
    expect(ledger?.versions).toHaveLength(1);
    expect(ledger?.versions[0]?.label).toBe('Refine: make the bargain harder');
    expect(ledger?.versions[0]?.origin).toBe('ai');
    await flushAsyncUpdates();
  }, 30_000);

  it('reject leaves the doc and the row untouched', async () => {
    const user = userEvent.setup();
    mockChatReply(REFINE_TEXT);
    await renderCanvasPart0();
    selectSpan(4, 9);
    await runInstruction(user, 'canvas-refine-selection', 'tighten');
    await screen.findByTestId('canvas-suggestion-ghost', {}, { timeout: 5_000 });
    await waitFor(() => {
      expect(screen.getByTestId('canvas-suggestion-reject')).toBeEnabled();
    });

    await user.click(screen.getByTestId('canvas-suggestion-reject'));
    await flushAsyncUpdates();
    expect(activeCanvasView.current?.state.doc.toString()).toBe(PART_0_TEXT);
    await flushAsyncUpdates();
    const row = await getModule(world.moduleId);
    const part = row?.parts.find((entry) => entry.planIndex === 0);
    expect(part?.markdown).toBe(PART_0_TEXT);
    expect(part?.edited).toBe(false);
    expect(promoteSpy).not.toHaveBeenCalled();
    expect(useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 0)]).toBeUndefined();
  }, 30_000);

  it('an unparseable reply fails loud and drops the proposal (never partial-apply)', async () => {
    const user = userEvent.setup();
    chatMock.mockResolvedValue({ text: 'the model rambled, no JSON', modelUsed: 'm', fallback: null });
    await renderCanvasPart0();
    selectSpan(4, 9);
    await runInstruction(user, 'canvas-refine-selection', 'tighten');

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Canvas refine failed — nothing was applied',
        expect.any(Error),
      );
    });
    expect(activeCanvasView.current?.state.doc.toString()).toBe(PART_0_TEXT);
    expect(screen.queryByTestId('canvas-suggestion-ghost')).not.toBeInTheDocument();
    const row = await getModule(world.moduleId);
    expect(row?.parts.find((entry) => entry.planIndex === 0)?.markdown).toBe(PART_0_TEXT);
    await flushAsyncUpdates();
  }, 30_000);

  it('an escape-debris reply rejects loudly (encodingHygiene scan at the boundary)', async () => {
    const user = userEvent.setup();
    mockChatReply('Der Flussm?fcndung steigt.');
    await renderCanvasPart0();
    selectSpan(4, 9);
    await runInstruction(user, 'canvas-refine-selection', 'translate the mood');

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Canvas refine failed — nothing was applied',
        expect.any(Error),
      );
    });
    expect(String(toastErrorMock.mock.calls[0]?.[1])).toContain('?fc');
    expect(activeCanvasView.current?.state.doc.toString()).toBe(PART_0_TEXT);
    await flushAsyncUpdates();
  }, 30_000);

  it('typing inside the proposed range invalidates it loudly (marimo semantics)', async () => {
    const user = userEvent.setup();
    mockChatReply(REFINE_TEXT);
    await renderCanvasPart0();
    selectSpan(4, 9);
    await runInstruction(user, 'canvas-refine-selection', 'tighten');
    await screen.findByTestId('canvas-suggestion-ghost', {}, { timeout: 5_000 });
    await waitFor(() => {
      expect(screen.getByTestId('canvas-suggestion-accept')).toBeEnabled();
    });

    editDoc(5, 5, 'X'); // strictly inside [4, 9)
    await flushAsyncUpdates();
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Suggestion discarded — the text was edited inside the proposed range',
        expect.any(Error),
      );
    });
    expect(screen.queryByTestId('canvas-suggestion-ghost')).not.toBeInTheDocument();
    // The typed edit itself survives; only the proposal died.
    expect(activeCanvasView.current?.state.doc.toString()).toBe(
      `${PART_0_TEXT.slice(0, 5)}X${PART_0_TEXT.slice(5)}`,
    );
    await flushAsyncUpdates();
  }, 30_000);

  it('whole-part rewrite: no-diff stage → Show previous → Apply; Discard variant drops', async () => {
    const user = userEvent.setup();
    const NEW_PART = 'Brand new stormy part text.';
    mockChatReply(NEW_PART);
    await renderCanvasPart0();
    await runInstruction(user, 'canvas-rewrite-part', 'make it stormy');

    const preview = await screen.findByTestId('canvas-wholepart-preview', {}, { timeout: 5_000 });
    await waitFor(() => {
      expect(preview).toHaveTextContent(NEW_PART);
    });
    // No-diff rendering: the proposed text as-is; the doc still holds the original.
    expect(activeCanvasView.current?.state.doc.toString()).toBe(PART_0_TEXT);
    expect(screen.getByTestId('canvas-proposal-bar')).toBeInTheDocument();

    await user.click(screen.getByTestId('canvas-show-previous'));
    await waitFor(() => {
      expect(screen.getByTestId('canvas-wholepart-preview')).toHaveTextContent(PART_0_TEXT);
    });
    await user.click(screen.getByTestId('canvas-show-previous'));
    await waitFor(() => {
      expect(screen.getByTestId('canvas-wholepart-preview')).toHaveTextContent(NEW_PART);
    });

    // Apply = the accept path: doc replaced + save path + ledger.
    await user.click(screen.getByTestId('canvas-proposal-apply'));
    await flushAsyncUpdates();
    await waitFor(() => {
      expect(promoteSpy).toHaveBeenCalledWith(world.moduleId, [NEW_PART]);
    });
    expect(activeCanvasView.current?.state.doc.toString()).toBe(NEW_PART);
    await waitFor(async () => {
      const row = await getModule(world.moduleId);
      expect(row?.parts.find((entry) => entry.planIndex === 0)?.markdown).toBe(NEW_PART);
      expect(row?.parts.find((entry) => entry.planIndex === 0)?.edited).toBe(true);
    });
    const ledger = useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 0)];
    expect(ledger?.versions).toHaveLength(1);
    expect(ledger?.versions[0]?.label).toBe('Rewrite: make it stormy');
    await flushAsyncUpdates();
  }, 30_000);

  it('whole-part discard drops the proposal without touching doc or row', async () => {
    const user = userEvent.setup();
    mockChatReply('Brand new stormy part text.');
    await renderCanvasPart0();
    await runInstruction(user, 'canvas-rewrite-part', 'make it stormy');
    await screen.findByTestId('canvas-wholepart-preview', {}, { timeout: 5_000 });
    await waitFor(() => {
      expect(screen.getByTestId('canvas-proposal-discard')).toBeEnabled();
    });

    await user.click(screen.getByTestId('canvas-proposal-discard'));
    await flushAsyncUpdates();
    expect(activeCanvasView.current?.state.doc.toString()).toBe(PART_0_TEXT);
    expect(screen.queryByTestId('canvas-proposal-bar')).not.toBeInTheDocument();
    await flushAsyncUpdates();
    const row = await getModule(world.moduleId);
    expect(row?.parts.find((entry) => entry.planIndex === 0)?.markdown).toBe(PART_0_TEXT);
    expect(promoteSpy).not.toHaveBeenCalled();
  }, 30_000);

  it('a busy module disables the AI actions and keeps the forge Stop affordance', async () => {
    await patchModule(world.moduleId, { status: 'generating', errorMessage: '' });
    await renderCanvasPart0();
    expect(screen.getByTestId('canvas-refine-selection')).toBeDisabled();
    expect(screen.getByTestId('canvas-rewrite-part')).toBeDisabled();
    expect(screen.getByTestId('canvas-stop')).toBeInTheDocument();
    await flushAsyncUpdates();
  }, 30_000);

  it('Restore re-proposes an older version through the same accept path', async () => {
    const user = userEvent.setup();
    mockChatReply(REFINE_TEXT);
    await renderCanvasPart0();
    selectSpan(4, 9);
    await runInstruction(user, 'canvas-refine-selection', 'make the bargain harder');
    await screen.findByTestId('canvas-suggestion-ghost', {}, { timeout: 5_000 });
    await user.click(await screen.findByTestId('canvas-suggestion-accept'));
    await flushAsyncUpdates();
    await waitFor(() => {
      expect(promoteSpy).toHaveBeenCalledWith(world.moduleId, [REFINED_DOC]);
    });

    // Manual edit + save → ledger entry #2.
    editDoc(REFINE_TEXT.length, REFINE_TEXT.length, ' Dusk falls.');
    await user.click(screen.getByTestId('canvas-save'));
    await flushAsyncUpdates();
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith('Part saved');
    });
    expect(useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 0)]?.versions).toHaveLength(2);

    // Restore #1: proposes the older markdown as a whole-part proposal.
    await user.click(screen.getByTestId('canvas-versions'));
    await user.click(await screen.findByTestId('canvas-version-1'));
    const preview = await screen.findByTestId('canvas-wholepart-preview', {}, { timeout: 5_000 });
    await waitFor(() => {
      expect(preview).toHaveTextContent(REFINE_TEXT);
    });
    await user.click(screen.getByTestId('canvas-proposal-apply'));
    await flushAsyncUpdates();
    await waitFor(() => {
      expect(promoteSpy).toHaveBeenLastCalledWith(world.moduleId, [REFINED_DOC]);
    });
    const ledger = useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 0)];
    expect(ledger?.versions).toHaveLength(3);
    expect(ledger?.versions[2]?.label).toBe('Restored version #1');
    expect(ledger?.versions[2]?.markdown).toBe(REFINED_DOC);
    await flushAsyncUpdates();
  }, 30_000);

  it('switching parts with a pending proposal demands the explicit guard', async () => {
    const user = userEvent.setup();
    mockChatReply(REFINE_TEXT);
    await renderCanvasPart0();
    selectSpan(4, 9);
    await runInstruction(user, 'canvas-refine-selection', 'tighten');
    await screen.findByTestId('canvas-suggestion-ghost', {}, { timeout: 5_000 });

    await user.click(screen.getByTestId('canvas-part-select'));
    await user.click(await screen.findByRole('option', { name: /The Flooded Nave/ }));
    expect(await screen.findByTestId('canvas-switch-guard')).toBeInTheDocument();
    await user.click(await screen.findByTestId('canvas-switch-confirm'));
    await flushAsyncUpdates();
    await waitFor(() => {
      expect(screen.getByText('The Flooded Nave')).toBeInTheDocument();
    });
    // The pending proposal died with the staging (session-only by design).
    expect(activeCanvasView.current?.state.doc.toString()).toBe(PART_1_TEXT);
    expect(screen.queryByTestId('canvas-suggestion-ghost')).not.toBeInTheDocument();
    await flushAsyncUpdates();
  }, 30_000);
});
