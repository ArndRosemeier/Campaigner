import 'fake-indexeddb/auto';

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { boardPath, canvasChatPath, canvasPath, modulePath, modulesPath } from '@/app/routes';
import { createCampaign } from '@/db/campaignRepo';
import { db } from '@/db/db';
import { getModule, saveModule } from '@/db/moduleRepo';
import {
  createModule,
  moduleDocumentText,
  modulePartSchema,
  moduleSchema,
  moduleSpineSchema,
  type Id,
  type ModuleChatMessage,
} from '@/domain';
import { buildCampaignExport, importExport } from '@/lib/exportImport';
import { priorModulesContext } from '@/llm/moduleGen';
import { activeCanvasView } from '@/features/modules/canvas/canvasView';
import { flushChatPersist } from '@/features/modules/canvas/chatPersist';
import {
  canvasChatKey,
  useCanvasChatStore,
} from '@/features/modules/canvas/chatStore';
import type * as PartTextModule from '@/features/modules/partText';
import type * as ChatPersistModule from '@/features/modules/canvas/chatPersist';
import {
  assembleModulePartsDocument,
} from '@/domain/modulePartsDocument';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';

/**
 * Canvas chat thread persistence (08-MODULE-DESIGNER §Module canvas chat,
 * docs/17 row 57 — owner-overturned: the conversation PERSISTS on the
 * module row): settled turns write the thread (debounced; failures toast
 * loudly but never block), a reload restores messages + outcomes as history
 * (never auto-applied), campaign export/import carries the thread, and no
 * generation prompt reader consults the field. The LLM is mocked — the
 * controller, persist writer, restore path and export/import run for real.
 */

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

/**
 * The debounced write is GATED BY THE TEST (docs/08 §Race cures). The
 * write-after-settled-turn (`chatPersist.scheduleChatPersist`, called from the
 * controller's settle path) is made to wait for this test, which resolves it only
 * after the row has been read. So "nothing is persisted yet" is asserted while
 * the write provably has not been SCHEDULED — on any machine, at any load.
 *
 * Why the gate and not a held DB read: holding a read cannot work here, because
 * the pending write's own timer fires on the event loop (a held read hands it the
 * loop). Why not fake timers: fake-indexeddb's own request queue rides the same
 * timers, so a faked clock wedges the DB (measured: the suite times out).
 *
 * This is what the test used to race: with BOTH turns settling inside the 600ms
 * window (a fast, unloaded box) the row was still empty at the read, and the
 * assertion passed. On a box where the turns were more than one window apart the
 * write had already fired and the row carried the FIRST turn's two messages —
 * `toHaveLength(0)` failed on the clock, not on the code. Measured with an
 * instrumented probe on this head: turn 1 scheduled the write at +483ms and turn
 * 2 settled at +1571ms.
 */
let writeGate: { reached: Promise<void>; wait: Promise<void>; release: () => void } | null = null;

/** Holds the next `scheduleChatPersist` until `waitForScheduledWrite` runs. */
function armWriteGate(): void {
  let reach!: () => void;
  let release!: () => void;
  writeGate = {
    reached: new Promise<void>((resolve) => {
      reach = resolve;
    }),
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release,
  };
  reach();
}

/** Releases the held write and waits until the settle path has reached it. */
async function waitForScheduledWrite(): Promise<void> {
  const gate = writeGate;
  writeGate = null;
  if (gate === null) {
    // Not fatal: the test then races the debounce window again (the bug).
    await flushAsyncUpdates();
    return;
  }
  gate.release();
  await gate.reached;
}

vi.mock('@/features/modules/canvas/chatPersist', async (importOriginal) => {
  const actual = await importOriginal<typeof ChatPersistModule>();
  return {
    ...actual,
    scheduleChatPersist: async (moduleId: string, key: string): Promise<void> => {
      const gate = writeGate;
      if (gate !== null) await gate.wait;
      actual.scheduleChatPersist(moduleId, key);
    },
  };
});

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
const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

const PART_0_TEXT = 'The party bargains with [[Keeper Ilse]] at the gate.\n\nRain hammers the stones.';
const PART_1_TEXT = 'The docks breathe fog.\n\nMist climbs the stairs.';

const PART_PLAN = [
  { title: 'The Gate Bargain', levelBand: '1', synopsis: '', levelUpTrigger: '' },
  { title: 'Under the Docks', levelBand: '1', synopsis: '', levelUpTrigger: '' },
  { title: 'The Long Watch', levelBand: '2', synopsis: '', levelUpTrigger: '' },
];

