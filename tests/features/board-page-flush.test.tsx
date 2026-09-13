import 'fake-indexeddb/auto';

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type * as ModuleRepo from '@/db/moduleRepo';
import type * as Sonner from 'sonner';

import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { boardPath } from '@/app/routes';
import { createCampaign } from '@/db/campaignRepo';
import { saveModule } from '@/db/moduleRepo';
import {
  canvasPartNodeKey,
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Id,
  type Module,
} from '@/domain';
import { useBoardStore } from '@/features/modules/board/boardStore';
import { BOARD_PERSIST_DEBOUNCE_MS } from '@/features/modules/board/BoardPage';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * THE BOARD'S PAGE-HIDE FLUSH (docs/17 row 111 + row 118, `lib/pageFlush`).
 *
 * The board writes its layout through a 600 ms debounce. That debounce already
 * flushed on UNMOUNT — which covers a route change and nothing else: closing,
 * discarding or freezing a tab never unmounts React, so a drag still inside
 * the window was gone with the tab and the row kept its old positions with no
 * surface saying so. The board is now the seam's third registration, and what
 * this file pins, in the owner's terms:
 *
 * 1. a drag whose write is still inside the debounce window LANDS when the
 *    page goes away — on `pagehide`, and separately on the hidden
 *    `visibilitychange` the seam listens for;
 * 2. a board with NOTHING pending writes nothing on either signal (the seam's
 *    pending gate: `visibilitychange` fires on every tab switch, so an
 *    ungated flush would turn a display event into a write loop);
 * 3. ONE write when both signals fire (the pending timer leaves the queue
 *    before the write, so a frozen tab cannot double-write);
 * 4. the IN-APP unmount flush still works (the regression: a drag followed by
 *    an immediate navigation must not be dropped by this change);
 * 5. a failing write still reaches the owner ('Could not save the board
 *    layout');
 * 6. the seam still owns ONE `pagehide` listener and ONE `visibilitychange`
 *    listener — a second mechanism for the same idea is the defect this slice
 *    exists to prevent (AGENTS rule 4).
 *
 * Every count is a REAL `patchModule` call (the write seam the board uses)
 * through the real implementation, not a mocked impression; the write is
 * observed on the module row.
 *
 * WHY the assertions on the event itself are SYNCHRONOUS: the flush issues the
 * write while the event handler runs, so `patchModule` has been called by the
 * time `dispatchEvent` returns — asserting there proves the flush landed the
 * write, where a wait would only prove that *something* did. The subsequent
 * `waitFor`s observe the ROW (the write is fire-and-forget through Dexie, the
 * same guarantee the seam's other registrations have) and are capped below
 * `BOARD_PERSIST_DEBOUNCE_MS`, which is exported from the board rather than
 * copied here: a duplicated constant would silently stop saying that.
 */

// Only the toast METHODS are mocked — the rest of the module (the `Toaster`
// component the app shell mounts) must stay real, or the render fails in the
// shell rather than in the board. The board's failure path goes through
// `lib/toast` → `toast.error`, which is what this counts.
vi.mock('sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof Sonner>();
  return {
    ...actual,
    toast: Object.assign(vi.fn(), {
      error: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
      loading: vi.fn(),
    }),
  };
});

vi.mock('@/db/moduleRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof ModuleRepo>();
  return { ...actual, patchModule: vi.fn(actual.patchModule) };
});

const { toast } = await import('sonner');
const { getModule, patchModule } = await import('@/db/moduleRepo');
const patchModuleMock = vi.mocked(patchModule);
// The REAL writer behind the counter: every count below is a real row write.
const realPatchModule = patchModuleMock.getMockImplementation();
const toastErrorMock = vi.mocked(toast.error);

const MODULE_TITLE = 'The Drowned Vault';
const PART_0_KEY = canvasPartNodeKey(0);
const DEBOUNCE_MS = BOARD_PERSIST_DEBOUNCE_MS;

/** What a `patchModule` call wrote to the layout, once the row has it. */
async function persistedCanvas(moduleId: Id) {
  const row = await getModule(moduleId);
  return row?.canvas ?? null;
}

