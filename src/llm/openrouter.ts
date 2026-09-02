import { z } from 'zod';

import { getSettings } from '@/db/settingsRepo';
import { applyLanguageDirective } from '@/llm/language';
import { debugLog } from '@/lib/debug';

/**
 * OpenRouter client (04-LLM-PERSONAS.md): always-streaming chat completions
 * with SSE parsing, typed errors and 429/5xx retries (2s/8s backoff).
 */

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export class OpenRouterError extends Error {
  readonly status: number;
  readonly bodyText: string;

  constructor(status: number, bodyText: string) {
    // Surface the reason in the message — this string is what failed runs
    // display, so "OpenRouter request failed (200)" alone is useless.
    const snippet = bodyText.length > 200 ? bodyText.slice(0, 200) + '…' : bodyText;
    super(`OpenRouter request failed (${String(status)})${snippet === '' ? '' : `: ${snippet}`}`);
    this.name = 'OpenRouterError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

export class MissingApiKeyError extends Error {
  constructor() {
    super('No OpenRouter API key configured');
    this.name = 'MissingApiKeyError';
  }
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
}

/** What a streamed call is doing right now (see ChatOptions.onActivity). */
export interface ChatStreamActivity {
  /** Milliseconds since the stream started. */
  elapsedMs: number;
  /** Content characters received so far (reasoning deltas excluded). */
  receivedChars: number;
  /** waiting = no bytes yet; thinking = reasoning deltas arriving; content =
   * answer deltas arriving. Reasoning deltas are deliberately NOT onToken —
   * this probe is the only way a caller can show life during a long think. */
  phase: 'waiting' | 'thinking' | 'content';
}

export interface ChatOptions {
  model: string;
  temperature: number;
  /** Sets response_format: { type: 'json_object' }. */
  responseFormat?: 'json' | undefined;
  signal?: AbortSignal | undefined;
  /** Streaming callback, invoked once per content delta. */
  onToken?: ((delta: string) => void) | undefined;
  /** Liveness probe, emitted by the 1s watchdog while the stream is open.
   * Lets a caller keep a progress surface alive during long quiet stretches
   * (queued providers, reasoning models thinking before the first delta). */
  onActivity?: ((activity: ChatStreamActivity) => void) | undefined;
}

/** Spec backoff schedule for 429/5xx retries (04 spec: 2s, 8s). */
export const DEFAULT_RETRY_BACKOFFS_MS = [2000, 8000] as const;

/**
 * Abort a stream that receives no bytes at all for this long (keep-alive
 * comments count as activity). Without it a hung SSE connection leaves a run
 * stuck in "streaming" forever; with it the run fails visibly and can be
 * retried.
 */
export const DEFAULT_STREAM_STALL_TIMEOUT_MS = 120_000;

/**
 * Abort a stream that produces no CONTENT for this long even while bytes
 * (OpenRouter `: OPENROUTER PROCESSING` keep-alives, reasoning deltas) keep
 * arriving. The byte-level stall timeout above cannot catch a provider that
 * accepts the request and then streams keep-alives forever — that was the
 * "drafting…" forever hang. Reasoning deltas count as progress (the model is
 * working); silent keep-alives do not.
 */
export const DEFAULT_CONTENT_STALL_TIMEOUT_MS = 180_000;

/**
 * Hard deadline for one streamed chat call regardless of activity — a slow
 * trickle (content every couple of minutes) would otherwise outlive any
 * stall-based watchdog.
 */
export const DEFAULT_STREAM_MAX_DURATION_MS = 600_000;

/** Shared OpenRouter headers (chat, images, models endpoints). */
export function openRouterHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': 'https://campaigner.local',
    'X-Title': 'Campaigner',
  };
}

export async function chat(
  messages: ChatMessage[],
  opts: ChatOptions,
  retryBackoffs: readonly number[] = DEFAULT_RETRY_BACKOFFS_MS,
  stallTimeoutMs: number = DEFAULT_STREAM_STALL_TIMEOUT_MS,
  contentStallMs: number = DEFAULT_CONTENT_STALL_TIMEOUT_MS,
  maxDurationMs: number = DEFAULT_STREAM_MAX_DURATION_MS,
): Promise<string> {
  const settings = await getSettings();
  if (settings.openRouterApiKey === '') throw new MissingApiKeyError();

  // Generation-language enforcement: the settings-selected language is
  // injected into every chat completion (07 §Settings).
  const effectiveMessages = applyLanguageDirective(messages, settings.language);

  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: opts.temperature,
    stream: true,
    messages: effectiveMessages,
  };
  if (opts.responseFormat === 'json') body.response_format = { type: 'json_object' };

  const init: RequestInit & { signal?: AbortSignal | undefined } = {
    method: 'POST',
    headers: openRouterHeaders(settings.openRouterApiKey),
    body: JSON.stringify(body),
  };
  if (opts.signal !== undefined) init.signal = opts.signal;
  const response = await fetchWithRetries(
    `${OPENROUTER_BASE}/chat/completions`,
    init,
    retryBackoffs,
  );
  return readStream(response, opts.onToken, {
    stallTimeoutMs,
    contentStallMs,
    maxDurationMs,
  }, opts.onActivity);
}

