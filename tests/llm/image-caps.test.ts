import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateImages } from '@/llm/imageGen';
import { defaultSettings } from '@/domain';

/**
 * Candidate-count caps (user report): `x-ai/grok-imagine-image-2.0` rejects
 * `n: 2` with `400 … supports the requested parameter(s): output_format
 * "webp", n "2"`. The client retries once with a single image, reports
 * `cappedToOne` (never a silent degrade), remembers the capped model so later
 * runs skip the doomed 400, and still fails loudly on any OTHER 400.
 */

vi.mock('@/db/settingsRepo', () => ({
  getSettings: vi.fn(() =>
    Promise.resolve({
      ...defaultSettings(),
      openRouterApiKey: 'test-key',
      imageModel: 'test-image-model',
    }),
  ),
}));

/** One webp image as the API would return it. */
function imageResponse(): Response {
  const b64 = btoa('fake-webp-bytes');
  return new Response(JSON.stringify({ data: [{ b64_json: b64, media_type: 'image/webp' }], usage: { cost: 0.01 } }), {
    status: 200,
  });
}

const CAP_400_BODY =
  '{"error":{"message":"No provider for x-ai/grok-imagine-image-2.0 supports the requested parameter(s): ' +
  'output_format \\"webp\\", n \\"2\\". Provider rejections: xAI: n: must be exactly 1","code":400}}';

interface CapturedCall {
  url: string;
  body: {
    model: string;
    prompt: string;
    n: number;
    output_format: string;
    input_references?: { type: string; image_url: { url: string } }[];
  };
}

function captureFetch(responses: (Response | ((call: CapturedCall) => Response))[]): CapturedCall[] {
  const calls: CapturedCall[] = [];
  let index = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : '';
      const body = JSON.parse(raw) as CapturedCall['body'];
      const call = { url: String(url), body };
      calls.push(call);
      const next = responses[index];
      index += 1;
      const response = typeof next === 'function' ? next(call) : next;
      if (response === undefined) throw new Error(`unexpected fetch #${String(index)}`);
      return Promise.resolve(response);
    }),
  );
  return calls;
}

const responses: (Response | ((call: CapturedCall) => Response))[] = [];

afterEach(() => {
  responses.length = 0;
  vi.unstubAllGlobals();
});

describe('image candidate-count caps', () => {
  it('retries once with n=1 when the model caps the candidate count, and reports it', async () => {
    // Distinct model name per test — the cap memory is module-level.
    const model = 'cap-test/retry-model';
    responses.push(new Response(CAP_400_BODY, { status: 400 }), imageResponse());
    const calls = captureFetch(responses);

    const result = await generateImages('a tavern at dusk', 2, { model });

    expect(result.images).toHaveLength(1);
    expect(result.cappedToOne).toBe(true);
    expect(result.costUsd).toBe(0.01);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.n).toBe(2);
    expect(calls[1]?.body.n).toBe(1);
    expect(calls[1]?.body.prompt).toBe('a tavern at dusk');
  });

  it('remembers the capped model: the next request asks for one image up front', async () => {
    const model = 'cap-test/memory-model';
    responses.push(new Response(CAP_400_BODY, { status: 400 }), imageResponse());
    captureFetch(responses);
    await generateImages('first', 2, { model });

    responses.length = 0;
    responses.push(imageResponse());
    const calls = captureFetch(responses);
    const result = await generateImages('second', 2, { model });

    expect(result.cappedToOne).toBe(true);
    expect(result.images).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.n).toBe(1);
  });

  it('sends structure reference images through OpenRouter input_references', async () => {
    responses.push(imageResponse());
    const calls = captureFetch(responses);
    await generateImages('stylize this map', 1, {
      model: 'reference-test/model',
      inputReferences: [{ dataUrl: 'data:image/png;base64,schematic' }],
    });

    expect(calls[0]?.body.input_references).toEqual([
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,schematic' },
      },
    ]);
  });

  it('fails loudly on any other 400 — no retry', async () => {
    const model = 'cap-test/other-error';
    responses.push(new Response('{"error":{"message":"prompt too long"}}', { status: 400 }));
    const calls = captureFetch(responses);

    await expect(generateImages('x', 2, { model })).rejects.toThrow(/prompt too long/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.n).toBe(2);
  });

  it('fails loudly when an n=1 request is rejected — no retry possible', async () => {
    const model = 'cap-test/single-refused';
    responses.push(new Response(CAP_400_BODY, { status: 400 }));
    const calls = captureFetch(responses);

    await expect(generateImages('x', 1, { model })).rejects.toThrow(/must be exactly 1/);
    expect(calls).toHaveLength(1);
  });

  it('does not treat a cap rejection of a DIFFERENT parameter as an n-cap', async () => {
    // "size" is the rejected parameter here — retrying with n=1 would be a
    // doomed second request and would hide the real problem.
    const model = 'cap-test/size-error';
    const body =
      '{"error":{"message":"No provider for m supports the requested parameter(s): size \\"1024x1024\\"","code":400}}';
    responses.push(new Response(body, { status: 400 }));
    const calls = captureFetch(responses);

    await expect(generateImages('x', 2, { model })).rejects.toThrow(/size/);
    expect(calls).toHaveLength(1);
  });
});