/** The WHOLE-module editor doc the page mounts with (byte-exact pin). */
const WHOLE_DOC = assembleModulePartsDocument({
  partPlan: PART_PLAN,
  parts: [
    { planIndex: 0, markdown: PART_0_TEXT },
    { planIndex: 1, markdown: PART_1_TEXT },
  ],
}).document;

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
  world = { campaignId: campaign.id, moduleId: draft.id };
}

beforeEach(async () => {
  // The write gate is per test: a gate left armed (or left over) would make the
  // next test's write wait for a release that never comes, and an un-armed one
  // would silently put the debounce pin back to racing the window.
  writeGate = null;
  await clearDatabase();
  vi.clearAllMocks();
  useCanvasChatStore.setState({ ownerModuleId: null, byModule: {} });
  await flushChatPersist();
  await seedModule();
});

/** The mocked chat settles the raw reply immediately (no streaming). */
function mockChatReply(raw: string): void {
  chatMock.mockImplementation(() => Promise.resolve({ text: raw, modelUsed: 'test-model', fallback: null }));
}

async function openSidebar(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  // Front door: the sidebar is OPEN by default — only toggle when closed.
  if (screen.queryByTestId('canvas-chat') === null) {
    await user.click(await screen.findByTestId('canvas-chat-toggle'));
  }
  expect(await screen.findByTestId('canvas-chat')).toBeInTheDocument();
  // The canvas opens in preview by default — these flows drive the editor.
  if (screen.queryByTestId('canvas-preview') !== null) {
    await user.click(screen.getByTestId('canvas-preview-toggle'));
  }
  await screen.findByTestId('canvas-editor');
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

describe('canvas chat thread persistence', () => {
  it('writes the thread after each settled turn (debounced) and restores messages + outcomes as history on reload — never auto-applied', async () => {
    const user = userEvent.setup();
    const { unmount } = renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);

    armWriteGate();
    mockChatReply('Noted — rain it is.');
    await sendChat(user, 'remember the rain');
    mockChatReply(
      'Trying.\n<edit><search>this text is nowhere in the module</search><replace>whatever</replace></edit>',
    );
    await sendChat(user, 'change the missing thing');

    // The failed command renders its loud card (zero matches, closest text).
    const panel = screen.getByTestId('canvas-chat');
    const failed = await within(panel).findByTestId('canvas-chat-outcome');
    expect(failed).toHaveAttribute('data-kind', 'failed');

    // The second turn's payload already carries the first (full history).
    expect(chatMock.mock.calls).toHaveLength(2);
    const [secondMessages] = chatMock.mock.calls[1] ?? [];
    expect(JSON.stringify(secondMessages)).toContain('remember the rain');

    // Debounced: nothing lands until the flush, then the whole thread does. The
    // write is held at the gate, so the row is read while the write provably has
    // not been scheduled — no race against the 600ms window (see the gate above).
    // (actDrained: the row write re-fires the page's live queries — the
    // cascade must land inside act, per the console guard.)
    await waitForScheduledWrite();
    let row = await getModule(world.moduleId);
    expect(row?.chatThread).toHaveLength(0);
    row = await actDrained(async () => {
      await flushChatPersist(canvasChatKey(world.moduleId));
      return getModule(world.moduleId);
    });
    expect(row?.chatThread.map((entry) => entry.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(row?.chatThread[1]?.text).toContain('Noted — rain it is.');
    expect(row?.chatThread[3]?.outcomes).toHaveLength(1);
    expect(row?.chatThread[3]?.outcomes[0]?.kind).toBe('failed');

    // Reload: fresh stores, remount — the thread restores as history.
    unmount();
    useCanvasChatStore.setState({ ownerModuleId: null, byModule: {} });
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    const restored = screen.getByTestId('canvas-chat');
    await waitFor(() => {
      expect(within(restored).getAllByTestId('canvas-chat-user-message')).toHaveLength(2);
    });
    expect(restored.textContent).toContain('remember the rain');
    expect(restored.textContent).toContain('Noted — rain it is.');
    const restoredOutcome = within(restored).getByTestId('canvas-chat-outcome');
    expect(restoredOutcome).toHaveAttribute('data-kind', 'failed');
    // A restored failure still offers its Report-to-LLM loop.
    expect(
      within(restoredOutcome).getByTestId('canvas-chat-report-outcome'),
    ).toBeInTheDocument();

    // Restored history never auto-applies: the doc and the row are byte-identical.
    expect(activeCanvasView.current?.state.doc.toString()).toBe(WHOLE_DOC);
    // actDrained (docs/08 §Race cures): the restore's hydration writes the store,
    // and the page's live queries can re-render during this raw read.
    const rowAfter = await actDrained(() => getModule(world.moduleId));
    expect(rowAfter?.parts.find((part) => part.planIndex === 0)?.markdown).toBe(PART_0_TEXT);
    expect(rowAfter?.parts.find((part) => part.planIndex === 1)?.markdown).toBe(PART_1_TEXT);
    await flushAsyncUpdates();
  });

  it('a write failure toasts loudly but NEVER blocks chatting', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);

    mockChatReply('ok');
    await sendChat(user, 'hello');

    // The row vanishes before the debounced write fires (loud NotFoundError).
    await actDrained(() => db.modules.delete(world.moduleId));
    await actDrained(() => flushChatPersist(canvasChatKey(world.moduleId)));
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('Could not save the chat history'),
      expect.anything(),
    );
    // The flush itself never rejects — and the settled turn is intact.
    await expect(flushChatPersist(canvasChatKey(world.moduleId))).resolves.toBeUndefined();
    expect(
      useCanvasChatStore.getState().module(canvasChatKey(world.moduleId)).messages,
    ).toHaveLength(2);
    await flushAsyncUpdates();
  });

  it('campaign export/import carries the thread', async () => {
    const thread: ModuleChatMessage[] = [
      {
        role: 'user',
        text: 'make the gate scene rainier',
        raw: null,
        status: 'ok',
        error: null,
        outcomes: [],
        createdAt: 1,
      },
      {
        role: 'assistant',
        text: 'Making it rainier.',
        raw: 'Making it rainier.\n<edit><search>Rain hammers the stones.</search><replace>Rain drowns every word.</replace></edit>',
        status: 'ok',
        error: null,
        outcomes: [
          {
            kind: 'applied',
            command: { search: 'Rain hammers the stones.', replace: 'Rain drowns every word.', all: false },
            targetParts: [{ planIndex: 0, title: 'The Gate Bargain' }],
            occurrences: 1,
            from: 10,
            to: 20,
            before: 'Rain hammers the stones.',
            reason: null,
            closest: null,
            failureFrom: null,
            reported: false,
          },
        ],
        createdAt: 2,
      },
    ];
    const row = await getModule(world.moduleId);
    if (row === undefined) throw new Error('seeded module missing');
    await saveModule({ ...row, chatThread: thread });

    const exported = await buildCampaignExport(world.campaignId);
    expect(exported.modules).toHaveLength(1);
    expect(exported.modules?.[0]?.chatThread).toEqual(thread);

    await clearDatabase();
    await importExport(JSON.parse(JSON.stringify(exported)));
    // Import re-ids campaigns + modules — read back whatever landed.
    const modules = (await db.modules.toArray()).map((row) => moduleSchema.parse(row));
    expect(modules).toHaveLength(1);
    expect(modules[0]?.chatThread).toEqual(thread);
    await flushAsyncUpdates();
  });

describe('canvas chat front door', () => {
  it('the canvas opens with the chat sidebar OPEN by default; the toggle still overrides per session', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    // No toggle click: the sidebar is already there.
    expect(await screen.findByTestId('canvas-chat')).toBeInTheDocument();
    expect(
      useCanvasChatStore.getState().module(canvasChatKey(world.moduleId)).open,
    ).toBe(true);
    // Collapsible: the toggle closes it and the session state sticks.
    await user.click(screen.getByTestId('canvas-chat-toggle'));
    expect(screen.queryByTestId('canvas-chat')).not.toBeInTheDocument();
    expect(
      useCanvasChatStore.getState().module(canvasChatKey(world.moduleId)).open,
    ).toBe(false);
    await flushAsyncUpdates();
  });

  it('a `?chat=open` arrival forces the sidebar open even after the toggle closed it', async () => {
    const user = userEvent.setup();
    const { unmount } = renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await user.click(await screen.findByTestId('canvas-chat-toggle'));
    expect(screen.queryByTestId('canvas-chat')).not.toBeInTheDocument();
    // Same module, fresh router (the toggle state is session-only and
    // survives the remount — only the param re-opens it).
    unmount();
    renderAppAt(canvasChatPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    expect(await screen.findByTestId('canvas-chat')).toBeInTheDocument();
    await flushAsyncUpdates();
  });

  it('a modules-list row offers NO chat entry — one row icon per destination (owner decision, ledger 91)', async () => {
    renderAppAt(modulesPath(world.campaignId));
    const row = await screen.findByTestId(`module-board-link-${world.moduleId}`, {}, { timeout: 10_000 });
    const listRow = row.closest('li');
    if (listRow === null) throw new Error('module list row missing');

    // The removed front door (ledger 57's second `canvasChatPath` entry) stays
    // removed: re-adding the row button fails this pin.
    expect(
      screen.queryByTestId(`module-chat-link-${world.moduleId}`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: `Chat: The Drowned Vault` }),
    ).not.toBeInTheDocument();

    // …and the row holds the canvas entry exactly ONCE (the row chat entry was
    // literally this destination again, with `?chat=open`).
    expect(within(listRow).getAllByTestId(`module-canvas-link-${world.moduleId}`)).toHaveLength(1);
    expect(
      screen.queryAllByTestId(new RegExp(`^module-canvas-link-`)),
    ).toHaveLength(1);

    // The row's whole control inventory: title → reader, cover (no
    // navigation), board, canvas, delete — FIVE controls, no chat. Querying by
    // REGEX matches the accessible NAME, so a re-added chat control fails here
    // by name even if it were given a different test id.
    const names = (pattern: RegExp): string[] =>
      screen.getAllByRole('button', { name: pattern }).map((control) => control.getAttribute('aria-label') ?? 'title → reader');
    expect(names(/Drowned Vault/)).toEqual([
      'title → reader',
      'Generate cover for The Drowned Vault',
      `Board: The Drowned Vault`,
      `Canvas: The Drowned Vault`,
      'Delete The Drowned Vault',
    ]);
    expect(screen.queryAllByRole('button', { name: /chat/i })).toHaveLength(0);
    await flushAsyncUpdates();
  });

  it('a reader-header Chat entry routes to the canvas with the chat open', async () => {
    const user = userEvent.setup();
    renderAppAt(modulePath(world.campaignId, world.moduleId));
    await user.click(await screen.findByTestId('chat-header-link', {}, { timeout: 10_000 }));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    expect(window.location.pathname).toContain(`/m/${world.moduleId}/canvas`);
    expect(window.location.search).toContain('chat=open');
    expect(await screen.findByTestId('canvas-chat')).toBeInTheDocument();
    await flushAsyncUpdates();
  });

  it('the reader header holds exactly ONE canvas destination — the Chat entry (owner request, ledger 138)', async () => {
    renderAppAt(modulePath(world.campaignId, world.moduleId));
    await screen.findByTestId('chat-header-link', {}, { timeout: 10_000 });

    // The header's nav controls are ANCHORS carrying `role="button"` (the
    // Button primitive renders its `render` prop that way), so both roles are
    // queried and the DESTINATION decides: every control whose `href` points
    // at this module's canvas. A re-added Canvas control fails this count
    // whatever test id or label it is given. The retired plain-canvas entry
    // (`canvasPath`) and the surviving Chat entry (`canvasChatPath`) are the
    // SAME destination — they differ only in the forced-open sidebar, which is
    // why the reader keeps one of them (owner request, verbatim: "looks like
    // the canvas and the chat button do exactly the same. Lets retire the
    // canvas button.").
    const canvasDestination = (control: HTMLElement): boolean =>
      (control.getAttribute('href') ?? '').includes(`/m/${world.moduleId}/canvas`);
    const canvasDestinations = [
      ...screen.getAllByRole('button'),
      ...screen.getAllByRole('link'),
    ].filter(canvasDestination);
    expect(canvasDestinations).toHaveLength(1);
    expect(canvasDestinations[0]).toHaveAttribute(
      'href',
      canvasChatPath(world.campaignId, world.moduleId),
    );
    expect(canvasDestinations[0]).toHaveAccessibleName('Chat');

    // …and the retired control is gone by test id AND by accessible name.
    expect(screen.queryByTestId('canvas-header-link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Canvas' })).not.toBeInTheDocument();
    // The reader nav that remains: Board + Chat + Contents.
    expect(screen.getByRole('button', { name: 'Board' })).toHaveAttribute(
      'href',
      boardPath(world.campaignId, world.moduleId),
    );
    expect(screen.getByRole('button', { name: /table of contents/i })).toBeInTheDocument();
    await flushAsyncUpdates();
  });
});

  it('generation prompt readers never contain the thread field', async () => {
    const marker = 'CHAT-THREAD-MARKER-9f3c';
    const row = await getModule(world.moduleId);
    if (row === undefined) throw new Error('seeded module missing');
    const threaded = {
      ...row,
      chatThread: [
        {
          role: 'user',
          text: marker,
          raw: null,
          status: 'ok',
          error: null,
          outcomes: [],
          createdAt: 1,
        },
      ] as ModuleChatMessage[],
    };
    // The document grounding (entity briefs, refill grounding, covers).
    expect(moduleDocumentText(threaded)).not.toContain(marker);
    // The generation-time prior-modules context (spine + parts passes).
    expect(priorModulesContext([threaded], null)).not.toContain(marker);
    await flushAsyncUpdates();
  });
});
