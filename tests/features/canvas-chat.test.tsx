import 'fake-indexeddb/auto';

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { canvasPath } from '@/app/routes';
import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule, patchModule } from '@/db/moduleRepo';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Id,
} from '@/domain';
import { DEFAULT_CHAT_MODEL } from '@/domain/settings';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';
import { activeCanvasView } from '@/features/modules/canvas/canvasView';
import {
  canvasLedgerKey,
  useCanvasLedgerStore,
} from '@/features/modules/canvas/canvasStore';
import {
  applyChatCommandToView,
} from '@/features/modules/canvas/chatApply';
import {
  canvasChatKey,
  useCanvasChatStore,
} from '@/features/modules/canvas/chatStore';

/**
 * Canvas CHAT sidebar — page flows (08-MODULE-DESIGNER §Module canvas chat):
 * send → stream → settle → parse → apply. Every applied command is ONE
 * undoable CM6 transaction landed through the save seam; failures render as
 * loud outcome cards whose Report-to-LLM button composes and sends the
 * follow-up turn; the payload always carries the CURRENT editor doc; chat
 * state is session-only. The LLM is mocked — the controller, store, apply
 * and save seam run for real.
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

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const PART_0_TEXT = 'The party bargains with [[Keeper Ilse]] at the gate.\n\nRain hammers the stones.';

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
      premise: 'The premise.',
      themes: [],
      partPlan: [
        { title: 'The Gate Bargain', levelBand: '1', synopsis: '', levelUpTrigger: '' },
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
    ],
  });
  world = { campaignId: campaign.id, moduleId: draft.id };
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  useCanvasLedgerStore.setState({ ownerModuleId: null, byPart: {} });
  useCanvasChatStore.setState({ ownerModuleId: null, byPart: {} });
  await seedModule();
});

/** The mocked chat: streams the raw reply in two deltas and settles. */
function mockChatReply(raw: string): void {
  chatMock.mockImplementation((_messages, opts) => {
    const mid = Math.max(1, Math.floor(raw.length / 2));
    opts.onToken?.(raw.slice(0, mid));
    opts.onToken?.(raw.slice(mid));
    return Promise.resolve({ text: raw, modelUsed: 'test-model', fallback: null });
  });
}

async function openSidebar(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.click(await screen.findByTestId('canvas-chat-toggle'));
  expect(await screen.findByTestId('canvas-chat')).toBeInTheDocument();
}

/** Types an instruction and sends it; drains the detached chat chain. */
async function sendChat(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
): Promise<void> {
  const input = screen.getByTestId('canvas-chat-input');
  await user.type(input, text);
  await user.click(screen.getByTestId('canvas-chat-send'));
  await flushAsyncUpdates();
}

