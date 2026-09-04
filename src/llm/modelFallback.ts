import type { Settings } from '@/domain';

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
