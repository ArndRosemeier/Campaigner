import { ZodError } from 'zod';

import type { FailureKind } from '@/domain';
import { fallbackReasonFor, MissingApiKeyError, OpenRouterError } from '@/llm/openrouterErrors';
import { StrictSchemaError } from '@/llm/strictSchema';

/**
 * Classifies WHY a run failed (docs/05 run views): pure error-object →
 * `FailureKind`, the same structural reading of the typed error classes
 * that `fallbackReasonFor` does for the escalation-notice wording
 * (openrouterErrors.ts header: match structured data, never English
 * prose). The classification only ANNOTATES the raw `errorMessage` (AGENTS
 * 2 — the message stays the error surface); runEngine writes both when it
 * fails a run. It has NO escalation role: the model chain escalates on any
 * error regardless of kind (owner decision 2026-09-07).
 *
 * Mapping:
 * - OpenRouter kinds: refusal → filter; schema-rejected keeps its kind;
 *   the delivery-watchdog family (stall/content-stall/max-duration/
 *   headers-timeout/no-images) → congestion; length → invalid-output
 *   (a truncated reply is unusable output — the chain escalates anyway,
 *   but the Details view names the real failure);
 *   http/stream-error refine through `fallbackReasonFor` (status /
 *   provider-code / filter-pattern) and stay 'unknown' when that returns
 *   its null (auth, credits, opaque 400s).
 * - DOMException: AbortError → cancelled; the fetch timeout (TimeoutError)
 *   → congestion.
 * - ZodError → invalid-output (contract failures; AGENTS 3).
 * - StrictSchemaError and the TypeError/ReferenceError/RangeError family →
 *   bug (programming errors: resuming fails identically).
 * - MissingApiKeyError and anything unrecognized → unknown.
 */
export function failureKindOf(error: unknown): FailureKind {
  if (error instanceof DOMException) {
    if (error.name === 'AbortError') return 'cancelled';
    if (error.name === 'TimeoutError') return 'congestion';
    return 'unknown';
  }
  if (error instanceof OpenRouterError) {
    switch (error.kind) {
      case 'refusal':
        return 'filter';
      case 'schema-rejected':
        return 'schema-rejected';
      case 'stall':
      case 'content-stall':
      case 'max-duration':
      case 'headers-timeout':
      case 'no-images':
        return 'congestion';
      case 'length':
        return 'invalid-output';
      // 'http', 'stream-error' and any unrecognized kind refine through the
      // shared status/code/filter-pattern classification. 'other' and null
      // both stay 'unknown' (loud) — the Details vocabulary is unchanged;
      // all of this is annotation, escalation is unconditional.
      default: {
        const reason = fallbackReasonFor(error);
        return reason === 'congestion' || reason === 'filter' ? reason : 'unknown';
      }
    }
  }
  if (error instanceof StrictSchemaError) return 'bug';
  if (error instanceof ZodError) return 'invalid-output';
  if (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof RangeError ||
    error instanceof URIError ||
    error instanceof EvalError
  ) {
    return 'bug';
  }
  if (error instanceof MissingApiKeyError) return 'unknown';
  return 'unknown';
}
