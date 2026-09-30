import type { Settings } from '@/domain';
import { getCachedModels, type CachedModel } from '@/llm/modelCache';
import { chainError, fallbackReasonFor, MissingApiKeyError, type FallbackReason } from '@/llm/openrouterErrors';
import { debugLog } from '@/lib/debug';

/**
 * Central model resolution and escalation-chain construction (model fallback
 * feature). One home for what every LLM/image call site used to duplicate.
 *
 * The tiers, cheapest first:
 *   1. First-try model — persona override or settings default. A cheaper
 *      model is fine; it is the workhorse.
 *   2. Fallback model — the escalation tier (settings `fallbackChatModel` /
 *      `fallbackImageModel`). Used when the first-try model fails AT ALL:
 *      escalation is unconditional (owner decision 2026-09-07, "ANY ERROR,
 *      ANY AT ALL should lead to the fallback") — the chain itself is the
 *      bound. Pick one at least as capable as the first-try models.
 *      Defining it activates it — '' means no escalation and failures stay
 *      loud (AGENTS rule 1).
 */

/** The first-try chat model: `preferredModel` (a persona override) when set,
 * else the settings default. */
export function resolveChatModel(
  settings: Pick<Settings, 'defaultChatModel'>,
  preferredModel = '',
): string {
  return preferredModel !== '' ? preferredModel : settings.defaultChatModel;
}

/** The first-try image model. Trivial today, but the single place that knows
 * where the image tier comes from. */
export function resolveImageModel(settings: Pick<Settings, 'imageModel'>): string {
  return settings.imageModel;
}

/**
 * The escalation chain for one call: `[primary, fallback]`. The fallback is
 * dropped when disabled ('') or identical to the primary — a chain entry is
 * never attempted twice, so `fallback === primary` means "no fallback".
 */
export function buildModelChain(primary: string, fallbackModel: string): string[] {
  return fallbackModel === '' || fallbackModel === primary ? [primary] : [primary, fallbackModel];
}

/**
 * The model for the ONE contract-repair attempt (invalid JSON, too-short
 * output, violated reply contract): the escalation tier when configured.
 * Contract violations are usually a capability weakness of the first-try
 * model, so the repair — which carries the specific diagnosis — goes to the
 * more potent fallback model. Without one, the repair stays on the model
 * that failed (the behavior before this feature existed).
 */
export function repairModel(
  firstTryModel: string,
  settings: Pick<Settings, 'fallbackChatModel'>,
): string {
  const { fallbackChatModel } = settings;
  return fallbackChatModel === '' || fallbackChatModel === firstTryModel
    ? firstTryModel
    : fallbackChatModel;
}

/**
 * Cached knowledge of whether a model accepts image INPUT (vision):
 * `undefined` when the cache has no answer (model unknown or no
 * architecture data) — callers must then attempt anyway, loudly.
 */
export function modelAcceptsImageInput(
  modelId: string,
  models: readonly CachedModel[] | null,
): boolean | undefined {
  if (models === null) return undefined;
  const found = models.find((model) => model.id === modelId);
  if (found?.architecture?.input_modalities === undefined) return undefined;
  return found.architecture.input_modalities.includes('image');
}

/**
 * The escalation info a mid-chain success carries (openrouter's ChatFallback
 * is structurally this — both call sites render it).
 */
export interface ChainFallback {
  from: string;
  to: string;
  reason: FallbackReason;
}

/**
 * The ONLY model-independent failure classes — errors that fail identically
 * for every model in the chain, so escalating cannot help (owner-ratified
 * minimal list, 2026-09-07; everything else escalates):
 *
 * - `MissingApiKeyError`: no key is account-level, not model-level — every
 *   attempt would fail the same way; escalating is pure noise.
 * - a user-initiated abort (the platform `AbortError` DOMException — the
 *   caller's AbortSignal, e.g. Stop all / run cancel): escalating would
 *   defy the stop the user just asked for. (The transport's own watchdog
 *   timeouts abort with `TimeoutError`, which is congestion and escalates.)
 */
function isModelIndependentFailure(error: unknown): boolean {
  if (error instanceof MissingApiKeyError) return true;
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Exposed for call sites that wrap a failed walk's error (e.g. imageGen's
 * config-gap guidance): those must leave model-independent failures
 * untouched, exactly as the walk itself does. */
export { isModelIndependentFailure };