async function persistedPart0(moduleId: Id): Promise<{ x: number; y: number }> {
  const canvas = await persistedCanvas(moduleId);
  const node = canvas?.nodes.find((entry) => entry.key === PART_0_KEY);
  if (node === undefined) throw new Error('part-0 position not persisted yet');
  return { x: node.x, y: node.y };
}

/** The wait every "the write landed" assertion uses: capped below the debounce. */
const WRITE_LANDED = { timeout: DEBOUNCE_MS - 200, interval: 10 };

interface World {
  campaignId: Id;
  moduleId: Id;
}

async function seedBoard(): Promise<World> {
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: MODULE_TITLE,
    concept: 'A drowned vault.',
    levelMin: 1,
    levelMax: 3,
    sizeDial: 'standard',
  });
  const spine = moduleSpineSchema.parse({
    premise: 'The party is hired to recover a drowned relic.',
    themes: [],
    partPlan: [
      { title: 'Part 1 plan', levelBand: '1', synopsis: 'synopsis 1', levelUpTrigger: 'trigger 1' },
      { title: 'Part 2 plan', levelBand: '2', synopsis: 'synopsis 2', levelUpTrigger: 'trigger 2' },
    ],
  });
  const parts = [0, 1].map((planIndex) =>
    modulePartSchema.parse({
      planIndex,
      markdown: `Part ${String(planIndex + 1)} text.`,
      status: 'ready',
      errorMessage: '',
      edited: false,
    }),
  );
  const row: Module = { ...draft, spine, parts };
  const saved = await saveModule(row);
  return { campaignId: campaign.id, moduleId: saved.id };
}

function renderBoardAt(path: string): ReturnType<typeof render> {
  window.history.replaceState(null, '', path);
  return render(<RouterProvider router={createAppRouter()} />);
}

async function mountBoard(world: World): Promise<ReturnType<typeof render>> {
  const view = renderBoardAt(boardPath(world.campaignId, world.moduleId));
  await screen.findByTestId('board-premise-card', {}, { timeout: 10_000 });
  return view;
}

/** The hidden state a browser reports before freezing/discarding a tab. */
function hideDocument(): void {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
}

function showDocument(): void {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
}

/** Mounts the board and drags part-0, leaving the write inside the debounce. */
async function mountBoardAndDrag(world: World): Promise<ReturnType<typeof render>> {
  const view = await mountBoard(world);
  await dragPart0();
  // Genuinely INSIDE the window: nothing has been issued yet.
  expect(patchModuleMock).not.toHaveBeenCalled();
  return view;
}

/**
 * jsdom plumbing the board suite already needs (module-board.test.tsx): React
 * Flow measures nodes with ResizeObserver and reads a viewport transform with
 * DOMMatrixReadOnly, neither of which jsdom has, and it renders node cards
 * with non-zero dimensions only if we provide them.
 */
class FiringResizeObserver {
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element): void {
    const rect = {
      width: 420,
      height: 200,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 420,
      bottom: 200,
      toJSON: () => ({}),
    } as DOMRectReadOnly;
    setTimeout(() => {
      this.callback([{ target, contentRect: rect } as ResizeObserverEntry], this);
    }, 0);
  }
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  unobserve(): void {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  disconnect(): void {}
}

beforeEach(() => {
  class DOMMatrixReadOnlyStub {
    m22 = 1;
    constructor(_transform?: string) {
      void _transform;
    }
  }
  const stubbed = DOMMatrixReadOnlyStub as unknown as typeof DOMMatrixReadOnly;
  globalThis.DOMMatrixReadOnly = stubbed;
  window.DOMMatrixReadOnly = stubbed;
});

beforeEach(() => {
  if (typeof SVGElement !== 'undefined' && !('getBBox' in SVGElement.prototype)) {
    Object.defineProperty(SVGElement.prototype, 'getBBox', {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 10, height: 10 }),
    });
  }
  for (const property of ['offsetWidth', 'clientWidth'] as const) {
    Object.defineProperty(HTMLElement.prototype, property, { configurable: true, get: () => 420 });
  }
  for (const property of ['offsetHeight', 'clientHeight'] as const) {
    Object.defineProperty(HTMLElement.prototype, property, { configurable: true, get: () => 200 });
  }
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    width: 420,
    height: 200,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 420,
    bottom: 200,
    toJSON: () => ({}),
  }));
});

