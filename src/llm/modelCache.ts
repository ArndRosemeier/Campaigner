import { z } from 'zod';

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

/** GET /api/v1/models — validated at the boundary (AGENTS rule 3):
 * unknown entry fields pass through; only the fields the app consumes are
 * declared (unknown fields are stripped, as with the vision model schema).
 * `output_modalities` sits at the top level on the output_modalities=image
 * filtered endpoint (listImageModels). */
export const modelEntrySchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    supported_parameters: z.array(z.string()).optional(),
    output_modalities: z.array(z.string()).optional(),
    architecture: z
      .object({
        input_modalities: z.array(z.string()).optional(),
        output_modalities: z.array(z.string()).optional(),
      })
      .optional(),
  });

export const modelsResponseSchema = z.object({
  data: z.array(modelEntrySchema.nullable()).optional(),
});

let cachedModels: CachedModel[] | null = null;

export function setCachedModels(models: readonly CachedModel[]): void {
  cachedModels = [...models];
}

export function getCachedModels(): CachedModel[] | null {
  return cachedModels;
}