import { z } from 'zod';

import { formatModifier } from '@/domain/statblock';
import {
  spellAreaSchema,
  spellDamageMapSchema,
  spellTraitsAreFocus,
  type SpellArea,
  type SpellDamage,
  type SpellData,
  type SpellHeighteningEntry,
  type Dnd5eDamagePart,
} from '@/domain/spellData';

/**
 * PF2e heightening — THE one rule (docs/17 ledger 183). A pure function over
 * the stored `SpellData` payload: no UI, no LLM, no IO, no second heightening
 * rule anywhere (the mob arc asks `spellAtRank` and renders what it returns).
 *
 * THE PAIZO RULE, per the source's OWN `system.heightening` shape — MEASURED
 * against `foundryvtt/pf2e` `v14-dev`, not guessed:
 *
 * - `fixed` (`{type:'fixed', levels:{'3':{damage:{…}}, …}}`): the applied layer
 *   is the HIGHEST listed rank `<= castRank`. Each layer's values are COMPLETE
 *   replacements, never deltas (`packs/pf2e/spells/spells/cantrip/acid-splash.json`
 *   carries full `2d6`/`3d6`/`4d6`/`5d6` formulas at 3rd/5th/7th/9th). Cast
 *   below the lowest listed rank the BASE spell applies.
 * - `interval` (`{type:'interval', interval:N, damage:{id:'2d6'}, area:0}`):
 *   the improvement is a DELTA applied once per whole `N` ranks above the base
 *   rank. The step count is `floor((appliedRank - baseRank) / interval)`, the
 *   exact expression the reference implementation uses
 *   (`src/module/item/spell/document.ts`, `getDamage()`:
 *   `Math.floor((castRank - this.baseRank) / heightening.interval)`); a rank
 *   that leaves a remainder grants the whole steps and nothing for the
 *   leftovers (a `(+2)` spell cast 3 ranks higher gains ONE increment). The
 *   remainder is reported in `stepRemainder` and named in `warnings`, so the
 *   arithmetic is never hidden. `area` is a NUMBER of feet ADDED per step
 *   (`prepareBaseData`: `system.area.value += heightening.area * timesHeightened`).
 * - `cantrip`: the caller does not choose the rank. A cantrip auto-heightens to
 *   `clamp(ceil(casterLevel / 2), 1, 10)` (`document.ts` `rank` getter:
 *   `Math.ceil(this.actor.level / 2)` then `Math.clamp(…, 1, 10)`), and its
 *   RULES base rank is 1 (the corpus stores every cantrip at
 *   `system.level.value: 1`; `spellData.rank === 0` is the deliberate
 *   LIST-ordering normalization from ledger 181, NOT the step origin). Using 0
 *   here would over-heighten every cantrip by one step.
 * - `focus` (ledger 191): a non-cantrip spell carrying the `focus` TRAIT
 *   auto-heightens EXACTLY like a cantrip upstream
 *   (`isAutoHeightened = isCantrip || isFocusSpell`) and IGNORES the item's
 *   `location.heightenedLevel`. Upstream's order is
 *   `location.autoHeightenLevel || spellcasting?.system?.autoHeightenLevel.value
 *   || Math.ceil(actor.level / 2)`, clamped to 1..10; this rule takes the
 *   already-resolved fixed rank in `request.autoHeightenLevel` (the two source
 *   fields live on the CREATURE document, which only the importer reads — see
 *   `ingest/packs/pf2e-foundry.ts`) and derives from `casterLevel` otherwise.
 *   A focus spell whose base rank is above 1 uses its OWN rank as the base,
 *   and an EXPLICIT `castRank` wins over every derived one.
 * - prose only: a source with NO structured `heightening` but WITH parsed notes
 *   returns the applicable note text VERBATIM and a loud marker — no numbers
 *   are computed from prose.
 *
 * NO INVENTED NUMBERS: every formula comes from the payload's own structure
 * (`spell.damage` plus the `heightening` object). Formulae are combined
 * SYMBOLICALLY — never evaluated, never rolled — and a formula term this module
 * cannot read throws instead of guessing.
 */

/** The loud marker for a spell whose heightening is prose only. */
export const PROSE_ONLY_MARKER =
  'prose-only: the source states heightening notes but carries no structured heightening values; the note text is returned verbatim and NO numbers are computed.';

