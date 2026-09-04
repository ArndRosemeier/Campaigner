import { DEFAULT_RETRY_BACKOFFS_MS, MissingApiKeyError, OPENROUTER_BASE, OpenRouterError, fetchWithRetries, openRouterHeaders } from '@/llm/openrouter';
import { getSettings } from '@/db/settingsRepo';
import { getCachedModels } from '@/llm/modelCache';
import { buildModelChain, modelAcceptsImageInput } from '@/llm/modelFallback';
import { chainError, fallbackReasonFor } from '@/llm/openrouterErrors';
import { bytesFromBase64 } from '@/lib/base64';

/**
 * Image generation client (07-MILESTONE-3 M3-A): OpenRouter's dedicated
 * Image API — `POST /api/v1/images` with `{ model, prompt, n, output_format }`
 * returning `{ data: [{ b64_json, media_type }], usage: { cost, … } }`. No
 * streaming; same retry/error policy as the chat client.
 */

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
  /** The model that actually produced the images (escalation-aware). */
  modelUsed: string;
}

export interface GenerateImagesOptions {
  model: string;
  signal?: AbortSignal | undefined;
  retryBackoffs?: readonly number[];
  /** Structure-first image edits (encounter schematic → stylized map). */
  inputReferences?: readonly { dataUrl: string }[];
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

/**
 * The per-model generation body (transport-level adaptations — input-
 * reference omission, cappedToOne — stay inside one model's attempt).
 */
async function generateImagesWithModel(
  prompt: string,
  n: number,
  opts: GenerateImagesOptions,
  settings: { openRouterApiKey: string },
  model: string,
): Promise<GeneratedImages> {
  const attempt = { ...opts, model };
  let response: Response;
  let cappedToOne = false;
  if (n > 1 && cappedToOneModels.has(model)) {
    // Known cap (learned from a previous rejection): ask for one image
    // immediately and report it — the caller still surfaces the degradation.
    cappedToOne = true;
    response = await postImages(prompt, 1, attempt, settings);
  } else {
    try {
      response = await postImages(prompt, n, attempt, settings);
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
        return generateImagesWithModel(prompt, n, cleanOpts, settings, model);
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
      cappedToOneModels.add(model);
      response = await postImages(prompt, 1, attempt, settings);
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
    return [new Blob([bytesFromBase64(b64)], { type: entry.media_type ?? 'image/webp' })];
  });
  if (images.length === 0) {
    throw new OpenRouterError('no-images', response.status, 'image API returned no images');
  }

  const cost = json.usage?.cost;
  return {
    images,
    costUsd: typeof cost === 'number' ? cost : null,
    cappedToOne,
    modelUsed: model,
  };
}

/**
 * Generates up to `n` images for `prompt`, escalating across the model
 * fallback chain when the first-try model is congested or refuses (transport
 * failures only — image generation has no output contract to repair). The
 * returned `modelUsed` tells the caller which model produced the images so
 * image rows record the truth instead of the requested model.
 */
export async function generateImages(
  prompt: string,
  n: number,
  opts: GenerateImagesOptions,
): Promise<GeneratedImages> {
  const settings = await getSettings();
  if (settings.openRouterApiKey === '') throw new MissingApiKeyError();

  const chain = buildModelChain(opts.model, settings.fallbackImageModel);
  const failures: { model: string; error: unknown }[] = [];
  for (const model of chain) {
    try {
      return await generateImagesWithModel(prompt, n, opts, settings, model);
    } catch (error) {
      failures.push({ model, error });
      // A user cancel is never an escalation trigger.
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      // Anything not classified congestion/filter fails loudly, as before.
      if (fallbackReasonFor(error) === null) throw error;
      // Single-model chain: the original error propagates unchanged.
      if (chain.length === 1) throw error;
      // Vision guard for structure-first edits: an image-input request is
      // not wasted on a fallback model the cache knows is text-to-image
      // only — the primary's own failure stays the diagnosis.
      const next = chain[chain.indexOf(model) + 1];
      if (
        next !== undefined &&
        opts.inputReferences !== undefined &&
        opts.inputReferences.length > 0 &&
        modelAcceptsImageInput(next, getCachedModels()) === false
      ) {
        throw error;
      }
    }
  }
  // Every model in the chain failed with congestion/filter errors.
  throw chainError(failures, 'image');
}
