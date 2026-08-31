import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chat, OpenRouterError } from '@/llm/openrouter';
import { updateSettings } from '@/db/settingsRepo';
import { clearDatabase } from '../db/helpers';

function sseResponse(chunks: string[], close = false): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function fetchStub(response: Response): typeof fetch {
  return vi.fn(() => Promise.resolve(response));
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
        sseResponse(
          [
            'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
            'data: [DONE]\n\n',
          ],
          true,
        ),
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
});

describe('more stream cases', () => {
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
        sseResponse(
          [
            'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
            'data: {"error":{"message":"provider exploded"}}\n\n',
          ],
          true,
        ),
      ),
    );
    await expect(
      chat([{ role: 'user', content: 'hi' }], { model: 'm', temperature: 0.5 }, [0, 0], 5000),
    ).rejects.toThrow(/provider exploded/);
  });
});

describe('documented OpenRouter behaviors', () => {
  it('treats stream end without DONE as completion of what arrived', async () => {
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

  it('finishes on finish_reason even when DONE never arrives', async () => {
    vi.stubGlobal(
      'fetch',
      fetchStub(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"{\\"ac\\": 14"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":", \\"hp\\": 22}"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          ': OPENROUTER PROCESSING\n\n',
        ]),
      ),
    );
    const result = await chat(
      [{ role: 'user', content: 'hi' }],
      { model: 'm', temperature: 0.5 },
      [0, 0],
      300,
    );
    expect(result).toBe('{"ac": 14, "hp": 22}');
  });
});

describe('documented error and framing shapes', () => {
  it('handles the documented mid-stream error event', async () => {
    vi.stubGlobal(
      'fetch',
      fetchStub(
        sseResponse(
          [
            'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
            'data: {"id":"cmpl-1","error":{"code":"server_error","message":"Provider disconnected unexpectedly"},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}\n\n',
          ],
          true,
        ),
      ),
    );
    await expect(
      chat([{ role: 'user', content: 'hi' }], { model: 'm', temperature: 0.5 }, [0, 0], 5000),
    ).rejects.toThrow(/Provider disconnected unexpectedly/);
  });

  it('treats finish_reason error as failure even without an error field', async () => {
    vi.stubGlobal(
      'fetch',
      fetchStub(
        sseResponse(['data: {"choices":[{"delta":{},"finish_reason":"error"}]}\n\n'], true),
      ),
    );
    await expect(
      chat([{ role: 'user', content: 'hi' }], { model: 'm', temperature: 0.5 }, [0, 0], 5000),
    ).rejects.toThrow(/finish_reason "error"/);
  });
});

describe('framing', () => {
  it('parses CRLF streams and data lines split across chunks', async () => {
    vi.stubGlobal(
      'fetch',
      fetchStub(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"He"}}]}\r\n\r\n',
          'data: {"choices"',
          ':[{"delta":{"content":"llo"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    );
    const result = await chat(
      [{ role: 'user', content: 'hi' }],
      { model: 'm', temperature: 0.5 },
      [0, 0],
      5000,
    );
    expect(result).toBe('Hello');
  });

  it('ignores empty deltas and the accounting usage chunk', async () => {
    // Per the streaming docs, OpenRouter ends every chat stream with a usage
    // chunk whose content-free delta repeats the terminal finish_reason, just
    // before [DONE]. The stream must complete on the first finish_reason with
    // only the real content deltas forwarded to onToken.
    vi.stubGlobal(
      'fetch',
      fetchStub(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{"content":"","role":"assistant"},"finish_reason":"stop","native_finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n',
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
    expect(result).toBe('Hi!');
    expect(tokens).toEqual(['Hi', '!']);
  });
});
