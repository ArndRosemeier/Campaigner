import { z } from 'zod';

import { BaseEntitySchema, stampNewEntity, type BaseEntity, type Id } from '@/domain/entity';
// The leaf primitive, imported directly rather than through
// `@/domain/creatureName`'s `sameCreatureName` (the two are the same function):
// `creatureName.ts` reaches `db/mobPortraitCache`, and this pure domain module
// must not gain a domain → db edge for a comparison it can make with the leaf
// (docs/17 row 166).
import { comparableName, sameAliasName } from '@/domain/artifactAlias';
import {
  encounterBudgetPolicySchema,
  type EncounterBudgetPolicy,
} from '@/domain/encounterBudget';
import { moduleDifficultySchema, type ModuleDifficulty } from '@/domain/moduleDifficulty';
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
 * WHO WROTE one module-text document (owner-directed, docs/17 row 113 — the
 * seam `moduleRepo.patchModulePartText` stamps it at write time, because the
 * origin is knowable there and nowhere else).
 *
 *   - `'model'` — a model write: the seam was handed the serving model
 *     (`writerModel`). Generated parts, a canvas chat apply and an accepted
 *     AI proposal are all this case. The owner's auto-accept checkbox is a
 *     DELEGATION of consent for exactly this text, so the normalization pass
 *     applies its link rewrites to it directly.
 *   - `'human'` — a HUMAN write: no model served it (the reader's hand edit,
 *     the canvas' manual Save). Its consent protection is unchanged: a
 *     rewrite of it is held as a proposal until the owner applies it.
 *   - `null` — NOT RECORDED, i.e. every row written before this field. The
 *     origin is NOT recoverable from what those rows carry: a hand edit
 *     deliberately KEEPS the previous `writerModel` (docs/17 row 93), so a
 *     recorded model id does not prove a model wrote the current text. Every
 *     reader therefore treats `null` as human-authored — the CONSERVATIVE
 *     default: such text keeps asking, and no rewrite is ever auto-applied to
 *     text that may have been typed by hand. `textOriginIsMachineWritten` is
 *     the ONE place that turns this into a verdict.
 */
export const textOriginSchema = z.enum(['human', 'model']);

export type TextOrigin = z.infer<typeof textOriginSchema>;

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
  /**
   * PROVENANCE (provenance arc, docs/17 row 93): the model that wrote this
   * spine's premise — the `modelUsed` of the serving spine call (the
   * contract-repair retry and the floor-repair retry escalate to the fallback
   * model, so the recorded value is whichever call's text actually landed).
   *
   * Additive `.default('')` — parse-on-read, NO Dexie version. `''` = NOT
   * RECORDED (every module written before the field; a hand-written premise)
   * and displays as NOTHING — never invented from the current settings. The
   * reader shows it below the premise; a hand edit of the premise keeps it
   * (the field answers "which model wrote this").
   */
  writerModel: z.string().default(''),
  /**
   * WHO WROTE the premise right now (see `textOriginSchema`). Additive
   * `.default(null)` — parse-on-read, NO Dexie version, exactly like
   * `writerModel` beside it.
   *
   * Stamped by the two premise writers, and by no one else:
   *   - the spine pass records `'model'` with the premise it just wrote;
   *   - `moduleGen.approveSpineAndRun` — the "Generate parts" click, whose
   *     draft the checkpoint let the owner edit — records `'human'` ONLY when
   *     the approved premise's TEXT differs from the premise already on the
   *     row (an untouched draft is the model's own text, so clicking through
   *     the always-on checkpoint must not claim authorship of it), and
   *     carries the recorded origin forward when it does not differ;
   *   - `moduleGen.applyNormalizationVerdict` records `'model'` after it
   *     rewrites the premise's link targets, because the document it wrote is
   *     no longer the one the owner typed.
   *
   * `null` = NOT RECORDED (every module written before the field) and reads
   * as HUMAN-AUTHORED (the conservative default, `textOriginSchema`). No
   * surface may infer it from `writerModel` — see the seam's rationale.
   */
  origin: textOriginSchema.nullable().default(null),
});

export type ModuleSpine = z.infer<typeof moduleSpineSchema>;