/**
 * The loud marker for a dnd5e spell whose "At Higher Levels" / cantrip
 * progression is prose only (row 194): the source's own damage `scaling.mode`
 * states no structured increase, so the sentence is printed VERBATIM and NO
 * number is computed from it. Deliberately a SECOND, dnd5e-worded marker:
 * `PROSE_ONLY_MARKER` names PF2e `heightening` notes, and a chip that showed
 * that sentence over a 5e spell would misname the mechanism.
 */
export const DND5E_PROSE_ONLY_MARKER =
  'prose-only: the source states its higher-level effect in prose only (no structured damage scaling); the source sentence is returned verbatim and NO numbers are computed.';

/** Prefix on every `warnings` entry that echoes a raw unparsed prose line. */
export const UNPARSED_HEIGHTENING_PREFIX = 'unparsed-heightening: ';

/**
 * Which mechanism produced `values`. For a cantrip or a focus spell the rank is
 * auto-derived (`source: 'cantrip-auto'` / `'focus-auto'`) while the numbers
 * still come from this arm — the two are reported separately so neither fact is
 * lost.
 */
export type HeighteningValuesSource = 'base' | 'fixed' | 'interval' | 'scaling';

/**
 * The provenance arm of the whole computation (the brief's six arms): the three
 * PF2e value mechanisms plus the two AUTO-RANK rules — which are deliberately
 * distinct, because a cantrip and a focus spell are different rules and a
 * chip's provenance line is the only place the owner can see which one ran —
 * plus dnd5e's own `upcast` arm (row 194), which is a DIFFERENT system's
 * mechanism and never shares a name with a PF2e one.
 */
export type HeighteningSource =
  | HeighteningValuesSource
  | 'cantrip-auto'
  | 'focus-auto'
  | 'prose-only'
  | 'upcast';

/** One damage entry at the applied rank; `key` is the source's own damage id. */
export interface SpellDamageValue extends SpellDamage {
  key: string;
}

export interface SpellAtRankValues {
  /** Deterministic order: the payload's own damage-record order. */
  damage: SpellDamageValue[];
  area: SpellArea | null;
  /** The base cast facts, replaced by a fixed layer that states its own. */
  target: string;
  duration: string;
}

export interface SpellAtRank {
  source: HeighteningSource;
  valuesSource: HeighteningValuesSource;
  /** True when the cantrip rule derived the rank from `casterLevel`. */
  cantripAuto: boolean;
  /**
   * True when the FOCUS rule derived the rank (from `autoHeightenLevel` or
   * `casterLevel`) — never set together with `cantripAuto`, and never set when
   * an explicit `castRank` was supplied (that rank wins).
   */
  focusAuto: boolean;
  /**
   * True when this is a dnd5e cantrip whose values were scaled by CHARACTER
   * level (row 194) — the dnd5e arm ONLY. A PF2e cantrip's derived RANK is
   * `cantripAuto`; the two are different rules on different systems and a
   * consumer must never read one as the other.
   */
  cantripScaling: boolean;
  appliedRank: number;
  /** Interval increments applied; `null` for every non-interval spell. */
  appliedSteps: number | null;
  /** Ranks above the last whole increment (`null` off the interval arm). */
  stepRemainder: number | null;
  values: SpellAtRankValues;
  /** The applicable `heighteningEntries` prose, VERBATIM, document order. */
  notes: string[];
  /**
   * The dnd5e source's OWN "At Higher Levels" sentence, VERBATIM (row 194);
   * `null` for PF2e and for a 5e document that states none.
   */
  upcastProse: string | null;
  /** Raw prose that matched no heightening shape (never dropped). */
  unparsed: string[];
  /** Loud markers: prose-only, unparsed lines, leftovers, unsupported keys. */
  warnings: string[];
  /** Whether the source carried a structured `heightening` object at all. */
  structured: boolean;
}

export interface SpellAtRankRequest {
  /**
   * The rank the spell is cast at — REQUIRED for a ranked spell, and it must be
   * an integer `>= spell.rank` (a spell cannot be cast below its own rank).
   * IGNORED for a cantrip, whose rank the module derives; for a FOCUS spell it
   * is OPTIONAL and, when present, WINS over every derived rank (the caller's
   * assignment is authoritative — ledger 191).
   */
  castRank?: number;
  /**
   * The caster's level (integer `>= 1`) — REQUIRED for a cantrip so the module
   * can derive its rank, and for a FOCUS spell that states no
   * `autoHeightenLevel`; ignored for a ranked spell. The mob arc always has
   * both and can pass the pair for every spell without branching on kind.
   */
  casterLevel?: number;
  /**
   * A FOCUS spell's fixed auto-heightened rank, already RESOLVED from the
   * source's own two fields in upstream's order (the creature item's
   * `system.location.autoHeightenLevel`, else its casting entry's
   * `system.autoHeightenLevel.value`). It lives on the CREATURE document, which
   * only the pack importer reads, so the importer carries it here; the rule
   * never re-reads a pack. `null`/absent means "derive from `casterLevel`".
   * Ignored for a non-focus spell, and ignored when `castRank` is supplied.
   */
  autoHeightenLevel?: number | null;
  /**
   * The creature's own CHARACTER level, when its document states one — the
   * dnd5e cantrip progression's input (row 194). Absent for PF2e (which
   * derives a cantrip's RANK from `casterLevel` and has no character level)
   * and for a dnd5e cantrip whose creature states none; the rule then prints
   * the source's structured per-tier damage WITHOUT choosing a tier.
   */
  characterLevel?: number;
}

