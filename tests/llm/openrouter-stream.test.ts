import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chat, OpenRouterError } from '@/llm/openrouter';
import { updateSettings } from '@/db/settingsRepo';
import { clearDatabase } from '../db/helpers';

/**
 * OpenRouter stream hardening: a stalled SSE connection and in-stream error
 * events must fail fast (previously runs hung in "streaming" forever).
 */

function sseResponse(chunks: string[], close = false): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
      // NOTE: when not closed, the stream stalls forever (provider hang).
    },
  });
  return new Response(stream, { status: 200 });
}

function fetchStub(response: Response): typeof fetch {
  return vi.fn(async () => response);
}

beforeEach(async () => {
  await clearDatabase();
  await updateSettings({ openRouterApiKey: 'sk-test' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('chat stream hardening', () => {
  it('completes normally when the stream delivers tokens and ends', async () => {
    vi.stubGlobal(
      'fetch',
      fetchStub(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    );
    const tokens: string[] = [];
    const result = await chat(
      [{ role: 'user', content: 'hi' }],
      { model: 'm', temperature: 0.5, onToken: (delta) => tokens.push(delta) },
      [0, 0],
      5000,
    );
    expect(result).toBe('Hello');
    expect(tokens).toEqual(['Hel', 'lo']);
  });

  it('throws when the stream stalls beyond the stall timeout', async () => {
    vi.stubGlobal('fetch', fetchStub(sseResponse([': keep-alive\n\n'])));
    await expect(
      chat([{ role: 'user', content: 'hi' }], { model: 'm', temperature: 0.5 }, [0, 0], 80),
    ).rejects.toThrow(OpenRouterError);
  });

  it('surfaces in-stream error events instead of hanging on them', async () => {
    vi.stubGlobal(
      'fetch',
      fetchStub(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
          'data: {"error":{"message":"provider exploded"}}\n\n',
        ]),
      ),
    );
    await expect(
      chat([{ role: 'user', content: 'hi' }], { model: 'm', temperature: 0.5 }, [0, 0], 5000),
    ).rejects.toThrow(/provider exploded/);
  });

  it('treats stream end without [DONE] as completion of what arrived', async () => {
    // Provider closed the connection without [DONE]: the partial text is kept
    // (the caller's JSON parsing decides whether it is usable).
    vi.stubGlobal(
      'fetch',
      fetchStub(sseResponse(['data: {"choices":[{"delta":{"content":"{}"}}]}\n\n'], true)),
    );
    const result = await chat(
      [{ role: 'user', content: 'hi' }],
      { model: 'm', temperature: 0.5 },
      [0, 0],
      5000,
    );
    expect(result).toBe('{}');
  });
});
