import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { updateSettings } from '@/db/settingsRepo';
import { notePageResumed, notePageSuspended, resetPageLiveness } from '@/lib/pageLiveness';
import { chat, OpenRouterError } from '@/llm/openrouter';
import { clearDatabase } from '../db/helpers';

/**
 * The stream watchdog must measure LIVENESS, not wall-clock time (docs/17 row
 * 110, docs/18 §2.2/§4).
 *
 * Two independent defects, both measured at HEAD 360a056, both pinned here:
 *
 * 1. The 1 Hz watchdog compared `Date.now()` deltas, so a page that was hidden,
 *    frozen or discarded mid-stream came back with a huge delta and CANCELLED a
 *    healthy stream (`reader.cancel()`), and the completed answer was lost.
 *    The two probes below (`notePageSuspended`/`notePageResumed` are exactly
 *    what the visibility/freeze/pagehide listeners call) credit the gap.
 * 2. The post-loop diagnosis re-derived the failure from the same wall clocks
 *    AFTER a clean socket close (`if (done) break` falls through), so a stream
 *    that closed instead of sending [DONE] had its COMPLETE answer thrown away
 *    as `content-stall`/`max-duration`. The diagnosis now reports only the
 *    limit the watchdog actually ARMED.
 *
 * Both directions are pinned: a gap must not kill a healthy stream, AND a
 * genuinely dead stream must still fail after the resume (the fix is gap
 * crediting, never a looser limit).
 */

/** A stream whose chunks are pushed by the test (the fake timers own time). */
function controllableStream(): {
  response: Response;
  send: (chunk: string) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
    },
  });
  return {
    response: new Response(stream, { status: 200 }),
    send: (chunk) => {
      try {
        controller?.enqueue(encoder.encode(chunk));
      } catch {
        // The reader was cancelled (a watchdog trip): stop feeding it.
      }
    },
    close: () => {
      controller?.close();
    },
  };
}

function contentChunk(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

const DONE_CHUNK = 'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}\n\n';

/** Limits small enough to be pinned in milliseconds, in the REAL order the
 * app uses (byte-level stall below content-stall, both far below the default
 * 2min/3min): a totally silent stream must trip the byte-level stall first. */
const STALL_MS = 2_000;
const CONTENT_MS = 3_000;

function startChat(
  stream: { response: Response },
  tokens: string[] = [],
  maxDurationMs = 600_000,
): Promise<{ text: string; modelUsed: string; fallback: unknown }> {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(stream.response)));
  return chat(
    [{ role: 'user', content: 'hi' }],
    { model: 'm', temperature: 0.5, onToken: (delta) => tokens.push(delta) },
    [0, 0],
    STALL_MS,
    CONTENT_MS,
    maxDurationMs,
  );
}

beforeEach(async () => {
  await clearDatabase();
  await updateSettings({ openRouterApiKey: 'sk-test' });
  resetPageLiveness();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetPageLiveness();
});

describe('the stream watchdog and a suspended page', () => {
  it('does not bill a suspended gap to a healthy stream (gap > content-stall)', async () => {
    vi.useFakeTimers();
    const source = controllableStream();
    const tokens: string[] = [];
    const pending = startChat(source, tokens);

    source.send(contentChunk('Hel'));
    await vi.advanceTimersByTimeAsync(10);

    // The page goes away for a minute — 20x the content-stall limit — and comes
    // back. Chromium throttles (and freezes) a hidden tab's timers exactly here.
    notePageSuspended();
    await vi.advanceTimersByTimeAsync(60_000);
    notePageResumed();
    await vi.advanceTimersByTimeAsync(10);

    // The stream was healthy all along and finishes normally.
    source.send(contentChunk('lo'));
    await vi.advanceTimersByTimeAsync(10);
    source.send(DONE_CHUNK);

    await expect(pending).resolves.toMatchObject({ text: 'Hello' });
    expect(tokens).toEqual(['Hel', 'lo']);
  });

  it('returns the COMPLETE answer when the stream closes cleanly after a long silence', async () => {
    vi.useFakeTimers();
    const source = controllableStream();
    const pending = startChat(source);

    source.send(contentChunk('{"a":'));
    await vi.advanceTimersByTimeAsync(10);

    // A long suspension, then a clean close with no [DONE]: some providers end
    // the body instead of sending the sentinel. Nothing armed a watchdog limit
    // (the gap was credited and the real silence after the resume is 1s), so
    // the accumulated text is the answer — the old diagnosis threw it away.
    notePageSuspended();
    await vi.advanceTimersByTimeAsync(600_000);
    notePageResumed();
    await vi.advanceTimersByTimeAsync(1_000);
    source.close();

    await expect(pending).resolves.toMatchObject({ text: '{"a":' });
  });

  it('does not bill a suspended gap to the max-duration limit either', async () => {
    vi.useFakeTimers();
    const source = controllableStream();
    const pending = startChat(source, [], 10_000);

    source.send(contentChunk('Hi'));
    await vi.advanceTimersByTimeAsync(10);

    notePageSuspended();
    await vi.advanceTimersByTimeAsync(120_000);
    notePageResumed();
    await vi.advanceTimersByTimeAsync(10);

    source.send(DONE_CHUNK);
    await expect(pending).resolves.toMatchObject({ text: 'Hi' });
  });

  it('still fails a stream that really died once the page is watching again', async () => {
    vi.useFakeTimers();
    const source = controllableStream();
    const pending = startChat(source);
    const captured = pending.catch((error: unknown) => error);
    // The stream stops delivering and NEVER resumes; the page was away for a
    // minute and then came back and watched 2.5s of real silence (the stall
    // limit) — the credited gap is not a licence for a dead socket.
    source.send(contentChunk('Hel'));
    await vi.advanceTimersByTimeAsync(10);
    notePageSuspended();
    await vi.advanceTimersByTimeAsync(60_000);
    notePageResumed();
    // 3.5s: the watchdog ticks every second, so this is the tick that sees
    // 3s of real silence against the 2s stall limit.
    await vi.advanceTimersByTimeAsync(3_500);

    const error = await captured;
    expect(error).toBeInstanceOf(OpenRouterError);
    expect(String(error)).toMatch(/stalled after 2s of silence/u);
  });

  it('still fails a keep-alive-only stream (the limit is credited, never loosened)', async () => {
    vi.useFakeTimers();
    const source = controllableStream();
    const pending = startChat(source);
    const captured = pending.catch((error: unknown) => error);
    // Bytes keep the byte-level stall fed; CONTENT silence is what trips.
    const feed = setInterval(() => {
      source.send(': OPENROUTER PROCESSING\n\n');
    }, 500);
    await vi.advanceTimersByTimeAsync(10_000);
    clearInterval(feed);

    const error = await captured;
    expect(error).toBeInstanceOf(OpenRouterError);
    expect(String(error)).toMatch(/delivered no content for 3s/u);
  });
});
