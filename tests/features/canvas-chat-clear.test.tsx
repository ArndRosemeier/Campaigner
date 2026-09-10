import 'fake-indexeddb/auto';

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { canvasPath } from '@/app/routes';
import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import {
  createModule,
  moduleDocumentText,
  modulePartSchema,
  moduleSpineSchema,
  type Id,
} from '@/domain';
import { activeCanvasView } from '@/features/modules/canvas/canvasView';
import { flushChatPersist } from '@/features/modules/canvas/chatPersist';
import {
  canvasChatKey,
  useCanvasChatStore,
  type CanvasChatMessage,
} from '@/features/modules/canvas/chatStore';
import {
  canvasLedgerKey,
  useCanvasLedgerStore,
} from '@/features/modules/canvas/canvasStore';
import { useCanvasPreviewStore } from '@/features/modules/canvas/previewStore';
import type * as PartTextModule from '@/features/modules/partText';
import { assembleModulePartsDocument } from '@/domain/modulePartsDocument';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';

/**
 * Canvas chat "Clear chat" control (08-MODULE-DESIGNER §Module canvas chat;
 * docs/18 §2.3): ONE action returns a module's chat to a pristine state —
 * the live conversation, the persisted `chatThread` on the module row, that
 * module's SESSION version ledger (so Versions tells the truth again) and the
 * last-replacement highlight in both surfaces — while the module's DOCUMENT
 * text is untouched (the control is not an undo) and a second module's
 * session state survives. A reply in flight refuses the clear LOUDLY instead
 * of clearing under a running turn. The LLM is mocked — the controller, the
 * persist seam, the ledger store and both highlight paths run for real.
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

vi.mock('@/features/modules/partText', async (importOriginal) => {
  const original = await importOriginal<typeof PartTextModule>();
  return {
    ...original,
    saveModulePartText: vi.fn(original.saveModulePartText),
  };
});

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError, toastSuccess } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const toastSuccessMock = vi.mocked(toastSuccess);

const PART_0_TEXT = 'The party bargains with [[Keeper Ilse]] at the gate.\n\nRain hammers the stones.';
const PART_1_TEXT = 'The docks breathe fog.\n\nMist climbs the stairs.';

const PART_PLAN = [
  { title: 'The Gate Bargain', levelBand: '1', synopsis: '', levelUpTrigger: '' },
  { title: 'Under the Docks', levelBand: '1', synopsis: '', levelUpTrigger: '' },
  { title: 'The Long Watch', levelBand: '2', synopsis: '', levelUpTrigger: '' },
];

/** The WHOLE-module doc the editor mounts with (byte-exact pin). */
const WHOLE_DOC = assembleModulePartsDocument({
  partPlan: PART_PLAN,
  parts: [
    { planIndex: 0, markdown: PART_0_TEXT },
    { planIndex: 1, markdown: PART_1_TEXT },
  ],
}).document;

/** A reply that APPLIES one edit (part 1) — the highlight + ledger source. */
const APPLY_REPLY =
  'Making it rainier.\n<edit><search>Rain hammers the stones.</search><replace>Rain drowns every word.</replace></edit>';

const CLEARED_TOAST = 'Chat cleared — the module text was not changed';

let world: { campaignId: Id; moduleId: Id; otherModuleId: Id } = {
  campaignId: '',
  moduleId: '',
  otherModuleId: '',
};

function renderAppAt(path: string): ReturnType<typeof render> {
  window.history.replaceState(null, '', path);
  return render(<RouterProvider router={createAppRouter()} />);
}

