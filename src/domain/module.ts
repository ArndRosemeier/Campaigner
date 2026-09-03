import { z } from 'zod';

import { BaseEntitySchema, stampNewEntity, type BaseEntity, type Id } from '@/domain/entity';

/**
 * Module Designer v2 (08-MODULE-DESIGNER M4-A): a Module is a markdown
 * document with wiki-links; structured artifacts are annotations that hang off
 * it. The spine is the approved plan the parts are generated from; parts are
 * embedded, ordered markdown chapters — individually regenerable (that is the
 * undo; modules are NOT revisioned).
 */

export const moduleSizeDialSchema = z.enum(['sketch', 'standard', 'detailed']);

export type ModuleSizeDial = z.infer<typeof moduleSizeDialSchema>;

export const MODULE_SIZE_LABELS: Readonly<Record<ModuleSizeDial, string>> = {
  sketch: 'Sketch',
  standard: 'Standard',
  detailed: 'Detailed',
};

/** Soft per-part word targets stated in the pass-1 prompt (08 §M4-B). */
export const MODULE_SIZE_WORD_TARGETS: Readonly<Record<ModuleSizeDial, string>> = {
  sketch: '400–700 words',
  standard: '800–1500 words',
  detailed: '1500–2500 words',
};

export const moduleStatusSchema = z.enum(['draft', 'generating', 'ready', 'failed']);

export type ModuleStatus = z.infer<typeof moduleStatusSchema>;

/** Entity panel ordering (08 §M4-C): first appearance in the document, or A–Z. */
export const moduleEntitySortSchema = z.enum(['mention', 'alphabetical']);

export type ModuleEntitySort = z.infer<typeof moduleEntitySortSchema>;

export const modulePartStatusSchema = z.enum(['pending', 'generating', 'ready', 'failed']);

export type ModulePartStatus = z.infer<typeof modulePartStatusSchema>;

/** One planned part of the module (spine pass output, user-editable). */
export const partPlanSchema = z.object({
  title: z.string().min(1),
  /** e.g. '1', '2–3' — the level band this part covers. */
  levelBand: z.string().min(1),
  synopsis: z.string(),
  /** What ends this part / triggers the level-up. */
  levelUpTrigger: z.string(),
});

export type PartPlan = z.infer<typeof partPlanSchema>;

/** Pass-0 output: premise + themes + the approved part plan. */
export const moduleSpineSchema = z.object({
  /** Markdown, a few paragraphs; rendered as the intro section. */
  premise: z.string(),
  themes: z.array(z.string()),
  partPlan: z.array(partPlanSchema).min(1).max(20),
});

export type ModuleSpine = z.infer<typeof moduleSpineSchema>;

/** One generated chapter. `planIndex` points into `spine.partPlan`. */
export const modulePartSchema = z.object({
  planIndex: z.number().int().nonnegative(),
  /** The actual module text with [[wiki-links]]; H1 is added by the reader. */
  markdown: z.string(),
  status: modulePartStatusSchema,
  errorMessage: z.string(),
  /** True once the user hand-edited the part after generation (08 §M4-B:
   * rewrite then confirms before overwriting). */
  edited: z.boolean(),
});

export type ModulePart = z.infer<typeof modulePartSchema>;

/**
 * The kinds the generator can declare for entities it introduces (08 §M4-C:
 * the model decides the type when it invents the name — never a client-side
 * heuristic). These are the stub-able artifact kinds.
 */
export const ENTITY_KINDS = ['npc', 'location', 'faction', 'note', 'encounter'] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

/** One model-recorded entity type: a wiki-link name and its kind. */
export const moduleEntityKindSchema = z.object({
  /** The name as first written in the module text (wiki-link form). For
   * normalized records: the canonical spelling. */
  name: z.string().trim().min(1),
  kind: z.enum(ENTITY_KINDS),
  /** fix-01: variant names this canonical entry absorbed (checkpoint
   * display only; the panel folds via rewritten links). Empty otherwise. */
  absorbed: z.array(z.string()).default([]),
});

export type ModuleEntityKind = z.infer<typeof moduleEntityKindSchema>;

/** Case-insensitive lookup of a recorded entity kind (undefined = unknown). */
export function entityKindFor(
  entityKinds: readonly ModuleEntityKind[],
  name: string,
): EntityKind | undefined {
  const target = name.trim().toLowerCase();
  if (target === '') return undefined;
  return entityKinds.find((entry) => entry.name.trim().toLowerCase() === target)?.kind;
}