/** 429/5xx responses are retried twice with backoff (defaults 2s/8s). */
export async function fetchWithRetries(
  url: string,
  init: RequestInit & { signal?: AbortSignal | undefined },
  backoffs: readonly number[],
  headersTimeoutMs: number = DEFAULT_HEADERS_TIMEOUT_MS,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchWithHeadersTimeout(url, init, headersTimeoutMs);
    if (response.ok) return response;
    const retryable = response.status === 429 || response.status >= 500;
    const backoff = backoffs[attempt];
    if (!retryable || backoff === undefined) {
      throw new OpenRouterError(response.status, await response.text());
    }
    await sleep(backoff, init.signal);
  }
}

/**
 * A fetch that never receives response HEADERS hangs forever (browsers impose
 * no timeout, and the stream-stall watchdog only starts once headers exist) —
 * the "Generating… forever" failure mode. The request is aborted loudly after
 * `headersTimeoutMs`; the caller's abort signal keeps working for the body.
 * Shared: chat/image retries AND the embeddings endpoint (a black-holed
 * embedding request used to hang runEngine's retrieve/draft steps forever).
 */
export const DEFAULT_HEADERS_TIMEOUT_MS = 60_000;

export async function fetchWithHeadersTimeout(
  url: string,
  init: RequestInit & { signal?: AbortSignal | undefined },
  headersTimeoutMs: number = DEFAULT_HEADERS_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const onCallerAbort = (): void => {
    controller.abort(init.signal?.reason);
  };
  if (init.signal !== undefined) {
    if (init.signal.aborted) onCallerAbort();
    else init.signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(
        `OpenRouter request timed out: no response headers within ${String(Math.round(headersTimeoutMs / 1000))}s — check your connection and retry`,
        'TimeoutError',
      ),
    );
  }, headersTimeoutMs);
  try {
    // Headers only: once fetch resolves, the timer is cleared — body streaming
    // is governed by the caller's signal and the stream-stall watchdog.
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Incremental SSE event parser per the WHATWG spec: events are separated by
 * blank lines, `data:` fields of one event concatenate with newlines, lines
 * starting with `:` are comments (OpenRouter's `: OPENROUTER PROCESSING`
 * keep-alives), and CR is stripped so CRLF streams work. Chunks may split
 * lines and events anywhere; push() buffers until events are complete.
 */
export class SseEventParser {
  private buffer = '';
  private dataLines: string[] = [];

  /** Feeds a decoded text chunk; returns the data payload of each complete event. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const events: string[] = [];
    for (;;) {
      const newlineAt = this.buffer.indexOf('\n');
      if (newlineAt === -1) break;
      const line = this.buffer.slice(0, newlineAt).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineAt + 1);
      if (line === '') {
        // Event boundary: dispatch the collected data field, if any.
        if (this.dataLines.length > 0) {
          events.push(this.dataLines.join('\n'));
          this.dataLines = [];
        }
        continue;
      }
      if (line.startsWith(':')) continue; // comment / keep-alive
      if (line.startsWith('data:')) {
        // Per spec, strip exactly one leading space after the field name.
        const value = line.slice(5);
        this.dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
      }
      // Other fields (event:, id:, retry:) are irrelevant here.
    }
    return events;
  }
}

/**
 * Reads an OpenRouter streaming response and concatenates content deltas.
 *
 * End-of-stream is whichever arrives first (per OpenRouter's streaming docs):
 * the `data: [DONE]` sentinel, a clean connection close, or the
 * `choices[0].finish_reason` field — OpenRouter's docs note the terminal
 * finish_reason appears on the last content chunk (and again on the usage
 * chunk), and some providers never send [DONE] nor close the socket, so
 * relying on either alone hangs the run.
 *
 * Failures that previously left runs in "streaming" forever are surfaced:
 * mid-stream errors arrive as data events with a top-level `error` field and
 * `finish_reason: "error"` (both throw), and a connection with no bytes at
 * all for `stallTimeoutMs` is aborted by a watchdog.
 */
async function readStream(
  response: Response,
  onToken: ((delta: string) => void) | undefined,
  limits: {
    stallTimeoutMs: number;
    contentStallMs: number;
    maxDurationMs: number;
  },
  onActivity: ((activity: ChatStreamActivity) => void) | undefined,
): Promise<string> {
  if (response.body === null) throw new OpenRouterError(response.status, 'empty response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseEventParser();
  let full = '';
  let reasoned = false;
  let lastActivity = Date.now();
  let lastContentAt = Date.now();
  const startedAt = Date.now();
  const { stallTimeoutMs, contentStallMs, maxDurationMs } = limits;

  const watchdog = setInterval(() => {
    const now = Date.now();
    // Liveness probe first: a caller showing progress must hear from us every
    // tick, whatever else the watchdog decides about the stream's health.
    onActivity?.({
      elapsedMs: now - startedAt,
      receivedChars: full.length,
      phase: full.length > 0 ? 'content' : reasoned ? 'thinking' : 'waiting',
    });
    // Order matters for the post-loop diagnosis: the FIRST tripped limit
    // describes the failure (silence vs keep-alive-only vs plain too long).
    if (now - lastActivity > stallTimeoutMs) {
      debugLog('llm', 'watchdog: no bytes — cancelling stream', { silentMs: now - lastActivity });
      void reader.cancel().catch(() => undefined);
    } else if (now - lastContentAt > contentStallMs) {
      debugLog('llm', 'watchdog: keep-alives but no content — cancelling stream', {
        contentSilentMs: now - lastContentAt,
        receivedChars: full.length,
      });
      void reader.cancel().catch(() => undefined);
    } else if (now - startedAt > maxDurationMs) {
      debugLog('llm', 'watchdog: total duration exceeded — cancelling stream', {
        durationMs: now - startedAt,
        receivedChars: full.length,
      });
      void reader.cancel().catch(() => undefined);
    }
  }, 1000);

  const handleEvent = (payload: string): 'done' | 'continue' => {
    if (payload === '[DONE]') return 'done';
    let delta: string | undefined;
    let errorText: string | undefined;
    let finishReason: string | null | undefined;
    try {
      const parsed = JSON.parse(payload) as {
        choices?: {
          delta?: {
            content?: string;
            reasoning?: string;
            reasoning_content?: string;
          };
          finish_reason?: string | null;
        }[];
        error?: { message?: string } | string;
      };
      delta = parsed.choices?.[0]?.delta?.content;
      // Reasoning deltas are progress (the model is working) even though they
      // are not part of the JSON reply — they count toward content activity
      // and switch the liveness probe to "thinking".
      const reasoning =
        parsed.choices?.[0]?.delta?.reasoning ?? parsed.choices?.[0]?.delta?.reasoning_content;
      if (typeof reasoning === 'string' && reasoning !== '') {
        reasoned = true;
        lastContentAt = Date.now();
      }
      finishReason = parsed.choices?.[0]?.finish_reason;
      if (parsed.error !== undefined) {
        errorText =
          typeof parsed.error === 'string'
            ? parsed.error
            : (parsed.error.message ?? 'unknown stream error');
      }
    } catch {
      return 'continue'; // ignore malformed payloads (comments never reach here)
    }
    if (errorText !== undefined) {
      throw new OpenRouterError(response.status, `stream error: ${errorText}`);
    }
    if (delta !== undefined && delta !== '') {
      full += delta;
      lastContentAt = Date.now();
      onToken?.(delta);
    }
    if (finishReason !== null && finishReason !== undefined) {
      if (finishReason === 'error') {
        // Per OpenRouter docs, mid-stream errors terminate with
        // finish_reason: "error" — even without an error field, that is a
        // failure, not a completed (truncated) answer. (An error field with
        // a message already threw above, so errorText is undefined here.)
        throw new OpenRouterError(response.status, 'stream terminated with finish_reason "error"');
      }
      return 'done';
    }
    return 'continue';
  };

  let firstByteLogged = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lastActivity = Date.now();
      if (!firstByteLogged) {
        firstByteLogged = true;
        debugLog('llm', `stream first byte after ${String(Date.now() - startedAt)}ms`);
      }
      for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
        if (handleEvent(payload) === 'done') {
          // Completion happens before the body is fully drained (the usage
          // chunk and [DONE] tail are never read): cancel the reader so the
          // socket is released back to the pool instead of leaking until GC.
          debugLog(
            'llm',
            `stream complete: ${String(full.length)} chars in ${String(Date.now() - startedAt)}ms`,
          );
          void reader.cancel().catch(() => undefined);
          return full;
        }
      }
    }
  } catch (error) {
    // Tear the connection down on failures too (mid-stream error event,
    // abort, watchdog stall) so a broken stream never lingers half-read.
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearInterval(watchdog);
  }
  // The reader was cancelled by a watchdog (or the socket closed): diagnose
  // WHICH limit tripped — in the watchdog's order — and fail loudly.
  const now = Date.now();
  if (now - startedAt > maxDurationMs) {
    throw new OpenRouterError(
      response.status,
      `stream exceeded ${String(Math.round(maxDurationMs / 1000))}s total — aborted; retry the run`,
    );
  }
  if (now - lastContentAt > contentStallMs) {
    throw new OpenRouterError(
      response.status,
      `stream delivered no content for ${String(Math.round(contentStallMs / 1000))}s ` +
        '(keep-alives only) — the provider accepted the request but never answered; retry the run',
    );
  }
  if (now - lastActivity > stallTimeoutMs) {
    throw new OpenRouterError(
      response.status,
      `stream stalled after ${String(Math.round(stallTimeoutMs / 1000))}s of silence`,
    );
  }
  return full;
}

