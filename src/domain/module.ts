import { z } from 'zod';

import { BaseEntitySchema, stampNewEntity, type BaseEntity, type Id } from '@/domain/entity';
import { modulePromptStyleSchema, type ModulePromptStyle } from '@/domain/promptStyle';

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
  synopsis: z.string().default(''),
  /** What ends this part / triggers the level-up. */
  levelUpTrigger: z.string().default(''),
});

export type PartPlan = z.infer<typeof partPlanSchema>;

/**
 * Pass-0 output: premise + themes + the approved part plan. All of it lands
 * on the ALWAYS-on spine checkpoint for user review before pass 1 runs, so a
 * model-omitted optional field defaults to empty (visible, editable) instead
 * of discarding an otherwise good spine.
 */
export const moduleSpineSchema = z.object({
  /** Markdown, a few paragraphs; rendered as the intro section. */
  premise: z.string(),
  themes: z.array(z.string()).default([]),
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
 * Canvas v1 (08-MODULE-DESIGNER §Module canvas): the user-arranged layout of
 * the whole-module canvas — one position per node key plus the persisted
 * viewport. Node keys are STABLE identifiers, never indexes that renumber:
 * `'premise'` and `'part-<planIndex>'` for this module's own cards
 * (`planIndex` is IDENTITY — deliverable seeding and encounter-floor bands
 * depend on it), `'prior-<moduleId>'` for prior-module text groups. The
 * layout rides the module row through `patchModule` (backup/export follow);
 * NO Dexie version, NO localStorage (parse-on-read precedent, additive
 * `.default(null)` like the cover backfill).
 */
export const moduleCanvasNodeSchema = z.object({
  key: z.string().min(1),
  x: z.number(),
  y: z.number(),
});

export type ModuleCanvasNode = z.infer<typeof moduleCanvasNodeSchema>;

export const moduleCanvasSchema = z.object({
  nodes: z.array(moduleCanvasNodeSchema),
  zoom: z.number(),
  pan: z.object({ x: z.number(), y: z.number() }),
});

export type ModuleCanvas = z.infer<typeof moduleCanvasSchema>;

/** The premise card's stable canvas node key. */
export const CANVAS_PREMISE_NODE_KEY = 'premise';

/** The stable canvas node key of part `planIndex` (identity, never renumbered). */
export function canvasPartNodeKey(planIndex: number): string {
  return `part-${String(planIndex)}`;
}

/** The stable canvas node key of a prior module's read-only text group. */
export function canvasPriorModuleNodeKey(moduleId: string): string {
  return `prior-${moduleId}`;
}

/**
 * The `planIndex` encoded in a canvas part node key, or null for every other
 * key (`premise`, `prior-…`) — the one parse site for the key format.
 */
export function planIndexFromCanvasNodeKey(key: string): number | null {
  const match = /^part-(\d+)$/.exec(key);
  if (match === null) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) ? index : null;
}

/**
 * The kinds the generator can declare for entities it introduces (08 §M4-C:
 * the model decides the type when it invents the name — never a client-side
 * heuristic). These are the stub-able artifact kinds.
 */
export const ENTITY_KINDS = ['npc', 'location', 'event', 'faction', 'note', 'encounter'] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * The EDITABLE part of the encounter floor (owner decision, docs/17).
 *
 * The module-creation flow's floor guardrail used to be a hard-coded sentence
 * in the spine prompt plus a hard-coded threshold in the gates. The owner wants
 * the guardrail to stay — it is what keeps a module from shipping encounter-free
 * — but to be changeable without editing prompt copy, behind an Advanced
 * disclosure in the New Module dialog. Editing PROSE was explicitly rejected, so
 * this is a NUMERICAL interface: `perLevel` (encounters per level of the module's
 * range) and an on/off switch. Those two numbers are the ONE source of truth:
 * they render the prompt clause in the spine pass, its repair retry, the parts
 * pass and the per-part instruction, AND they set the thresholds and copy of the
 * floor validator — a value can never disagree with the gate it configures.
 *
 * Under the defaults (`enabled: true, perLevel: 1`) every rendered string and
 * every threshold is byte-identical to the pre-config behavior; the golden test
 * is the regression contract for that.
 *
 * Deliberately floor-ONLY: it counts named encounters and nothing else. What a
 * scene IS (a fight, or an `event` instead) and whether the story's conflict is
 * real are prompt discipline plus the owner's read of the spine checkpoint — a
 * check over prose would need a classifier guessing at a gate, which this repo
 * forbids (docs/08 §M4-B, docs/18 §2.2).
 *
 * Integers only (a fractional encounter count is meaningless), min 0, and the
 * refine keeps `enabled: false` honest — a disabled floor may carry
 * `perLevel: 0`, while an ENABLED floor always demands at least one encounter
 * per level. Recorded per module (see `moduleSchema.encounterFloorGuardrail`),
 * so a repair or retry months later reads the module's own rules.
 */
export const encounterFloorGuardrailSchema = z
  .object({
    /** false = no floor at all: no clause in the prompt, no gate, no repair. */
    enabled: z.boolean().default(true),
    /** Distinct encounters required per level of the module's range. */
    perLevel: z.number().int().min(0).default(1),
  })
  .refine((floor) => !floor.enabled || floor.perLevel >= 1, {
    message: 'perLevel must be >= 1 when the encounter floor is enabled',
    path: ['perLevel'],
  });

export type EncounterFloorGuardrail = z.infer<typeof encounterFloorGuardrailSchema>;

/** The floor enforced when nothing was configured: one distinct named encounter
 * per level of the module's range — today's behavior, unchanged. */
export function defaultEncounterFloorGuardrail(): EncounterFloorGuardrail {
  return { enabled: true, perLevel: 1 };
}

/**
 * The floor a module enforces: its OWN recorded value when present, today's
 * default otherwise (the row field is additive optional, so a module written
 * before it behaves exactly as before). The ONE resolver every consumer uses —
 * the spine prompt builder, the spine gate, the parts gate, the repair
 * instructions — so all of them read the module's rules rather than whatever a
 * dialog happens to show later (docs/18 §2.2).
 */
export function encounterFloorGuardrailFor(module: {
  encounterFloorGuardrail?: EncounterFloorGuardrail | null | undefined;
}): EncounterFloorGuardrail {
  return module.encounterFloorGuardrail ?? defaultEncounterFloorGuardrail();
}

/** English number words for the small counts a floor expresses (0..10); larger
 * counts fall back to digits, which read fine ("at least 12 distinct
 * encounters"). */
const COUNT_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
] as const;