/** One generated chapter. `planIndex` points into `spine.partPlan`. */
export const modulePartSchema = z.object({
  planIndex: z.number().int().nonnegative(),
  /** The actual module text with [[wiki-links]]; H1 is added by the reader. */
  markdown: z.string(),
  status: modulePartStatusSchema,
  errorMessage: z.string(),
  /** True once the part was written OUTSIDE the generator — a hand edit, a
   * chat apply, an accepted AI proposal (08 §M4-B / docs/17 row 113: rewrite
   * then confirms before overwriting). It is NOT an authorship claim: a
   * canvas-applied model rewrite sets it too. `origin` below is the field that
   * answers "who wrote this text" and is what the consent rule reads. */
  edited: z.boolean(),
  /**
   * PROVENANCE (provenance arc, docs/17 row 93): the model that wrote THIS
   * part's markdown — the `modelUsed` of the serving parts call (generation,
   * missing-part fill, a single-part rewrite, the in-pass floor repair or the
   * board rewrite; the repair and rewrite passes escalate to the fallback
   * model, so the recorded value is whichever call actually wrote the text).
   * A chat-applied rewrite writes the CHAT model (the last writer).
   *
   * Additive `.default('')` — parse-on-read, NO Dexie version. `''` = NOT
   * RECORDED (parts written before the field; a part whose call genuinely
   * produced no model) and displays as NOTHING. A HAND EDIT KEEPS the value:
   * the field answers "which model wrote this", and the owner's edits must not
   * erase the provenance of the text they edited. Never derived from settings
   * and never backfilled (docs/18 §2.2, §4).
   */
  writerModel: z.string().default(''),
  /**
   * WHO WROTE this part's markdown right now (see `textOriginSchema`).
   * Additive `.default(null)` — parse-on-read, NO Dexie version.
   *
   * THE ONE authoring record, stamped at THE one part-text save seam
   * (`moduleRepo.patchModulePartText`: handing it a `writerModel` records
   * `'model'`, omitting it records `'human'`) and by the generator's own part
   * writes (`'model'`). It answers what `edited` never could: an auto-accepted
   * AI rewrite is `edited: true` AND `origin: 'model'`.
   *
   * `null` = NOT RECORDED (every part written before the field) and reads as
   * HUMAN-AUTHORED — the conservative default. NEVER inferred from
   * `writerModel`, which a hand edit deliberately carries forward.
   */
  origin: textOriginSchema.nullable().default(null),
});

export type ModulePart = z.infer<typeof modulePartSchema>;

/**
 * Canvas v1 (08-MODULE-DESIGNER §Module canvas): the user-arranged layout of
 * the whole-module canvas — one position per node key plus the persisted
 * viewport. Node keys are STABLE identifiers, never indexes that renumber:
 * `'premise'` and `'part-<planIndex>'` for this module's own cards
 * (`planIndex` is IDENTITY, never a position in a list: every part write and
 * single-part rewrite addresses a part BY it — `moduleRepo.patchModulePartText`
 * and `moduleGen`'s parts pass, whose stream events carry it too — the reader
 * orders and labels parts by it, the encounter floor's per-part bands and its
 * `repairModuleEncounterFloor` repairs are keyed on it, and the canvas's
 * `?part=<planIndex>` scroll target and this node key both spell it),
 * `'prior-<moduleId>'` for prior-module text groups. The
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
 * THE bestiary slot (the Aunt Agatha path, docs/11 D4/§Module-side cast,
 * docs/17 row 107): a library creature whose STATS this entity borrows while
 * keeping its own name and prose — *"Often modules want lets say a zombie, but
 * its old aunt agatha. So, she will have zombie stats but with prose."*
 * (owner, verbatim).
 *
 * The model emits it on an entity RECORD, so the request is expressible in the
 * module-generation contract itself. It names a LIBRARY creature only — the
 * app resolves the name to the chunk's identity, so the model never has to
 * invent a chunk id or a content hash, and no campaign row is involved.
 */
export const entityBestiarySlotSchema = z.object({
  /** The creature's name as the library spells it (`canonicalCreatureName`):
   * the last non-empty heading of a stat-block chunk. */
  creature: z.string().trim().min(1),
  /**
   * The BOOK to disambiguate with, when the library carries more than one
   * creature of that name — the rulebook's title as the app shows it in an
   * origin label. Omit it for the common case.
   */
  book: z.string().trim().min(1).optional(),
});

export type EntityBestiarySlot = z.infer<typeof entityBestiarySlotSchema>;

