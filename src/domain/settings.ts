import { z } from 'zod';

import { DEFAULT_IMAGE_MODEL } from '@/domain/image';
import { encounterMapAspectSchema, encounterPresetSchema } from '@/domain/encounterMap/schema';

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

/** One surface's artifact-scope filter (10-MILESTONE-6 D3/D4): which
 * ownership scopes a surface shows. A genuine UI preference — persisted in
 * settings, never derived from data. */
export const scopeTogglesSchema = z.object({
  global: z.boolean(),
  campaign: z.boolean(),
  module: z.boolean(),
});

export type ScopeToggles = z.infer<typeof scopeTogglesSchema>;

/** Workspace surfaces start Campaign + Module (the campaign's own content);
 * the module view starts with everything visible — it IS the play view (D4). */
export function defaultScopeToggles(surface: 'workspace' | 'moduleView'): ScopeToggles {
  return surface === 'workspace'
    ? { global: false, campaign: true, module: true }
    : { global: true, campaign: true, module: true };
}

export const REASONING_EFFORT_OPTIONS = [
  'default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'max',
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORT_OPTIONS)[number];

export const reasoningEffortSchema = z.enum(REASONING_EFFORT_OPTIONS);

/** The setup wizard's steps, in display order ('welcome' resolves on Begin). */
export const ONBOARDING_STEP_IDS = [
  'welcome',
  'openrouter',
  'language',
  'rulebook',
  'pack',
  'author',
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

/** One step's resolution. A step missing from `stepState` reads as 'pending'. */
export const onboardingStepStateSchema = z.enum(['pending', 'done', 'skipped']);

export type OnboardingStepState = z.infer<typeof onboardingStepStateSchema>;

export const onboardingStepEntrySchema = z.object({
  id: z.enum(ONBOARDING_STEP_IDS),
  state: onboardingStepStateSchema,
});

export type OnboardingStepEntry = z.infer<typeof onboardingStepEntrySchema>;

export const onboardingStatusSchema = z.enum(['fresh', 'active', 'dismissed', 'complete']);

export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>;

/**
 * First-run wizard state (stored as a list of per-step entries; an id absent
 * from the list is pending — old rows and backups written before the field
 * parse via the `.default()` post-M3 field convention). `status` drives the
 * one-time auto-open: 'fresh' shows it once, 'dismissed' never again,
 * 'complete' retires it; re-open affordances stay available in every state.
 */
export const onboardingSchema = z.object({
  status: onboardingStatusSchema.default('fresh'),
  stepState: z.array(onboardingStepEntrySchema).default([]),
});

export type Onboarding = z.infer<typeof onboardingSchema>;

/**
 * Last-used module shortcut (stored on the settings row): the module whose
 * READER was opened most recently. `null` = none yet (the TopBar shortcut is
 * hidden). Written whole by the reader's mount effect — `updateSettings`
 * merges one level deep, so the object is always replaced atomically. Rows
 * and backups written before the field parse via the `.default(null)`
 * post-M3 field convention.
 */
export const lastModuleSchema = z
  .object({
    campaignId: z.uuid(),
    moduleId: z.uuid(),
    name: z.string().min(1),
  })
  .nullable()
  .default(null);

export type LastModule = z.infer<typeof lastModuleSchema>;

export const settingsSchema = z.object({
  id: z.literal(SETTINGS_ID),
  /** '' when unset. */
  openRouterApiKey: z.string(),
  defaultChatModel: z.string().min(1),
  /** Default reasoning effort for reasoning-capable models ('default' = let the model decide). */
  defaultReasoningEffort: reasoningEffortSchema.default('default'),
  embeddingModel: z.string().min(1),
  /** Default false until an API key is present. */
  embeddingsEnabled: z.boolean(),
  /**
   * Graph-aware retrieval (15-GRAPH-RETRIEVAL, decision D4): when true, the
   * retrieve step detects pool entities in the run brief, expands them
   * through the derived wiki-link graph (co-mention only) and grounds the
   * draft with the bounded campaign-grounding section. Default ON — the OFF
   * toggle is the escape hatch for wiki-link-sparse or noisy campaigns; a
   * genuine preference default, not a failure mask. Defaulted so rows and
   * backups written before the field parse (the post-M3 field convention).
   */
  wikiGroundingEnabled: z.boolean().default(true),
  /** Image generation model (M3-A). */
  imageModel: z.string().min(1),
  /** Image generation off until the user opts in (M3-A). */
  imagesEnabled: z.boolean(),
  /**
   * Escalation-tier chat model (model fallback feature). '' = disabled.
   * Defining it activates it: it is the second, more potent brain used when
   * the first-try model (persona override or `defaultChatModel`) is
   * congested, refuses content, or fails the output contract.
   */
  fallbackChatModel: z.string().default(''),
  /**
   * Escalation-tier image model. '' = disabled. Used when the first-try
   * image model (`imageModel`) is congested, refuses content, or returns
   * no images.
   */
  fallbackImageModel: z.string().default(''),
  /**
   * Language every generation prompt is required to produce (default
   * English). Enforced client-side by injecting a directive into each chat
   * completion (see /src/llm/language.ts).
   */
  language: z.enum(GENERATION_LANGUAGE_CODES).default('en'),
  /** Scope filter per surface (10-MILESTONE-6 D3/D4). */
  artifactScopes: z
    .object({
      workspace: scopeTogglesSchema,
      moduleView: scopeTogglesSchema,
    })
    .default({
      workspace: defaultScopeToggles('workspace'),
      moduleView: defaultScopeToggles('moduleView'),
    }),
  /** Encounter Cartographer layout aspect preference. */
  encounterMapAspect: encounterMapAspectSchema.default('4:3'),
  /**
   * Encounter Cartographer preset preference (docs/11 D10, amended):
   * `null` = **Auto** (the default) — each encounter's own `locationKind`
   * decides its grid tier (dungeon → Dungeon; building/wilderness →
   * Standard), and this setting only backstops unclassified ('other')
   * encounters. An explicit 'standard'/'dungeon' choice here remains the
   * override for campaigns that want the old fixed behavior (a genuine
   * preference, never a failure mask).
   */
  encounterPreset: encounterPresetSchema.nullable().default(null),
  /**
   * Remembered defaults for the creation dialog's "After creation" extras
   * checkboxes (aspect pattern): the dialog pre-ticks these per persona.
   * The former one-off "Generate a battlemap" extra is gone — battlemaps
   * for freshly created encounters run automatically via the unattended
   * map queue (post-run-extras; the module dialog's battlemaps toggle is
   * the module-scoped master switch).
   */
  runExtras: z
    .object({
      image: z.boolean().default(false),
      statBlock: z.boolean().default(false),
      mobPortraits: z.boolean().default(false),
    })
    .default({ image: false, statBlock: false, mobPortraits: false }),
  /**
   * Chat model for the encounter verify step (docs/11 §verify). It sends the
   * generated map image to the model, so it must accept image input. ''
   * falls back to `defaultChatModel` (a genuine preference default, not a
   * failure mask — the run fails loudly when the resolved model is not
   * vision-capable).
   */
  encounterVerifyModel: z.string().default(''),
  /**
   * Parallelization (optimization feature): how many OpenRouter requests may
   * run at once when independent work is generated (entity batches, queued
   * entity images, encounter map verification). 1 = the old sequential
   * behavior. Dependent chains (module parts, persona chains) are always
   * sequential regardless of this value.
   */
  maxParallelRequests: z.number().int().min(1).max(4).default(2),
  /** v11 migration notice, consumed once by AppShell after it is shown. */
  retiredSessionNotesRemoved: z.number().int().nonnegative().default(0),
  /** First-run setup wizard (see onboardingSchema above). */
  onboarding: onboardingSchema.default({ status: 'fresh', stepState: [] }),
  /** Last-used module shortcut (see lastModuleSchema above). */
  lastModule: lastModuleSchema,
});

export type Settings = z.infer<typeof settingsSchema>;

/** The default settings row, created on first read. */
export function defaultSettings(): Settings {
  return {
    id: SETTINGS_ID,
    openRouterApiKey: '',
    defaultChatModel: DEFAULT_CHAT_MODEL,
    defaultReasoningEffort: 'default',
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    embeddingsEnabled: false,
    wikiGroundingEnabled: true,
    imageModel: DEFAULT_IMAGE_MODEL,
    imagesEnabled: false,
    fallbackChatModel: '',
    fallbackImageModel: '',
    language: 'en',
    artifactScopes: {
      workspace: defaultScopeToggles('workspace'),
      moduleView: defaultScopeToggles('moduleView'),
    },
    encounterMapAspect: '4:3',
    encounterPreset: null,
    runExtras: { image: false, statBlock: false, mobPortraits: false },
    encounterVerifyModel: '',
    maxParallelRequests: 2,
    retiredSessionNotesRemoved: 0,
    onboarding: { status: 'fresh', stepState: [] },
    lastModule: null,
  };
}