/** One ready module on a shared part plan (two of them in the world). */
async function seedOneModule(campaignId: Id, title: string, createdAt: number): Promise<Id> {
  const draft = createModule({
    campaignId,
    title,
    concept: 'concept',
    levelMin: 1,
    levelMax: 2,
    tone: '',
    sizeDial: 'standard',
    includePriorModules: false,
  });
  await saveModule({
    ...draft,
    createdAt,
    spine: moduleSpineSchema.parse({
      premise: 'A drowned vault premise.',
      themes: [],
      partPlan: PART_PLAN,
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
  return draft.id;
}

async function seedWorld(): Promise<void> {
  const campaign = await createCampaign({
    name: 'Ember',
    description: 'The ember war.',
    system: 'dnd5e',
  });
  const moduleId = await seedOneModule(campaign.id, 'The Drowned Vault', 2);
  // A SECOND module: its session ledger must survive the first one's clear.
  const otherModuleId = await seedOneModule(campaign.id, 'The Second Vault', 3);
  world = { campaignId: campaign.id, moduleId, otherModuleId };
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  useCanvasLedgerStore.setState({ ownerModuleId: null, byPart: {} });
  useCanvasChatStore.setState({ ownerModuleId: null, byModule: {} });
  useCanvasPreviewStore.setState({ ownerModuleId: null, openByModule: {} });
  await flushChatPersist();
  await seedWorld();
});

/** The mocked chat settles the raw reply immediately (no streaming). */
function mockChatReply(raw: string): void {
  chatMock.mockImplementation(() => Promise.resolve({ text: raw, modelUsed: 'test-model', fallback: null }));
}

/**
 * Mounts the canvas and lands in EDIT mode (the canvas opens in preview by
 * default; these flows drive the editor unless a test says otherwise).
 */
async function renderCanvasEditor(
  user: ReturnType<typeof userEvent.setup>,
): Promise<ReturnType<typeof render>> {
  const view = renderAppAt(canvasPath(world.campaignId, world.moduleId));
  await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
  if (screen.queryByTestId('canvas-chat') === null) {
    await user.click(await screen.findByTestId('canvas-chat-toggle'));
  }
  if (screen.queryByTestId('canvas-preview') !== null) {
    await user.click(screen.getByTestId('canvas-preview-toggle'));
  }
  await screen.findByTestId('canvas-editor');
  await flushAsyncUpdates();
  return view;
}

/** The default view: chat + live preview (no editor mounted). */
async function renderCanvasPreview(): Promise<void> {
  renderAppAt(canvasPath(world.campaignId, world.moduleId));
  await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
  expect(await screen.findByTestId('canvas-chat')).toBeInTheDocument();
  await flushAsyncUpdates();
}

/** Types an instruction and sends it; drains the detached chat chain. */
async function sendChat(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  const input = screen.getByTestId('canvas-chat-input');
  await user.type(input, text);
  await user.click(screen.getByTestId('canvas-chat-send'));
  await flushAsyncUpdates();
}

/** Panel header → confirm-dialog → clear (the one user-facing flow). */
async function clearChatThroughUi(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByTestId('canvas-chat-clear'));
  await user.click(await screen.findByTestId('canvas-chat-clear-confirm'));
  await flushAsyncUpdates();
}

function chatMessages(): CanvasChatMessage[] {
  return useCanvasChatStore.getState().module(canvasChatKey(world.moduleId)).messages;
}

describe('canvas chat clear (one module, pristine state)', () => {
  it('clears the live conversation AND the persisted thread, and the next send starts a fresh session', async () => {
    const user = userEvent.setup();
    const { unmount } = await renderCanvasEditor(user);

    mockChatReply('Noted — rain it is.');
    await sendChat(user, 'remember the rain');
    expect(chatMessages()).toHaveLength(2);

    // DURABILITY FIRST: the settled turn lands on the row (the owner's exact
    // reported state — a persisted thread beside a session-only ledger), so
    // the assertion below can only be satisfied by a real CLEARING write.
    let row = await actDrained(async () => {
      await flushChatPersist(canvasChatKey(world.moduleId));
      return getModule(world.moduleId);
    });
    expect(row?.chatThread.map((entry) => entry.text)).toEqual([
      'remember the rain',
      'Noted — rain it is.',
    ]);

    await clearChatThroughUi(user);

    // The live store is pristine and the panel is back to its front door.
    expect(chatMessages()).toHaveLength(0);
    const panel = screen.getByTestId('canvas-chat');
    expect(within(panel).queryAllByTestId('canvas-chat-user-message')).toHaveLength(0);
    expect(panel.textContent).toContain('Ask for edits in plain language');
    expect(toastSuccessMock).toHaveBeenCalledWith(CLEARED_TOAST);

    // Persisted, not just in-memory: the ROW reads `chatThread: []`…
    row = await actDrained(() => getModule(world.moduleId));
    expect(row?.chatThread).toEqual([]);
    // …and the clear survives a later flush (the cancelled debounce can never
    // re-serialize the thread the user just cleared).
    row = await actDrained(async () => {
      await flushChatPersist(canvasChatKey(world.moduleId));
      return getModule(world.moduleId);
    });
    expect(row?.chatThread).toEqual([]);

    // Reload-equivalent: a fresh session + remount restores NOTHING.
    unmount();
    useCanvasChatStore.setState({ ownerModuleId: null, byModule: {} });
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await flushAsyncUpdates();
    const reloaded = screen.getByTestId('canvas-chat');
    expect(within(reloaded).queryAllByTestId('canvas-chat-user-message')).toHaveLength(0);
    expect(reloaded.textContent).toContain('Ask for edits in plain language');

    // The NEXT send starts from nothing: no ghost history rides the payload.
    if (screen.queryByTestId('canvas-preview') !== null) {
      await user.click(screen.getByTestId('canvas-preview-toggle'));
    }
    await screen.findByTestId('canvas-editor');
    mockChatReply('Starting fresh.');
    await sendChat(user, 'start over');
    expect(chatMock.mock.calls).toHaveLength(2);
    expect(JSON.stringify(chatMock.mock.calls[1]?.[0])).not.toContain('remember the rain');
    expect(JSON.stringify(chatMock.mock.calls[1]?.[0])).toContain('start over');
    expect(within(screen.getByTestId('canvas-chat')).getAllByTestId('canvas-chat-user-message')).toHaveLength(1);
    row = await actDrained(async () => {
      await flushChatPersist(canvasChatKey(world.moduleId));
      return getModule(world.moduleId);
    });
    expect(row?.chatThread.map((entry) => entry.role)).toEqual(['user', 'assistant']);
    await flushAsyncUpdates();
  }, 30_000);

  it('empties THIS module\'s Versions list while a second module\'s session versions survive', async () => {
    const user = userEvent.setup();
    await renderCanvasPreview();
    mockChatReply(APPLY_REPLY);
    await sendChat(user, 'make the rain heavier');
    // The real apply landed a session-ledger entry for part 1 of this module.
    expect(
      useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 0)]?.versions,
    ).toHaveLength(1);
    // A second module's session ledger (its own keys) is in the store.
    act(() => {
      useCanvasLedgerStore.getState().append(canvasLedgerKey(world.otherModuleId, 0), {
        markdown: 'Other module text',
        origin: 'ai',
        label: 'Chat: other',
      });
    });

    // Before the clear the Versions dropdown lists this module's entry…
    await user.click(screen.getByTestId('canvas-versions'));
    expect(await screen.findByTestId('canvas-version-0-1')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await flushAsyncUpdates();

    await clearChatThroughUi(user);

    // This module: every part's ledger is gone…
    expect(useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 0)]).toBeUndefined();
    expect(useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 1)]).toBeUndefined();
    // …which is exactly what the Versions dropdown now reports.
    await user.click(screen.getByTestId('canvas-versions'));
    expect(await screen.findByTestId('canvas-versions-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-version-0-1')).not.toBeInTheDocument();
    // The SECOND module's session versions are untouched (owner-keyed ledger).
    expect(
      useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.otherModuleId, 0)]?.versions,
    ).toHaveLength(1);
    await flushAsyncUpdates();
  }, 30_000);

  it('clears the last-replacement highlight in BOTH surfaces and leaves the document byte-identical', async () => {
    const user = userEvent.setup();
    await renderCanvasPreview();
    mockChatReply(APPLY_REPLY);
    await sendChat(user, 'make the rain heavier');

    // Preview (the default surface): the wash is up…
    const wash = await within(screen.getByTestId('canvas-preview')).findByTestId(
      'replacement-highlight',
    );
    expect(wash).toHaveTextContent('Rain drowns every word.');
    const before = await actDrained(() => getModule(world.moduleId));
    const docAfterApply = WHOLE_DOC.replace('Rain hammers the stones.', 'Rain drowns every word.');

    await clearChatThroughUi(user);

    // …and the clear takes it with it (no stale wash over an untouched doc).
    expect(
      within(screen.getByTestId('canvas-preview')).queryByTestId('replacement-highlight'),
    ).toBeNull();
    // The editor surface had the CM6 mark too (same page state) — mounting it
    // back proves the mark is gone, not merely hidden behind the preview.
    await user.click(screen.getByTestId('canvas-preview-toggle'));
    await screen.findByTestId('canvas-editor');
    expect(screen.queryByTestId('canvas-last-replacement')).not.toBeInTheDocument();
    expect(activeCanvasView.current?.state.doc.toString()).toBe(docAfterApply);

    // Clearing the CHAT never rewrites the DOCUMENT.
    const after = await actDrained(() => getModule(world.moduleId));
    expect(after?.parts).toEqual(before?.parts);
    expect(after === undefined ? '' : moduleDocumentText(after)).toBe(
      before === undefined ? '' : moduleDocumentText(before),
    );
    await flushAsyncUpdates();
  }, 30_000);

  it('the confirm dialog states exactly what is cleared and what is NOT, and the doc stays byte-identical', async () => {
    const user = userEvent.setup();
    await renderCanvasEditor(user);
    mockChatReply(APPLY_REPLY);
    await sendChat(user, 'make the rain heavier');
    // The thread is durably on the row before the dialog opens (so the
    // post-clear `[]` is a clearing write, not a write that never happened).
    const before = await actDrained(async () => {
      await flushChatPersist(canvasChatKey(world.moduleId));
      return getModule(world.moduleId);
    });
    expect(before?.chatThread.length).toBeGreaterThan(0);

    await user.click(screen.getByTestId('canvas-chat-clear'));
    const description = await screen.findByTestId('canvas-chat-clear-description');
    // The boundary is unmistakable in the copy: what goes, and what stays.
    expect(description.textContent).toContain('NOT cleared: the module');
    expect(description.textContent).toContain('DOCUMENT TEXT');
    expect(description.textContent).toContain('not an undo');
    expect(description.textContent).toContain('Versions');
    expect(description.textContent).toContain('saved thread on the module');

    await user.click(screen.getByTestId('canvas-chat-clear-confirm'));
    await flushAsyncUpdates();
    const after = await actDrained(() => getModule(world.moduleId));
    expect(after?.chatThread).toEqual([]);
    expect(after?.parts).toEqual(before?.parts);
    expect(after === undefined ? '' : moduleDocumentText(after)).toBe(
      before === undefined ? '' : moduleDocumentText(before),
    );
    await flushAsyncUpdates();
  }, 30_000);

  it('refuses LOUDLY while a reply is in flight — nothing is cleared', async () => {
    const user = userEvent.setup();
    await renderCanvasEditor(user);
    let release!: () => void;
    chatMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ text: 'late reply', modelUsed: 'm', fallback: null });
          };
        }),
    );
    await sendChat(user, 'hold that thought');
    expect(chatMessages()).toHaveLength(2);
    // In flight: the composer offers Stop (the running turn is real).
    expect(screen.getByTestId('canvas-chat-stop')).toBeInTheDocument();

    await clearChatThroughUi(user);

    // Refused, loudly and specifically: the reply is still arriving.
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('still in flight'),
      expect.anything(),
    );
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(chatMessages()).toHaveLength(2);
    expect(screen.queryByTestId('canvas-chat-clear-dialog')).not.toBeInTheDocument();
    // Nothing was written to the row either (before OR after the refusal).
    let row = await actDrained(() => getModule(world.moduleId));
    expect(row?.chatThread).toEqual([]);

    // The running turn settles normally: the refused clear left it whole.
    release();
    await flushAsyncUpdates();
    await actDrained(() => flushChatPersist(canvasChatKey(world.moduleId)));
    row = await actDrained(() => getModule(world.moduleId));
    expect(row?.chatThread.map((entry) => entry.text)).toEqual(['hold that thought', 'late reply']);
    expect(chatMessages()).toHaveLength(2);
    await flushAsyncUpdates();
  }, 30_000);
});