describe('canvas chat sidebar (page flows)', () => {
  it('applies a valid command: doc edit (one undo step), outcome card, save seam + ledger', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    mockChatReply(
      'Making it rainier.\n<edit><search>Rain hammers the stones.</search><replace>Rain drowns every word.</replace></edit>',
    );
    await sendChat(user, 'make the rain heavier');

    // The doc changed through the editor.
    const view = activeCanvasView.current;
    expect(view?.state.doc.toString()).toBe(
      'The party bargains with [[Keeper Ilse]] at the gate.\n\nRain drowns every word.',
    );
    // The outcome card is applied with 1 occurrence and a mini before→after.
    const panel = screen.getByTestId('canvas-chat');
    const card = await within(panel).findByTestId('canvas-chat-outcome');
    expect(card).toHaveAttribute('data-kind', 'applied');
    expect(card).toHaveAttribute('data-occurrences', '1');
    expect(card.textContent).toContain('Rain hammers the stones.');
    expect(card.textContent).toContain('Rain drowns every word.');
    // Persistence rode THE one part-text save path (edited: true) + ledger.
    const row = await getModule(world.moduleId);
    expect(row?.parts[0]?.markdown).toBe(
      'The party bargains with [[Keeper Ilse]] at the gate.\n\nRain drowns every word.',
    );
    expect(row?.parts[0]?.edited).toBe(true);
    const ledger = useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 0)];
    expect(ledger?.versions).toHaveLength(1);
    expect(ledger?.versions[0]?.origin).toBe('ai');
    expect(ledger?.versions[0]?.label).toContain('Chat:');
    // One undo step reverts the chat edit.
    if (view === null) throw new Error('editor view missing');
    act(() => {
      undo(view);
    });
    expect(activeCanvasView.current?.state.doc.toString()).toBe(PART_0_TEXT);
  });

  it('the payload carries the doc AS OF SEND TIME (current text, not the initial copy)', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    // The user edits the doc BEFORE sending — the payload must reflect that.
    act(() => {
      const view = activeCanvasView.current;
      view?.dispatch({
        changes: { from: PART_0_TEXT.length, to: PART_0_TEXT.length, insert: '\n\nA new line.' },
      });
    });
    mockChatReply('ok');
    await sendChat(user, 'add drama');
    const [messages] = chatMock.mock.calls[0] ?? [];
    const last = messages?.[messages.length - 1];
    expect(last?.role).toBe('user');
    expect(last?.content).toContain('A new line.');
    expect(last?.content).toContain('CURRENT state');
  });

  it('a zero-match failure renders the closest candidate and Report-to-LLM sends the composed follow-up', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    mockChatReply(
      '<edit><search>Rain hammer the stones today.</search><replace>Rain drowns the stones.</replace></edit>',
    );
    await sendChat(user, 'drown the stones');

    const panel = screen.getByTestId('canvas-chat');
    const card = await within(panel).findByTestId('canvas-chat-outcome');
    expect(card).toHaveAttribute('data-kind', 'failed');
    expect(within(card).getByTestId('canvas-chat-outcome-reason').textContent).toContain(
      'does not appear',
    );
    expect(card.textContent).toContain('Rain hammers the stones.');
    // Doc untouched, nothing saved.
    expect(activeCanvasView.current?.state.doc.toString()).toBe(PART_0_TEXT);
    expect(useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 0)]).toBeUndefined();

    // Report to LLM: the follow-up turn composes error + command + excerpt.
    chatMock.mockResolvedValue({
      text: '<edit><search>Rain hammers the stones.</search><replace>Mist swallows the stones.</replace></edit>',
      modelUsed: 'm',
      fallback: null,
    });
    await user.click(within(card).getByTestId('canvas-chat-report-outcome'));
    await flushAsyncUpdates();
    expect(chatMock).toHaveBeenCalledTimes(2);
    const [messages] = chatMock.mock.calls[1] ?? [];
    const last = messages?.[messages.length - 1];
    expect(last?.role).toBe('user');
    expect(last?.content).toContain('could not be applied');
    expect(last?.content).toContain('does not appear');
    expect(last?.content).toContain('<search>Rain hammer the stones today.</search>');
    expect(last?.content).toContain('Rain hammers the stones.'); // doc excerpt
    expect(last?.content).toContain(PART_0_TEXT); // current doc rides too
    // The retried command applies and the card flips to Reported.
    const appliedCard = await within(panel).findAllByTestId('canvas-chat-outcome');
    expect(appliedCard.some((entry) => entry.getAttribute('data-kind') === 'applied')).toBe(true);
    expect(activeCanvasView.current?.state.doc.toString()).toBe(
      PART_0_TEXT.replace('Rain hammers', 'Mist swallows'),
    );
  });

  it('multiple matches without all fail loud; all="true" applies every occurrence in one command', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    act(() => {
      activeCanvasView.current?.dispatch({
        changes: { from: PART_0_TEXT.length, to: PART_0_TEXT.length, insert: '\n\nRain hammers the stones.' },
      });
    });
    await openSidebar(user);
    mockChatReply(
      '<edit><search>Rain hammers the stones.</search><replace>Mist swallows the stones.</replace></edit>',
    );
    await sendChat(user, 'replace the rain line');
    const panel = screen.getByTestId('canvas-chat');
    const failed = await within(panel).findByTestId('canvas-chat-outcome');
    expect(failed).toHaveAttribute('data-kind', 'failed');
    expect(within(failed).getByTestId('canvas-chat-outcome-reason').textContent).toContain('2 matches');

    mockChatReply(
      '<edit all="true"><search>Rain hammers the stones.</search><replace>Mist swallows the stones.</replace></edit>',
    );
    await sendChat(user, 'replace every occurrence');
    const cards = await within(panel).findAllByTestId('canvas-chat-outcome');
    const applied = cards.find((entry) => entry.getAttribute('data-kind') === 'applied');
    expect(applied).toBeDefined();
    expect(applied).toHaveAttribute('data-occurrences', '2');
    // PART_0_TEXT occurrence + the appended one — both replaced.
    expect(activeCanvasView.current?.state.doc.toString()).toBe(
      `${PART_0_TEXT.replace(/Rain hammers the stones\./g, 'Mist swallows the stones.')}\n\nMist swallows the stones.`,
    );
  });

  it('a malformed reply fails the WHOLE reply loudly with a report button', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    mockChatReply('Here you go: <edit><search>abc</search><replace>def');
    await sendChat(user, 'do the thing');
    const panel = screen.getByTestId('canvas-chat');
    const errorCard = await within(panel).findByTestId('canvas-chat-error-card');
    expect(within(errorCard).getByTestId('canvas-chat-error-text').textContent).toContain('unbalanced');
    expect(activeCanvasView.current?.state.doc.toString()).toBe(PART_0_TEXT);
    chatMock.mockResolvedValue({ text: 'Understood — corrected reply. No edits this time.', modelUsed: 'm', fallback: null });
    await user.click(within(errorCard).getByTestId('canvas-chat-report-error'));
    await flushAsyncUpdates();
    const [messages] = chatMock.mock.calls[1] ?? [];
    expect(messages?.[messages.length - 1]?.content).toContain('unbalanced');
  });

  it('streams the prose into the bubble (XML hidden) and only applies after the reply completes', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    let release!: () => void;
    chatMock.mockImplementation((_messages, opts) => {
      opts.onToken?.('Working on it… <edit><search>Rain hammers');
      return new Promise((resolve) => {
        release = () => {
          resolve({
            text: 'Working on it… <edit><search>Rain hammers the stones.</search><replace>Mist swallows the stones.</replace></edit>',
            modelUsed: 'm',
            fallback: null,
          });
        };
      });
    });
    await sendChat(user, 'swap rain for mist');
    // Mid-stream: the bubble shows prose-so-far, no XML, no outcome cards yet.
    const panel = screen.getByTestId('canvas-chat');
    const streaming = await within(panel).findByTestId('canvas-chat-assistant-message');
    expect(streaming).toHaveAttribute('data-status', 'streaming');
    expect(streaming.textContent).toContain('Working on it…');
    expect(streaming.textContent).not.toContain('<edit>');
    expect(activeCanvasView.current?.state.doc.toString()).toBe(PART_0_TEXT);
    // Settle: now the command applies and the card appears.
    release();
    await flushAsyncUpdates();
    await waitFor(() => {
      expect(activeCanvasView.current?.state.doc.toString()).toContain('Mist swallows');
    });
    expect(await within(panel).findByTestId('canvas-chat-outcome')).toHaveAttribute('data-kind', 'applied');
  });

  it('aborting mid-stream marks the reply aborted loudly and applies nothing', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    chatMock.mockImplementation((_messages, opts) => {
      opts.onToken?.('Partial prose ');
      return new Promise((_resolve, reject) => {
        const onAbort = (): void => {
          reject(new DOMException('Aborted', 'AbortError'));
        };
        if (opts.signal?.aborted) onAbort();
        else opts.signal?.addEventListener('abort', onAbort, { once: true });
      });
    });
    await sendChat(user, 'partial work');
    await user.click(screen.getByTestId('canvas-chat-stop'));
    await flushAsyncUpdates();
    const panel = screen.getByTestId('canvas-chat');
    const aborted = await within(panel).findByTestId('canvas-chat-assistant-message');
    expect(aborted).toHaveAttribute('data-status', 'aborted');
    expect(aborted.textContent).toContain('NOTHING was applied');
    expect(activeCanvasView.current?.state.doc.toString()).toBe(PART_0_TEXT);
    const ledger = useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 0)];
    expect(ledger).toBeUndefined();
  });

  it('the model selector defaults to the Settings model and the override rides the next call', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    mockChatReply('ok');
    await sendChat(user, 'first turn');
    expect(chatMock.mock.calls[0]?.[1]?.model).toBe(DEFAULT_CHAT_MODEL);
    // Override (session-only): type a concrete model id into the field.
    const modelField = document.querySelector<HTMLInputElement>('#canvas-chat-model');
    if (modelField === null) throw new Error('chat model field missing');
    await user.clear(modelField);
    await user.type(modelField, 'custom/canvas-model');
    await sendChat(user, 'second turn');
    expect(chatMock.mock.calls[1]?.[1]?.model).toBe('custom/canvas-model');
  });

  it('a busy module is loud: send disabled + generating badge (the error path is engine-tested)', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await patchModule(world.moduleId, { status: 'generating', errorMessage: '' });
    await openSidebar(user);
    // The send affordance is disabled while the module generates (the
    // queue-less ONE-generation-per-module rule surfaced in the UI).
    const input = screen.getByTestId('canvas-chat-input');
    await user.type(input, 'hello?');
    expect(screen.getByTestId('canvas-chat-send')).toBeDisabled();
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('chat state is session-only zustand (no persistence layer, module switch resets)', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    mockChatReply('plain answer');
    await sendChat(user, 'hello');
    const key = canvasChatKey(world.moduleId, 0);
    expect(useCanvasChatStore.getState().byPart[key]?.messages).toHaveLength(2);
    // No persist middleware anywhere on the store.
    expect((useCanvasChatStore as unknown as { persist?: unknown }).persist).toBeUndefined();
    // A module change wipes the chats (Board staging precedent).
    act(() => {
      useCanvasChatStore.getState().resetFor('other-module');
    });
    expect(useCanvasChatStore.getState().byPart[key]).toBeUndefined();
  });
});

