import { z } from 'zod';

import { DEFAULT_IMAGE_MODEL } from '@/domain/image';

/** The settings table holds a single row with this fixed id. */
export const SETTINGS_ID = 'settings';

/**
 * Languages a user can pick for generated content. The first entry is the
 * default ("default to English"); codes are stable storage values.
 */
export const GENERATION_LANGUAGE_CODES = [
  'en',
  'de',
  'fr',
  'es',
  'it',
  'pt',
  'nl',
  'pl',
  'ru',
  'ja',
  'zh',
] as const;

export type GenerationLanguage = (typeof GENERATION_LANGUAGE_CODES)[number];

/** Picker entries: native label first so the list reads naturally. */
export const GENERATION_LANGUAGES: readonly {
  code: GenerationLanguage;
  label: string;
}[] = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch (German)' },
  { code: 'fr', label: 'Français (French)' },
  { code: 'es', label: 'Español (Spanish)' },
  { code: 'it', label: 'Italiano (Italian)' },
  { code: 'pt', label: 'Português (Portuguese)' },
  { code: 'nl', label: 'Nederlands (Dutch)' },
  { code: 'pl', label: 'Polski (Polish)' },
  { code: 'ru', label: 'Русский (Russian)' },
  { code: 'ja', label: '日本語 (Japanese)' },
  { code: 'zh', label: '中文 (Chinese)' },
];

/** English label for a language code ('English' for the default 'en'). */
export function generationLanguageLabel(code: string): string {
  return GENERATION_LANGUAGES.find((language) => language.code === code)?.label ?? 'English';
}

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
  /**
   * Language every generation prompt is required to produce (default
   * English). Enforced client-side by injecting a directive into each chat
   * completion (see /src/llm/language.ts).
   */
  language: z.enum(GENERATION_LANGUAGE_CODES).default('en'),
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
    language: 'en',
  };
}