// --- the source's `system.heightening` shapes (verbatim in the payload) ------

/**
 * One `fixed` layer: `Partial<SpellSystemSource>` in the pinned upstream types
 * (`src/module/item/spell/data.ts`), of which this module CONSUMES damage,
 * area, target and duration. `.loose()` keeps every other key so an unhandled
 * one is REPORTED in `warnings`, never silently dropped.
 */
const fixedLevelSchema = z
  .object({
    damage: spellDamageMapSchema.optional(),
    area: spellAreaSchema.nullish(),
    target: z.object({ value: z.string() }).nullish(),
    duration: z.object({ value: z.string() }).nullish(),
  })
  .loose();

type FixedLevel = z.infer<typeof fixedLevelSchema>;

const fixedHeighteningSchema = z.object({
  type: z.literal('fixed'),
  levels: z.record(z.string(), fixedLevelSchema),
});

const intervalHeighteningSchema = z.object({
  type: z.literal('interval'),
  interval: z.number().int().positive(),
  area: z.number().default(0),
  damage: z.record(z.string(), z.string()).default({}),
});

type ParsedHeightening =
  | { kind: 'none' }
  | { kind: 'fixed'; levels: { rank: number; level: FixedLevel }[] }
  | { kind: 'interval'; interval: number; area: number; damage: Record<string, string> };

/**
 * Read the VERBATIM `heightening` object the payload stores into the small
 * shape this module acts on. A `type` this build does not know, a malformed
 * layer, or a non-integer level key is a LOUD error — never a silent base.
 */
function parseHeightening(raw: unknown): ParsedHeightening {
  if (raw === null || raw === undefined) return { kind: 'none' };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('spell heightening is not an object');
  }
  const record = raw as Record<string, unknown>;
  const type = record.type;
  if (type === undefined || type === null) {
    if (Object.keys(record).length === 0) return { kind: 'none' };
    throw new Error(`spell heightening has keys but no "type" (${Object.keys(record).join(', ')})`);
  }
  if (type === 'fixed') {
    const parsed = fixedHeighteningSchema.safeParse(record);
    if (!parsed.success) throw new Error(`malformed fixed heightening: ${parsed.error.message}`);
    const levels = Object.entries(parsed.data.levels)
      .map(([rankText, level]) => {
        const rank = Number(rankText);
        if (!Number.isInteger(rank) || rank < 1) {
          throw new Error(`fixed heightening has a non-rank level key "${rankText}"`);
        }
        return { rank, level };
      })
      .sort((first, second) => first.rank - second.rank);
    return { kind: 'fixed', levels };
  }
  if (type === 'interval') {
    const parsed = intervalHeighteningSchema.safeParse(record);
    if (!parsed.success) throw new Error(`malformed interval heightening: ${parsed.error.message}`);
    return {
      kind: 'interval',
      interval: parsed.data.interval,
      area: parsed.data.area,
      damage: parsed.data.damage,
    };
  }
  const label = typeof type === 'string' ? type : JSON.stringify(type);
  throw new Error(`unsupported heightening type "${label}"`);
}

// --- formula arithmetic (symbolic, deterministic, never evaluated) -----------

interface FormulaTerms {
  /** die size → signed count, in FIRST-APPEARANCE order. */
  dice: Map<number, number>;
  flat: number;
}

/**
 * Parse one simple damage formula (`'6d6'`, `'1d4 + 4'`, `'-2'`) into dice and
 * a flat total. Anything else — `@item.level`, a nested expression, a stray
 * token — is a LOUD error: this module never evaluates a formula and never
 * guesses at one it cannot read.
 */