/**
 * How long an entity's author's-intent note may be (08 §M4-C "Entity intent",
 * docs/17 row 141). ONE constant: the record schema refuses anything past it and
 * the spine clause states the SAME number to the model, so the prompt can never
 * promise a length the boundary then rejects (AGENTS rule 4). The cap is a
 * steering note, not a draft — it bounds the note, and a value past it is a LOUD
 * validation failure, never a silent truncation (AGENTS rules 1/3).
 */
export const ENTITY_INTENT_MAX_LENGTH = 400;

/**
 * The inclusive bounds of an entity's recorded LEVEL hint (docs/17 row 197).
 * ONE pair of constants: the record schema refuses anything outside them and the
 * spine clause states the SAME range to the model, so the prompt can never offer
 * a level the boundary then rejects (AGENTS rule 4). A value outside the range —
 * or a non-integer — is a LOUD validation failure that fails the spine parse,
 * never a silent clamp (AGENTS rules 1/3).
 */
export const ENTITY_LEVEL_HINT_MIN = 1;
export const ENTITY_LEVEL_HINT_MAX = 20;

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
  /**
   * The library creature this entity's stats come from, when the model asked
   * for a cast (the Aunt Agatha path, docs/17 row 107).
   *
   * ADDITIVE and OPTIONAL — as strictly additive as a field can be: a record
   * written before the field, a record that asks for nothing, and the model's
   * own `"bestiary": null` (the strict contract's spelling of "no cast") ALL
   * read as `undefined`. Nothing is backfilled, no default is materialized onto
   * rows that predate the question, and every existing assertion about a
   * record's shape (`{ name, kind, absorbed }`) stays true. `undefined` is
   * "this entity is detailed by its own persona run", which is what every
   * module written before this arc asks for.
   *
   * It is a REQUEST, not a resolved citation: the app resolves it against the
   * library at the moment the entity becomes an artifact
   * (`features/modules/entity-batch` → `db/creatureRepo.castCreatureAsNpc`,
   * the ONE cast function), and an unresolvable or ambiguous name fails the
   * entity LOUDLY by name rather than being guessed at.
   */
  bestiary: z
    .preprocess((value) => (value === null ? undefined : value), entityBestiarySlotSchema.optional()),
  /**
   * The module author's note about what this entity is FOR — the hint that
   * steers the detail worker which fills the name in (08 §M4-C "Entity intent",
   * docs/17 row 141).
   *
   * ADDITIVE and OPTIONAL, exactly as strictly additive as `bestiary` above: a
   * record written before the field, the model's own `"intent": null` (the
   * strict contract's spelling of "nothing to say") and an empty string ALL read
   * as "no intent" — the preprocessor folds `null`, `''` and a whitespace-only
   * value to `undefined`, so there is ONE spelling of absence downstream, nothing
   * is backfilled and no default is materialized onto rows that predate the
   * question. Every existing assertion about a record's shape
   * (`{ name, kind, absorbed }`) stays true.
   *
   * BOUNDED to a steering note, not a draft: `ENTITY_INTENT_MAX_LENGTH` is
   * enforced HERE, at the boundary that parses both the model's spine reply and
   * every stored row — a longer value is a validation ERROR that fails the run
   * loudly (AGENTS rules 1/3), never a silent truncation. The strict JSON
   * contract cannot carry the bound (its subset strips `maxLength`), which is why
   * the spine clause states the same number to the model.
   *
   * It is an AUTHORING note, never printed on a surface a reader sees: the
   * reader, the canvas, the module document and every export read prose, and the
   * only consumer of this field is `buildEntityBrief` (via `entityIntentFor`
   * below). Slice (B) — the owner's editable field in the entity panel — is NOT
   * built; nothing else may read it.
   */
  intent: z.preprocess(
    (value) => {
      if (value === null) return undefined;
      if (typeof value !== 'string') return value;
      const note = value.trim();
      return note === '' ? undefined : note;
    },
    z
      .string()
      .max(ENTITY_INTENT_MAX_LENGTH, {
        // Loud and NAMED (AGENTS rules 1/3): the reason says which field, which
        // limit, and that shortening is the remedy — never a truncation.
        message: `an entity's intent is a steering note of at most ${String(ENTITY_INTENT_MAX_LENGTH)} characters — shorten it, it is never truncated`,
      })
      .optional(),
  ),
  /**
   * The LEVEL the module author fixed for this entity in the prose (owner
   * request, docs/17 row 197) — the structured hint that survives the boundary
   * into the generator that builds the entity.
   *
   * THE MEASURED GAP IT CLOSES. The encounter lane has a real structured level
   * input (`artifact.ts` `data.levelHint`, fed to the room budget); the NPC lane
   * had none — `statBlockSchema.level` is a bare `z.string()` and
   * `runEngine.runStatblock` recovered a level only by REGEX over the brief text
   * (`/level\s*(\d{1,2})/i`). A level stated in the module's own prose was
   * therefore lost at the entity boundary unless that exact sentence happened to
   * ride the brief, and the owner's level-7 gnome came out at level 1.
   *
   * WHY IT LIVES ON THE ENTITY RECORD AND NOT IN A SECOND, TOP-LEVEL
   * `entityHints` ARRAY. The record IS the module author's per-entity channel to
   * the generators: it already carries the author's `intent` note (row 141) and
   * the cast `bestiary` slot (row 107), it already has ONE name comparison
   * (`sameAliasName` through `entityKindFor` / `entityIntentFor` /
   * `entityLevelHintFor`), ONE record cap, ONE normalization carry
   * (`withEntityBestiarySlots`) and ONE read path into `buildEntityBrief`. A
   * parallel array would be a SECOND name-keyed per-entity record on the module
   * row — a second comparison, a second cap, a second carry and a second answer
   * to "which one wins" when both carried a note (AGENTS rule 4).
   *
   * ADDITIVE and OPTIONAL, exactly as strictly additive as `intent` above: a
   * record written before the field, the model's own `"levelHint": null` (the
   * strict contract's spelling of "no level stated") and an empty/whitespace
   * string ALL read as `undefined`, so there is ONE spelling of absence
   * downstream, nothing is backfilled and no default is materialized onto rows
   * that predate the question. A module with no hints therefore behaves BYTE-
   * IDENTICALLY to before this field existed (the compatibility pin).
   *
   * A numeric STRING is accepted (meaning-preserving coercion, the shared
   * `numericStat` precedent); anything else — a float, a non-numeric string, a
   * value outside `ENTITY_LEVEL_HINT_MIN`..`ENTITY_LEVEL_HINT_MAX` — is a LOUD
   * validation ERROR that fails the spine parse naming the field (AGENTS rules
   * 1/3), never a clamp and never a partial apply.
   */
  levelHint: z.preprocess(
    (value) => {
      if (value === null) return undefined;
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      // An empty/whitespace string is the OTHER spelling of absence (the
      // `intent` precedent): folded to `undefined`, never handed to `z.number`.
      if (trimmed === '') return undefined;
      if (Number.isFinite(Number(trimmed))) return Number(trimmed);
      return value;
    },
    z
      .number({
        // The reason names the field, the range and the remedy (AGENTS 1/3).
        error: `an entity's levelHint must be a whole number between ${String(ENTITY_LEVEL_HINT_MIN)} and ${String(ENTITY_LEVEL_HINT_MAX)}, or null when the prose states no level — it is never guessed`,
      })
      .int({
        message: `an entity's levelHint must be a whole number between ${String(ENTITY_LEVEL_HINT_MIN)} and ${String(ENTITY_LEVEL_HINT_MAX)} — it is never rounded`,
      })
      .min(ENTITY_LEVEL_HINT_MIN, {
        message: `an entity's levelHint must be at least ${String(ENTITY_LEVEL_HINT_MIN)}`,
      })
      .max(ENTITY_LEVEL_HINT_MAX, {
        message: `an entity's levelHint must be at most ${String(ENTITY_LEVEL_HINT_MAX)}`,
      })
      .optional(),
  ),
});

