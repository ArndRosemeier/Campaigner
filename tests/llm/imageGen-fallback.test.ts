import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateImages } from '@/llm/imageGen';
import { failureKindOf } from '@/llm/failureKind';
import { OpenRouterError } from '@/llm/openrouterErrors';
import { setCachedModels } from '@/llm/modelCache';
import { defaultSettings } from '@/domain';

/**
 * Image escalation chain (model fallback feature): the /images client
 * escalates across `[primary, settings.fallbackImageModel]` on ANY failure —
 * escalation is unconditional (owner decision 2026-09-07; a 200 response
 * with no images and unknown 400s alike advance to the next chain entry).
 * Output-contract-free path — no repair tier here.
 *
 * Error-shape fixtures pin the STRUCTURAL classification (the OpenRouter
 * error envelope's `metadata.error_type` reaches the typed error as `code`):
 * a typed refusal — the canonical slime-monster shape — escalates to the
 * fallback image model AND classifies as a filter, never as congestion.
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

/** A 200 response carrying the OpenRouter error envelope (documented for
 * non-streaming endpoints) — here a refusal with its real diagnosis. */
function errorEnvelopeResponse(errorType: string, message: string, status = 200): Response {
  return new Response(
    JSON.stringify({ error: { message, code: status, metadata: { error_type: errorType } } }),
    { status },
  );
}

/** A 400 body typed as a content refusal — the canonical shape the
 * content-filter bug shipped with (the "slime monster" symptom). */
function refusal400(message = 'The request was refused: the slime monster prompt violates policy'): Response {
  return errorEnvelopeResponse('refusal', message, 400);
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

  it('escalates on an unknown 400 — the chain is the bound even for unclassifiable errors', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: 'potent/image' };
    const calls = captureFetch([
      new Response('{"error":{"message":"prompt too long"}}', { status: 400 }),
      imageResponse(),
    ]);

    const result = await generateImages('x', 1, { model: 'cheap/image', retryBackoffs: [0, 0] });
    expect(result.modelUsed).toBe('potent/image');
    expect(calls).toHaveLength(2);
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

describe('image error shapes → typed classification + escalation (owner symptom)', () => {
  it('escalates to the fallback image model on a typed refusal 400 — the slime-monster shape', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: 'potent/image' };
    const calls = captureFetch([refusal400(), imageResponse()]);

    const result = await generateImages('a heroic slime monster', 1, {
      model: 'cheap/image',
      retryBackoffs: [0, 0],
    });

    // The fallback produced the image; the primary's typed refusal only
    // advanced the chain (owner: "ANY ERROR, ANY AT ALL should lead to the
    // fallback").
    expect(result.modelUsed).toBe('potent/image');
    expect(calls.map((call) => call.body.model)).toEqual(['cheap/image', 'potent/image']);
  });

  it('classifies a typed refusal 400 as a filter — structurally, not by prose', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: '' };
    const body = JSON.stringify({
      error: { message: 'totally opaque provider text', code: 400, metadata: { error_type: 'refusal' } },
    });
    captureFetch([new Response(body, { status: 400 })]);

    const error = await generateImages('x', 1, { model: 'cheap/image', retryBackoffs: [0, 0] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpenRouterError);
    expect((error as OpenRouterError).kind).toBe('http');
    expect((error as OpenRouterError).code).toBe('refusal');
    // The Details view names the filter, not an unclassified failure.
    expect(failureKindOf(error)).toBe('filter');
  });

  it('escalates on a typed content_policy_violation 400', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: 'potent/image' };
    const calls = captureFetch([
      errorEnvelopeResponse('content_policy_violation', 'provider rejected the input', 400),
      imageResponse(),
    ]);

    const result = await generateImages('x', 1, { model: 'cheap/image', retryBackoffs: [0, 0] });
    expect(result.modelUsed).toBe('potent/image');
    expect(calls).toHaveLength(2);
  });

  it('a 200 response with an error envelope throws the TYPED error (diagnosis kept) and escalates', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: 'potent/image' };
    const calls = captureFetch([
      errorEnvelopeResponse('refusal', 'the model refused: no slime monsters today'),
      imageResponse(),
    ]);

    const result = await generateImages('x', 1, { model: 'cheap/image', retryBackoffs: [0, 0] });
    expect(result.modelUsed).toBe('potent/image');
    expect(calls).toHaveLength(2);
  });

  it('a 200-with-error-body single-entry chain fails loudly with the REAL diagnosis (not "no images")', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: '' };
    captureFetch([errorEnvelopeResponse('refusal', 'the model refused: no slime monsters today')]);

    // The envelope's message survives — the old collapse said "image API
    // returned no images" and mislabeled the refusal as congestion.
    await expect(
      generateImages('x', 1, { model: 'cheap/image', retryBackoffs: [0, 0] }),
    ).rejects.toThrow(/the model refused: no slime monsters today/);
  });

  it('genuinely-empty data (no error field) stays a no-images congestion failure', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: '' };
    captureFetch([emptyResponse()]);

    const error = await generateImages('x', 1, { model: 'cheap/image', retryBackoffs: [0, 0] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpenRouterError);
    expect((error as OpenRouterError).kind).toBe('no-images');
    expect(failureKindOf(error)).toBe('congestion');
  });

  it('does not misread a moderation 400 as a candidate-count cap — no n=1 retry, it escalates', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: 'potent/image' };
    // Opaque (untyped) moderation body that mentions "parameter(s)" and a
    // standalone "n" — the tightened pattern requires n WITH a quoted value.
    const body = JSON.stringify({
      error: {
        message: 'Moderation blocked the prompt: disallowed parameter(s) referenced; the token n was flagged',
        code: 400,
      },
    });
    const calls = captureFetch([new Response(body, { status: 400 }), imageResponse()]);

    const result = await generateImages('x', 2, { model: 'cheap/image', retryBackoffs: [0, 0] });
    expect(result.modelUsed).toBe('potent/image');
    // Both calls asked for 2 candidates — the moderation 400 was never
    // treated as a cap.
    expect(calls.map((call) => call.body.n)).toEqual([2, 2]);
  });

  it('a typed refusal 400 is never retried as a candidate-count cap (error_type first in the catch)', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: 'potent/image' };
    // Cap-LIKE body text (`n "2"`) under a typed refusal class.
    const body = JSON.stringify({
      error: {
        message: 'refused: the requested n "2" collides with policy',
        code: 400,
        metadata: { error_type: 'refusal' },
      },
    });
    const calls = captureFetch([new Response(body, { status: 400 }), imageResponse()]);

    const result = await generateImages('x', 2, { model: 'cheap/image', retryBackoffs: [0, 0] });
    expect(result.modelUsed).toBe('potent/image');
    expect(calls.map((call) => call.body.n)).toEqual([2, 2]);
  });

  it('a typed refusal on every attempt exhausts the chain as a filter-class failure', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: 'potent/image' };
    captureFetch([refusal400(), refusal400(), refusal400(), refusal400(), refusal400(), refusal400()]);

    const error = await generateImages('x', 1, { model: 'cheap/image', retryBackoffs: [0, 0] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpenRouterError);
    expect(String(error)).toMatch(/every image model in the escalation chain failed/);
    expect(failureKindOf(error)).toBe('filter');
  });
});

