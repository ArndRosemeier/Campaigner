import type { Settings } from '@/domain';
import type { CachedModel } from '@/llm/modelCache';

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
