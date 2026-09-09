import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveSettings } from '@/db/settingsRepo';
import { clearDatabase } from '../db/helpers';

import { chat, fetchWithRetries, listModels, modelSupportsReasoning, MissingApiKeyError, type ChatStreamActivity } from '@/llm/openrouter';
import { schemaResponseFormat } from '@/llm/strictSchema';
import { z } from 'zod';

/**
 * OpenRouter client (04-LLM-PERSONAS.md): SSE streaming, retries, typed
 * errors — with mocked fetch and fast retry backoffs.
 */

interface SseEvent {
  choices?: {
    delta?: { content?: string; reasoning?: string; refusal?: string };
    finish_reason?: string;
  }[];
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
  maxParallelRequests: 2,
  openRouterApiKey: 'test-key',
  defaultChatModel: 'anthropic/claude-sonnet-4.5',
  defaultReasoningEffort: 'default' as const,
  embeddingModel: 'openai/text-embedding-3-small',
  embeddingsEnabled: false,
  wikiGroundingEnabled: true,
  strictOutputs: true,
  imageModel: 'google/gemini-2.5-flash-image',
  imagesEnabled: false,
  fallbackChatModel: '',
  fallbackImageModel: '',
  artifactScopes: {
    workspace: { global: false, campaign: true, module: true },
    moduleView: { global: true, campaign: true, module: true },
  },
  encounterMapAspect: '4:3' as const,
  encounterPreset: 'standard' as const,
  dungeonMapPath: 'classic' as const,
  runExtras: { image: false, statBlock: false, mobPortraits: false },
  retiredSessionNotesRemoved: 0,
  language: 'en' as const,
  onboarding: { status: 'fresh' as const, stepState: [] },
  lastModule: null,
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

    expect(result.text).toBe('Hello world');
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
    expect(result.text).toBe('{"ok":true}');
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

    expect(result.text).toBe('{"premise"');
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

    expect(result.text).toBe('abcdef');
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

    expect(result.text).toBe('ok');
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

describe('model fallback chain', () => {
  const FALLBACK_SETTINGS = { ...SETTINGS, fallbackChatModel: 'potent/fallback' };
  const chatCallsOf = (fetchMock: { mock: { calls: unknown[][] } }): unknown[][] =>
    fetchMock.mock.calls.filter(([url]) => String(url).includes('/chat/completions'));

  it('keeps single-model behavior when no fallback is configured', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('rate limited', { status: 429 })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chat([{ role: 'user', content: 'hi' }], { model: 'cheap/primary', temperature: 1 }, [0, 0]),
    ).rejects.toMatchObject({ name: 'OpenRouterError', status: 429 });
    // The original error propagates unwrapped (no "escalation chain" wrapper).
    await expect(
      chat([{ role: 'user', content: 'hi' }], { model: 'cheap/primary', temperature: 1 }, [0, 0]),
    ).rejects.toThrow(/rate limited/);
    expect(chatCallsOf(fetchMock)).toHaveLength(6); // 3 attempts per call × 2 calls
  });

