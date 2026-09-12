import { z } from 'zod';

import { DEFAULT_IMAGE_MODEL } from '@/domain/image';
import {
  dungeonMapPathSchema,
  encounterMapAspectSchema,
  encounterPresetSchema,
} from '@/domain/encounterMap/schema';
import {
  defaultEncounterFloorGuardrail,
  encounterFloorGuardrailSchema,
  ENTITY_KINDS,
  moduleSizeDialSchema,
} from '@/domain/module';
import {
  PROMPT_STYLE_FREESTYLE_ID,
  userPromptStyleSchema,
} from '@/domain/promptStyle';

/**
 * The one-shot report of the core-mob citation repair (docs/11 D7): what the
 * v20 upgrade converted, and — BY NAME — everything it could not convert.
 * Written by the upgrade, consumed once by AppShell, then nulled.
 *
 * The by-name half is the point (AGENTS rule 1): a repair that cannot convert
 * a citation must never leave it to render as a bare `missing ref` with no
 * explanation of what was lost.
 */
export const creatureCitationRepairReportSchema = z.object({
  /** `npc-ref` citations rewritten to the `rulebook` citation of the identity
   * the deleted mob artifact's marker named — the owner's incident, healed. */
  citationsRewritten: z.number().int().nonnegative(),
  /** Marked `npc` rows deleted as cache (they were never authored content). */
  emptyRowsDeleted: z.number().int().nonnegative(),
  /** Marked rows whose cover was carried onto the campaign's presentation row
   * for the creature identity, so no portrait was lost with the row. */
  coversCarriedForward: z.number().int().nonnegative(),
  /** Rows that still carried authored text when they were deleted — reported
   * because the owner may want to re-create them as real NPCs (docs/11 D7). */
  authoredRowsRemoved: z.array(z.string()).default([]),
  /** Citations that could NOT be converted, by name, with the reason. */
  unconverted: z
    .array(z.object({ where: z.string(), name: z.string(), reason: z.string() }))
    .default([]),
});

export type CreatureCitationRepairReport = z.infer<typeof creatureCitationRepairReportSchema>;

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

/**
 * The New Module dialog's persisted draft (owner request, docs/17): every value
 * the dialog holds — concept included — so a module creation can be retried, or
 * restarted after a reset, without retyping it.
 *
 * ONE entry, TAGGED with its campaign, overwritten when the owner starts a
 * module in another campaign, and prefilled only when the tag matches the
 * campaign being created in. A per-campaign MAP would leak nothing either, but
 * it would add a second record shape that every delete path (`deleteCampaign`,
 * `removeAllGeneratedContent`, `deleteCampaignWorkspace`) would have to sweep —
 * exactly the orphan class this repo has spent two arcs closing. A single
 * tagged entry has nothing to orphan.
 *
 * Every value is validated with the schema the DIALOG itself uses: kind arrays
 * through the real `ENTITY_KINDS` enum (so a removed artifact kind can never
 * resurrect through a stale draft), the size dial through `moduleSizeDialSchema`,
 * the levels through the same 1..20 integer bounds and the `levelMax >= levelMin`
 * refine, and the Advanced floor through the domain schema — a stored draft that
 * no longer validates fails the settings parse LOUDLY rather than silently
 * half-prefilling the dialog.
 *
 * The two campaign WIPES deliberately KEEP the draft ("Remove all generated
 * content" and "Clear workspace"): retry-after-reset is the whole point of the
 * feature, and the draft is authored input, not generated content.
 * `deleteCampaign` clears it — the campaign it was tagged for is gone.
 */
export const newModuleDraftSchema = z
  .object({
    /** The campaign this draft was written in — the prefill tag. */
    campaignId: z.uuid(),
    concept: z.string(),
    levelMin: z.number().int().min(1).max(20),
    levelMax: z.number().int().min(1).max(20),
    tone: z.string(),
    sizeDial: moduleSizeDialSchema,
    includePriorModules: z.boolean(),
    autoApproveSpine: z.boolean(),
    autoGenerateKinds: z.array(z.enum(ENTITY_KINDS)),
    autoImageKinds: z.array(z.enum(ENTITY_KINDS)),
    autoGenerateBattlemaps: z.boolean(),
    autoGenerateMobImages: z.boolean(),
    /** The Advanced floor editor's numbers — part of the draft so a retry
     * starts from the same rules the deleted attempt used. */
    encounterFloorGuardrail: encounterFloorGuardrailSchema,
    /**
     * The prompt style this module will be written in (docs/17 row 86): a
     * built-in id or one of the user styles. Part of the draft so a retry after
     * a reset starts from the same voice — but OPTIONAL and absent by default,
     * because "no choice made" is a real state: it means the creation uses the
     * app default (`settings.defaultPromptStyleId`) as it stands at that
     * moment. A defaulted 'classic' here would silently pin every module to
     * Classic for anyone who changed the app default while a prior draft sat in
     * the row — a fallback hiding a preference, which is exactly what AGENTS 1
     * forbids.
     */
    promptStyleId: z.string().min(1).optional(),
  })
  .refine((draft) => draft.levelMax >= draft.levelMin, {
    message: 'levelMax must be >= levelMin',
    path: ['levelMax'],
  });

export type NewModuleDraft = z.infer<typeof newModuleDraftSchema>;

/**
 * The draft the dialog opens with when nothing (or another campaign's draft) is
 * stored — the dialog's own initial state, unchanged. `campaignId` is the
 * campaign the dialog is being used in.
 */
