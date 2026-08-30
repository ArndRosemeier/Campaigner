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
    super(`OpenRouter request failed (${String(status)})`);
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

export async function chat(
  messages: ChatMessage[],
  opts: ChatOptions,
  retryBackoffs: readonly number[] = DEFAULT_RETRY_BACKOFFS_MS,
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
  return readStream(response, opts.onToken);
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

/** Parses `data: {json}` SSE lines, concatenating content deltas. */
async function readStream(response: Response, onToken?: (delta: string) => void): Promise<string> {
  if (response.body === null) throw new OpenRouterError(response.status, 'empty response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
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
      try {
        const parsed = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        delta = parsed.choices?.[0]?.delta?.content;
      } catch {
        continue; // ignore keep-alive/malformed lines
      }
      if (delta !== undefined && delta !== '') {
        full += delta;
        onToken?.(delta);
      }
    }
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
