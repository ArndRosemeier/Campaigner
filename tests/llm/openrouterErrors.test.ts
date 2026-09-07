import { describe, expect, it } from 'vitest';

import {
  chainError,
  OpenRouterError,
  fallbackReasonFor,
  FILTER_PATTERN,
} from '@/llm/openrouterErrors';
import { failureKindOf } from '@/llm/failureKind';

/**
 * `fallbackReasonFor` is the pure failure CLASSIFIER: it names the
 * congestion/filter classes for the Details-view kind (failureKind.ts) and
 * the escalation-notice wording. It no longer gates escalation — the model
 * chain escalates on ANY error regardless of what this returns (owner
 * decision 2026-09-07: "ANY ERROR, ANY AT ALL should lead to the
 * fallback"); null only means "no specific class" ('unknown' in the Details
 * view, plain "failed" in the notice). These pins hold the vocabulary
 * stable.
 */
describe('fallbackReasonFor (classification only — escalation is unconditional)', () => {
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

  it('classifies auth, credits, validation and truncation as null (Details view: unknown/invalid-output)', () => {
    expect(fallbackReasonFor(new OpenRouterError('http', 401, 'invalid key'))).toBeNull();
    expect(fallbackReasonFor(new OpenRouterError('http', 402, 'insufficient credits'))).toBeNull();
    expect(fallbackReasonFor(new OpenRouterError('http', 400, 'model not found'))).toBeNull();
    expect(fallbackReasonFor(new OpenRouterError('length', 200, 'truncated'))).toBeNull();
  });

  it('recognizes filter phrasings inside 400 bodies (annotation only)', () => {
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
    // User aborts classify as null — and stop the walk as model-independent
    // failures (modelFallback.isModelIndependentFailure), never escalate.
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

  it('is null for unknown errors and unknown mid-stream failures (Details view: unknown)', () => {
    expect(fallbackReasonFor(new TypeError('Failed to fetch'))).toBeNull();
    expect(fallbackReasonFor(new Error('anything'))).toBeNull();
    expect(fallbackReasonFor(new OpenRouterError('stream-error', 200, 'opaque failure'))).toBeNull();
    // The empty-result image failure is delivery congestion.
    expect(fallbackReasonFor(new OpenRouterError('no-images', 200, 'no images'))).toBe('congestion');
  });
  it('classifies a model refusal as filter (censorship class)', () => {
    expect(fallbackReasonFor(new OpenRouterError('refusal', 200, 'the model refused the task: no'))).toBe('filter');
  });

  it('classifies a rejected strict response_format as null (its own Details kind; the chain still escalates)', () => {
    expect(fallbackReasonFor(new OpenRouterError('schema-rejected', 400, 'model "m" rejected the strict JSON-schema response format'))).toBeNull();
    expect(fallbackReasonFor(new OpenRouterError('schema-rejected', 422, 'invalid schema'))).toBeNull();
  });
});

describe('fallbackReasonFor: typed error_type classes (structural, read FIRST)', () => {
  it('classifies filter error_types on http errors — no prose needed', () => {
    // The canonical image-refusal shape: a 400 whose body carries
    // metadata.error_type — classified structurally even with an opaque body.
    for (const errorType of ['content_policy_violation', 'refusal', 'image_content_policy_violation']) {
      expect(fallbackReasonFor(new OpenRouterError('http', 400, '{"opaque":true}', errorType))).toBe(
        'filter',
      );
    }
  });

  it('classifies congestion error_types on http errors', () => {
    for (const errorType of ['rate_limit_exceeded', 'provider_overloaded', 'provider_unavailable', 'timeout']) {
      expect(fallbackReasonFor(new OpenRouterError('http', 400, '{"opaque":true}', errorType))).toBe(
        'congestion',
      );
    }
  });

  it('reads the string error_type BEFORE the status check and the body prose', () => {
    // A refusal class beats a 5xx status; a congestion class beats a plain 400.
    expect(fallbackReasonFor(new OpenRouterError('http', 500, 'content policy said no', 'refusal'))).toBe('filter');
    expect(fallbackReasonFor(new OpenRouterError('http', 400, 'plain body', 'timeout'))).toBe('congestion');
  });

  it('falls back to the status/prose classification for unknown or absent codes', () => {
    expect(fallbackReasonFor(new OpenRouterError('http', 429, 'x', 'unknown_error_type'))).toBe('congestion');
    expect(fallbackReasonFor(new OpenRouterError('http', 400, 'x', 'unknown_error_type'))).toBeNull();
    // Legacy prose bodies (no error_type) keep the FILTER_PATTERN last resort.
    expect(fallbackReasonFor(new OpenRouterError('http', 400, 'content_policy_violation: disallowed'))).toBe('filter');
  });

  it('classifies stream errors carrying a string error_type, numeric codes unchanged', () => {
    expect(fallbackReasonFor(new OpenRouterError('stream-error', 200, 'stream error: e', 'refusal'))).toBe('filter');
    expect(fallbackReasonFor(new OpenRouterError('stream-error', 200, 'stream error: e', 'provider_overloaded'))).toBe('congestion');
    expect(fallbackReasonFor(new OpenRouterError('stream-error', 200, 'stream error: e', 429))).toBe('congestion');
    expect(fallbackReasonFor(new OpenRouterError('stream-error', 200, 'stream error: e', 403))).toBe('filter');
  });

  it('keeps the error_type class through chain exhaustion (chainError code passthrough)', () => {
    const combined = chainError(
      [{ model: 'a', error: new OpenRouterError('http', 400, 'refused', 'refusal') }],
      'image',
    );
    expect(combined).toBeInstanceOf(OpenRouterError);
    expect(fallbackReasonFor(combined)).toBe('filter');
    // The Details view classifies the exhausted image run as a filter, not
    // an unclassified failure.
    expect(failureKindOf(combined)).toBe('filter');
  });
});