describe('chatApply (raw-view units)', () => {
  function mountEditor(doc: string): { view: EditorView; host: HTMLElement } {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [history()] }),
      parent: host,
    });
    return { view, host };
  }

  it('an applied replace-all rides ONE transaction (one undo step)', () => {
    const { view, host } = mountEditor('Rain here.\nRain there.');
    const outcome = applyChatCommandToView(view, {
      search: 'Rain',
      replace: 'Mist',
      all: true,
    });
    expect(outcome.kind).toBe('applied');
    expect(outcome.occurrences).toBe(2);
    expect(view.state.doc.toString()).toBe('Mist here.\nMist there.');
    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe('Rain here.\nRain there.');
    host.remove();
  });

  it('multiple matches without all fail loud with the count', () => {
    const { view, host } = mountEditor('Rain here.\nRain there.');
    const outcome = applyChatCommandToView(view, { search: 'Rain', replace: 'Mist', all: false });
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toContain('2 matches');
    expect(view.state.doc.toString()).toBe('Rain here.\nRain there.');
    host.remove();
  });

  it('an empty search fails loud', () => {
    const { view, host } = mountEditor('text');
    const outcome = applyChatCommandToView(view, { search: '  ', replace: 'x', all: false });
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toContain('empty');
    host.remove();
  });
});