function parseFormulaTerms(formula: string): FormulaTerms {
  const text = formula.replace(/\s+/g, '');
  if (text === '') throw new Error('spell heightening: an empty damage formula cannot be combined');
  const tokens: string[] = [];
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if ((character === '+' || character === '-') && index > 0) {
      tokens.push(current);
      current = character;
    } else {
      current += character;
    }
  }
  tokens.push(current);

  const terms: FormulaTerms = { dice: new Map(), flat: 0 };
  for (const token of tokens) {
    const dice = /^([+-]?)(\d*)d(\d+)$/i.exec(token);
    if (dice !== null) {
      const sign = dice[1] === '-' ? -1 : 1;
      const count = (dice[2] === '' || dice[2] === undefined ? 1 : Number(dice[2])) * sign;
      const die = Number(dice[3]);
      if (count === 0 || die <= 0) throw new Error(`spell heightening: unusable dice term "${token}"`);
      terms.dice.set(die, (terms.dice.get(die) ?? 0) + count);
      continue;
    }
    if (/^[+-]?\d+$/.test(token)) {
      terms.flat += Number(token);
      continue;
    }
    throw new Error(
      `spell heightening cannot read the formula term "${token}" in "${formula}"; it is never evaluated to a number`,
    );
  }
  return terms;
}

/**
 * Render parsed terms deterministically: dice terms in FIRST-APPEARANCE order
 * (the base formula's dice first, then any die the delta introduces), a single
 * flat total LAST, and `0` for an empty expression. Same-die terms are already
 * summed; a negative dice total is refused.
 */
function formatFormulaTerms(terms: FormulaTerms): string {
  const dice: string[] = [];
  for (const [die, count] of terms.dice) {
    if (count === 0) continue;
    if (count < 0) throw new Error(`spell heightening produced a negative dice count (${count}d${die})`);
    dice.push(`${count}d${die}`);
  }
  if (dice.length === 0) return String(terms.flat);
  if (terms.flat === 0) return dice.join(' + ');
  const flat = terms.flat > 0 ? `+ ${terms.flat}` : `- ${-terms.flat}`;
  return `${dice.join(' + ')} ${flat}`;
}

/**
 * Add `delta` to `base` `times` times, symbolically. `6d6 + 2×2d6 → 10d6`;
 * mixed dice and flats stay separate (`1d6 + 1d4 + 4`). Never evaluated.
 */
export function combineDamageFormula(base: string, delta: string, times: number): string {
  if (!Number.isInteger(times) || times < 0) {
    throw new Error(`spell heightening: "times" must be a non-negative integer (got ${String(times)})`);
  }
  const terms = parseFormulaTerms(base);
  if (times > 0) {
    const deltaTerms = parseFormulaTerms(delta);
    for (let step = 0; step < times; step += 1) {
      for (const [die, count] of deltaTerms.dice) {
        terms.dice.set(die, (terms.dice.get(die) ?? 0) + count);
      }
      terms.flat += deltaTerms.flat;
    }
  }
  return formatFormulaTerms(terms);
}

// --- the dnd5e arm (row 194): 5e upcasting is NOT PF2e heightening ----------

/**
 * The character level a dnd5e cantrip's progression uses, from the actor's
 * own `cantripLevel(spell)` (foundryvtt/dnd5e @ `6.0.x`, `module/data/actor/
 * npc.mjs`: `spell.system.method === "innate" ? details.cr : (details.level ||
 * attributes.spell.level)`; `character.mjs`: `details.level`). This module
 * takes the already-RESOLVED value in `request.characterLevel` — the two
 * source fields live on the CREATURE document, which only the importer reads —
 * so the rule never re-reads a pack. Throws loudly on a value that is not a
 * positive integer.
 */
function dnd5eCharacterLevel(request: SpellAtRankRequest): number | null {
  const level = request.characterLevel ?? null;
  if (level === null) return null;
  if (!Number.isInteger(level) || level < 1) {
    throw new Error(
      `spellAtRank: a dnd5e character level must be an integer >= 1 (got ${String(level)})`,
    );
  }
  return level;
}

/**
 * The number of cantrip scaling tiers a character of `level` has reached —
 * the system's own expression, NOT the PF2e `ceil(level / 2)` rule:
 * `scalingIncrease` is `Math.floor(((actor.system.cantripLevel(spell) ?? 0) +
 * 1) / 6)` (foundryvtt/dnd5e @ `6.0.x`, `module/data/item/spell.mjs`), i.e.
 * 0 tiers below level 5, 1 at 5–10, 2 at 11–16, 3 from 17 — the printed 5e
 * cantrip progression. MEASURED for levels 1…20 against that expression.
 */