export type ModuleEntityKind = z.infer<typeof moduleEntityKindSchema>;

/**
 * Carries the model-RECORDED fields the normalizer cannot know about onto the
 * CANONICAL records a name normalization pass produces (docs/17 row 107; the
 * author's intent, docs/17 row 141).
 *
 * The name is HISTORICAL: the helper was written for the bestiary slot and now
 * carries the entity's `intent` (row 141) and `levelHint` (row 197) too, because
 * the reason is the same for all three — and a second carry function would be a
 * second mechanism for one idea (AGENTS rule 4). Every field is the MODEL's own
 * record, written on the variant-keyed records the reply produced; the
 * normalization reply answers which canonical name each listed name refers to
 * and knows nothing about any of them, so the requests the model already made
 * ride through the substitution rather than being dropped with the records they
 * were written on. Without this the spine pass would record an intent or a level
 * hint and the very next pass (name normalization, `moduleGen.normalizeAndSave`)
 * would silently delete it.
 *
 * Matching is exact and case-insensitive over the record's own name plus every
 * `absorbed` variant, the same comparison the normalization pass itself is
 * allowed to use; a name whose spelling the pass canonicalized keeps its request,
 * because the variant it was written under still resolves to that canonical.
 *
 * LOUD, never a pick (AGENTS rule 1): two source records answering one canonical
 * with DIFFERENT creatures — or with two different intents, or two different
 * levels — is a state the normalizer cannot have meant, and quietly choosing one
 * would silently re-stat, silently re-steer or silently re-level an entity.
 *
 * KEY SPACE `MODULE_NAME_KEY` (docs/17 row 167): the module's own entity-kind
 * records answer to several names (their `absorbed` aliases, and the
 * comma-split alternates of their own name), and every one of those is matched
 * through `comparableName` — so a record's alias and a later lookup cannot
 * disagree about what one name is.
 */