/** `<count>` as a word for 0..10, digits above — the floor's prose renders
 * `perLevel: 1` as "one", exactly as the pre-config copy did. */
export function encounterCountWord(count: number): string {
  return COUNT_WORDS[count] ?? String(count);
}

/** Total distinct named encounters the floor demands across a module range. */
export function encounterFloorTotal(floor: EncounterFloorGuardrail, levelCount: number): number {
  return floor.enabled ? Math.max(1, levelCount * floor.perLevel) : 0;
}

/** Encounters one part must name, for a band covering `levels` levels. */
export function encounterFloorPerPart(floor: EncounterFloorGuardrail, levels: number): number {
  return floor.enabled ? Math.max(1, levels * floor.perLevel) : 0;
}

/**
 * The automation the owner asked for when a module was created (recorded INTENT
 * for a later "Resume automatic module creation" surface).
 *
 * This is a RECORD, not a computation: the four values are exactly what the
 * creation run used — captured onto the row in the same flow that starts the
 * run, never re-read from a dialog later. A later session derives whether the
 * real state has DEVIATED from this intent (for example: the intent asked for
 * images and an artifact still has none); **no `hasProblems` / `deviates` flag
 * is stored, and none may be added** — a stored verdict goes stale the moment
 * the owner fixes or re-breaks the module, while the intent it is compared
 * against stays true. Derive, never cache.
 *
 * Additive optional: `null` (every row written before this field) means
 * "nothing recorded" and stays INERT — no surface may infer intent from a
 * legacy row's automation fields, because those describe what the engine did,
 * not what the owner asked for.
 *
 * The four fields mirror the module row's own automation fields and are typed
 * from THIS schema (`satisfies` in `createModule`), so the recorded intent can
 * never drift from what the sweep reads.
 */