export function dnd5eCantripStepsFor(level: number): number {
  return Math.floor((level + 1) / 6);
}

/**
 * One dnd5e damage part's formula with `steps` scaling increments applied,
 * in the printed `NdM±K` convention. The increment is the part's OWN
 * `scaling.number` dice — `whole` mode only, because that is the only mode the
 * real corpus states (verified across the fetched documents) — and `half`
 * (a mode the system also declares) is a LOUD error here rather than a
 * guessed rounding: a formula this module cannot read is never invented.
 * A part whose `scaling.mode` is empty (`''`) or absent has NO structured
 * increase; with `steps > 0` that is an error (the caller only counts parts
 * that stated one, so this is a corrupt payload) and with `steps === 0` the
 * base formula is returned unchanged.
 */
function dnd5eScaledFormula(part: Dnd5eDamagePart, steps: number): string {
  const mode = part.scaling?.mode ?? '';
  if (mode === '') {
    if (steps > 0) {
      throw new Error(
        `spellAtRank: damage part ${String(part.index)} states no scaling mode but ${String(steps)} increment(s) were applied — the payload is inconsistent`,
      );
    }
    return part.formula;
  }
  if (mode !== 'whole') {
    throw new Error(
      `spellAtRank: unsupported dnd5e damage scaling mode "${mode}" on damage part ${String(part.index)} (this build computes "whole" only; "half" is never guessed)`,
    );
  }
  const number = part.scaling?.number;
  if (number === undefined || number === null || !Number.isInteger(number) || number < 1) {
    throw new Error(
      `spellAtRank: damage part ${String(part.index)} states scaling mode "whole" without a positive dice count`,
    );
  }
  const bonus = numericPartBonus(part.bonus);
  if (typeof part.number !== 'number' || typeof part.denomination !== 'number') {
    // A non-dice formula (a custom expression) is carried VERBATIM and never
    // increased: the increment is a DICE count, and adding dice to prose is
    // not something this module will guess.
    if (steps > 0) {
      throw new Error(
        `spellAtRank: damage part ${String(part.index)} states dice scaling but carries no dice formula; refusing to increase it`,
      );
    }
    return part.formula;
  }
  // THE INCREMENT IS DICE, NOT A FLAT BONUS: `scaling.number` more dice of the
  // part's own denomination per step (Fire Bolt 1d10 → 2d10 at tier 1; Fireball
  // 8d6 → 10d6 two slot levels up).
  const dice = part.number + number * steps;
  return `${String(dice)}d${String(part.denomination)}${bonus === 0 ? '' : formatModifier(bonus)}`;
}

/** The flat bonus a damage part carries, as an exact number (a non-numeric
 *  bonus string is a LOUD failure, never a silent zero). */
function numericPartBonus(bonus: string): number {
  const trimmed = bonus.trim();
  if (trimmed === '') return 0;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`spellAtRank: unsupported dnd5e damage-part bonus "${bonus}"`);
  }
  return parsed;
}

/** The damage a 5e spell deals at `steps` scaling increments: the source's
 *  parts, each formatted, plus the spell's own base area and cast facts
 *  (dnd5e does not scale areas — `system.template.size` is fixed — so the
 *  base area rides through unchanged). */
function dnd5eValues(spell: SpellData, steps: number): SpellAtRankValues {
  const damage: SpellDamageValue[] = (spell.upcast?.parts ?? []).map((part) => ({
    key: String(part.index),
    formula: dnd5eScaledFormula(part, steps),
    type: part.types.join(', '),
    category: null,
    materials: [],
  }));
  return {
    damage,
    area: spell.area === null ? null : copyArea(spell.area),
    target: spell.cast.target,
    duration: spell.cast.duration,
  };
}

/**
 * THE dnd5e "At Higher Levels" rule (row 194) — the SAME `spellAtRank`
 * contract, a DIFFERENT system's mechanism. A leveled spell scales by the
 * spell SLOT it is cast in: `steps = castRank - upcast.baseLevel`, each step
 * adding the source's own `scaling.number` dice to every part that states a
 * `whole` scaling mode. A cantrip scales by CHARACTER level at the system's
 * own tiers (`dnd5eCantripStepsFor`) and is NEVER given the PF2e
 * `clamp(ceil(casterLevel / 2), 1, 10)` rank — that rule is PF2e's alone.
 *
 * When a part states no scaling, the source's own "At Higher Levels" sentence
 * is returned VERBATIM behind `DND5E_PROSE_ONLY_MARKER` and no number is
 * computed from it; when a part DOES state one, the sentence still rides
 * `upcastProse` so the owner reads the source's own words beside the numbers
 * they come from.
 */
