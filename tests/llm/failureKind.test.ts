import { describe, expect, it } from 'vitest';
import { ZodError, z } from 'zod';

import {
  FAILURE_KIND_GUIDANCE,
  FAILURE_KIND_LABELS,
  failureKindSchema,
} from '@/domain';
import { MissingApiKeyError, OpenRouterError } from '@/llm/openrouterErrors';
import { StrictSchemaError } from '@/llm/strictSchema';
import { failureKindOf } from '@/llm/failureKind';

/**
 * Failure classification pins (docs/05 run views): each error class a run
 * engine catch path can see maps to exactly one owner-facing kind. The kind
 * only annotates the raw errorMessage — these pins are the classification
 * contract the Details UI's guidance copy rides on.
 */

describe('failureKindOf', () => {
  it('classifies delivery congestion: watchdog stalls, 429/5xx and the fetch timeout', () => {
    expect(failureKindOf(new OpenRouterError('http', 429, 'rate limited'))).toBe('congestion');
    expect(failureKindOf(new OpenRouterError('http', 503, 'provider down'))).toBe('congestion');
    expect(failureKindOf(new OpenRouterError('stall', 200, 'no bytes'))).toBe('congestion');
    expect(failureKindOf(new OpenRouterError('content-stall', 200, 'keep-alives only'))).toBe(
      'congestion',
    );
    expect(failureKindOf(new OpenRouterError('max-duration', 200, 'deadline'))).toBe('congestion');
    expect(failureKindOf(new OpenRouterError('headers-timeout', 0, 'no headers'))).toBe(
      'congestion',
    );
    expect(failureKindOf(new OpenRouterError('no-images', 200, 'empty result'))).toBe('congestion');
    expect(
      failureKindOf(new DOMException('OpenRouter request timed out', 'TimeoutError')),
    ).toBe('congestion');
  });

  it('classifies refusals and moderation as filter', () => {
    expect(failureKindOf(new OpenRouterError('refusal', 200, 'I cannot help with that'))).toBe(
      'filter',
    );
    expect(
      failureKindOf(
        new OpenRouterError('http', 403, 'your input was flagged by the moderation system'),
      ),
    ).toBe('filter');
    expect(failureKindOf(new OpenRouterError('stream-error', 200, 'mid-stream', 403))).toBe(
      'filter',
    );
  });

  it('keeps the schema-rejected kind for rejected strict response formats', () => {
    expect(
      failureKindOf(
        new OpenRouterError(
          'schema-rejected',
          400,
          'model "m" rejected the strict JSON-schema response format',
        ),
      ),
    ).toBe('schema-rejected');
    expect(failureKindOf(new OpenRouterError('schema-rejected', 422, 'nope'))).toBe(
      'schema-rejected',
    );
  });

  it('classifies truncated replies and zod contract failures as invalid-output', () => {
    expect(failureKindOf(new OpenRouterError('length', 200, 'finish_reason length'))).toBe(
      'invalid-output',
    );
    const zodError = z.object({ name: z.string() }).safeParse({ name: 42 });
    if (zodError.success) throw new Error('expected the parse to fail');
    expect(zodError.error).toBeInstanceOf(ZodError);
    expect(failureKindOf(zodError.error)).toBe('invalid-output');
  });

  it('classifies programming errors as bug', () => {
    expect(
      failureKindOf(new StrictSchemaError('recursive schemas are not supported')),
    ).toBe('bug');
    expect(failureKindOf(new TypeError('cannot read properties of undefined'))).toBe('bug');
    expect(failureKindOf(new ReferenceError('x is not defined'))).toBe('bug');
    expect(failureKindOf(new RangeError('invalid array length'))).toBe('bug');
  });

  it('classifies user/owner aborts as cancelled', () => {
    expect(failureKindOf(new DOMException('The operation was aborted', 'AbortError'))).toBe(
      'cancelled',
    );
  });

  it('stays unknown for auth, credits, opaque provider errors and unrecognized throws', () => {
    expect(failureKindOf(new OpenRouterError('http', 401, 'invalid key'))).toBe('unknown');
    expect(failureKindOf(new OpenRouterError('http', 402, 'insufficient credits'))).toBe(
      'unknown',
    );
    expect(failureKindOf(new OpenRouterError('http', 400, 'model not found'))).toBe('unknown');
    expect(failureKindOf(new OpenRouterError('stream-error', 200, 'opaque failure'))).toBe(
      'unknown',
    );
    expect(failureKindOf(new MissingApiKeyError())).toBe('unknown');
    expect(failureKindOf(new Error('something else entirely'))).toBe('unknown');
    expect(failureKindOf('a plain string thrown')).toBe('unknown');
    expect(failureKindOf(undefined)).toBe('unknown');
  });
});

describe('failureKind guidance map (docs/05 run views)', () => {
  it('has a label and a one-line guidance sentence for every kind', () => {
    const kinds = failureKindSchema.options;
    expect(kinds).toHaveLength(7);
    for (const kind of kinds) {
      expect(FAILURE_KIND_LABELS[kind]).toBeTruthy();
      expect(FAILURE_KIND_GUIDANCE[kind]).toBeTruthy();
      // One sentence: no line breaks in owner-facing copy.
      expect(FAILURE_KIND_GUIDANCE[kind]).not.toMatch(/\n/);
    }
  });

  it('pins the recovery intent verbatim for the kinds the owner asked about', () => {
    expect(FAILURE_KIND_GUIDANCE.congestion).toBe(
      'The provider was overloaded or timed out — resuming this run makes sense.',
    );
    expect(FAILURE_KIND_GUIDANCE.filter).toBe(
      'The model refused the content — resuming with the same model will refuse again; pick a different model or adjust the prompt.',
    );
    expect(FAILURE_KIND_GUIDANCE['schema-rejected']).toBe(
      'The model rejected the strict JSON contract — pick a model that supports structured outputs or turn Strict structured outputs off in Settings.',
    );
    expect(FAILURE_KIND_GUIDANCE.bug).toBe(
      'This looks like a Campaigner bug, not a transient failure — resuming will fail the same way. Please report it.',
    );
    expect(FAILURE_KIND_GUIDANCE.unknown).toBe(
      'No classification was possible — see the raw error below.',
    );
  });
});
