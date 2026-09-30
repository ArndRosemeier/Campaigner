import 'fake-indexeddb/auto';

import type * as ModuleRepo from '@/db/moduleRepo';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import { createModule, moduleChatMessageSchema, type Module } from '@/domain';
import {
  CHAT_PERSIST_DEBOUNCE_MS,
  flushChatPersist,
  scheduleChatPersist,
} from '@/features/modules/canvas/chatPersist';
import { newChatId, useCanvasChatStore } from '@/features/modules/canvas/chatStore';
import { registerPageFlush } from '@/lib/pageFlush';
import { clearDatabase } from '../db/helpers';

/**
 * THE PAGE-HIDE FLUSH SEAM (docs/17 row 111, `lib/pageFlush`).
 *
 * A debounced write is only durable if something lands it before the page can
 * be taken away, and "unmount" is not that event: a tab that is BACKGROUNDED
 * and then frozen or discarded never unmounts. What this file pins, in the
 * owner's terms:
 *
 * 1. a settled chat turn sitting in the 600 ms debounce LANDS when the page
 *    hides (`pagehide`) or is reported hidden (`visibilitychange` → hidden);
 * 2. a page with NOTHING queued writes nothing — `visibilitychange` fires on
 *    every tab switch, so a flush that wrote unconditionally would be a write
 *    loop, not a durability fix;
 * 3. ONE write per pending turn even when both signals fire (no double write),
 *    and the debounce contract itself is untouched (a pagehide inside the
 *    window lands the write EARLY; the schedule/flush pair is the same one the
 *    unmount path uses).
 *
 * The `patchModule` count is the observation instrument: it is the ONE write
 * seam this writer uses, and the tests delegate to the real implementation, so
 * every count is a real row write rather than a mocked impression.
 */

vi.mock('@/db/moduleRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof ModuleRepo>();
  return { ...actual, patchModule: vi.fn(actual.patchModule) };
});

const { patchModule } = await import('@/db/moduleRepo');
const patchModuleMock = vi.mocked(patchModule);

const CHAT_KEY_SUFFIX = 'canvas-chat';

let module: Module;
let key: string;

function settledTurn(text: string): void {
  useCanvasChatStore.getState().addMessage(key, {
    id: newChatId('msg'),
    role: 'user',
    text,
    raw: null,
    status: 'ok',
    error: null,
    outcomes: [],
    createdAt: Date.now(),
  });
}

/** The hidden state a browser reports before freezing/discarding a tab. */
function hideDocument(): void {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
}

beforeEach(async () => {
  // The queue is deliberately not cancellable (only a flush empties it), so a
  // test that leaves a write queued — the "visible is not a write" case — would
  // otherwise leak its 600 ms timer into the next test's write counts. Landed
  // here, BEFORE the database is cleared, where it can still write.
  await flushChatPersist();
  await clearDatabase();
  vi.restoreAllMocks();
  patchModuleMock.mockClear();
  useCanvasChatStore.getState().resetFor('page-flush-module');
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  module = await saveModule(
    createModule({
      campaignId: campaign.id,
      title: 'Ember Crypt',
      concept: 'A drowned crypt.',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'sketch',
    }),
  );
  key = `${module.id}-${CHAT_KEY_SUFFIX}`;
});

