import { DEFAULT_RETRY_BACKOFFS_MS, MissingApiKeyError, OpenRouterError, fetchWithRetries, openRouterHeaders } from '@/llm/openrouter';
import { getSettings } from '@/db/settingsRepo';

/**
 * Image generation client (07-MILESTONE-3 M3-A): OpenRouter's dedicated
 * Image API — `POST /api/v1/images` with `{ model, prompt, n, output_format }`
 * returning `{ data: [{ b64_json, media_type }], usage: { cost, … } }`. No
 * streaming; same retry/error policy as the chat client.
 */

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export interface GeneratedImages {
  images: Blob[];
  /** Total generation cost in USD from the API's usage object, if reported. */
  costUsd: number | null;
}

export interface GenerateImagesOptions {
  model: string;
  signal?: AbortSignal | undefined;
  retryBackoffs?: readonly number[];
}

/** Decodes base64 image bytes from the API response. */
function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

interface ImageApiResponse {
  data?: ({ b64_json?: string; media_type?: string } | null | undefined)[];
  usage?: { cost?: number };
}

/**
 * Generates `n` images for `prompt` with the given model. Each returned Blob
 * carries the API-reported media type (defaulting to image/webp).
 */
export async function generateImages(
  prompt: string,
  n: number,
  opts: GenerateImagesOptions,
): Promise<GeneratedImages> {
  const settings = await getSettings();
  if (settings.openRouterApiKey === '') throw new MissingApiKeyError();

  const init: RequestInit & { signal?: AbortSignal | undefined } = {
    method: 'POST',
    headers: openRouterHeaders(settings.openRouterApiKey),
    body: JSON.stringify({ model: opts.model, prompt, n, output_format: 'webp' }),
  };
  if (opts.signal !== undefined) init.signal = opts.signal;

  const response = await fetchWithRetries(
    `${OPENROUTER_BASE}/images`,
    init,
    opts.retryBackoffs ?? DEFAULT_RETRY_BACKOFFS_MS,
  );

  let json: ImageApiResponse;
  try {
    json = (await response.json()) as ImageApiResponse;
  } catch {
    throw new OpenRouterError(response.status, 'image API returned no JSON body');
  }

  const images = (json.data ?? []).flatMap((entry) => {
    if (entry === undefined || entry === null) return [];
    const b64 = entry.b64_json;
    if (typeof b64 !== 'string' || b64 === '') return [];
    return [new Blob([decodeBase64(b64)], { type: entry.media_type ?? 'image/webp' })];
  });
  if (images.length === 0) {
    throw new OpenRouterError(response.status, 'image API returned no images');
  }

  const cost = json.usage?.cost;
  return { images, costUsd: typeof cost === 'number' ? cost : null };
}