export const moduleAutomationIntentSchema = z.object({
  autoGenerateKinds: z.array(z.enum(ENTITY_KINDS)),
  autoImageKinds: z.array(z.enum(ENTITY_KINDS)),
  autoGenerateBattlemaps: z.boolean(),
  autoGenerateMobImages: z.boolean(),
});

export type ModuleAutomationIntent = z.infer<typeof moduleAutomationIntentSchema>;

/**
 * One model-recorded entity type: a wiki-link name and its kind.
 *
 * Rows written before the conflict-kind vocabulary was retired may still carry
 * `wants` / `conflictKind` keys on their records. This schema is deliberately
 * NOT strict, so zod STRIPS unknown keys on read: those keys are simply
 * ignored, an old module parses and behaves exactly as it did, and no data
 * migration is needed (owner decision, docs/17: the repo is in a testing
 * phase — no migration ceremony for a shape change).
 */
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

/**
 * How many recorded entities one module row carries (`entityKinds` schema
 * cap). The incremental classification pass reads it too: appending past the
 * cap throws LOUDLY there rather than dropping a record — a dropped record is
 * a silently un-batchable name (08 §M4-C).
 */
export const MODULE_ENTITY_KIND_CAP = 400;

/**
 * fix-01 consent record: the wiki-link target rewrites a HELD verdict wants
 * applied to ONE document (`planIndex` −1 = the premise), stored on the module
 * row while the panel's review banner awaits the user's decision. Named here
 * (not inline in `moduleSchema`) so the normalization seams that derive and
 * merge proposals share one type.
 */
export const entityRewriteProposalSchema = z.object({
  planIndex: z.number().int(),
  replacements: z.array(z.object({ from: z.string(), to: z.string() })),
});

export type EntityRewriteProposal = z.infer<typeof entityRewriteProposalSchema>;

/** Case-insensitive lookup of a recorded entity kind (undefined = unknown). */
export function entityKindFor(
  entityKinds: readonly ModuleEntityKind[],
  name: string,
): EntityKind | undefined {
  const target = name.trim().toLowerCase();
  if (target === '') return undefined;
  return entityKinds.find((entry) => entry.name.trim().toLowerCase() === target)?.kind;
}

/**
 * The module canvas chat thread (08-MODULE-DESIGNER §Module canvas chat,
 * docs/17 row 57): the persisted conversation — user instructions plus the
 * assistant replies with their per-command outcome cards. Restored entries
 * are HISTORY (they never auto-apply; a restored Report-to-LLM re-resolves
 * against the live doc at click time). The canvas model selection is NOT
 * part of this — it stays session-only.
 *
 * Additive `.default(...)` exactly like the `canvas` backfill: rows written
 * before the thread parse at the read boundary with an empty thread — NO
 * Dexie version bump, NO index changes. Inert by construction: no generation
 * prompt reader may consult this field (module grounding reads premise +
 * parts only), so it rides backup and campaign export/import with the rest
 * of the row — exported modules carry their chat history, which is the
 * point. Whole-doc offsets stored on outcomes (`from`/`to`/`failureFrom`)
 * are history anchors only, never apply coordinates.
 */
export const moduleChatCommandSchema = z.object({
  search: z.string(),
  replace: z.string(),
  all: z.boolean(),
});

export type ModuleChatCommand = z.infer<typeof moduleChatCommandSchema>;

export const moduleChatOutcomeSchema = z.object({
  kind: z.enum(['applied', 'failed']),
  command: moduleChatCommandSchema,
  targetParts: z
    .array(z.object({ planIndex: z.number().int(), title: z.string() }))
    .default([]),
  occurrences: z.number().int().nullable().default(null),
  from: z.number().int().nullable().default(null),
  to: z.number().int().nullable().default(null),
  before: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
  closest: z.string().nullable().default(null),
  failureFrom: z.number().int().nullable().default(null),
  reported: z.boolean().default(false),
});