export function withEntityBestiarySlots(
  records: readonly ModuleEntityKind[],
  source: readonly ModuleEntityKind[],
): ModuleEntityKind[] {
  /** Every name a source record answers to, mapped to that record. */
  const sourceByName = new Map<string, ModuleEntityKind>();
  for (const entry of source) {
    for (const alias of [entry.name, ...entry.absorbed]) {
      const key = comparableName(alias);
      if (key !== '') sourceByName.set(key, entry);
    }
  }
  return records.map((record) => {
    const parts = [record.name, ...record.name.split(',')].map((part) => comparableName(part));
    const contributing = [...record.absorbed, ...parts]
      .map((alias) => sourceByName.get(comparableName(alias)))
      .filter((entry): entry is ModuleEntityKind => entry !== undefined);
    const found: EntityBestiarySlot[] = [];
    for (const entry of contributing) {
      const slot = entry.bestiary;
      if (slot === undefined) continue;
      if (!found.some((existing) => sameSlot(existing, slot))) found.push(slot);
    }
    // The author's intents the same source records carry (docs/17 row 141):
    // exact, trimmed equality — two spellings of one note are one note, two
    // different notes about one entity are a contradiction.
    const intents: string[] = [];
    for (const entry of contributing) {
      const note = entry.intent?.trim();
      if (note === undefined || note === '') continue;
      if (!intents.includes(note)) intents.push(note);
    }
    // The author's LEVEL hints the same source records carry (docs/17 row 197):
    // numeric equality — two records answering one canonical with different
    // levels are a contradiction, not a choice to make silently.
    const levels: number[] = [];
    for (const entry of contributing) {
      const level = entry.levelHint;
      if (level === undefined) continue;
      if (!levels.includes(level)) levels.push(level);
    }
    if (found.length === 0 && intents.length === 0 && levels.length === 0) return record;
    if (found.length > 1) {
      // Two source records answer ONE canonical with different creatures: the
      // normalizer cannot have meant that, and picking one would silently
      // re-stat an entity (AGENTS rule 1).
      throw new Error(
        `entity bestiary slot: «${record.name}» was asked to borrow the stats of two different library ` +
          `creatures (${found.map((slot) => `«${slot.creature}»`).join(' and ')}) — one entity cannot be cast twice`,
      );
    }
    if (intents.length > 1) {
      // The same rule for the author's note: it steers what this entity is FOR,
      // so two of them are two different entities wearing one name.
      throw new Error(
        `entity intent: «${record.name}» was given two different author's notes ` +
          `(${intents.map((note) => `«${note}»`).join(' and ')}) — one entity has one intent`,
      );
    }
    if (levels.length > 1) {
      // ...and for the author's level hint: silently picking one would generate
      // the entity at a level the other record contradicts (AGENTS rule 1).
      throw new Error(
        `entity level hint: «${record.name}» was given two different levels ` +
          `(${levels.map((level) => String(level)).join(' and ')}) — one entity has one level`,
      );
    }
    return {
      ...record,
      ...(found[0] === undefined ? {} : { bestiary: found[0] }),
      ...(intents[0] === undefined ? {} : { intent: intents[0] }),
      ...(levels[0] === undefined ? {} : { levelHint: levels[0] }),
    };
  });
}