beforeEach(async () => {
  await clearDatabase();
  useBoardStore.getState().resetFor('reset');
  globalThis.ResizeObserver = FiringResizeObserver;
  // The counters are PER-TEST observations of the real writer, so both reset
  // here. `mockReset` drops the implementation the factory installed with the
  // counts, which is why the real `patchModule` is put STRAIGHT back: a reset
  // mock that never reaches the real writer would make every "writes nothing"
  // pin pass for the wrong reason (a counter that cannot count the thing it is
  // supposed to count). Measured in docs/18 §4.
  patchModuleMock.mockReset();
  if (realPatchModule !== undefined) patchModuleMock.mockImplementation(realPatchModule);
  toastErrorMock.mockClear();
});

// The suite has no `restoreMocks` config, so spies installed by a pin (the
// visibility state, the bounding rect) are restored HERE: a leaked
// `visibilityState = 'hidden'` would make a later "nothing is written" pin
// pass on a document a previous test hid.
afterEach(() => {
  vi.restoreAllMocks();
});

describe('a pending board layout write lands when the page goes away', () => {
  it('lands on pagehide, inside the debounce window', async () => {
    const world = await seedBoard();
    await mountBoardAndDrag(world);

    const started = Date.now();
    window.dispatchEvent(new Event('pagehide'));
    // Synchronous: the flush issues the write INSIDE the pagehide handler.
    expect(patchModuleMock).toHaveBeenCalledTimes(1);

    await waitFor(async () => {
      expect(await persistedCanvas(world.moduleId)).not.toBeNull();
    }, WRITE_LANDED);
    expect(Date.now() - started).toBeLessThan(DEBOUNCE_MS);
    expect(patchModuleMock).toHaveBeenCalledTimes(1);
    const position = await persistedPart0(world.moduleId);
    expect(position.x).toBeGreaterThan(500);
    expect(position.y).toBeGreaterThan(500);
  });

  it('lands on visibilitychange → hidden', async () => {
    const world = await seedBoard();
    await mountBoardAndDrag(world);

    hideDocument();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(patchModuleMock).toHaveBeenCalledTimes(1);

    await waitFor(async () => {
      expect(await persistedCanvas(world.moduleId)).not.toBeNull();
    }, WRITE_LANDED);
    expect(patchModuleMock).toHaveBeenCalledTimes(1);
    const position = await persistedPart0(world.moduleId);
    expect(position.x).toBeGreaterThan(500);
    expect(position.y).toBeGreaterThan(500);
  });

  it('does not flush on visibilitychange → VISIBLE (a tab switch is not a write)', async () => {
    const world = await seedBoard();
    await mountBoardAndDrag(world);

    showDocument();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(patchModuleMock).not.toHaveBeenCalled();
    expect(await persistedCanvas(world.moduleId)).toBeNull();

    // …and the write the drag owes is still pending afterwards: landing it on
    // pagehide proves the visible event did not consume the queue.
    window.dispatchEvent(new Event('pagehide'));
    expect(patchModuleMock).toHaveBeenCalledTimes(1);
    await waitFor(async () => {
      expect(await persistedCanvas(world.moduleId)).not.toBeNull();
    }, WRITE_LANDED);
  });

  it('writes nothing on either signal when no layout write is pending', async () => {
    const world = await seedBoard();
    await mountBoard(world);
    expect(patchModuleMock).not.toHaveBeenCalled();

    // A tab switch is not a write. The row's `canvas` stays null, so a write
    // would be visible as a row change and not only as a call count.
    hideDocument();
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    await flushAsyncUpdates();

    expect(patchModuleMock).not.toHaveBeenCalled();
    expect(await persistedCanvas(world.moduleId)).toBeNull();
  });

  it('writes ONCE when both signals fire for one drag', async () => {
    const world = await seedBoard();
    await mountBoardAndDrag(world);

    hideDocument();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(patchModuleMock).toHaveBeenCalledTimes(1);

    // The pending timer left the queue with the first flush, so the pagehide a
    // hidden page produces when it is finally frozen finds nothing to write.
    window.dispatchEvent(new Event('pagehide'));
    await flushAsyncUpdates();
    expect(patchModuleMock).toHaveBeenCalledTimes(1);

    await waitFor(async () => {
      expect(await persistedCanvas(world.moduleId)).not.toBeNull();
    }, WRITE_LANDED);
    expect(patchModuleMock).toHaveBeenCalledTimes(1);
  });

  it('still flushes the pending write on unmount (the in-app route change)', async () => {
    const world = await seedBoard();
    const view = await mountBoardAndDrag(world);

    // No page event at all: this is the trigger that already worked, and this
    // change must not have moved it.
    act(() => {
      view.unmount();
    });
    expect(patchModuleMock).toHaveBeenCalledTimes(1);
    await waitFor(async () => {
      expect(await persistedCanvas(world.moduleId)).not.toBeNull();
    }, WRITE_LANDED);
    const position = await persistedPart0(world.moduleId);
    expect(position.x).toBeGreaterThan(500);
    expect(position.y).toBeGreaterThan(500);
  });

  it('reports a failing write on the page-hide flush too', async () => {
    const world = await seedBoard();
    await mountBoardAndDrag(world);
    patchModuleMock.mockRejectedValueOnce(new Error('IndexedDB is gone'));

    window.dispatchEvent(new Event('pagehide'));
    expect(patchModuleMock).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Could not save the board layout',
        expect.objectContaining({ description: 'IndexedDB is gone' }),
      );
    });
  });
});