  it('escalates to the fallback model on a persistent 429 and reports it', async () => {
    await saveSettings(FALLBACK_SETTINGS);
    const fallbacks: { from: string; to: string; reason: string }[] = [];
    const resets: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(sseResponse([{ choices: [{ delta: { content: 'Hello' } }] }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await chat([{ role: 'user', content: 'hi' }], {
      model: 'cheap/primary',
      temperature: 1,
      onFallback: (info) => {
        fallbacks.push(info);
      },
      onReset: () => {
        resets.push(1);
      },
    }, [0, 0]);

    expect(result).toEqual({
      text: 'Hello',
      modelUsed: 'potent/fallback',
      fallback: { from: 'cheap/primary', to: 'potent/fallback', reason: 'congestion' },
    });
    expect(fallbacks).toEqual([{ from: 'cheap/primary', to: 'potent/fallback', reason: 'congestion' }]);
    expect(resets).toHaveLength(1);
    const bodies = chatCallsOf(fetchMock).map(
      (call) => JSON.parse((call[1] as { body: string }).body) as { model: string },
    );
    expect(bodies.map((body) => body.model)).toEqual([
      'cheap/primary',
      'cheap/primary',
      'cheap/primary',
      'potent/fallback',
    ]);
  });

  it('reports a filter refusal as the fallback reason', async () => {
    await saveSettings(FALLBACK_SETTINGS);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('input was flagged by moderation', { status: 403 }))
      .mockResolvedValueOnce(sseResponse([{ choices: [{ delta: { content: 'ok' } }] }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await chat([{ role: 'user', content: 'hi' }], { model: 'cheap/primary', temperature: 1 }, [0, 0]);
    expect(result.fallback).toEqual({
      from: 'cheap/primary',
      to: 'potent/fallback',
      reason: 'filter',
    });
  });

  it('throws a combined error naming every attempt when the chain is exhausted', async () => {
    await saveSettings(FALLBACK_SETTINGS);
    const fetchMock = vi
      .fn(() => Promise.resolve(new Response('rate limited', { status: 429 })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chat([{ role: 'user', content: 'hi' }], { model: 'cheap/primary', temperature: 1 }, [0, 0]),
    ).rejects.toThrow(/every chat model in the escalation chain failed.*cheap\/primary.*potent\/fallback/s);
    expect(chatCallsOf(fetchMock)).toHaveLength(6); // 429-retries run per model
  });

  it('escalates on an unknown 400 — the owner\'s Meta content-filter body verbatim', async () => {
    // Owner bug report: Meta's content-management rejection never matched
    // FILTER_PATTERN, so the old gate let it die without trying the
    // fallback. Escalation is now unconditional — the chain is the bound.
    await saveSettings(FALLBACK_SETTINGS);
    const metaBody =
      'The response was filtered due to the prompt triggering our content management policy.';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(metaBody, { status: 400 }))
      .mockResolvedValueOnce(sseResponse([{ choices: [{ delta: { content: 'ok' } }] }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await chat([{ role: 'user', content: 'hi' }], { model: 'cheap/primary', temperature: 1 }, [0, 0]);
    expect(result.modelUsed).toBe('potent/fallback');
    expect(result.fallback).toEqual({
      from: 'cheap/primary',
      to: 'potent/fallback',
      reason: 'other',
    });
    const bodies = chatCallsOf(fetchMock).map(
      (call) => JSON.parse((call[1] as { body: string }).body) as { model: string },
    );
    expect(bodies.map((body) => body.model)).toEqual(['cheap/primary', 'potent/fallback']);
  });

  it('escalates truncation (finish_reason "length") — another model may fit the answer', async () => {
    await saveSettings(FALLBACK_SETTINGS);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([{ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }]),
      )
      .mockResolvedValueOnce(sseResponse([{ choices: [{ delta: { content: 'full answer' } }] }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await chat([{ role: 'user', content: 'hi' }], { model: 'cheap/primary', temperature: 1 }, [0, 0]);
    expect(result.modelUsed).toBe('potent/fallback');
    expect(chatCallsOf(fetchMock)).toHaveLength(2);
  });

  it('skips the fallback for image-input requests when the fallback model is not vision-capable', async () => {
    await saveSettings(FALLBACK_SETTINGS);
    const fetchMock = vi.fn((url: unknown) => {
      if (String(url).includes('/models')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'potent/fallback',
                  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response('moderation blocked', { status: 403 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    await listModels(); // populate the client's model cache

    const visionMessages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'compare' },
          { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,map' } },
        ],
      },
    ];
    await expect(
      chat(visionMessages, { model: 'cheap/primary', temperature: 1 }, [0, 0]),
    ).rejects.toMatchObject({ status: 403 });
    // Only the primary attempt was made — no wasted call to a text-only model.
    expect(chatCallsOf(fetchMock)).toHaveLength(1);
  });

  it('does not fall back after a user abort', async () => {
    await saveSettings(FALLBACK_SETTINGS);
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((_resolve, reject) => {
          reject(new DOMException('Aborted', 'AbortError'));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chat([{ role: 'user', content: 'hi' }], { model: 'cheap/primary', temperature: 1, signal: controller.signal }, [0, 0]),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(chatCallsOf(fetchMock)).toHaveLength(1);
  });
});

describe('strict structured outputs (json_schema response_format)', () => {
  const callsOf = (fetchMock: { mock: { calls: unknown[][] } }): unknown[][] =>
    fetchMock.mock.calls.filter(([url]) => String(url).includes('/chat/completions'));
  const bodyOf = (call: unknown[]): { model?: string; response_format?: Record<string, unknown> } =>
    JSON.parse((call[1] as { body: string }).body) as { model?: string; response_format?: Record<string, unknown> };
  const contract = schemaResponseFormat(
    'test-contract',
    z.object({ name: z.string(), count: z.coerce.number().int() }),
  );
  const okStream = () =>
    Promise.resolve(sseResponse([{ choices: [{ delta: { content: '{}' } }] }]));

  it('sends response_format json_schema with name, strict:true and the converted schema', async () => {
    const fetchMock = vi.fn(okStream);
    vi.stubGlobal('fetch', fetchMock);

    await chat([{ role: 'user', content: 'hi' }], {
      model: 'm',
      temperature: 0,
      responseFormat: contract,
    }, [1, 1]);

    expect(callsOf(fetchMock)).toHaveLength(1);
    const body = bodyOf(callsOf(fetchMock)[0] ?? []);
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'test-contract',
        strict: true,
        schema: contract.jsonSchema,
      },
    });
    // The converted schema is the strict subset: no extra keys, all keys required.
    const schema = (body.response_format?.json_schema as { schema?: JsonSchemaShape }).schema;
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.required).toEqual(['name', 'count']);
    expect(schema?.properties?.count).toMatchObject({ type: 'integer' });
  });

  it('downgrades to json_object ONLY via the explicit strictOutputs=false setting', async () => {
    await saveSettings({ ...SETTINGS, strictOutputs: false });
    const fetchMock = vi.fn(okStream);
    vi.stubGlobal('fetch', fetchMock);

    await chat([{ role: 'user', content: 'hi' }], {
      model: 'm',
      temperature: 0,
      responseFormat: contract,
    }, [1, 1]);

    const body = bodyOf(callsOf(fetchMock)[0] ?? []);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('fails LOUDLY, naming the model, when the provider rejects the schema with 400', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('json_schema not supported', { status: 400 })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chat([{ role: 'user', content: 'hi' }], { model: 'cheap/primary', temperature: 0, responseFormat: contract }, [1, 1]),
    ).rejects.toMatchObject({
      name: 'OpenRouterError',
      kind: 'schema-rejected',
      status: 400,
    });
    await expect(
      chat([{ role: 'user', content: 'hi' }], { model: 'cheap/primary', temperature: 0, responseFormat: contract }, [1, 1]),
    ).rejects.toThrow(/model "cheap\/primary" rejected the strict JSON-schema response format/);
    // No retry, no fallback — one loud failure.
    expect(callsOf(fetchMock)).toHaveLength(2);
  });

  it('escalates a schema rejection to the fallback WITHOUT downgrading the strict format', async () => {
    // Owner decision 2026-09-07: the rejection escalates like any other
    // error (another model may support strict mode) — but every attempt
    // still sends json_schema; there is no automatic downgrade anywhere.
    await saveSettings({ ...SETTINGS, fallbackChatModel: 'potent/fallback' });
    const fetchMock = vi.fn(() => Promise.resolve(new Response('json_schema not supported', { status: 400 })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chat([{ role: 'user', content: 'hi' }], { model: 'cheap/primary', temperature: 0, responseFormat: contract }, [1, 1]),
    ).rejects.toMatchObject({ kind: 'schema-rejected' });
    const attempts = callsOf(fetchMock);
    expect(attempts).toHaveLength(2);
    const bodies = attempts.map(
      (call) => JSON.parse((call[1] as { body: string }).body) as { model?: string; response_format?: Record<string, unknown> },
    );
    expect(bodies.map((body) => body.model)).toEqual(['cheap/primary', 'potent/fallback']);
    for (const body of bodies) {
      // The strict format rides EVERY attempt — escalation is not a downgrade.
      expect(body.response_format).toMatchObject({ type: 'json_schema' });
    }
  });

  it('treats a strict-mode refusal (delta.refusal) as a loud refusal error', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        sseResponse([
          { choices: [{ delta: { refusal: 'I cannot help with that request' } }] },
          { choices: [{ delta: { content: 'sorry' } }] },
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chat([{ role: 'user', content: 'hi' }], { model: 'm', temperature: 0, responseFormat: contract }, [1, 1]),
    ).rejects.toMatchObject({ name: 'OpenRouterError', kind: 'refusal' });
    await expect(
      chat([{ role: 'user', content: 'hi' }], { model: 'm', temperature: 0, responseFormat: contract }, [1, 1]),
    ).rejects.toThrow(/the model refused the task: I cannot help with that request/);
    expect(callsOf(fetchMock)).toHaveLength(2);
  });

  it('routes a refusal to the fallback model when one is configured (censorship class)', async () => {
    await saveSettings({ ...SETTINGS, fallbackChatModel: 'potent/fallback' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([{ choices: [{ delta: { refusal: 'I cannot help with that' } }] }]),
      )
      .mockResolvedValueOnce(sseResponse([{ choices: [{ delta: { content: '{"ok":true}' } }] }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await chat([{ role: 'user', content: 'hi' }], {
      model: 'cheap/primary',
      temperature: 0,
      responseFormat: contract,
    }, [1, 1]);

    expect(result.text).toBe('{"ok":true}');
    expect(result.fallback).toEqual({ from: 'cheap/primary', to: 'potent/fallback', reason: 'filter' });
    expect(bodyOf(callsOf(fetchMock)[1] ?? []).model).toBe('potent/fallback');
  });

  it('fails loudly on a refusal when no fallback is configured', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(sseResponse([{ choices: [{ delta: { refusal: 'nope' } }] }])),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chat([{ role: 'user', content: 'hi' }], { model: 'm', temperature: 0 }, [1, 1]),
    ).rejects.toMatchObject({ kind: 'refusal' });
    expect(callsOf(fetchMock)).toHaveLength(1);
  });
});

interface JsonSchemaShape {
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, { type?: string | string[] }>;
}