export function spellAtRankDnd5e(
  spell: SpellData,
  request: SpellAtRankRequest,
): SpellAtRank {
  const warnings: string[] = [];
  const upcast = spell.upcast ?? null;
  const sentence = upcast?.sentence.trim() ?? '';
  const baseLevel = upcast?.baseLevel ?? 0;
  const cantrip = spell.cantrip;

  let steps: number;
  if (cantrip) {
    if (request.castRank !== undefined && request.castRank !== 0) {
      warnings.push(
        `upcast: castRank ${String(request.castRank)} ignored; a dnd5e cantrip has no slot level and is cast at its own level 0.`,
      );
    }
    const characterLevel = dnd5eCharacterLevel(request);
    if (characterLevel === null) {
      steps = 0;
      warnings.push(
        'upcast: the creature states no character level, so the cantrip\'s tier is not chosen; the source\'s per-tier scaling is printed below without a computed total.',
      );
    } else {
      steps = dnd5eCantripStepsFor(characterLevel);
    }
  } else {
    const rank = request.castRank;
    if (rank === undefined || !Number.isInteger(rank)) {
      throw new Error(
        `spellAtRank: needs an integer castRank for a non-cantrip spell (got ${String(rank)})`,
      );
    }
    if (rank < baseLevel) {
      throw new Error(
        `spellAtRank: this spell is level ${String(baseLevel)} and cannot be cast at level ${String(rank)}`,
      );
    }
    steps = rank - baseLevel;
  }

  const parts = upcast?.parts ?? [];
  const scalingParts = parts.filter((part) => (part.scaling?.mode ?? '') !== '');
  const scales = steps > 0 && scalingParts.length > 0;
  const values = dnd5eValues(spell, scales ? steps : 0);

  // A prose-only document is one whose parts state no structured increase —
  // with or without a slot level to multiply by. The sentence is printed
  // VERBATIM and no number is derived from it.
  const proseOnly = scalingParts.length === 0;
  if (proseOnly && sentence !== '') warnings.push(DND5E_PROSE_ONLY_MARKER);
  if (proseOnly && sentence === '') {
    warnings.push(
      'upcast: the source states no structured damage scaling and no higher-level sentence — there is nothing to print at another level.',
    );
  }
  if (!proseOnly && scalingParts.length !== parts.length) {
    warnings.push(
      `upcast: ${String(parts.length - scalingParts.length)} of ${String(parts.length)} damage part(s) state no scaling mode; only the parts with one were increased.`,
    );
  }

  return {
    source: proseOnly ? 'prose-only' : 'upcast',
    valuesSource: scales ? 'scaling' : 'base',
    cantripAuto: false,
    focusAuto: false,
    cantripScaling: cantrip && scales,
    appliedRank: cantrip ? 0 : (request.castRank ?? baseLevel),
    appliedSteps: steps,
    stepRemainder: null,
    values,
    notes: [],
    upcastProse: sentence === '' ? null : sentence,
    unparsed: [],
    warnings,
    structured: parts.length > 0 || sentence !== '',
  };
}

// --- the PF2e arm (unchanged) -----------------------------------------------

function copyDamage(key: string, damage: SpellDamage): SpellDamageValue {
  return {
    key,
    formula: damage.formula,
    type: damage.type,
    category: damage.category ?? null,
    materials: [...damage.materials],
  };
}

function copyArea(area: SpellArea): SpellArea {
  return {
    type: area.type,
    value: area.value,
    ...(area.details === null || area.details === undefined ? {} : { details: area.details }),
  };
}

interface DamageApplication {
  /** How many base damage entries a source delta actually reached. */
  applied: number;
  /** Delta keys the payload has no base entry for. */
  unmatched: string[];
  changed: boolean;
}

function applyIntervalDamage(
  values: SpellAtRankValues,
  damage: Record<string, string>,
  steps: number,
): DamageApplication {
  const result: DamageApplication = { applied: 0, unmatched: [], changed: false };
  for (const entry of values.damage) {
    const delta = damage[entry.key];
    if (delta === undefined) continue;
    entry.formula = combineDamageFormula(entry.formula, delta, steps);
    result.applied += 1;
    result.changed = true;
  }
  for (const key of Object.keys(damage)) {
    if (!values.damage.some((entry) => entry.key === key)) result.unmatched.push(key);
  }
  return result;
}