export const moduleSchema = z
  .object({
    ...BaseEntitySchema.shape,
    campaignId: z.uuid(),
    title: z.string().min(1),
    /** The user's concept text, kept for regeneration context. */
    concept: z.string(),
    levelMin: z.number().int().min(1).max(20),
    levelMax: z.number().int().min(1).max(20),
    tone: z.string(),
    sizeDial: moduleSizeDialSchema,
    /** Null until pass 0 has run. */
    spine: moduleSpineSchema.nullable(),
    parts: z.array(modulePartSchema),
    status: moduleStatusSchema,
    errorMessage: z.string(),
    /** Entity types the generator recorded for names it introduced
     * (08 §M4-C). Names typed by the user later have no record here. */
    entityKinds: z.array(moduleEntityKindSchema).max(400).default([]),
    /** Names focused in play — the entity panel's top group (08 §M4-C). */
    focusedEntities: z.array(z.string()).max(400).default([]),
    /** How the entity panel orders entities (08 §M4-C). */
    entitySort: moduleEntitySortSchema.default('mention'),
    /** fix-01: true once the name-normalization pass succeeded for the
     * current text; batch entity generation is gated on it. */
    entityNamesNormalized: z.boolean().default(false),
    /** fix-01: the recorded pass failure ('' when none) — the panel shows it
     * with a Retry; never a silent path back to duplicates. */
    entityNormalizationError: z.string().default(''),
    /** fix-01: held rewrites for hand-edited parts (planIndex −1 = premise)
     * awaiting the user's consent in the panel; null = nothing pending. */
    entityRewriteProposals: z
      .array(
        z.object({
          planIndex: z.number().int(),
          replacements: z.array(z.object({ from: z.string(), to: z.string() })),
        }),
      )
      .nullable()
      .default(null),
    /** Opt-in continuity (08 §M4-B): when true, the spine and parts passes
     * receive the campaign's other modules (premise + part texts, drafts
     * included, capped) as settled history. Off = the previous behavior,
     * byte-for-byte. */
    includePriorModules: z.boolean().default(false),
    /** Artifact types that should be autogenerated afterwards (e.g. ['npc', 'location']). */
    autoGenerateKinds: z.array(z.enum(ENTITY_KINDS)).default([]),
    /** Artifact types for which images should also be autogenerated (e.g. ['npc']). */
    autoImageKinds: z.array(z.enum(ENTITY_KINDS)).default([]),
    /** Whether encounter battlemaps should be generated automatically. */
    autoGenerateBattlemaps: z.boolean().default(false),
  })
  .refine((module) => module.levelMax >= module.levelMin, {
    message: 'levelMax must be >= levelMin',
    path: ['levelMax'],
  });

export type Module = z.infer<typeof moduleSchema>;

export type ModulePatch = Partial<
  Omit<Module, keyof BaseEntity | 'campaignId' | 'id'>
>;

/** Input for creating a new module; identity/timestamps are stamped. */
export interface NewModule {
  campaignId: Id;
  title: string;
  concept: string;
  levelMin: number;
  levelMax: number;
  tone?: string;
  sizeDial: ModuleSizeDial;
  /** Opt-in: feed the campaign's other modules to the generator (08 §M4-B). */
  includePriorModules?: boolean;
  autoGenerateKinds?: EntityKind[];
  autoImageKinds?: EntityKind[];
  autoGenerateBattlemaps?: boolean;
}

export function createModule(input: NewModule): Module {
  const stamp = stampNewEntity();
  if (input.levelMin < 1 || input.levelMax < input.levelMin) {
    throw new Error('Invalid level range: max must be >= min and both within 1–20');
  }
  return moduleSchema.parse({
    ...stamp,
    campaignId: input.campaignId,
    title: input.title,
    concept: input.concept,
    levelMin: input.levelMin,
    levelMax: input.levelMax,
    tone: input.tone ?? '',
    sizeDial: input.sizeDial,
    spine: null,
    parts: [],
    status: 'draft',
    errorMessage: '',
    entityKinds: [],
    focusedEntities: [],
    entitySort: 'mention',
    entityNamesNormalized: false,
    entityNormalizationError: '',
    entityRewriteProposals: null,
    includePriorModules: input.includePriorModules ?? false,
    autoGenerateKinds: input.autoGenerateKinds ?? [],
    autoImageKinds: input.autoImageKinds ?? [],
    autoGenerateBattlemaps: input.autoGenerateBattlemaps ?? false,
  });
}

/** The `module:<title>` tag stamped on artifacts produced for a module. */
export function moduleTagFor(title: string): string {
  return `module:${title}`;
}

/** Placeholder title used until the spine suggests nothing better. */
export function defaultModuleTitle(): string {
  return 'New Module';
}
