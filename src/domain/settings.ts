import { z } from 'zod';

import { DEFAULT_IMAGE_MODEL } from '@/domain/image';

/** The settings table holds a single row with this fixed id. */
export const SETTINGS_ID = 'settings';

/** Default OpenRouter models (01-DATA-MODEL §Settings). */
export const DEFAULT_CHAT_MODEL = 'anthropic/claude-sonnet-4.5';
export const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';

export const settingsSchema = z.object({
  id: z.literal(SETTINGS_ID),
  /** '' when unset. */
  openRouterApiKey: z.string(),
  defaultChatModel: z.string().min(1),
  embeddingModel: z.string().min(1),
  /** Default false until an API key is present. */
  embeddingsEnabled: z.boolean(),
  /** Image generation model (M3-A). */
  imageModel: z.string().min(1),
  /** Image generation off until the user opts in (M3-A). */
  imagesEnabled: z.boolean(),
});

export type Settings = z.infer<typeof settingsSchema>;

/** The default settings row, created on first read. */
export function defaultSettings(): Settings {
  return {
    id: SETTINGS_ID,
    openRouterApiKey: '',
    defaultChatModel: DEFAULT_CHAT_MODEL,
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    embeddingsEnabled: false,
    imageModel: DEFAULT_IMAGE_MODEL,
    imagesEnabled: false,
  };
}
