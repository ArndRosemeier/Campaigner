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
  /**
   * True when the model rejected the requested candidate count (its provider
   * caps `n` at 1) and the request was retried with a single image. Callers
   * MUST surface this — AGENTS rule 1 forbids silent degradations.
   */
  cappedToOne: boolean;
}

export interface GenerateImagesOptions {
  model: string;
  signal?: AbortSignal | undefined;
  retryBackoffs?: readonly number[];
  /** Structure-first image edits (encounter schematic → stylized map). */
  inputReferences?: readonly { dataUrl: string }[];
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
 * Generates up to `n` images for `prompt` with the given model. Each returned
 * Blob carries the API-reported media type (defaulting to image/webp).
 *
 * Some models (e.g. `x-ai/grok-imagine-image-2.0`) only support `n: 1`. When
 * OpenRouter rejects the requested count with a 400 naming the parameter, the
 * request is retried ONCE with a single image and `cappedToOne: true` — the
 * caller must surface the degradation (AGENTS rule 1: no silent fallbacks).
 * Any other 400 fails loudly.
 *
 * Headers timeout: image generation is NOT streaming — the API sends no
 * response headers until the picture is fully rendered, so the shared 60s
 * chat headers timeout aborted most generations mid-flight. Images get 5
 * minutes (M4-C: users reported frequent 60s timeouts).
 */
export const IMAGE_HEADERS_TIMEOUT_MS = 5 * 60 * 1000;

/** Matches 400 bodies like `... supports the requested parameter(s): n "2"` —
 * i.e. the rejection is about the candidate count, not the prompt or model. */
const N_UNSUPPORTED_PATTERN = /parameter\(s\):?[^]*\bn\b/i;

/**
 * Models observed to cap `n` at 1. After the first rejection the request is
 * sent with a single image right away — skipping the doomed 400 round-trip —
 * while still reporting `cappedToOne` so the UI can tell the user. Session
 * memory only; a settings change or reload starts fresh.
 */
const cappedToOneModels = new Set<string>();

async function postImages(
  prompt: string,
  n: number,
  opts: GenerateImagesOptions,
  settings: { openRouterApiKey: string },
): Promise<Response> {
  const init: RequestInit & { signal?: AbortSignal | undefined } = {
    method: 'POST',
    headers: openRouterHeaders(settings.openRouterApiKey),
    body: JSON.stringify({
      model: opts.model,
      prompt,
      n,
      output_format: 'webp',
      ...(opts.inputReferences === undefined
        ? {}
        : {
            input_references: opts.inputReferences.map((reference) => ({
              type: 'image_url',
              image_url: { url: reference.dataUrl },
            })),
          }),
    }),
  };
  if (opts.signal !== undefined) init.signal = opts.signal;
  return fetchWithRetries(
    `${OPENROUTER_BASE}/images`,
    init,
    opts.retryBackoffs ?? DEFAULT_RETRY_BACKOFFS_MS,
    IMAGE_HEADERS_TIMEOUT_MS,
  );
}

export async function generateImages(
  prompt: string,
  n: number,
  opts: GenerateImagesOptions,
): Promise<GeneratedImages> {
  const settings = await getSettings();
  if (settings.openRouterApiKey === '') throw new MissingApiKeyError();

  let response: Response;
  let cappedToOne = false;
  if (n > 1 && cappedToOneModels.has(opts.model)) {
    // Known cap (learned from a previous rejection): ask for one image
    // immediately and report it — the caller still surfaces the degradation.
    cappedToOne = true;
    response = await postImages(prompt, 1, opts, settings);
  } else {
    try {
      response = await postImages(prompt, n, opts, settings);
    } catch (error) {
      // If the model rejects input_references (HTTP 400 when input_references
      // were provided, common for models that only support text-to-image),
      // retry cleanly as pure text-to-image without reference images.
      if (
        error instanceof OpenRouterError &&
        error.status === 400 &&
        opts.inputReferences !== undefined &&
        opts.inputReferences.length > 0
      ) {
        const { inputReferences: _omitted, ...cleanOpts } = opts;
        return generateImages(prompt, n, cleanOpts);
      }

      // The provider caps n at 1: retry once with a single candidate, mark
      // the model, and report the cap (never a silent degrade).
      if (
        !(error instanceof OpenRouterError) ||
        error.status !== 400 ||
        n <= 1 ||
        !N_UNSUPPORTED_PATTERN.test(error.bodyText)
      ) {
        throw error;
      }
      cappedToOne = true;
      cappedToOneModels.add(opts.model);
      response = await postImages(prompt, 1, opts, settings);
    }
  }
  if (!response.ok) {
    // Re-read the body of a non-JSON/failed retry — fetchWithRetries already
    // threw for the first attempt, so this is the retried request's error.
    throw new OpenRouterError('http', response.status, await response.text());
  }

  let json: ImageApiResponse;
  try {
    json = (await response.json()) as ImageApiResponse;
  } catch {
    throw new OpenRouterError('http', response.status, 'image API returned no JSON body');
  }

  const images = (json.data ?? []).flatMap((entry) => {
    if (entry === undefined || entry === null) return [];
    const b64 = entry.b64_json;
    if (typeof b64 !== 'string' || b64 === '') return [];
    return [new Blob([decodeBase64(b64)], { type: entry.media_type ?? 'image/webp' })];
  });
  if (images.length === 0) {
    throw new OpenRouterError('no-images', response.status, 'image API returned no images');
  }

  const cost = json.usage?.cost;
  return { images, costUsd: typeof cost === 'number' ? cost : null, cappedToOne };
}
