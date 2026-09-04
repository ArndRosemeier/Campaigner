/**
 * Typed OpenRouter failures. Every throw site in the OpenRouter clients
 * labels WHY it failed via `kind`, so fallback classification reads
 * structured data instead of matching English prose (model-fallback
 * feature). This is a leaf module: both the OpenRouter client and the
 * model-fallback helpers import it — never the other way around.
 */

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

export type FallbackReason = 'congestion' | 'filter';

/** Why `error` qualifies for escalation to the fallback model, or null when
 * it must NOT fall back. Null is the loud default: auth/credit problems,
 * request validation and truncated output change nothing on another model
 * (or would mask a failure the user must see — AGENTS rule 1). */
export function fallbackReasonFor(error: unknown): FallbackReason | null {
  // Our own fetchWithHeadersTimeout aborts with a platform TimeoutError when
  // no response headers arrive: the provider accepted nothing — congestion.
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'congestion';
  if (!(error instanceof OpenRouterError)) return null;
  switch (error.kind) {
    case 'stall':
    case 'content-stall':
    case 'max-duration':
    case 'headers-timeout':
    case 'no-images':
      // The provider never delivered a usable answer — availability.
      return 'congestion';
    case 'length':
      // Truncation is task-shaped (output budget vs prompt size), not
      // model-availability: retrying on another model doubles spend for a
      // failure the user must fix (shorten the task or raise the budget).
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
      // Some providers report content filters as plain 400s with a telling body.
      if (FILTER_PATTERN.test(error.bodyText)) return 'filter';
      return null;
    }
  }
}

/** Provider phrasings for moderation / content-policy refusals. */
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
        `“${model}” failed: ${error instanceof Error ? error.message : String(error)}`,
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
