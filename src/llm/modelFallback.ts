import type { Settings } from '@/domain';
import { getCachedModels, type CachedModel } from '@/llm/modelCache';
import { chainError, fallbackReasonFor, type FallbackReason } from '@/llm/openrouterErrors';
import { debugLog } from '@/lib/debug';

/**
 * Central model resolution and escalation-chain construction (model fallback
 * feature). One home for what every LLM/image call site used to duplicate.
 *
 * The tiers, cheapest first:
 *   1. First-try model — persona override or settings default. A cheaper
 *      model is fine; it is the workhorse.
 *   2. Fallback model — the escalation tier (settings `fallbackChatModel` /
 *      `fallbackImageModel`). Used when the first-try model is congested,
 *      refuses content, or fails the output contract; pick one at least as
 *      capable as the first-try models. Defining it activates it — '' means
 *      no escalation and failures stay loud (AGENTS rule 1).
 */

/** The first-try chat model: `preferredModel` (persona override, verify
 * model) when set, else the settings default. */
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
 * The repair model for a VISION call (e.g. encounter-map verification): the
 * escalation tier only when the cached /models data knows it accepts image
 * input. An unknown fallback is attempted anyway — the failure stays loud.
 */
export function visionRepairModel(
  firstTryModel: string,
  fallbackModel: string,
  models: readonly CachedModel[] | null,
): string {
  const chain = buildModelChain(firstTryModel, fallbackModel);
  const escalated = chain[chain.length - 1];
  if (escalated === undefined || escalated === firstTryModel) return firstTryModel;
  return modelAcceptsImageInput(escalated, models) === false ? firstTryModel : escalated;
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
 * copies in openrouter.chat and imageGen.generateImages). Unified contract:
 *
 * - every failure is recorded, then the walk decides:
 *   a user cancel (AbortError), an unclassifiable error (fallbackReasonFor
 *   null) and a single-entry chain rethrow the ORIGINAL error unchanged —
 *   the three checks are order-swappable (all rethrow the same error);
 * - the vision guard blocks escalation to the NEXT entry (chain[attempts+1],
 *   mid-chain-correct — the chat copy used the fixed `chain[1]`) when
 *   `needsImageInput` is set and the cache knows that entry cannot take
 *   image input; the primary's failure stays the diagnosis;
 * - exhausting the chain throws the combined chainError(failures, kind).
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
      const reason = fallbackReasonFor(failures[failures.length - 1]?.error);
      if (reason !== null) opts.onFallback?.({ from: firstModel, to: model, reason });
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
                reason: fallbackReasonFor(failures[0]?.error) ?? 'congestion',
              },
      };
    } catch (error) {
      failures.push({ model, error });
      // A user cancel is never an escalation trigger.
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      // Anything not classified congestion/filter fails loudly, as before.
      if (fallbackReasonFor(error) === null) throw error;
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
    }
  }
  throw chainError(failures, opts.kind);
}