export interface OpenRouterModel {
  id: string;
  name?: string;
}

/** GET /api/v1/models — used by "Test key" and the model combobox. */
export async function listModels(): Promise<OpenRouterModel[]> {
  const settings = await getSettings();
  if (settings.openRouterApiKey === '') throw new MissingApiKeyError();
  const response = await fetch(`${OPENROUTER_BASE}/models`, {
    headers: { Authorization: `Bearer ${settings.openRouterApiKey}` },
  });
  if (!response.ok) throw new OpenRouterError(response.status, await response.text());
  const json = (await response.json()) as { data?: OpenRouterModel[] };
  return json.data ?? [];
}

/**
 * Model ids that can generate images (07-MILESTONE-3 M3-A §Settings): the
 * /models endpoint is filtered server-side via output_modalities=image; a
 * client-side check on each entry keeps the result robust.
 */
export async function listImageModels(): Promise<string[]> {
  const settings = await getSettings();
  if (settings.openRouterApiKey === '') throw new MissingApiKeyError();
  const response = await fetch(`${OPENROUTER_BASE}/models?output_modalities=image`, {
    headers: { Authorization: `Bearer ${settings.openRouterApiKey}` },
  });
  if (!response.ok) throw new OpenRouterError(response.status, await response.text());
  const json = (await response.json()) as {
    data?: ({ id?: string; output_modalities?: string[] } | null | undefined)[];
  };
  const imageModelIds: string[] = [];
  for (const model of json.data ?? []) {
    if (model?.id === undefined) continue;
    if (!(model.output_modalities?.includes('image') ?? true)) continue;
    imageModelIds.push(model.id);
  }
  return imageModelIds.sort();
}