/** Two slots asking for the same creature from the same book. The CREATURE half
 * is the app's ONE comparable form — `domain/artifactAlias.comparableName`,
 * which is `sameCreatureName`'s own primitive (docs/17 row 166) — so a slot
 * written with a decomposed umlaut and one written precomposed are one slot.
 * The BOOK half is deliberately a plain trim+case fold and is NOT folded onto
 * the comparable form: a book title is not a creature/artifact NAME, and the
 * disambiguation rule that reads it is docs/17 row 161's (this file only asks
 * whether two slots named the same book). */
function sameSlot(a: EntityBestiarySlot, b: EntityBestiarySlot): boolean {
  return (
    comparableName(a.creature) === comparableName(b.creature) &&
    (a.book ?? '').trim().toLowerCase() === (b.book ?? '').trim().toLowerCase()
  );
}

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

/** Lookup of a recorded entity kind through the ONE name comparison
 *  (docs/17 row 166; `target` is only the emptiness probe). Undefined =
 *  unknown. */
export function entityKindFor(
  entityKinds: readonly ModuleEntityKind[],
  name: string,
): EntityKind | undefined {
  const target = name.trim().toLowerCase();
  if (target === '') return undefined;
  return entityKinds.find((entry) => sameAliasName(entry.name, name))?.kind;
}

/**
 * The bestiary slot the module RECORDED for one entity name — the model's cast
 * request, read back at the moment the entity becomes an artifact (docs/17
 * row 107). `null` when the name has no record or its record asks for no cast,
 * which is every module written before the field and every entity that is
 * detailed by its own persona run. ONE read, so the finalize path and a test
 * can never disagree about which record carries the request.
 */
export function bestiarySlotForEntity(
  entityKinds: readonly ModuleEntityKind[],
  name: string,
): EntityBestiarySlot | null {
  const target = name.trim().toLowerCase();
  if (target === '') return null;
  return entityKinds.find((entry) => sameAliasName(entry.name, name))?.bestiary ?? null;
}

/**
 * The author's-intent note the module RECORDED for one entity name, read back
 * at the moment its detail brief is built (08 §M4-C "Entity intent", docs/17 row
 * 141). `null` when the name has no record or its record carries no note —
 * which is every module written before the field, every `null` the model
 * answered, and every `''`. ONE read, so the batch, the post-generation
 * automation, the stub popover's single-entity delegation and the change/refill
 * seam can never disagree about which note an entity carries (AGENTS rule 4):
 * they all reach the brief through `buildEntityBrief`.
 *
 * The schema above already folds `null`/`''`/whitespace to `undefined`; the
 * empty check is repeated here because a record may be built in code without
 * passing that parse, and `''` must read as NO INTENT rather than as an empty
 * paragraph on the brief (the byte-identical rule).
 */
export function entityIntentFor(
  entityKinds: readonly ModuleEntityKind[],
  name: string,
): string | null {
  const target = name.trim().toLowerCase();
  if (target === '') return null;
  const value = entityKinds.find((entry) => sameAliasName(entry.name, name))?.intent?.trim();
  return value === undefined || value === '' ? null : value;
}

/**
 * The LEVEL the module RECORDED for one entity name (docs/17 row 197), read back
 * at the moment its detail brief and its stat-block run are built. `null` when
 * the name has no record or its record states no level — which is every module
 * written before the field, every `null` the model answered, and every `''`.
 * ONE read, so the entity batch, the post-generation automation, the stub
 * popover's single-entity delegation and the change/refill lane can never
 * disagree about which level an entity carries (AGENTS rule 4): they all reach
 * the generators through the batch, which reads THIS function.
 *
 * Matching is the record's own `name` through the ONE comparison
 * (`sameAliasName`, docs/17 row 166) — the exact seam `entityKindFor` and
 * `entityIntentFor` above use; the empty-name probe is the same one, and exists
 * only as an emptiness test (composition cannot change emptiness).
 */
export function entityLevelHintFor(
  entityKinds: readonly ModuleEntityKind[],
  name: string,
): number | null {
  const target = name.trim().toLowerCase();
  if (target === '') return null;
  return entityKinds.find((entry) => sameAliasName(entry.name, name))?.levelHint ?? null;
}