export type ModuleChatOutcome = z.infer<typeof moduleChatOutcomeSchema>;

export const moduleChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  /** user: the instruction. assistant: the settled prose (raw on failure). */
  text: z.string(),
  /** assistant only: the canonical raw reply (prose + XML blocks). */
  raw: z.string().nullable().default(null),
  /** Settled only — a streaming turn is never persisted. */
  status: z.enum(['ok', 'failed', 'aborted']).default('ok'),
  /** failed: the loud error. */
  error: z.string().nullable().default(null),
  /** assistant only: command outcomes in reply order. */
  outcomes: z.array(moduleChatOutcomeSchema).default([]),
  createdAt: z.number().default(0),
});

export type ModuleChatMessage = z.infer<typeof moduleChatMessageSchema>;

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
    entityKinds: z.array(moduleEntityKindSchema).max(MODULE_ENTITY_KIND_CAP).default([]),
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
      .array(entityRewriteProposalSchema)
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
    /** Whether each module-owned encounter's roster mob portraits should be
     * enqueued automatically after the parts pass (the encounter editor's
     * "Generate mob portraits" batch: one portrait per rulebook-cited
     * creature kind, canonically cached, skip-if-imaged). */
    autoGenerateMobImages: z.boolean().default(false),
    /** Opt-in unattended generation: the pass-0 spine is approved as-is and
     * pass 1 starts immediately — the spine checkpoint never stops the flow. */
    autoApproveSpine: z.boolean().default(false),
    /**
     * The module's OWN encounter floor, recorded at creation (see
     * `encounterFloorGuardrailSchema`). Additive optional: `null` — every row
     * written before the field, and every module created without an explicit
     * choice — means TODAY'S DEFAULT FLOOR, so existing modules behave exactly
     * as before. Nullable rather than defaulted on purpose: the recorded value
     * must be able to say "the owner chose nothing", and
     * `encounterFloorGuardrailFor` is the ONE resolver that turns that into the
     * default.
     *
     * Every consumer reads it from the MODULE ROW — never from the dialog or
     * from settings: this pass's prompt and gate, the floor repair, a retry, and
     * a later pass months on all use the rules the module was created with.
     */
    encounterFloorGuardrail: encounterFloorGuardrailSchema.nullable().default(null),
    /**
     * What the owner asked for at creation: recorded INTENT for a later
     * "Resume automatic module creation" surface (see
     * `moduleAutomationIntentSchema`). Written by `createModule` in the same
     * flow that starts the run. `null` on every row written before the field —
     * legacy modules stay inert — and NO deviation flag is ever stored beside
     * it (the future surface derives deviation from the live state).
     */
    automationIntent: moduleAutomationIntentSchema.nullable().default(null),
    /**
     * The prompt STYLE this module was generated with (owner decision, docs/17
     * row 86): the style's id, name and version for provenance, plus the
     * TEMPLATE TEXT itself. `src/llm/promptStyles.ts` composes the spine and
     * part prompts from this text — never from the settings' current version of
     * that style — so resume, "Fix module problems" and a per-part regeneration
     * keep writing in the voice the module started in after the style was
     * edited or deleted. Editing a style can therefore never silently change an
     * existing module; the canvas offers an explicit adoption when the module's
     * text and the style's current text differ.
     *
     * Additive `.default(null)` — parse-on-read, no Dexie version. `null` is
     * the LEGACY shape, and it reads as Classic: this module was written before
     * styles existed, and Classic is the text that existed when it was written.
     * That is provenance, not a fallback to a default (AGENTS rule 1 is about
     * masking failures).
     */
    promptStyle: modulePromptStyleSchema.nullable().default(null),
    /** The module's cover image (list thumb / reader hero / module-PDF
     * fallback), or null. Additive `.default(null)` mirrors the v2 upgrade
     * backfill, so rows written before covers parse at the read boundary —
     * NO Dexie version bump, NO index changes (cover-only; no gallery). */
    coverImageId: z.uuid().nullable().default(null),
    /** Whole-module canvas layout (08 §Module canvas): user-arranged node
     * positions + viewport, or null until the canvas was used. Additive
     * `.default(null)` — parse-on-read, no Dexie version, rides
     * backup/export with the rest of the row. */
    canvas: moduleCanvasSchema.nullable().default(null),
    /** The persisted canvas chat thread (08 §Module canvas chat, docs/17
     * row 57): messages AND outcomes as history. Additive `.default([])` —
     * parse-on-read, no Dexie version, rides backup/export with the rest
     * of the row. NEVER read by a generation prompt (module grounding
     * reads premise + parts only). */
    chatThread: z.array(moduleChatMessageSchema).default([]),
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
  autoGenerateMobImages?: boolean;
  /** Opt-in: skip the spine checkpoint (auto-approve pass 0, run pass 1). */
  autoApproveSpine?: boolean;
  /**
   * The encounter floor this module enforces (see
   * `encounterFloorGuardrailSchema`). Omitted or undefined = not recorded =
   * today's default floor, exactly as before.
   */
  encounterFloorGuardrail?: EncounterFloorGuardrail;
  /**
   * The prompt style this module is written in (docs/17 row 86). The CALLER
   * resolves it — a chosen style id or the app default — and hands the record
   * in; `createModule` stores id, name, version and template text as-is.
   * Omitted = not recorded = the legacy shape (Classic), which is what every
   * module created before styles records.
   */
  promptStyle?: ModulePromptStyle;
}