export interface WalkModelChainOptions {
  /** The combined end-of-chain error's label (chainError kind). */
  kind: 'chat' | 'image';
  /**
   * True when the request needs image INPUT (vision messages or image-edit
   * references): a fallback model the cached /models data knows is text-only
   * is not attempted — the failing model's own error stays the diagnosis. An
   * unknown fallback (not cached or no architecture data) is attempted
   * anyway, loudly.
   */
  needsImageInput?: boolean;
  /** Fired when the walk escalates to the next chain entry. */
  onFallback?: ((info: ChainFallback) => void) | undefined;
  /**
   * Fired before each attempt after the first: the previous attempt may have
   * streamed partial tokens — subscribers must clear their buffers before
   * the restarted stream appends.
   */
  onReset?: (() => void) | undefined;
}

export interface ChainWalkResult<T> {
  value: T;
  /** The chain entry that produced `value`. */
  modelUsed: string;
  /** Escalation info on a mid-chain success; null on a first-try success. */
  fallback: ChainFallback | null;
}

/**
 * THE model-escalation walk (one implementation for the formerly divergent
 * copies in openrouter.chat and imageGen.generateImages). Unified contract
 * (owner decision 2026-09-07 — escalation is UNCONDITIONAL):
 *
 * - every model failure advances to the next chain entry — 'length'
 *   truncation, strict-schema rejections, unknown 400s (e.g. Meta's
 *   content-management-policy body the filter pattern never matched),
 *   watchdog stalls, refusals, unexpected throws: ALL escalate ("ANY ERROR,
 *   ANY AT ALL should lead to the fallback");
 * - the only stops are the model-independent failures
 *   (`isModelIndependentFailure`: MissingApiKeyError, user aborts — they
 *   rethrow the ORIGINAL error unchanged, no wrapping) and a single-entry
 *   chain (the bound is exhausted immediately; the original error stays the
 *   diagnosis, exactly the pre-fallback-feature surface);
 * - the vision guard blocks escalation to the NEXT entry (chain[attempts+1],
 *   mid-chain-correct — the chat copy used the fixed `chain[1]`) when
 *   `needsImageInput` is set and the cache knows that entry cannot take
 *   image input; the primary's failure stays the diagnosis;
 * - exhausting the chain throws the combined chainError(failures, kind):
 *   every model tried, in order, last error's kind/status surviving.
 */
export async function walkModelChain<T>(
  chain: readonly string[],
  tryModel: (model: string) => Promise<T>,
  opts: WalkModelChainOptions,
): Promise<ChainWalkResult<T>> {
  const firstModel = chain[0];
  if (firstModel === undefined) throw new Error('the model escalation chain is empty');
  const failures: { model: string; error: unknown }[] = [];
  for (let attempt = 0; attempt < chain.length; attempt += 1) {
    const model = chain[attempt];
    if (model === undefined) break;
    if (attempt > 0) {
      // Escalation is unconditional, so this fires for EVERY previous
      // failure; the reason is the honest classification of the trigger
      // ('other' when no specific class applies) — never a gate.
      const reason = fallbackReasonFor(failures[failures.length - 1]?.error) ?? 'other';
      opts.onFallback?.({ from: firstModel, to: model, reason });
      opts.onReset?.();
    }
    try {
      const value = await tryModel(model);
      return {
        value,
        modelUsed: model,
        fallback:
          attempt === 0
            ? null
            : {
                from: firstModel,
                to: model,
                reason: fallbackReasonFor(failures[0]?.error) ?? 'other',
              },
      };
    } catch (error) {
      failures.push({ model, error });
      // Model-independent failures (no API key, user abort): escalating
      // cannot help — fail immediately on the original error.
      if (isModelIndependentFailure(error)) throw error;
      // Single-model chain: behavior is exactly what it was before the
      // fallback feature — no wrapping, no change.
      if (chain.length === 1) throw error;
      // Vision guard: never waste an attempt on a fallback that cannot even
      // accept the request — rethrow the failing model's error unchanged.
      const next = chain[attempt + 1];
      if (
        next !== undefined &&
        opts.needsImageInput === true &&
        modelAcceptsImageInput(next, getCachedModels()) === false
      ) {
        debugLog('llm', 'fallback skipped: request needs image input the fallback model cannot take');
        throw error;
      }
      // Anything else escalates: the loop's next iteration tries the next
      // chain entry; exhausting the chain throws the combined chainError.
    }
  }
  throw chainError(failures, opts.kind);
}
