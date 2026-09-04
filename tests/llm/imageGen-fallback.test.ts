import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateImages } from '@/llm/imageGen';
import { setCachedModels } from '@/llm/modelCache';
import { defaultSettings } from '@/domain';

/**
 * Image escalation chain (model fallback feature): the /images client
 * escalates across `[primary, settings.fallbackImageModel]` on congestion-
 * or filter-classified transport failures (a 200 response with no images is
 * classified congestion). Output-contract-free path — no repair tier here.
 */

let currentSettings = {
  ...defaultSettings(),
  openRouterApiKey: 'test-key',
  imageModel: 'cheap/image',
  fallbackImageModel: '',
};

vi.mock('@/db/settingsRepo', () => ({
  getSettings: vi.fn(() => Promise.resolve(currentSettings)),
}));

/** One webp image as the API would return it. */
function imageResponse(): Response {
  const b64 = btoa('fake-webp-bytes');
  return new Response(
    JSON.stringify({ data: [{ b64_json: b64, media_type: 'image/webp' }], usage: { cost: 0.01 } }),
    { status: 200 },
  );
}

function emptyResponse(): Response {
  return new Response(JSON.stringify({ data: [], usage: { cost: 0 } }), { status: 200 });
}

interface CapturedCall {
  url: string;
  body: { model: string; prompt: string; n: number };
}

function captureFetch(responses: Response[]): CapturedCall[] {
  const calls: CapturedCall[] = [];
  let index = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : '';
      const call = { url: String(url), body: JSON.parse(raw) as CapturedCall['body'] };
      calls.push(call);
      const response = responses[index];
      index += 1;
      if (response === undefined) throw new Error(`unexpected fetch #${String(index)}`);
      return Promise.resolve(response);
    }),
  );
  return calls;
}

const FAST_RETRIES = { retryBackoffs: [0, 0] as readonly number[] };

afterEach(() => {
  currentSettings = { ...currentSettings, fallbackImageModel: '' };
  setCachedModels([]);
  vi.unstubAllGlobals();
});

describe('image model fallback chain', () => {
  it('escalates to the fallback image model on a persistent 429', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: 'potent/image' };
    const calls = captureFetch([
      new Response('rate limited', { status: 429 }),
      new Response('rate limited', { status: 429 }),
      new Response('rate limited', { status: 429 }),
      imageResponse(),
    ]);

    const result = await generateImages('a tavern at dusk', 1, {
      model: 'cheap/image',
      ...FAST_RETRIES,
    });

    expect(result.images).toHaveLength(1);
    expect(result.modelUsed).toBe('potent/image');
    expect(calls.map((call) => call.body.model)).toEqual([
      'cheap/image',
      'cheap/image',
      'cheap/image',
      'potent/image',
    ]);
  });

  it('classifies a 200 response with no images as congestion and escalates', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: 'potent/image' };
    const calls = captureFetch([emptyResponse(), imageResponse()]);

    const result = await generateImages('a tavern at dusk', 1, {
      model: 'cheap/image',
      retryBackoffs: [0, 0, 0, 0],
    });

    expect(result.modelUsed).toBe('potent/image');
    expect(calls).toHaveLength(2);
  });

  it('never escalates on errors that are not congestion or filter', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: 'potent/image' };
    const calls = captureFetch([new Response('{"error":{"message":"prompt too long"}}', { status: 400 })]);

    await expect(
      generateImages('x', 1, { model: 'cheap/image', retryBackoffs: [0, 0] }),
    ).rejects.toThrow(/prompt too long/);
    expect(calls).toHaveLength(1);
  });

  it('throws a combined error naming every model when the chain is exhausted', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: 'potent/image' };
    captureFetch([
      new Response('rate limited', { status: 429 }),
      new Response('rate limited', { status: 429 }),
      new Response('rate limited', { status: 429 }),
      new Response('rate limited', { status: 429 }),
      new Response('rate limited', { status: 429 }),
      new Response('rate limited', { status: 429 }),
    ]);

    await expect(
      generateImages('x', 1, { model: 'cheap/image', retryBackoffs: [0, 0] }),
    ).rejects.toThrow(/every image model in the escalation chain failed.*cheap\/image.*potent\/image/s);
  });

  it('does not waste a fallback attempt on a text-to-image model for image edits', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: 'potent/image' };
    setCachedModels([
      { id: 'potent/image', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
    ]);
    const calls = captureFetch([
      new Response('rate limited', { status: 429 }),
      new Response('rate limited', { status: 429 }),
      new Response('rate limited', { status: 429 }),
    ]);

    await expect(
      generateImages('stylize', 1, {
        model: 'cheap/image',
        inputReferences: [{ dataUrl: 'data:image/png;base64,schematic' }],
        retryBackoffs: [0, 0],
      }),
    ).rejects.toThrow(/rate limited/);
    // Only the primary's three attempts — the text-only fallback was skipped.
    expect(calls).toHaveLength(3);
  });
});