export function defaultNewModuleDraft(campaignId: string): NewModuleDraft {
  return {
    campaignId,
    concept: '',
    levelMin: 1,
    levelMax: 3,
    tone: '',
    sizeDial: 'standard',
    includePriorModules: false,
    autoApproveSpine: false,
    autoGenerateKinds: [],
    autoImageKinds: [],
    // The master battlemap switch is ON by default; mob portraits stay opt-in
    // (both owner decisions, unchanged — see the dialog).
    autoGenerateBattlemaps: true,
    autoGenerateMobImages: false,
    encounterFloorGuardrail: defaultEncounterFloorGuardrail(),
  };
}

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
   * Strict structured outputs (owner decision, default ON): JSON-contract
   * calls send `response_format: { type: 'json_schema', strict: true }` so
   * OpenRouter enforces the schema token-level during decoding. Turning this
   * OFF is the explicit escape hatch for models whose provider rejects the
   * schema (loud `schema-rejected` 400) — those calls then use the old
   * best-effort `json_object` mode. There is NO automatic downgrade either
   * way; failures stay loud (AGENTS rule 1).
   */
  strictOutputs: z.boolean().default(true),
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
   * Dungeon-map production path (docs/11 vision path): which pipeline
   * authors COMPLEX (multi-room) encounter maps — `'classic'` (the default)
   * packs vector rooms deterministically and stylizes a rendered schematic;
   * `'vision'` paints the labeled map first and locates each room's letter
   * plaque with the configured chat model. Governs initial generation, the
   * unattended map queue (no steering possible unattended) and Regenerate
   * everything; SINGLES ignore it (one arena needs no registration) and
   * REPOPULATE never touches the map. A genuine preference default (current
   * behavior changes for nobody silently), never a failure mask.
   */
  dungeonMapPath: dungeonMapPathSchema.default('classic'),
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
   * Parallelization (optimization feature): how many OpenRouter requests may
   * run at once when independent work is generated (entity batches, queued
   * entity images). 1 = the old sequential behavior. Dependent chains
   * (module parts, persona chains) are always sequential regardless of this
   * value.
   */
  maxParallelRequests: z.number().int().min(1).max(4).default(2),
  /** v11 migration notice, consumed once by AppShell after it is shown. */
  retiredSessionNotesRemoved: z.number().int().nonnegative().default(0),
  /**
   * The one-shot core-mob citation repair report (docs/11 D7), consumed once by
   * AppShell and then reset to null. `null` = nothing to report.
   */
  creatureCitationRepair: creatureCitationRepairReportSchema.nullable().default(null),
  /** First-run setup wizard (see onboardingSchema above). */
  onboarding: onboardingSchema.default({ status: 'fresh', stepState: [] }),
  /** Last-used module shortcut (see lastModuleSchema above). */
  lastModule: lastModuleSchema,
  /**
   * The New Module dialog's persisted draft (see newModuleDraftSchema above).
   * `null` = nothing stored yet. Required-but-nullable exactly like
   * `lastModule`: the settings read paths merge over `defaultSettings()`, so a
   * row (or a backup) written before the field parses as `null`, while a
   * CORRUPT stored draft fails the parse LOUDLY — this path never falls back to
   * defaults (AGENTS rules 1/3, the settingsRepo convention).
   */
  newModuleDraft: newModuleDraftSchema.nullable().default(null),
  /**
   * The app-default module prompt style (docs/17 rows 86 and 88): the id a New
   * Module dialog preselects, overridable per module. A genuine preference, so
   * it has a default — and an id that no longer resolves fails LOUDLY where it
   * is used (the dialog and the creation path name it) rather than quietly
   * falling back to another voice.
   *
   * The product default is FREESTYLE (owner request, docs/17 row 88): a FRESH
   * app is born with it, and a stored row that predates the styles arc (the
   * field ABSENT, so this zod default applies) reads back as it too. A stored
   * value — including a stored `'classic'` — is honored VERBATIM and never
   * rewritten; there is no migration and no version bump for it. Reachable ONLY
   * where no style has been recorded for the module being created: a module's
   * own recorded style always wins, and a module with no recorded style keeps
   * resolving to Classic by provenance (`promptStyleForModule`, docs/17 row 86).
   */
  defaultPromptStyleId: z.string().min(1).default(PROMPT_STYLE_FREESTYLE_ID),
  /**
   * The user's own module prompt styles. Built-ins are NOT stored here (they
   * ship in code and are immutable); this is authored content, so the app
   * treats it as the user's work: it rides backup/export, and no wipe path
   * touches it.
   *
   * `null` = the stored value could not be read (the field is carved out of the
   * settings repo's core parse so one bad styles blob can never take down every
   * settings read — the `newModuleDraft` precedent). An empty list is `[]`,
   * which is a real state: no styles of your own yet.
   */
  promptStyles: z.array(userPromptStyleSchema).nullable().default(null),
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
    strictOutputs: true,
    language: 'en',
    artifactScopes: {
      workspace: defaultScopeToggles('workspace'),
      moduleView: defaultScopeToggles('moduleView'),
    },
    encounterMapAspect: '4:3',
    encounterPreset: null,
    dungeonMapPath: 'classic',
    runExtras: { image: false, statBlock: false, mobPortraits: false },
    maxParallelRequests: 2,
    retiredSessionNotesRemoved: 0,
    creatureCitationRepair: null,
    onboarding: { status: 'fresh', stepState: [] },
    lastModule: null,
    newModuleDraft: null,
    defaultPromptStyleId: PROMPT_STYLE_FREESTYLE_ID,
    promptStyles: [],
  };
}
