/**
 * Typed OpenRouter failures. Every throw site in the OpenRouter clients
 * labels WHY it failed via `kind`, so failure classification reads
 * structured data instead of matching English prose. This is a leaf module:
 * both the OpenRouter client and the model-fallback helpers import it —
 * never the other way around.
 *
 * ESCALATION IS UNCONDITIONAL (owner decision 2026-09-07, model-fallback
 * arc): `walkModelChain` escalates on ANY error — "ANY ERROR, ANY AT ALL
 * should lead to the fallback" — with only two model-independent exceptions
 * (MissingApiKeyError, user aborts). Nothing in this module gates escalation
 * anymore: the kinds, `fallbackReasonFor` and FILTER_PATTERN are the
 * CLASSIFICATION layer that annotates a failure for the run Details view
 * (failureKind.ts) and words the escalation notice honestly.
 */

import { errorMessage } from '@/lib/errors';

export type OpenRouterErrorKind =
  /** Non-OK HTTP response (retries exhausted, bad request, auth, …). */
  | 'http'
  /** Mid-stream error event, or finish_reason "error". */
  | 'stream-error'
  /** Watchdog: no bytes at all for the stall timeout. */
  | 'stall'
  /** Watchdog: keep-alives kept arriving but no content did. */
  | 'content-stall'
  /** Watchdog: the stream outlived its total-duration deadline. */
  | 'max-duration'
  /** No response headers within the headers timeout (non-streaming waits). */
  | 'headers-timeout'
  /** finish_reason "length" — the answer was truncated mid-way. */
  | 'length'
  /**
   * The model declined the task itself (OpenAI-style `delta.refusal`).
   * Censorship class — classified 'filter' for the Details view; the chain
   * escalates like it does for every other error (owner: "we still need
   * repair models, for censorship and congestion").
   */
  | 'refusal'
  /**
   * The provider rejected the strict JSON-schema response_format (HTTP
   * 400/422). Classified as its own kind for the Details view; the chain
   * escalates to the next model like for any other error (owner decision
   * 2026-09-07 — another model may support strict mode). The Settings
   * "Strict structured outputs" toggle remains the explicit downgrade.
   */
  | 'schema-rejected'
  /** The image API answered 200 but with zero images. */
  | 'no-images';

export class OpenRouterError extends Error {
  readonly kind: OpenRouterErrorKind;
  readonly status: number;
  readonly bodyText: string;
  /** Provider-reported code from a mid-stream error payload, when present. */
  readonly code: number | string | undefined;

  constructor(
    kind: OpenRouterErrorKind,
    status: number,
    bodyText: string,
    code?: number | string,
  ) {
    // Surface the reason in the message — this string is what failed runs
    // display, so "OpenRouter request failed (200)" alone is useless.
    const snippet = bodyText.length > 200 ? bodyText.slice(0, 200) + '…' : bodyText;
    super(`OpenRouter request failed (${String(status)})${snippet === '' ? '' : `: ${snippet}`}`);
    this.name = 'OpenRouterError';
    this.kind = kind;
    this.status = status;
    this.bodyText = bodyText;
    this.code = code;
  }
}

export class MissingApiKeyError extends Error {
  constructor() {
    super('No OpenRouter API key configured');
    this.name = 'MissingApiKeyError';
  }
}

/**
 * Why an escalation-triggering error reads the way it does in user-facing
 * surfaces: 'congestion' (provider availability), 'filter' (moderation /
 * refusal), 'other' (everything the classifier cannot name — truncation,
 * schema rejections, opaque 400s, unexpected throws). This is NOT an
 * escalation gate: the chain escalates regardless (owner: "ANY ERROR, ANY
 * AT ALL should lead to the fallback"); it only words the escalation notice
 * and refines the Details-view kind for http/stream errors.
 */
export type FallbackReason = 'congestion' | 'filter' | 'other';

/**
 * The pure failure classifier: names the congestion/filter classes, or null
 * when the error belongs to no specific class. Null is NOT "do not
 * escalate" (escalation is unconditional) — it maps to the Details view's
 * 'unknown' kind (failureKind.ts) and the notice's plain "failed" wording.
 */
export function fallbackReasonFor(error: unknown): FallbackReason | null {
  // Our own fetchWithHeadersTimeout aborts with a platform TimeoutError when
  // no response headers arrive: the provider accepted nothing — congestion.
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'congestion';
  if (!(error instanceof OpenRouterError)) return null;
  switch (error.kind) {
    case 'refusal':
      // The model refused the task: censorship, the class the fallback tier
      // was built for.
      return 'filter';
    case 'schema-rejected':
      // The provider cannot enforce strict JSON schemas. Classified as its
      // own kind; the chain escalates like for any other error.
      return null;
    case 'stall':
    case 'content-stall':
    case 'max-duration':
    case 'headers-timeout':
    case 'no-images':
      // The provider never delivered a usable answer — availability.
      return 'congestion';
    case 'length':
      // Truncation is task-shaped output, not provider congestion — the
      // Details view shows 'invalid-output'; the chain still escalates (a
      // larger-context model may fit the answer).
      return null;
    case 'stream-error': {
      const code = Number(error.code);
      if (error.code !== undefined && error.code !== '' && Number.isFinite(code)) {
        if (code === 403) return 'filter';
        if (code === 408 || code === 429 || code >= 500) return 'congestion';
      }
      return FILTER_PATTERN.test(error.bodyText) ? 'filter' : null;
    }
    case 'http':
    default: {
      // Same retryable family as fetchWithRetries (429 / >= 500) plus 408,
      // and OpenRouter's documented 403 "input was flagged" moderation.
      if (error.status === 403) return 'filter';
      if (error.status === 408 || error.status === 429 || error.status >= 500) return 'congestion';
      // Some providers report content filters as plain 400s with a telling
      // body (e.g. Meta's "content management policy" phrasing, which this
      // pattern deliberately does not need to catch for escalation's sake —
      // the chain escalates on it regardless; this only names the class).
      if (FILTER_PATTERN.test(error.bodyText)) return 'filter';
      return null;
    }
  }
}

/**
 * Provider phrasings for moderation / content-policy refusals. ANNOTATION
 * ONLY since the unconditional-escalation owner decision: classification
 * informs the Details view (failureKind.ts) and the escalation notice;
 * escalation itself is unconditional and no longer reads this pattern.
 */
export const FILTER_PATTERN =
  /content[ _-]?filter|content[ _-]?polic(?:y|ies)|moderation|flagged|inappropriate/i;

/**
 * The combined end-of-chain error: every model that was tried and failed, in
 * order. The last entry's kind/status survive so outer instanceof/status
 * checks keep working.
 */
export function chainError(
  failures: readonly { model: string; error: unknown }[],
  what: 'chat' | 'image' = 'chat',
): Error {
  const last = failures[failures.length - 1];
  if (last === undefined) return new Error(`the ${what} escalation chain failed without an error`);
  const detail = failures
    .map(
      ({ model, error }) =>
        `“${model}” failed: ${errorMessage(error)}`,
    )
    .join(' | ');
  if (last.error instanceof OpenRouterError) {
    return new OpenRouterError(
      last.error.kind,
      last.error.status,
      `every ${what} model in the escalation chain failed — ${detail}`,
    );
  }
  return new Error(`every ${what} model in the escalation chain failed — ${detail}`, {
    cause: last.error,
  });
}