describe('the seam keeps ONE registration list at this third writer', () => {
  it('only pageFlush.ts registers pagehide/visibilitychange handlers for the app', async () => {
    async function sourceFiles(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
        else if (/\.tsx?$/.test(entry.name)) files.push(full);
      }
      return files;
    }

    const listeners: string[] = [];
    for (const file of await sourceFiles('src')) {
      const source = await readFile(file, 'utf8');
      const listenersFor = (event: string): number =>
        (source.match(new RegExp(`addEventListener\\(\\s*'${event}'`, 'g')) ?? []).length;
      if (listenersFor('pagehide') + listenersFor('visibilitychange') > 0) listeners.push(file);
    }
    // The ONE seam is `src/lib/pageFlush.ts`; `src/lib/pageLiveness.ts` is the
    // suspend/resume CLOCK (an unrelated seam that credits suspended time to
    // the streaming watchdogs, nothing to do with flushing). A third file here
    // means a writer grew its own page-hide listener — the second mechanism
    // this slice exists to prevent (AGENTS rule 4).
    expect(listeners.sort()).toEqual(['src/lib/pageFlush.ts', 'src/lib/pageLiveness.ts']);

    // …and the board is on the seam rather than beside it: it names no page
    // event at all, so its flush can only be reached through the one list.
    const board = await readFile('src/features/modules/board/BoardPage.tsx', 'utf8');
    expect(board).toContain('registerPageFlush');
    expect(board).not.toMatch(/addEventListener\(\s*'pagehide'/);
    expect(board).not.toMatch(/addEventListener\(\s*'visibilitychange'/);
  });

  it('is counted by BEHAVIOUR, not by listener count: one registration, one write per signal', async () => {
    // WHY this test asserts behaviour instead of counting `addEventListener`
    // calls: MEASURED, and it is brittle in jsdom. `vi.spyOn(document,
    // 'addEventListener')` does NOT intercept the seam's own call — the
    // instrumented seam logged `isMock=undefined` while the spy recorded the
    // document's other listeners (React Flow's keydown/selectionchange) — so a
    // count-based pin would assert against an instrument that cannot see the
    // call it is supposed to count. (The window spy DOES see `pagehide`, which
    // is what made the mismatch look like a second mechanism.) The seam's
    // registration model is therefore pinned where it is observable: N writers
    // registered, ONE dispatch, ONE write per writer, and a writer with
    // nothing pending writes nothing.
    const world = await seedBoard();
    await mountBoard(world);

    // Writer 1 (the board): a drag inside the debounce window.
    await dragPart0();
    expect(patchModuleMock).not.toHaveBeenCalled();

    // Writer 2 (the chat thread): the SAME list, a real queued write through
    // the same module-scope registration the app uses.
    const { flushChatPersist, scheduleChatPersist } = await import(
      '@/features/modules/canvas/chatPersist'
    );
    const { newChatId, useCanvasChatStore } = await import(
      '@/features/modules/canvas/chatStore'
    );
    const chatKey = `${world.moduleId}-canvas-chat`;
    useCanvasChatStore.getState().addMessage(chatKey, {
      id: newChatId('msg'),
      role: 'user',
      text: 'Count the visitors.',
      raw: null,
      status: 'ok',
      error: null,
      outcomes: [],
      createdAt: Date.now(),
    });
    scheduleChatPersist(world.moduleId, chatKey);
    expect(patchModuleMock).not.toHaveBeenCalled();

    // ONE pagehide reaches BOTH writers through the one list — which is the
    // property a second listener would hide, not break.
    window.dispatchEvent(new Event('pagehide'));
    expect(patchModuleMock).toHaveBeenCalledTimes(2);

    // …and the second dispatch writes nothing: neither writer has anything
    // queued any more (Dexie's promise is in flight; this is the idempotence
    // half of the contract, not a race with the debounce — the pending work
    // left each queue inside the handler).
    window.dispatchEvent(new Event('pagehide'));
    await flushAsyncUpdates();
    expect(patchModuleMock).toHaveBeenCalledTimes(2);

    // Leave the chat queue empty: its timer is deliberate in production (it
    // lands the write 600 ms later) and would otherwise leak into the next
    // test's write counts.
    await flushChatPersist();
  });
});

// --- jsdom gesture plumbing (same technique as module-board.test.tsx) ---------
//
// d3-drag attaches its move/up listeners to `event.view` and immediately calls
// `nodrag(event.view)`, which reads `view.document.documentElement`. jsdom's
// Window fails its OWN brand check when passed through a MouseEvent
// constructor, so a synthetic view object is the only way to drive the gesture.

interface FakeView {
  document: { documentElement: { style: Record<string, string> } };
  addEventListener: (type: string, listener: EventListener) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
  dispatch: (type: string, event: Event) => void;
}

function makeFakeView(): FakeView {
  const listeners = new Map<string, EventListener[]>();
  const view: FakeView = {
    document: { documentElement: { style: {} } },
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener: (type, listener) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== listener),
      );
    },
    dispatch: (type, event) => {
      for (const listener of listeners.get(type) ?? []) listener.call(view, event);
    },
  };
  return view;
}

