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
import type * as PartTextModule from '@/features/modules/partText';
import {
  applyChatCommandsAcrossParts,
} from '@/features/modules/canvas/chatApply';
import {
  canvasChatKey,
  useCanvasChatStore,
} from '@/features/modules/canvas/chatStore';

/**
 * Canvas CHAT sidebar — page flows (08-MODULE-DESIGNER §Module canvas
 * chat): send → stream → settle → parse → apply ACROSS THE WHOLE MODULE.
 * The open part edits as ONE undoable CM6 transaction landed through the
 * save seam; other parts land through the same save path per changed part
 * (a failed save is a loud failed outcome, never a silent drop); failures
 * render as loud outcome cards whose Report-to-LLM button composes and
 * sends the follow-up turn; the payload always carries the CURRENT
 * whole-module parts document + the REFERENCE-ONLY grounding; chat state
 * is session-only and keyed per MODULE. The LLM is mocked — the
 * controller, store, apply and save seam run for real.
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
const { saveModulePartText } = await import('@/features/modules/partText');
const savePartMock = vi.mocked(saveModulePartText);
const { toastError } = await import('@/lib/toast');

const PART_0_TEXT = 'The party bargains with [[Keeper Ilse]] at the gate.\n\nRain hammers the stones.\n\n[[Keeper Ilse]] watches.';
const PART_1_TEXT = 'The docks breathe fog.\n\nMist climbs the stairs.\n\n[[Keeper Ilse]] watches.';
const SPINE_PREMISE = 'The premise that must not be edited by the chat.';
const PRIOR_TEXT = 'The chapel bells ring beneath the water.';

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

function renderAppAt(path: string): ReturnType<typeof render> {
  window.history.replaceState(null, '', path);
  return render(<RouterProvider router={createAppRouter()} />);
}

async function seedModule(): Promise<void> {
  const campaign = await createCampaign({
    name: 'Ember',
    description: 'The ember war.',
    system: 'dnd5e',
  });
  // A preceding module — its FULL text grounds the chat read-only.
  const priorDraft = createModule({
    campaignId: campaign.id,
    title: 'The Sunken Chapel',
    concept: 'concept',
    levelMin: 1,
    levelMax: 1,
    tone: '',
    sizeDial: 'standard',
  });
  await saveModule({
    ...priorDraft,
    createdAt: 1,
    spine: moduleSpineSchema.parse({
      premise: 'The chapel premise.',
      themes: [],
      partPlan: [{ title: 'Chapel Bells', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: PRIOR_TEXT,
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
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
    createdAt: 2,
    spine: moduleSpineSchema.parse({
      premise: SPINE_PREMISE,
      themes: [],
      partPlan: [
        { title: 'The Gate Bargain', levelBand: '1', synopsis: '', levelUpTrigger: '' },
        { title: 'Under the Docks', levelBand: '1', synopsis: '', levelUpTrigger: '' },
        { title: 'The Long Watch', levelBand: '2', synopsis: '', levelUpTrigger: '' },
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
  useCanvasChatStore.setState({ ownerModuleId: null, byModule: {} });
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
  it('applies a valid command to the OPEN part: doc edit (one undo step), outcome card, save seam + ledger', async () => {
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
      PART_0_TEXT.replace('Rain hammers the stones.', 'Rain drowns every word.'),
    );
    // The outcome card is applied with 1 occurrence and a mini before→after.
    const panel = screen.getByTestId('canvas-chat');
    const card = await within(panel).findByTestId('canvas-chat-outcome');
    expect(card).toHaveAttribute('data-kind', 'applied');
    expect(card).toHaveAttribute('data-occurrences', '1');
    expect(card.textContent).toContain('Rain hammers the stones.');
    expect(card.textContent).toContain('Rain drowns every word.');
    expect(within(card).getByTestId('canvas-chat-outcome-part').textContent).toContain(
      'Part 1 — The Gate Bargain',
    );
    // Persistence rode THE one part-text save path (edited: true) + ledger.
    const row = await getModule(world.moduleId);
    expect(row?.parts[0]?.markdown).toBe(
      PART_0_TEXT.replace('Rain hammers the stones.', 'Rain drowns every word.'),
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

  it('the payload carries the WHOLE module: other parts, delimiter + labels, grounding, NO premise', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    mockChatReply('ok');
    await sendChat(user, 'tighten the module');
    const [messages] = chatMock.mock.calls[0] ?? [];
    const last = messages?.[messages.length - 1];
    expect(last?.role).toBe('user');
    // Every planned part rides (the open part from the live view, others from the row).
    expect(last?.content).toContain(PART_0_TEXT);
    expect(last?.content).toContain(PART_1_TEXT);
    expect(last?.content).toContain('==========');
    expect(last?.content).toContain('[Part 1 of 3 — The Gate Bargain]');
    expect(last?.content).toContain('[Part 2 of 3 — Under the Docks]');
    expect(last?.content).toContain('[Part 3 of 3 — The Long Watch]');
    // The spine premise is EXCLUDED from the parts document.
    expect(last?.content).not.toContain(SPINE_PREMISE);
    // REFERENCE-ONLY grounding: campaign premise + system label + prior modules FULL text.
    expect(last?.content).toContain('REFERENCE-ONLY CONTEXT');
    expect(last?.content).toContain('Campaign: Ember — The ember war.');
    expect(last?.content).toContain('Game system: D&D 5e');
    expect(last?.content).toContain('## The Sunken Chapel');
    expect(last?.content).toContain(PRIOR_TEXT);
  });

  it('the payload carries the open part AS OF SEND TIME (current text, not the initial copy)', async () => {
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

  it('a command targeting a NON-open part lands on the row (save per changed part), open part untouched', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    mockChatReply(
      '<edit><search>Mist climbs the stairs.</search><replace>Mist floods the stairwell.</replace></edit>',
    );
    await sendChat(user, 'flood the stairwell');

    // The outcome names the target part and shows the mini before→after.
    const panel = screen.getByTestId('canvas-chat');
    const card = await within(panel).findByTestId('canvas-chat-outcome');
    expect(card).toHaveAttribute('data-kind', 'applied');
    expect(within(card).getByTestId('canvas-chat-outcome-part').textContent).toContain(
      'Part 2 — Under the Docks',
    );
    // The row for part 1 landed through the save seam; the open part was NOT rewritten.
    const row = await getModule(world.moduleId);
    expect(row?.parts.find((part) => part.planIndex === 1)?.markdown).toBe(
      PART_1_TEXT.replace('Mist climbs the stairs.', 'Mist floods the stairwell.'),
    );
    expect(row?.parts.find((part) => part.planIndex === 1)?.edited).toBe(true);
    expect(row?.parts.find((part) => part.planIndex === 0)?.markdown).toBe(PART_0_TEXT);
    expect(row?.parts.find((part) => part.planIndex === 0)?.edited).toBe(false);
    expect(activeCanvasView.current?.state.doc.toString()).toBe(PART_0_TEXT);
    // Ledger entry for THAT part, none for the open part.
    expect(
      useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 1)]?.versions,
    ).toHaveLength(1);
    expect(useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 0)]).toBeUndefined();
  });

  it('all="true" applies in EVERY part where it matched (open part + other part)', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    // '[[Keeper Ilse]] watches.' occurs once per part.
    mockChatReply(
      '<edit all="true"><search>[[Keeper Ilse]] watches.</search><replace>[[Keeper Ilse]] keeps the watch.</replace></edit>',
    );
    await sendChat(user, 'sharpen the watcher line');
    const panel = screen.getByTestId('canvas-chat');
    const cards = await within(panel).findAllByTestId('canvas-chat-outcome');
    const applied = cards.filter((entry) => entry.getAttribute('data-kind') === 'applied');
    // One outcome PER PART application, each naming its part.
    expect(applied).toHaveLength(2);
    expect(applied.map((card) => card.textContent).join(' ')).toContain('Part 1 — The Gate Bargain');
    expect(applied.map((card) => card.textContent).join(' ')).toContain('Part 2 — Under the Docks');
    const row = await getModule(world.moduleId);
    expect(row?.parts.find((part) => part.planIndex === 1)?.markdown).toBe(
      PART_1_TEXT.replace('[[Keeper Ilse]] watches.', '[[Keeper Ilse]] keeps the watch.'),
    );
    expect(activeCanvasView.current?.state.doc.toString()).toBe(
      PART_0_TEXT.replace('[[Keeper Ilse]] watches.', '[[Keeper Ilse]] keeps the watch.'),
    );
  });

  it('matches spread across parts fail loud without all; a spanning search cannot match', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    // '[[Keeper Ilse]] watches.' appears TWICE in the open doc (the user
    // appended a copy) and once in part 1 → 3 matches across the module.
    act(() => {
      activeCanvasView.current?.dispatch({
        changes: { from: PART_0_TEXT.length, to: PART_0_TEXT.length, insert: '\n\n[[Keeper Ilse]] watches.' },
      });
    });
    mockChatReply(
      '<edit><search>[[Keeper Ilse]] watches.</search><replace>[[Keeper Ilse]] keeps the watch.</replace></edit>',
    );
    await sendChat(user, 'sharpen the watcher line once');
    const panel = screen.getByTestId('canvas-chat');
    const failed = await within(panel).findByTestId('canvas-chat-outcome');
    expect(failed).toHaveAttribute('data-kind', 'failed');
    expect(within(failed).getByTestId('canvas-chat-outcome-reason').textContent).toContain('3 matches');
    expect(activeCanvasView.current?.state.doc.toString()).toBe(
      `${PART_0_TEXT}\n\n[[Keeper Ilse]] watches.`,
    );

    // A search SPANNING the delimiter never matches (per-part matching).
    mockChatReply(
      `<edit><search>${PART_0_TEXT}\n\n==========\n\n[Part 2 of 3 — Under the Docks]\nThe docks breathe fog.</search><replace>x</replace></edit>`,
    );
    await sendChat(user, 'spanning edit');
    const failedCards = await within(panel).findAllByTestId('canvas-chat-outcome');
    expect(
      failedCards.some(
        (card) =>
          card.getAttribute('data-kind') === 'failed' &&
          card.textContent.includes('does not appear'),
      ),
    ).toBe(true);
    expect(activeCanvasView.current?.state.doc.toString()).toBe(
      `${PART_0_TEXT}\n\n[[Keeper Ilse]] watches.`,
    );
    const row = await getModule(world.moduleId);
    expect(row?.parts.find((part) => part.planIndex === 1)?.markdown).toBe(PART_1_TEXT);
  });

  it('an EMPTY part fills through its label anchor and lands on the row', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    mockChatReply(
      '<edit><search>[Part 3 of 3 — The Long Watch]</search><replace>[Part 3 of 3 — The Long Watch]\n\nThe watch begins in fog.</replace></edit>',
    );
    await sendChat(user, 'write the last part');
    const panel = screen.getByTestId('canvas-chat');
    const card = await within(panel).findByTestId('canvas-chat-outcome');
    expect(card).toHaveAttribute('data-kind', 'applied');
    expect(within(card).getByTestId('canvas-chat-outcome-part').textContent).toContain(
      'Part 3 — The Long Watch',
    );
    const row = await getModule(world.moduleId);
    expect(row?.parts.find((part) => part.planIndex === 2)?.markdown).toBe('The watch begins in fog.');
    expect(activeCanvasView.current?.state.doc.toString()).toBe(PART_0_TEXT);
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

  it('a failed save for a NON-open part is LOUD: failed outcome card + toast naming the part', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    savePartMock.mockImplementationOnce(() => Promise.reject(new Error('disk full')));
    mockChatReply(
      '<edit><search>Mist climbs the stairs.</search><replace>Mist floods the stairwell.</replace></edit>',
    );
    await sendChat(user, 'flood the stairwell');

    const panel = screen.getByTestId('canvas-chat');
    const card = await within(panel).findByTestId('canvas-chat-outcome');
    expect(card).toHaveAttribute('data-kind', 'failed');
    expect(within(card).getByTestId('canvas-chat-outcome-reason').textContent).toContain(
      'the edit did not land',
    );
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining('Under the Docks'),
      expect.anything(),
    );
    // The row was NOT touched — the edit did not land.
    const row = await getModule(world.moduleId);
    expect(row?.parts.find((part) => part.planIndex === 1)?.markdown).toBe(PART_1_TEXT);
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

  it('chat state is keyed per MODULE: switching parts keeps the conversation, module change resets', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    mockChatReply('plain answer');
    await sendChat(user, 'hello');
    const key = canvasChatKey(world.moduleId);
    expect(useCanvasChatStore.getState().byModule[key]?.messages).toHaveLength(2);
    // No persist middleware anywhere on the store.
    expect((useCanvasChatStore as unknown as { persist?: unknown }).persist).toBeUndefined();
    // Switching the open part keeps the SAME conversation (per-module key).
    await user.click(screen.getByTestId('canvas-part-select'));
    await user.click(await screen.findByRole('option', { name: 'Part 2: Under the Docks' }));
    await flushAsyncUpdates();
    expect(useCanvasChatStore.getState().byModule[key]?.messages).toHaveLength(2);
    const panel = screen.getByTestId('canvas-chat');
    await within(panel).findByTestId('canvas-chat-assistant-message');
    // A module change wipes the chat (Board staging precedent).
    act(() => {
      useCanvasChatStore.getState().resetFor('other-module');
    });
    expect(useCanvasChatStore.getState().byModule[key]).toBeUndefined();
  });
});

describe('chatApply across parts (raw-view units)', () => {
  function mountEditor(doc: string): { view: EditorView; host: HTMLElement } {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [history()] }),
      parent: host,
    });
    return { view, host };
  }

  const SNAPSHOT_PARTS = [
    { planIndex: 0, title: 'Open Part', text: 'Rain here.\nRain there.' },
    { planIndex: 1, title: 'Other Part', text: 'Fog elsewhere.' },
  ];

  it('an applied replace-all on the open part rides ONE transaction (one undo step)', () => {
    const { view, host } = mountEditor(SNAPSHOT_PARTS[0]?.text ?? '');
    const result = applyChatCommandsAcrossParts({
      commands: [{ search: 'Rain', replace: 'Mist', all: true }],
      parts: SNAPSHOT_PARTS,
      openPlanIndex: 0,
      view,
    });
    expect(result.openPartChanged).toBe(true);
    expect(result.changedParts).toEqual([]);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.kind).toBe('applied');
    expect(result.outcomes[0]?.occurrences).toBe(2);
    expect(result.outcomes[0]?.targetParts[0]?.title).toBe('Open Part');
    expect(view.state.doc.toString()).toBe('Mist here.\nMist there.');
    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe('Rain here.\nRain there.');
    host.remove();
  });

  it('multiple matches across the whole module fail loud with the total count (open + other)', () => {
    const { view, host } = mountEditor('the gate.\nthe dock.');
    const result = applyChatCommandsAcrossParts({
      commands: [{ search: 'the', replace: 'ye', all: false }],
      parts: [
        { planIndex: 0, title: 'Open Part', text: 'the gate.\nthe dock.' },
        { planIndex: 1, title: 'Other Part', text: 'past the weir.' },
      ],
      openPlanIndex: 0,
      view,
    });
    const outcome = result.outcomes[0];
    expect(outcome?.kind).toBe('failed');
    expect(outcome?.reason).toContain('3 matches');
    expect(view.state.doc.toString()).toBe('the gate.\nthe dock.');
    host.remove();
  });

  it('a command lands in a NON-open part as a splice reported for save; the open doc is untouched', () => {
    const { view, host } = mountEditor('Open text.');
    const result = applyChatCommandsAcrossParts({
      commands: [{ search: 'Fog elsewhere.', replace: 'Mist elsewhere.', all: false }],
      parts: SNAPSHOT_PARTS,
      openPlanIndex: 0,
      view,
    });
    expect(result.openPartChanged).toBe(false);
    expect(result.changedParts).toEqual([
      { partIndex: 1, title: 'Other Part', text: 'Mist elsewhere.' },
    ]);
    expect(view.state.doc.toString()).toBe('Open text.');
    host.remove();
  });

  it('an empty search fails loud', () => {
    const { view, host } = mountEditor('text');
    const result = applyChatCommandsAcrossParts({
      commands: [{ search: '  ', replace: 'x', all: false }],
      parts: SNAPSHOT_PARTS,
      openPlanIndex: 0,
      view,
    });
    expect(result.outcomes[0]?.kind).toBe('failed');
    expect(result.outcomes[0]?.reason).toContain('empty');
    host.remove();
  });
});
