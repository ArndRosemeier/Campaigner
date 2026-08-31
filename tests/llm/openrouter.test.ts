import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveSettings } from '@/db/settingsRepo';
import { clearDatabase } from '../db/helpers';

import { chat, listModels, MissingApiKeyError } from '@/llm/openrouter';

/**
 * OpenRouter client (04-LLM-PERSONAS.md): SSE streaming, retries, typed
 * errors — with mocked fetch and fast retry backoffs.
 */

interface SseEvent {
  choices?: { delta?: { content?: string } }[];
}

function sseResponse(events: SseEvent[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const SETTINGS = {
  id: 'settings' as const,
  openRouterApiKey: 'test-key',
  defaultChatModel: 'anthropic/claude-sonnet-4.5',
  embeddingModel: 'openai/text-embedding-3-small',
  embeddingsEnabled: false,
  imageModel: 'google/gemini-2.5-flash-image',
  imagesEnabled: false,
  language: 'en' as const,
};

beforeEach(async () => {
  await clearDatabase();
  await saveSettings(SETTINGS);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chat', () => {
  it('streams content deltas to onToken and returns the full text', async () => {
    const fetchMock = vi.fn((_url: unknown, _init?: { body?: string }) =>
      Promise.resolve(
        sseResponse([
          { choices: [{ delta: { content: 'Hello ' } }] },
          { choices: [{ delta: { content: 'world' } }] },
          { choices: [{ delta: {} }] },
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await chat(
      [{ role: 'user', content: 'hi' }],
      { model: 'm', temperature: 0.7 },
      [1, 1],
    );

    expect(result).toBe('Hello world');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    const body = JSON.parse(init?.body ?? '{}') as { stream?: boolean; model?: string };
    expect(body.stream).toBe(true);
    expect(body.model).toBe('m');
  });

  it('throws MissingApiKeyError without a key', async () => {
    await saveSettings({ ...SETTINGS, openRouterApiKey: '' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chat([{ role: 'user', content: 'hi' }], { model: 'm', temperature: 1 }, [1, 1]),
    ).rejects.toBeInstanceOf(MissingApiKeyError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws OpenRouterError on 4xx without retrying', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('bad request', { status: 400 })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chat([{ role: 'user', content: 'hi' }], { model: 'm', temperature: 1 }, [1, 1]),
    ).rejects.toMatchObject({ name: 'OpenRouterError', status: 400, bodyText: 'bad request' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries 429 twice with backoff, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(new Response('still slow', { status: 503 }))
      .mockImplementationOnce(() =>
        Promise.resolve(sseResponse([{ choices: [{ delta: { content: 'ok' } }] }])),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await chat(
      [{ role: 'user', content: 'hi' }],
      { model: 'm', temperature: 1 },
      [1, 1],
    );

    expect(result).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up after two retries and throws the last error', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('overloaded', { status: 429 })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chat([{ role: 'user', content: 'hi' }], { model: 'm', temperature: 1 }, [1, 1]),
    ).rejects.toMatchObject({ name: 'OpenRouterError', status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('listModels', () => {
  it('returns model ids from the /models endpoint', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: 'a/b' }, { id: 'c/d' }] }), { status: 200 }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const models = await listModels();
    expect(models.map((model) => model.id)).toEqual(['a/b', 'c/d']);
  });
});