describe('image fallback visibility (fallback + filteredCount + config gap)', () => {
  it('reports the escalation on the result — a typed refusal escalation classifies as filter', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: 'potent/image' };
    captureFetch([refusal400(), imageResponse()]);

    const result = await generateImages('a slime monster', 1, {
      model: 'cheap/image',
      retryBackoffs: [0, 0],
    });
    expect(result.fallback).toEqual({ from: 'cheap/image', to: 'potent/image', reason: 'filter' });
  });

  it('reports congestion as the escalation reason for a 429 fallback', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: 'potent/image' };
    captureFetch([
      new Response('rate limited', { status: 429 }),
      new Response('rate limited', { status: 429 }),
      new Response('rate limited', { status: 429 }),
      imageResponse(),
    ]);

    const result = await generateImages('x', 1, { model: 'cheap/image', ...FAST_RETRIES });
    expect(result.fallback).toEqual({ from: 'cheap/image', to: 'potent/image', reason: 'congestion' });
  });

  it('reports no escalation on a first-try success (fallback null, nothing filtered)', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: 'potent/image' };
    captureFetch([imageResponse()]);

    const result = await generateImages('x', 1, { model: 'cheap/image', retryBackoffs: [0, 0] });
    expect(result.fallback).toBeNull();
    expect(result.filteredCount).toBe(0);
  });

  it('counts partially filtered candidates (null entry / empty b64) in filteredCount', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: 'potent/image' };
    const b64 = btoa('fake-webp-bytes');
    captureFetch([
      new Response(
        JSON.stringify({
          data: [null, { b64_json: '', media_type: 'image/webp' }, { b64_json: b64, media_type: 'image/webp' }],
          usage: { cost: 0.02 },
        }),
        { status: 200 },
      ),
      imageResponse(),
    ]);

    // The primary's partial filter is NOT a failure: one usable candidate
    // came back, so the walk succeeded on the first entry — the filter drop
    // must be visible via filteredCount (the caller persists a notice).
    const result = await generateImages('x', 2, { model: 'cheap/image', retryBackoffs: [0, 0] });
    expect(result.modelUsed).toBe('cheap/image');
    expect(result.fallback).toBeNull();
    expect(result.images).toHaveLength(1);
    expect(result.filteredCount).toBe(2);
  });

  it('ALL candidates filtered still throws no-images (never a silent zero-image success)', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: '' };
    captureFetch([new Response(JSON.stringify({ data: [null, { b64_json: '' }] }), { status: 200 })]);

    await expect(
      generateImages('x', 2, { model: 'cheap/image', retryBackoffs: [0, 0] }),
    ).rejects.toThrow(/image API returned no images/);
  });

  it('a single-entry chain failure names the config gap (the owner symptom can never recur silently)', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: '' };
    captureFetch([refusal400()]);

    const error = await generateImages('a heroic slime monster', 1, {
      model: 'cheap/image',
      retryBackoffs: [0, 0],
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(error)).toMatch(/no fallback image model is configured/);
    expect(String(error)).toMatch(/Settings → Image generation/);
    // The real diagnosis survives next to the guidance.
    expect(String(error)).toMatch(/slime monster prompt violates policy/);
  });

  it('the config-gap wrap keeps the classification (kind/status/code) intact', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: '' };
    captureFetch([refusal400()]);

    const error = await generateImages('x', 1, { model: 'cheap/image', retryBackoffs: [0, 0] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpenRouterError);
    expect((error as OpenRouterError).kind).toBe('http');
    expect((error as OpenRouterError).code).toBe('refusal');
    expect(failureKindOf(error)).toBe('filter');
  });

  it('a multi-entry exhaustion does NOT claim a missing fallback (the chain ran)', async () => {
    currentSettings = { ...currentSettings, fallbackImageModel: 'potent/image' };
    captureFetch([refusal400(), refusal400(), refusal400(), refusal400(), refusal400(), refusal400()]);

    await expect(
      generateImages('x', 1, { model: 'cheap/image', retryBackoffs: [0, 0] }),
    ).rejects.toThrow(/every image model in the escalation chain failed(?!.*no fallback image model)/s);
  });
});
