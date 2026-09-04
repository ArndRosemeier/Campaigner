/**
 * Session cache of the OpenRouter /models list. A leaf module of its own so
 * capability checks (reasoning support, vision-capable escalation) can read
 * the cache without importing the streaming client — and so tests that mock
 * the client still see the real, empty-by-default cache instead of needing a
 * mock seam.
 */

/** Structural shape of a /models entry (only the fields the app uses). */
export interface CachedModel {
  id: string;
  name?: string;
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[]; output_modalities?: string[] } | undefined;
}

let cachedModels: CachedModel[] | null = null;

export function setCachedModels(models: readonly CachedModel[]): void {
  cachedModels = [...models];
}

export function getCachedModels(): CachedModel[] | null {
  return cachedModels;
}