function applicableNotes(
  entries: SpellHeighteningEntry[],
  appliedRank: number,
  baseRank: number,
): string[] {
  let highest: number | null = null;
  for (const entry of entries) {
    if (entry.kind === 'fixed' && entry.rank <= appliedRank) {
      highest = highest === null ? entry.rank : Math.max(highest, entry.rank);
    }
  }
  const chosen = new Set<SpellHeighteningEntry>();
  for (const entry of entries) {
    // The single highest applicable `fixed` note (each states the complete
    // increase at that rank); every `increment` note applies once heightened.
    if (entry.kind === 'fixed' && entry.rank === highest) chosen.add(entry);
    if (entry.kind === 'increment' && appliedRank > baseRank) chosen.add(entry);
  }
  return entries.filter((entry) => chosen.has(entry)).map((entry) => entry.text);
}

function baseValues(spell: SpellData): SpellAtRankValues {
  return {
    damage: Object.entries(spell.damage).map(([key, damage]) => copyDamage(key, damage)),
    area: spell.area === null ? null : copyArea(spell.area),
    target: spell.cast.target,
    duration: spell.cast.duration,
  };
}

/**
 * The ONE heightening rule: this spell cast at `request.castRank` by a caster
 * of `request.casterLevel`. Throws loudly on a corrupt row (no payload), a
 * rank below the spell's own, a missing/invalid caster level for a cantrip (or
 * for a focus spell that states no fixed auto rank), or a formula it cannot
 * read.
 *
 * SYSTEM-AWARE BY CONSTRUCTION (row 194): a payload whose own `system` is
 * `dnd5e` is answered by `spellAtRankDnd5e` and NEVER reaches a PF2e arm — a
 * 5e cantrip is not, and can never be, given PF2e's `clamp(ceil(casterLevel /
 * 2), 1, 10)` rank. The PF2e path below it is byte-identical to the
 * pre-row-194 rule.
 */