/** Minimal validated slice of GET /api/v1/models (boundary rule: zod). */
const visionModelResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      architecture: z
        .object({
          input_modalities: z.array(z.string()),
          output_modalities: z.array(z.string()),
        })
        .optional(),
    }),
  ),
});

/**
 * Chat models that accept image input (docs/11 §verify): the /models endpoint
 * is filtered server-side via input_modalities=image; the client-side check
 * also requires text output, excluding pure image generators. Used by the
 * "Encounter map verify model" browse list — a non-vision chat model fails
 * the verify step with "No endpoints found that support image input".
 */
export async function listVisionChatModels(): Promise<string[]> {
  const settings = await getSettings();
  if (settings.openRouterApiKey === '') throw new MissingApiKeyError();
  const response = await fetch(`${OPENROUTER_BASE}/models?input_modalities=image`, {
    headers: { Authorization: `Bearer ${settings.openRouterApiKey}` },
  });
  if (!response.ok) throw new OpenRouterError(response.status, await response.text());
  const json = visionModelResponseSchema.parse(await response.json());
  return json.data
    .filter(
      (model) =>
        (model.architecture?.input_modalities.includes('image') ?? false) &&
        (model.architecture?.output_modalities.includes('text') ?? false),
    )
    .map((model) => model.id)
    .sort();
}