/**
 * Records the MODULE's own stated level on the entity records that get a stat
 * block authored from scratch (docs/17 row 247) — the spine-time half of "the
 * premise's level must actually reach resolution".
 *
 * THE DEFECT IT CLOSES. `levelHint` was written ONLY by the spine MODEL: when
 * the planner answered `"levelHint": null` (or when a name was introduced by a
 * later part and only CLASSIFIED by the normalization pass, which can carry a
 * field but never author one — docs/17 row 197), the record kept no level at
 * all, and the entity generator was left to pick one. The owner's module
 * DESCRIBED a level-5 smith in its premise and the Smith produced a level-3
 * block.
 *
 * WHICH KINDS. `npc` only, and deliberately: a mob IS an npc row in this app,
 * and `npc` is the one entity kind whose stat block the Smith authors from
 * scratch. `encounter` carries its own structured level chain (its free-text
 * `data.levelHint` plus `partLevelForMention`), and location/event/faction/note
 * author no stat block at all — stamping a level on those would invent a fact
 * about an entity that has no level semantics.
 *
 * A RECORD THAT ALREADY STATES A LEVEL IS UNTOUCHED — the model's own answer is
 * more specific than the module's overall statement, and this function never
 * overwrites what the planner fixed. An `undefined` `statedLevel` (a module
 * whose own sources state no level) leaves every record byte-identical, so the
 * engine's loud refusal is decided by the engine, never papered over here.
 */
export function withCombatEntityLevelHints(
  records: readonly ModuleEntityKind[],
  statedLevel: number | undefined,
): ModuleEntityKind[] {
  if (statedLevel === undefined) return [...records];
  return records.map((record) =>
    record.kind === 'npc' && record.levelHint === undefined
      ? { ...record, levelHint: statedLevel }
      : record,
  );
}

/**
 * The recorded LEVEL hints whose NAME the module's own text never mentions — the
 * ONE derivation of "this hint can never reach a generator" (docs/17 row 197,
 * AGENTS rules 1/3).
 *
 * WHY THIS EXISTS. A hint is consumed by NAME, through the same mention rule
 * every batch target passes (`post-generation.namesOfKind`: a wiki-link name of
 * the module document whose recorded kind is the batch's kind). A record that
 * carries a level hint but whose name is not a wiki-link mention is therefore
 * never a target and never a brief: without this derivation the hint would be
 * dropped in SILENCE, which AGENTS rule 1 forbids. It is named, not repaired:
 * the caller reports it loudly and NEVER invents an entity for it.
 *
 * It is deliberately NOT a second name comparison: both sides are matched with
 * `sameAliasName`, the module's one comparable form (docs/17 row 166), and only
 * the record's canonical `name` is asked — exactly what `entityKindFor` (and so
 * `batchTargets`) asks, so "the panel offers it" and "the hint is matched"
 * cannot come to mean two different sets of names.
 *
 * `mentionedNames` is the module document's wiki-link names
 * (`lib/wikilinks.extractWikiLinks` over `module.moduleDocumentText`) — the
 * caller reads them, keeping this pure domain module free of a `lib` import.
 */
