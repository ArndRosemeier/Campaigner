import { describe, expect, it } from 'vitest';

import {
  OpenRouterError,
  fallbackReasonFor,
  FILTER_PATTERN,
} from '@/llm/openrouterErrors';

describe('fallbackReasonFor', () => {
  it('classifies congestion statuses on plain HTTP errors', () => {
    for (const status of [408, 429, 500, 502, 503, 504, 508]) {
      expect(fallbackReasonFor(new OpenRouterError('http', status, 'boom'))).toBe('congestion');
    }
  });

  it('treats OpenRouter 403 moderation as a filter refusal', () => {
    expect(
      fallbackReasonFor(
        new OpenRouterError('http', 403, 'your input was flagged by the moderation system'),
      ),
    ).toBe('filter');
  });

  it('never falls back on auth, credits, validation or truncation', () => {
    expect(fallbackReasonFor(new OpenRouterError('http', 401, 'invalid key'))).toBeNull();
    expect(fallbackReasonFor(new OpenRouterError('http', 402, 'insufficient credits'))).toBeNull();
    expect(fallbackReasonFor(new OpenRouterError('http', 400, 'model not found'))).toBeNull();
    expect(fallbackReasonFor(new OpenRouterError('length', 200, 'truncated'))).toBeNull();
  });

  it('recognizes filter phrasings inside 400 bodies', () => {
    expect(
      fallbackReasonFor(new OpenRouterError('http', 400, 'content_policy_violation: disallowed')),
    ).toBe('filter');
    expect(FILTER_PATTERN.test('The request was rejected: content filtering policy')).toBe(true);
    expect(FILTER_PATTERN.test('just a normal error')).toBe(false);
  });

  it('classifies watchdog stalls and timeouts as congestion', () => {
    expect(fallbackReasonFor(new OpenRouterError('stall', 200, 'silence'))).toBe('congestion');
    expect(fallbackReasonFor(new OpenRouterError('content-stall', 200, 'keep-alives'))).toBe(
      'congestion',
    );
    expect(fallbackReasonFor(new OpenRouterError('max-duration', 200, 'too long'))).toBe(
      'congestion',
    );
    expect(fallbackReasonFor(new OpenRouterError('headers-timeout', 0, 'no headers'))).toBe(
      'congestion',
    );
  });

  it('treats the platform TimeoutError from fetchWithHeadersTimeout as congestion', () => {
    const timeout = new DOMException('OpenRouter request timed out: no response headers', 'TimeoutError');
    expect(fallbackReasonFor(timeout)).toBe('congestion');
    // User aborts must never fall back.
    expect(fallbackReasonFor(new DOMException('Aborted', 'AbortError'))).toBeNull();
  });

  it('uses the provider code of a mid-stream error when present', () => {
    expect(fallbackReasonFor(new OpenRouterError('stream-error', 200, 'stream error: e', 429))).toBe(
      'congestion',
    );
    expect(fallbackReasonFor(new OpenRouterError('stream-error', 200, 'stream error: e', 503))).toBe(
      'congestion',
    );
    expect(fallbackReasonFor(new OpenRouterError('stream-error', 200, 'stream error: e', 403))).toBe(
      'filter',
    );
    expect(fallbackReasonFor(new OpenRouterError('stream-error', 200, 'stream error: e', 400))).toBe(
      null,
    );
  });

  it('is null for unknown errors and unknown mid-stream failures (loud default)', () => {
    expect(fallbackReasonFor(new TypeError('Failed to fetch'))).toBeNull();
    expect(fallbackReasonFor(new Error('anything'))).toBeNull();
    expect(fallbackReasonFor(new OpenRouterError('stream-error', 200, 'opaque failure'))).toBeNull();
    // The empty-result image failure is delivery congestion.
    expect(fallbackReasonFor(new OpenRouterError('no-images', 200, 'no images'))).toBe('congestion');
  });
});