function dragNode(
  nodeElement: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
): void {
  const fake = makeFakeView();
  const down = createEvent.mouseDown(nodeElement, { button: 0, clientX: from.x, clientY: from.y });
  Object.defineProperty(down, 'view', { value: fake, configurable: true });
  fireEvent(nodeElement, down);
  const move = (x: number, y: number): MouseEvent => {
    const event = new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true });
    Object.defineProperty(event, 'view', { value: fake, configurable: true });
    return event;
  };
  fake.dispatch(
    'mousemove',
    move(Math.round((from.x + to.x) / 2), Math.round((from.y + to.y) / 2)),
  );
  fake.dispatch('mousemove', move(to.x, to.y));
  const up = new MouseEvent('mouseup', { clientX: to.x, clientY: to.y, bubbles: true });
  Object.defineProperty(up, 'view', { value: fake, configurable: true });
  fake.dispatch('mouseup', up);
}

/** Drags part-0 by (+80, +40) — the gesture the layout debounce is for. */
async function dragPart0(): Promise<void> {
  const nodeElement = document.querySelector('.react-flow__node[data-id="part-0"]');
  if (nodeElement === null) throw new Error('part-0 node element not found');
  act(() => {
    dragNode(nodeElement, { x: 100, y: 100 }, { x: 180, y: 140 });
  });
  await flushAsyncUpdates();
}
