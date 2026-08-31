import { getSettings } from '@/db/settingsRepo';

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

export async function chat(
  messages: ChatMessage[],
  opts: ChatOptions,
  retryBackoffs: readonly number[] = DEFAULT_RETRY_BACKOFFS_MS,
  stallTimeoutMs: number = DEFAULT_STREAM_STALL_TIMEOUT_MS,
): Promise<string> {
  const settings = await getSettings();
  if (settings.openRouterApiKey === '') throw new MissingApiKeyError();

  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: opts.temperature,
    stream: true,
    messages,
  };
  if (opts.responseFormat === 'json') body.response_format = { type: 'json_object' };

  const init: RequestInit & { signal?: AbortSignal | undefined } = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.openRouterApiKey}`,
      'HTTP-Referer': 'https://campaigner.local',
      'X-Title': 'Campaigner',
    },
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
async function fetchWithRetries(
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
 * Parses `data: {json}` SSE lines, concatenating content deltas. Aborts with
 * an error when the connection goes silent for `stallTimeoutMs`, and treats
 * in-stream `{ "error": … }` events as hard failures instead of ignoring
 * them (both previously left runs stuck in "streaming" forever).
 */
async function readStream(
  response: Response,
  onToken: ((delta: string) => void) | undefined,
  stallTimeoutMs: number,
): Promise<string> {
  if (response.body === null) throw new OpenRouterError(response.status, 'empty response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let lastActivity = Date.now();

  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > stallTimeoutMs) {
      void reader.cancel().catch(() => undefined);
    }
  }, 1000);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lastActivity = Date.now();
      buffer += decoder.decode(value, { stream: true });
      let newlineAt = buffer.indexOf('\n');
      while (newlineAt !== -1) {
        const line = buffer.slice(0, newlineAt).trimEnd();
        buffer = buffer.slice(newlineAt + 1);
        newlineAt = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          return full;
        }
        let delta: string | undefined;
        let errorText: string | undefined;
        let finishReason: string | null | undefined;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
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
          continue; // ignore keep-alive/malformed lines
        }
        if (errorText !== undefined) {
          throw new OpenRouterError(response.status, `stream error: ${errorText}`);
        }
        if (delta !== undefined && delta !== '') {
          full += delta;
          onToken?.(delta);
        }
        if (finishReason !== null && finishReason !== undefined) {
          // The model finished. Some providers never send the [DONE] sentinel
          // nor close the socket (keep-alive comments keep flowing), which
          // used to leave runs in "streaming" forever — the finish_reason is
          // the authoritative end marker, so stop reading here.
          return full;
        }
      }
    }
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
