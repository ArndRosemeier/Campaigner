import { getSettings } from '@/db/settingsRepo';
import { applyLanguageDirective } from '@/llm/language';

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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model: string;
  temperature: number;
  /** Sets response_format: { type: 'json_object' }. */
  responseFormat?: 'json' | undefined;
  signal?: AbortSignal | undefined;
  /** Streaming callback, invoked once per content delta. */
  onToken?: ((delta: string) => void) | undefined;
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
  return readStream(response, opts.onToken, stallTimeoutMs);
}

/** 429/5xx responses are retried twice with backoff (defaults 2s/8s). */
export async function fetchWithRetries(
  url: string,
  init: RequestInit & { signal?: AbortSignal | undefined },
  backoffs: readonly number[],
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      ...init,
      ...(init.signal !== undefined ? { signal: init.signal } : {}),
    });
    if (response.ok) return response;
    const retryable = response.status === 429 || response.status >= 500;
    const backoff = backoffs[attempt];
    if (!retryable || backoff === undefined) {
      throw new OpenRouterError(response.status, await response.text());
    }
    await sleep(backoff, init.signal);
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
  stallTimeoutMs: number,
): Promise<string> {
  if (response.body === null) throw new OpenRouterError(response.status, 'empty response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseEventParser();
  let full = '';
  let lastActivity = Date.now();

  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > stallTimeoutMs) {
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
          delta?: { content?: string; reasoning?: string; reasoning_content?: string };
          finish_reason?: string | null;
        }[];
        error?: { message?: string } | string;
      };
      delta = parsed.choices?.[0]?.delta?.content;
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

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lastActivity = Date.now();
      for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
        if (handleEvent(payload) === 'done') {
          // Completion happens before the body is fully drained (the usage
          // chunk and [DONE] tail are never read): cancel the reader so the
          // socket is released back to the pool instead of leaking until GC.
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
  if (Date.now() - lastActivity > stallTimeoutMs) {
    throw new OpenRouterError(
      response.status,
      `stream stalled after ${String(stallTimeoutMs)}ms of silence`,
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