describe('a queued debounced write lands when the page goes away', () => {
  it('flushes the chat thread on pagehide, inside the debounce window', async () => {
    settledTurn('Make the gate a ruin.');
    scheduleChatPersist(module.id, key);

    // Nothing has landed yet — the write is genuinely INSIDE the window.
    expect(patchModuleMock).not.toHaveBeenCalled();
    const before = await getModule(module.id);
    expect(before?.chatThread).toEqual([]);

    const started = Date.now();
    window.dispatchEvent(new Event('pagehide'));

    // The wait is CAPPED BELOW the debounce (`CHAT_PERSIST_DEBOUNCE_MS`), so a
    // timer that fires on its own cannot make this pass: with no flush the row
    // is still empty when the cap expires and the test fails. (Measured the
    // hard way — a 5 s cap here was green with the registration removed.)
    await waitFor(
      async () => {
        const row = await getModule(module.id);
        expect(row?.chatThread).toHaveLength(1);
      },
      { timeout: CHAT_PERSIST_DEBOUNCE_MS - 200, interval: 10 },
    );
    expect(Date.now() - started).toBeLessThan(CHAT_PERSIST_DEBOUNCE_MS);
    const row = await getModule(module.id);
    expect(row?.chatThread[0]?.text).toBe('Make the gate a ruin.');
    expect(patchModuleMock).toHaveBeenCalledTimes(1);
  });

  it('flushes the chat thread when the document goes hidden', async () => {
    settledTurn('Count the visitors.');
    scheduleChatPersist(module.id, key);
    expect(patchModuleMock).not.toHaveBeenCalled();

    hideDocument();
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(
      async () => {
        const row = await getModule(module.id);
        expect(row?.chatThread).toHaveLength(1);
      },
      { timeout: CHAT_PERSIST_DEBOUNCE_MS - 200, interval: 10 },
    );
    expect(patchModuleMock).toHaveBeenCalledTimes(1);
  });

  it('does not flush on visibilitychange → VISIBLE (a tab switch is not a write)', async () => {
    settledTurn('Wait for dusk.');
    scheduleChatPersist(module.id, key);

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));

    const row = await getModule(module.id);
    expect(row?.chatThread).toEqual([]);
    expect(patchModuleMock).not.toHaveBeenCalled();
    // Left deliberately queued — the next test's `beforeEach` lands it (the
    // queue has no cancel; only a flush empties it).
  });

  it('writes ONCE when both signals fire, and nothing when nothing is queued', async () => {
    settledTurn('Bar the doors.');
    scheduleChatPersist(module.id, key);

    hideDocument();
    document.dispatchEvent(new Event('visibilitychange'));
    // Capped below the debounce, exactly as above: the flush must be what
    // landed the write, not the timer.
    await waitFor(
      async () => {
        expect((await getModule(module.id))?.chatThread).toHaveLength(1);
      },
      { timeout: CHAT_PERSIST_DEBOUNCE_MS - 200, interval: 10 },
    );
    // The pending work was taken out of the queue by the first flush, so the
    // second signal — the pagehide a hidden page always produces when it is
    // finally frozen — finds nothing and writes nothing.
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
    expect(patchModuleMock).toHaveBeenCalledTimes(1);

    // …and a page with NOTHING queued: the row is deliberately loaded with a
    // sentinel that differs from the live store, so any write would be visible
    // as a changed row rather than only as a call count.
    const sentinel = [moduleChatMessageSchema.parse({
      role: 'assistant',
      text: 'already saved',
      raw: null,
      status: 'ok',
      error: null,
      outcomes: [],
      createdAt: 1,
    })];
    await patchModule(module.id, { chatThread: sentinel });
    patchModuleMock.mockClear();
    window.dispatchEvent(new Event('pagehide'));
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(patchModuleMock).not.toHaveBeenCalled();
    expect((await getModule(module.id))?.chatThread).toEqual(sentinel);
  });
});

describe('the seam itself', () => {
  it('calls a registered flush on pagehide only while registered', () => {
    const flush = vi.fn();
    const unregister = registerPageFlush(flush);

    window.dispatchEvent(new Event('pagehide'));
    expect(flush).toHaveBeenCalledTimes(1);

    unregister();
    window.dispatchEvent(new Event('pagehide'));
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('keeps the debounce contract: a pending write is not duplicated by a later unmount flush', async () => {
    settledTurn('Light the lamp.');
    scheduleChatPersist(module.id, key);
    expect(CHAT_PERSIST_DEBOUNCE_MS).toBe(600);

    window.dispatchEvent(new Event('pagehide'));
    await waitFor(
      async () => {
        expect((await getModule(module.id))?.chatThread).toHaveLength(1);
      },
      { timeout: CHAT_PERSIST_DEBOUNCE_MS - 200, interval: 10 },
    );
    // The canvas's own unmount flush runs the same function; the queue is
    // already empty, so it writes nothing a second time.
    const { flushChatPersist } = await import('@/features/modules/canvas/chatPersist');
    await flushChatPersist();
    expect(patchModuleMock).toHaveBeenCalledTimes(1);
  });
});