export function spellAtRank(spell: SpellData | null | undefined, request: SpellAtRankRequest): SpellAtRank {
  if (spell === null || spell === undefined) {
    throw new Error('spellAtRank: the spell row carries no spellData payload (corrupt spell chunk)');
  }
  if (spell.system === 'dnd5e') return spellAtRankDnd5e(spell, request);

  const warnings: string[] = [];
  const unparsed = [...spell.heighteningUnparsed];
  for (const line of unparsed) warnings.push(`${UNPARSED_HEIGHTENING_PREFIX}${line}`);

  // The rules base rank: a cantrip's own rank is 1 in the source (the corpus
  // stores `level.value: 1`); `spell.rank` is the list-ordering normalization.
  // A focus spell keeps its OWN rank as the base (only its auto-heightened
  // cast rank is derived).
  const baseRank = spell.cantrip ? 1 : spell.rank;

  let appliedRank: number;
  let cantripAuto = false;
  let focusAuto = false;
  if (spell.cantrip) {
    cantripAuto = true;
    const level = request.casterLevel;
    if (level === undefined || !Number.isInteger(level) || level < 1) {
      throw new Error(
        `spellAtRank: a cantrip needs an integer casterLevel >= 1 to auto-heighten (got ${String(level)})`,
      );
    }
    appliedRank = Math.min(10, Math.max(1, Math.ceil(level / 2)));
    if (request.castRank !== undefined && request.castRank !== appliedRank) {
      warnings.push(
        `cantrip-auto: castRank ${request.castRank} ignored; a cantrip is cast at rank ${appliedRank} for caster level ${level}.`,
      );
    }
  } else if (spellTraitsAreFocus(spell.traits) && request.castRank === undefined) {
    // THE FOCUS ARM (ledger 191): upstream auto-heightens a focus spell exactly
    // like a cantrip and IGNORES its `location.heightenedLevel`. The fixed rank
    // comes first, in the source's own order (the importer resolved
    // item-then-entry into `request.autoHeightenLevel`); only when the source
    // states none does the caster's level drive `ceil(level / 2)`.
    focusAuto = true;
    const fixed = request.autoHeightenLevel;
    if (fixed !== undefined && fixed !== null) {
      if (!Number.isInteger(fixed) || fixed < 1 || fixed > 10) {
        throw new Error(
          `spellAtRank: a focus spell's autoHeightenLevel must be an integer rank 1..10 (got ${String(fixed)})`,
        );
      }
      appliedRank = fixed;
    } else {
      const level = request.casterLevel;
      if (level === undefined || !Number.isInteger(level) || level < 1) {
        throw new Error(
          `spellAtRank: a focus spell needs EITHER an autoHeightenLevel or an integer casterLevel >= 1 to auto-heighten (got casterLevel ${String(level)})`,
        );
      }
      appliedRank = Math.min(10, Math.max(1, Math.ceil(level / 2)));
    }
  } else {
    // A ranked spell, and a focus spell whose caller ASSIGNED a cast rank (that
    // assignment is authoritative and lands here unchanged).
    const rank = request.castRank;
    if (rank === undefined || !Number.isInteger(rank)) {
      throw new Error(`spellAtRank: needs an integer castRank for a non-cantrip spell (got ${String(rank)})`);
    }
    if (rank < spell.rank) {
      throw new Error(`spellAtRank: this spell is rank ${spell.rank} and cannot be cast at rank ${rank}`);
    }
    appliedRank = rank;
  }

  const heightening = parseHeightening(spell.heightening);
  const values = baseValues(spell);
  let valuesSource: HeighteningValuesSource = 'base';
  let appliedSteps: number | null = null;
  let stepRemainder: number | null = null;

  if (heightening.kind === 'fixed') {
    let layer: FixedLevel | null = null;
    let layerRank: number | null = null;
    for (const candidate of heightening.levels) {
      if (candidate.rank <= appliedRank) {
        layer = candidate.level;
        layerRank = candidate.rank;
      }
    }
    if (layer !== null) {
      if (layer.damage !== undefined) {
        values.damage = Object.entries(layer.damage).map(([key, damage]) => copyDamage(key, damage));
      }
      if (layer.area !== undefined) {
        values.area = layer.area === null ? null : copyArea(layer.area);
      }
      if (layer.target !== undefined && layer.target !== null) values.target = layer.target.value;
      if (layer.duration !== undefined && layer.duration !== null) values.duration = layer.duration.value;
      const consumed = ['damage', 'area', 'target', 'duration'];
      const ignored = Object.keys(layer).filter((key) => !consumed.includes(key));
      if (ignored.length > 0) {
        warnings.push(
          `fixed-heightening: rank ${layerRank ?? appliedRank} also states ${ignored.join(', ')}, which these values do not apply (the source's own text carries them).`,
        );
      }
      valuesSource = 'fixed';
    }
  } else if (heightening.kind === 'interval') {
    const delta = appliedRank - baseRank;
    appliedSteps = Math.floor(delta / heightening.interval);
    stepRemainder = delta % heightening.interval;
    if (stepRemainder > 0) {
      warnings.push(
        `interval-heightening: rank ${appliedRank} is ${delta} rank(s) above base rank ${baseRank} for a (+${heightening.interval}) spell; ${appliedSteps} whole increment(s) apply and the ${stepRemainder} leftover rank(s) grant nothing (the Paizo/Foundry floor rule).`,
      );
    }
    if (appliedSteps > 0) {
      const application = applyIntervalDamage(values, heightening.damage, appliedSteps);
      for (const key of application.unmatched) {
        warnings.push(
          `interval-heightening: the source states a delta for damage key "${key}", which no base damage entry uses; it was not applied.`,
        );
      }
      if (Object.keys(heightening.damage).length > 0 && application.applied === 0) {
        throw new Error(
          `spellAtRank: interval heightening states delta(s) for damage key(s) [${Object.keys(heightening.damage).join(', ')}] but the payload carries no matching base damage; refusing to heighten from nothing.`,
        );
      }
      let areaApplied = false;
      if (heightening.area !== 0) {
        if (values.area === null) {
          warnings.push(
            `interval-heightening: the source adds ${heightening.area} to the area per step, but the spell states no base area; the increase was not applied.`,
          );
        } else {
          values.area = { ...values.area, value: values.area.value + heightening.area * appliedSteps };
          areaApplied = true;
        }
      }
      if (application.changed || areaApplied) valuesSource = 'interval';
    }
  }

  const notes = applicableNotes(spell.heighteningEntries, appliedRank, baseRank);
  const structured = heightening.kind !== 'none';
  let source: HeighteningSource;
  if (!structured && notes.length > 0) {
    source = 'prose-only';
    warnings.push(PROSE_ONLY_MARKER);
  } else if (cantripAuto) {
    source = 'cantrip-auto';
  } else if (focusAuto) {
    source = 'focus-auto';
  } else {
    source = valuesSource;
  }

  return {
    source,
    valuesSource,
    cantripAuto,
    focusAuto,
    cantripScaling: false,
    appliedRank,
    appliedSteps,
    stepRemainder,
    values,
    notes,
    upcastProse: null,
    unparsed,
    warnings,
    structured,
  };
}
