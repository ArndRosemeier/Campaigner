import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveSettings } from '@/db/settingsRepo';
import { clearDatabase } from '../db/helpers';

import { chat, fetchWithRetries, listModels, listVisionChatModels, modelSupportsReasoning, MissingApiKeyError, type ChatStreamActivity } from '@/llm/openrouter';

/**
 * OpenRouter client (04-LLM-PERSONAS.md): SSE streaming, retries, typed
 * errors — with mocked fetch and fast retry backoffs.
 */

interface SseEvent {
  choices?: { delta?: { content?: string; reasoning?: string } }[];
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

/**
 * A stream that enqueues its events on a real-timer schedule and keeps the
 * connection open between them — the 1s watchdog (and with it the
 * `onActivity` liveness probe) can only be observed while the stream runs.
 * `event: null` closes the stream.
 */
function timedSseResponse(steps: { delayMs: number; event: SseEvent | null }[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const step of steps) {
        setTimeout(() => {
          if (step.event === null) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(step.event)}\n\n`));
        }, step.delayMs);
      }
    },
  });
  return new Response(stream, { status: 200 });
}

const SETTINGS = {
  id: 'settings' as const,
  openRouterApiKey: 'test-key',
  defaultChatModel: 'anthropic/claude-sonnet-4.5',
  defaultReasoningEffort: 'default' as const,
  embeddingModel: 'openai/text-embedding-3-small',
  embeddingsEnabled: false,
  imageModel: 'google/gemini-2.5-flash-image',
  imagesEnabled: false,
  artifactScopes: {
    workspace: { global: false, campaign: true, module: true },
    moduleView: { global: true, campaign: true, module: true },
  },
  encounterMapAspect: '4:3' as const,
  encounterVerifyModel: '',
  retiredSessionNotesRemoved: 0,
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

  it('streams reasoning deltas to onReasoning without mixing them into the answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, _init?: unknown) =>
        Promise.resolve(
          sseResponse([
            { choices: [{ delta: { reasoning: 'let me think: ' } }] },
            { choices: [{ delta: { reasoning: 'the party is level 5' } }] },
            { choices: [{ delta: { content: '{"ok":true}' } }] },
            { choices: [{ delta: {} }] },
          ]),
        ),
      ),
    );

    const reasoningDeltas: string[] = [];
    const contentDeltas: string[] = [];
    const result = await chat([{ role: 'user', content: 'hi' }], {
      model: 'm',
      temperature: 0.7,
      onToken: (delta) => {
        contentDeltas.push(delta);
      },
      onReasoning: (delta) => {
        reasoningDeltas.push(delta);
      },
    }, [1, 1]);

    expect(reasoningDeltas.join('')).toBe('let me think: the party is level 5');
    expect(contentDeltas).toEqual(['{"ok":true}']);
    // The returned answer is the content only — reasoning never leaks into it.
    expect(result).toBe('{"ok":true}');
  });

  it('reports "thinking" activity while only reasoning deltas arrive', async () => {
    // Reasoning deltas never reach onToken; the liveness probe is the only
    // way a caller can tell a thinking model from a dead connection.
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, _init?: unknown) =>
        Promise.resolve(
          timedSseResponse([
            { delayMs: 10, event: { choices: [{ delta: { reasoning: 'pondering the premise' } }] } },
            { delayMs: 1300, event: { choices: [{ delta: { content: '{"premise"' } }] } },
            { delayMs: 1450, event: null },
          ]),
        ),
      ),
    );

    const activities: ChatStreamActivity[] = [];
    const result = await chat([{ role: 'user', content: 'hi' }], {
      model: 'm',
      temperature: 0.7,
      onActivity: (activity) => {
        activities.push(activity);
      },
    }, [1, 1]);

    expect(result).toBe('{"premise"');
    // The 1s watchdog ticked while only reasoning had arrived.
    const thinking = activities.find((activity) => activity.phase === 'thinking');
    expect(thinking).toBeDefined();
    expect(thinking?.receivedChars).toBe(0);
    expect(thinking?.elapsedMs).toBeGreaterThan(0);
  }, 10_000);

  it('reports waiting before the first byte and content phases with char counts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, _init?: unknown) =>
        Promise.resolve(
          timedSseResponse([
            // Silent for >1s: the first watchdog tick must report "waiting".
            { delayMs: 1350, event: { choices: [{ delta: { content: 'abcdef' } }] } },
            // Hold the stream open past the next tick so a "content" sample lands.
            { delayMs: 2350, event: null },
          ]),
        ),
      ),
    );

    const activities: ChatStreamActivity[] = [];
    const result = await chat([{ role: 'user', content: 'hi' }], {
      model: 'm',
      temperature: 0.7,
      onActivity: (activity) => {
        activities.push(activity);
      },
    }, [1, 1]);

    expect(result).toBe('abcdef');
    expect(activities.some((activity) => activity.phase === 'waiting')).toBe(true);
    const content = activities.find((activity) => activity.phase === 'content');
    expect(content?.receivedChars).toBe(6);
  }, 10_000);

  it('serializes multimodal image parts without flattening them', async () => {
    const fetchMock = vi.fn((_url: unknown, _init?: { body?: string }) =>
      Promise.resolve(sseResponse([{ choices: [{ delta: { content: 'ok' } }] }])),
    );
    vi.stubGlobal('fetch', fetchMock);
    await chat(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Compare these maps' },
            { type: 'image_url', image_url: { url: 'data:image/webp;base64,map' } },
          ],
        },
      ],
      { model: 'vision', temperature: 0 },
      [],
    );

    const init = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    const body = JSON.parse(init?.body ?? '{}') as {
      messages?: { role: string; content: unknown }[];
    };
    const user = body.messages?.find((message) => message.role === 'user');
    expect(user?.content).toEqual([
      { type: 'text', text: 'Compare these maps' },
      { type: 'image_url', image_url: { url: 'data:image/webp;base64,map' } },
    ]);
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

describe('listVisionChatModels', () => {
  it('keeps only models that take image input and produce text output', async () => {
    const fetchMock = vi.fn((_url: unknown) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'vision/chat',
                architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
              },
              {
                id: 'text/only',
                architecture: { input_modalities: ['text'], output_modalities: ['text'] },
              },
              {
                id: 'pure/image-gen',
                architecture: { input_modalities: ['image'], output_modalities: ['image'] },
              },
              { id: 'no/architecture' },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const models = await listVisionChatModels();
    expect(models).toEqual(['vision/chat']);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('input_modalities=image');
  });

  it('rejects a malformed /models payload loudly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{"data": "not-an-array"}', { status: 200 }))),
    );
    await expect(listVisionChatModels()).rejects.toThrow();
  });
});

describe('fetchWithRetries headers timeout', () => {
  it('aborts loudly when response headers never arrive', async () => {
    // A fetch that never resolves used to hang the run forever: browsers
    // impose no fetch timeout and the stream-stall watchdog only starts once
    // headers exist ("Generating…" forever — 04-LLM-PERSONAS). Real fetch
    // rejects when its signal aborts; the mock mirrors that contract.
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal.addEventListener('abort', () => {
            const reason: unknown = init.signal.reason;
            reject(reason instanceof Error ? reason : new Error(String(reason)));
          });
        }),
      ),
    );

    await expect(
      fetchWithRetries('https://openrouter.ai/api/v1/chat/completions', { method: 'POST' }, [], 30),
    ).rejects.toThrow(/timed out.*no response headers/iu);
  });

  it('keeps honoring the caller abort signal before headers arrive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal.addEventListener('abort', () => {
            const reason: unknown = init.signal.reason;
            reject(reason instanceof Error ? reason : new Error(String(reason)));
          });
        }),
      ),
    );
    const caller = new AbortController();
    const pending = fetchWithRetries(
      'https://openrouter.ai/api/v1/chat/completions',
      { method: 'POST', signal: caller.signal },
      [],
      10_000,
    );
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('reasoning effort in chat', () => {
  it('sends reasoning.effort when model supports reasoning and effort is specified', async () => {
    const fetchMock = vi.fn((_url: unknown, _init?: { body?: string }) =>
      Promise.resolve(sseResponse([{ choices: [{ delta: { content: 'ok' } }] }])),
    );
    vi.stubGlobal('fetch', fetchMock);

    await chat(
      [{ role: 'user', content: 'hi' }],
      { model: 'openai/o3-mini', temperature: 1, reasoningEffort: 'low' },
      [1, 1],
    );

    const init = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    const body = JSON.parse(init?.body ?? '{}') as { reasoning?: { effort?: string } };
    expect(body.reasoning).toEqual({ effort: 'low' });
  });

  it('omits reasoning parameter when effort is default', async () => {
    const fetchMock = vi.fn((_url: unknown, _init?: { body?: string }) =>
      Promise.resolve(sseResponse([{ choices: [{ delta: { content: 'ok' } }] }])),
    );
    vi.stubGlobal('fetch', fetchMock);

    await chat(
      [{ role: 'user', content: 'hi' }],
      { model: 'openai/o3-mini', temperature: 1, reasoningEffort: 'default' },
      [1, 1],
    );

    const init = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    const body = JSON.parse(init?.body ?? '{}') as { reasoning?: unknown };
    expect(body.reasoning).toBeUndefined();
  });

  it('omits reasoning parameter when model does not support reasoning', async () => {
    const fetchMock = vi.fn((_url: unknown, _init?: { body?: string }) =>
      Promise.resolve(sseResponse([{ choices: [{ delta: { content: 'ok' } }] }])),
    );
    vi.stubGlobal('fetch', fetchMock);

    await chat(
      [{ role: 'user', content: 'hi' }],
      { model: 'openai/gpt-4o', temperature: 1, reasoningEffort: 'high' },
      [1, 1],
    );

    const init = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    const body = JSON.parse(init?.body ?? '{}') as { reasoning?: unknown };
    expect(body.reasoning).toBeUndefined();
  });
});

describe('modelSupportsReasoning', () => {
  it('detects reasoning support from supported_parameters when available', () => {
    const models = [
      { id: 'custom/reasoner', supported_parameters: ['reasoning', 'max_tokens'] },
      { id: 'custom/standard', supported_parameters: ['temperature'] },
    ];
    expect(modelSupportsReasoning('custom/reasoner', models)).toBe(true);
    expect(modelSupportsReasoning('custom/standard', models)).toBe(false);
  });

  it('detects reasoning support from model id naming patterns as fallback', () => {
    expect(modelSupportsReasoning('openai/o3-mini')).toBe(true);
    expect(modelSupportsReasoning('deepseek/deepseek-r1')).toBe(true);
    expect(modelSupportsReasoning('google/gemini-2.5-pro')).toBe(true);
    expect(modelSupportsReasoning('anthropic/claude-3.7-sonnet:thinking')).toBe(true);
    expect(modelSupportsReasoning('openai/gpt-4o')).toBe(false);
    expect(modelSupportsReasoning('meta-llama/llama-3.3-70b-instruct')).toBe(false);
  });
});