export function createModule(input: NewModule): Module {
  const stamp = stampNewEntity();
  if (input.levelMin < 1 || input.levelMax < input.levelMin) {
    throw new Error('Invalid level range: max must be >= min and both within 1–20');
  }
  // The owner's four automation choices, exactly as handed in: these are BOTH
  // the row's automation fields AND the recorded intent, so the intent a later
  // session compares against is byte-for-byte what the sweep runs. The omitted
  // case resolves to []/false on the row (unchanged behavior) and records that
  // as the intent — "nothing was asked for", never "unknown".
  const automationIntent = {
    autoGenerateKinds: input.autoGenerateKinds ?? [],
    autoImageKinds: input.autoImageKinds ?? [],
    autoGenerateBattlemaps: input.autoGenerateBattlemaps ?? false,
    autoGenerateMobImages: input.autoGenerateMobImages ?? false,
  } satisfies ModuleAutomationIntent;
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
    autoGenerateKinds: automationIntent.autoGenerateKinds,
    autoImageKinds: automationIntent.autoImageKinds,
    autoGenerateBattlemaps: automationIntent.autoGenerateBattlemaps,
    autoGenerateMobImages: automationIntent.autoGenerateMobImages,
    autoApproveSpine: input.autoApproveSpine ?? false,
    encounterFloorGuardrail: input.encounterFloorGuardrail ?? null,
    promptStyle: input.promptStyle ?? null,
    automationIntent,
  });
}

/** The `module:<title>` tag stamped on artifacts produced for a module. */
export function moduleTagFor(title: string): string {
  return `module:${title}`;
}

/**
 * The full module text (premise + parts, plan order) — the ONE assembled form
 * of a module's document for grounding (08 §M4-C): the entity batch's briefs,
 * the reader's stub summaries and the run engine's in-place refill grounding
 * all excerpt THIS text, so every consumer sees the same document.
 */
export function moduleDocumentText(module: Module): string {
  return [
    module.spine?.premise ?? '',
    ...module.parts
      .slice()
      .sort((a, b) => a.planIndex - b.planIndex)
      .map((part) => part.markdown),
  ].join('\n\n');
}

/** Placeholder title used until the spine suggests nothing better. */
export function defaultModuleTitle(): string {
  return 'New Module';
}