export function unmatchedEntityLevelHints(
  mentionedNames: readonly string[],
  entityKinds: readonly ModuleEntityKind[],
): ModuleEntityKind[] {
  return entityKinds.filter(
    (record) =>
      record.levelHint !== undefined &&
      !mentionedNames.some((name) => sameAliasName(record.name, name)),
  );
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
     * The module's OWN encounter budget policy (docs/17 row 180, owner
     * request): which rule bounds a generated room's challenge. Additive
     * optional — `null` on every row written before the field, which
     * `resolveEncounterBudgetPolicy` reads as `'system'` (today's per-system
     * behaviour, byte-identical). A module created after the field is STAMPED
     * with the creation default (`defaultEncounterBudgetPolicy`: pf2e →
     * `'pf2e-budget'`, everything else → `'system'`), so every later
     * generation and repopulate of that module uses the same policy
     * deterministically — a later Settings/dialog change can never drift it.
     * Nullable rather than defaulted on purpose: the recorded value must be
     * able to say "no explicit choice" (the legacy reading).
     */
    encounterBudgetPolicy: encounterBudgetPolicySchema.nullable().default(null),
    /**
     * The module's OWN difficulty (docs/17 row 190, owner request): how hard
     * the module should be for the party — a SIBLING of
     * `encounterBudgetPolicy` above, never a second version of it. The policy
     * decides WHICH rule bounds a room's challenge; difficulty scales whatever
     * numeric budget that rule produces. Additive optional — `null` on every
     * row written before the field, which `resolveModuleDifficulty` reads as
     * `'normal'` (multiplier 1: today's numbers, byte-identical). A module
     * created after the field is STAMPED with the middle step
     * (`DEFAULT_MODULE_DIFFICULTY`), so every later generation of that module
     * reads the same difficulty deterministically. Nullable rather than
     * defaulted on purpose (the policy field's precedent): the recorded value
     * must be able to say "no explicit choice" — the legacy reading — rather
     * than being indistinguishable from an owner who explicitly chose normal.
     */
    difficulty: moduleDifficultySchema.nullable().default(null),
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
    /**
     * The module's DOCUMENT PLAN (docs/17 row 109, docs/07 §M3-D,
     * `domain/documentPlan.ts`): the LLM-authored, zod-validated layout plan
     * for this module's PDFs. Additive `.default(null)` — parse-on-read, NO
     * Dexie version, NO index change (the `modules` store indexes `id`,
     * `campaignId`, `updatedAt` only, and this field is not indexed), and it
     * rides backup plus campaign export/import with the rest of the row
     * (`moduleSchema` IS the export shape).
     *
     * Stored UNVALIDATED (`z.unknown()`) on purpose, and this is the one field
     * of the row that is: a plan is model output, so a corrupt or hand-edited
     * value must NOT make the whole module row unreadable at the repo
     * boundary (every other surface — reader, canvas, battle — would die for a
     * defect that belongs to the PDF alone). `domain/documentPlan.
     * readStoredDocumentPlan` is the ONE read: absent ⇒ the procedural
     * outline, silently (the normal case); invalid ⇒ a LOUD report at the
     * document, whose export still lands (AGENTS rules 1–2).
     *
     * Written by exactly one writer, the planner seam
     * (`llm/modulePlan.planModuleDocument` → `patchModule`); the renderer
     * reads it straight off the row, so no call site passes a plan around.
     */
    documentPlan: z.unknown().default(null),
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
   * The encounter budget policy this module enforces (docs/17 row 180). The
   * CALLER resolves the default (`defaultEncounterBudgetPolicy(campaign.system)`)
   * when the owner recorded no explicit choice; the creation path always stamps
   * a real value, so a fresh module never relies on the legacy null reading.
   * Omitted or undefined = not recorded (a caller that predates the field, or a
   * direct `createModule` in a test) = `'system'`, exactly as before.
   */
  encounterBudgetPolicy?: EncounterBudgetPolicy;
  /**
   * The module difficulty this module is tuned for (docs/17 row 190), the
   * sibling of the budget policy above. The CALLER resolves the default
   * (`DEFAULT_MODULE_DIFFICULTY`, the middle step) when the owner recorded no
   * explicit choice; the creation path always stamps a real value, so a fresh
   * module never relies on the legacy null reading. Omitted or undefined = not
   * recorded (a caller that predates the field, or a direct `createModule` in a
   * test) = `'normal'`, exactly as before.
   */
  difficulty?: ModuleDifficulty;
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
    encounterBudgetPolicy: input.encounterBudgetPolicy ?? null,
    difficulty: input.difficulty ?? null,
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

/**
 * THE one resolution of a typed CREATION name to a module title (docs/17 row
 * 213). A blank or whitespace-only field means "no name given" and resolves to
 * the placeholder `defaultModuleTitle()`; otherwise the trimmed text. The
 * result is always a non-empty string, because `moduleSchema.title` is
 * `z.string().min(1)` and the persisted draft must never fail validation on a
 * whitespace-only field. BOTH places that turn the dialog's Name field into a
 * title call this — the draft's saved value and the `NewModule` input the
 * creation sends — so the two can never disagree.
 *
 * This is NOT the reader's rename rule (`ModuleReaderPage.ModuleTitleInput`):
 * there a blank field means "revert to the STORED title" — a write refusal, not
 * a default. The two stay two questions: creation has no stored title to revert
 * to, and a rename must never silently become the placeholder (a cleared title
 * on an existing module is a mistake to undo, not a request to rename it "New
 * Module").
 */
export function resolveModuleTitle(name: string): string {
  const trimmed = name.trim();
  return trimmed === '' ? defaultModuleTitle() : trimmed;
}
