import { comparableName } from '@/domain/artifactAlias';
import type { GameSystem } from '@/domain/gameSystem';
import { spellTraitsAreFocus, type SpellData } from '@/domain/spellData';
import { pf2eCantripRankFor, spellAtRank, type SpellAtRank } from '@/domain/spellHeightening';
import {
  storedMobSpellAssignmentSchema,
  type MobSpellAssignment,
} from '@/domain/statblockFields';

/**
 * A mob's spells (docs/17 row 184, the mob half of the spells arc).
 *
 * THE CONTRACT THE AI WRITES. An AI-authored mob (the NPC stat-block step, an
 * encounter's inline monster block) may assign spells to its caster: the spell
 * NAME and — optionally — the RANK it is cast at. A cantrip carries nothing
 * more, because the cantrip rule derives its rank from the caster's level and
 * a caller that chose one would be re-implementing the rule (docs/17 row 183).
 * A FOCUS spell is the same shape (docs/17 row 191): upstream auto-heightens it
 * exactly like a cantrip and IGNORES its stated `heightenedLevel`, so a library
 * creature's focus item is stamped with no rank and the rule derives it —
 * `autoHeightenLevel` when the creature document states one, else
 * `ceil(casterLevel / 2)`.
 *
 * THE FIELD IS ADDITIVE AND NULLABLE (the `itemData`/`spellData` precedent):
 * it sits on `statBlockSchema`, a stored nested row, so every row written
 * before this arc decodes with `spells: undefined` — no migration, no index,
 * and NO chip (which is what "no spells" honestly looks like).
 *
 * NO INVENTED SPELLS. The name is checked against the campaign's imported
 * library at the parse/validation boundary, with the ONE comparable-name form
 * (`domain/artifactAlias.comparableName`); an unresolvable name is a LOUD
 * named issue AND stays as an unresolved chip — never dropped, never folded
 * into prose.
 *
 * ONE HEIGHTENING RULE. Every value a chip shows comes from
 * `domain/spellHeightening.spellAtRank`; this module computes NOTHING itself,
 * it only decides which spell the name means and which rank to ask about.
 */

export const mobSpellAssignmentSchema = storedMobSpellAssignmentSchema();

export type { MobSpellAssignment };

/** One library spell a name can resolve to (the library's own spelling). */
export interface MobSpellEntry {
  name: string;
  spellData: SpellData;
}

/** The library's spells, keyed by `comparableName` (the ONE name comparison). */
export type MobSpellIndex = ReadonlyMap<string, MobSpellEntry>;

/**
 * Index library spells for resolution. When two books carry the same spell name
 * the FIRST entry wins, deterministically: the corpus is read in chunk order,
 * and a later duplicate must not silently shadow the one an earlier list row
 * already answered with (the spell list's own first-wins ordering).
 */
export function mobSpellIndex(entries: Iterable<MobSpellEntry>): MobSpellIndex {
  const index = new Map<string, MobSpellEntry>();
  for (const entry of entries) {
    const key = comparableName(entry.name);
    if (!index.has(key)) index.set(key, entry);
  }
  return index;
}

/**
 * The caster level a printed stat-block `level` stands for, or `null` when it
 * states none. PF2e prints an integer creature level (a level-0 or negative
 * creature is legal); dnd5e prints a CR, which may be a fraction ("1/2") or the
 * CR-less "—". A fractional/junk level is `null`: no arbitrary default is ever
 * invented for it (`spellAtRank` then refuses a cantrip loudly, which is the
 * honest outcome).
 *
 * WHAT THIS IS NOT (row 194): a dnd5e creature's CHARACTER level. The printed
 * level of a 5e stat block is its challenge rating, and the 5e cantrip
 * progression reads a character/caster level instead — the dnd5e importer
 * carries that separately on the assignment (`casterLevel`/`characterLevel`),
 * so this helper's value is never substituted for it.
 */
export function mobCasterLevel(level: string): number | null {
  const match = /^\s*(-?\d+)\s*$/.exec(level);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) ? value : null;
}

/** One assigned spell as a chip: the library answer, the rule's result, and the
 *  loud issues behind either. */
export interface MobSpellChip {
  /** The name the author assigned, verbatim (what the chip shows). */
  name: string;
  /** The requested cast rank; `null` = the spell's own rank. */
  castRank: number | null;
  /** True when the name resolved to a library spell. */
  resolved: boolean;
  /** The library's own spelling of the spell, once resolved. */
  libraryName: string | null;
  /**
   * The RESOLVED payload's game system (row 194) — the chip's own noun switch
   * (`rank` for PF2e, `level` for dnd5e). Separate from the mob's system so a
   * chip can never take its wording from the caller's context.
   */
  system: GameSystem | null;
  /**
   * `spellAtRank`'s result — `null` when the name did not resolve, or when the
   * rule refused to compute (a missing caster level for a cantrip, a corrupt
   * spell row). The chip shows `issues` in that case, never a number.
   */
  result: SpellAtRank | null;
  /**
   * LOUD problems: an unresolved name, a missing caster level, a rule throw.
   * `mobSpellIssues` names them, the run boundary spends its one repair turn
   * on them and the chip's loud box renders them. A REAL refusal only.
   */
  issues: string[];
  /**
   * QUIET notes (docs/17 row 205): a stored assignment carried a field that
   * belongs to the OTHER system (`casterLevel`/`characterLevel` on a PF2e
   * spell, `autoHeightenLevel` on a dnd5e one). The field is IGNORED — the
   * values are the rule's own — and the note says so. It is NOT an issue: it
   * must never spend the one repair turn, never count as a boundary failure
   * and never be reported as "a spell it cannot use", because a harmless extra
   * field is not an unusable spell. The chip detail and the card render it;
   * `mobSpellWarnings` names the mob for the surfaces that want the sentence.
   */
  warnings: string[];
}

/**
 * The QUIET note for an assignment field that belongs to the OTHER system
 * (docs/17 row 205): the field is ignored — every value still comes from the
 * rule — and the note names it. It is a warning, never an issue: a harmless
 * extra field must not read as "a spell it cannot use", must not spend the
 * repair turn and must not count as a boundary failure.
 */
function foreignAssignmentWarnings(
  assignment: MobSpellAssignment,
  foreign: readonly string[],
): string[] {
  const stated = foreign.filter((key) => assignment[key as keyof MobSpellAssignment] != null);
  if (stated.length === 0) return [];
  const fields = stated.map((key) => `"${key}"`).join(' and ');
  return [
    `${fields} ${stated.length === 1 ? 'belongs' : 'belong'} to the other game system, so ${stated.length === 1 ? 'it was' : 'they were'} ignored`,
  ];
}

/**
 * The ONE assignment resolver: every assigned spell as a chip, with the
 * library answer and the heightening rule's own output. Pure — no IO, no
 * React — so the run boundary, the stat-block card and the PDF box all ask the
 * SAME question of the SAME inputs (docs/18 §2.3).
 *
 * `casterLevel` is the mob's level (`mobCasterLevel` over the printed level) or
 * `null`; it is passed through to the rule for EVERY spell with no branch on
 * kind, exactly as `spellAtRank`'s request shape intends.
 */
export function mobSpellChips(
  spells: readonly MobSpellAssignment[] | null | undefined,
  casterLevel: number | null,
  index: MobSpellIndex,
): MobSpellChip[] {
  const chips: MobSpellChip[] = [];
  for (const assignment of spells ?? []) {
    const castRank = assignment.castRank ?? null;
    const entry = index.get(comparableName(assignment.name));
    if (entry === undefined) {
      chips.push({
        name: assignment.name,
        castRank,
        resolved: false,
        libraryName: null,
        system: null,
        result: null,
        issues: [
          `the spell «${assignment.name}» is not in this campaign's imported spell library`,
        ],
        // The cross-system keys are only ignorable once we know the system:
        // an unresolved name made no claim about one, so it says nothing here.
        warnings: [],
      });
      continue;
    }
    try {
      // "Absent cast rank means the spell's own rank" is the ASSIGNMENT
      // contract — not a heightening computation. `spellAtRank` deliberately
      // requires an explicit `castRank` for a ranked spell (docs/17 row 183),
      // so the one line below hands it the stored rank; every VALUE still comes
      // from the rule. A cantrip or a FOCUS spell is never given a defaulted
      // one: its rank is the rule's to derive (docs/17 rows 183/191), and a
      // supplied rank is passed straight through only so the rule can honour it
      // (focus) or report ignoring it (cantrip). A focus spell's fixed
      // `autoHeightenLevel`, when the source creature stated one, rides along
      // so the rule can apply upstream's precedence.
      const requested = assignment.castRank ?? null;
      const request: {
        castRank?: number;
        casterLevel?: number;
        autoHeightenLevel?: number;
        characterLevel?: number;
      } = {};
      const focus = spellTraitsAreFocus(entry.spellData.traits);
      if (!entry.spellData.cantrip && !focus) request.castRank = requested ?? entry.spellData.rank;
      else if (requested !== null) request.castRank = requested;
      const isDnd5e = entry.spellData.system === 'dnd5e';
      // THE CROSS-SYSTEM ARM IS A WARNING, NOT A REFUSAL (docs/17 row 205).
      // The RESOLVED payload's own system decides which of an assignment's
      // keys apply: a dnd5e assignment's `casterLevel`/`characterLevel` mean
      // nothing on a PF2e spell and `autoHeightenLevel` means nothing on a 5e
      // one, so the foreign keys are IGNORED and named. This used to throw and
      // the run boundary reported it as "a spell it cannot use" — the owner's
      // eight loud errors on a real PF2e run, where our own contract had asked
      // the model for the wrong system's fields. Every rule check stays loud:
      // this arm is about a field that does not apply, not about a value.
      const warnings = foreignAssignmentWarnings(
        assignment,
        isDnd5e ? ['autoHeightenLevel'] : ['casterLevel', 'characterLevel'],
      );
      if (!isDnd5e) {
        if (assignment.autoHeightenLevel !== undefined && assignment.autoHeightenLevel !== null) {
          request.autoHeightenLevel = assignment.autoHeightenLevel;
        }
        if (casterLevel !== null) request.casterLevel = casterLevel;
      } else {
        // The dnd5e arm's OWN inputs (row 194): the cantrip progression reads
        // the creature's CHARACTER level, or the caster level from its
        // spellcasting attribute when the document states no character level.
        // The mob's printed challenge rating is NEITHER, so it is deliberately
        // not substituted — `spellAtRankDnd5e` then prints the source's own
        // structured scaling without choosing a tier rather than scaling a 5e
        // cantrip off a CR.
        const dnd5eLevel = assignment.characterLevel ?? assignment.casterLevel ?? null;
        if (dnd5eLevel !== null) request.characterLevel = dnd5eLevel;
      }
      const result = spellAtRank(entry.spellData, request);
      chips.push({
        name: assignment.name,
        castRank,
        resolved: true,
        libraryName: entry.name,
        system: entry.spellData.system,
        result,
        issues: [],
        warnings,
      });
    } catch (error) {
      chips.push({
        name: assignment.name,
        castRank,
        resolved: true,
        libraryName: entry.name,
        system: entry.spellData.system,
        result: null,
        issues: [error instanceof Error ? error.message : String(error)],
        warnings: foreignAssignmentWarnings(
          assignment,
          entry.spellData.system === 'dnd5e'
            ? ['autoHeightenLevel']
            : ['casterLevel', 'characterLevel'],
        ),
      });
    }
  }
  return chips;
}

/**
 * The loud run issues behind a mob's chips, each NAMING both halves (AGENTS
 * rule 1): which spell, and which mob. Used by the stat-block boundary (the
 * one repair turn, then the persisted notice) so an invented spell can never
 * be quiet.
 */
export function mobSpellIssues(chips: readonly MobSpellChip[], mobName: string): string[] {
  return chips.flatMap((chip) =>
    chip.issues.map((issue) => `the mob «${mobName}» assigns a spell it cannot use: ${issue}`),
  );
}

/** The values at the applied rank as one plain string: `10d6 fire`, `1d6 fire + 1d6 cold`. */
export function mobSpellValuesText(result: SpellAtRank): string {
  const parts: string[] = [];
  for (const damage of result.values.damage) {
    parts.push(damage.type === '' ? damage.formula : `${damage.formula} ${damage.type}`);
  }
  if (result.values.area !== null) {
    const { type, value } = result.values.area;
    parts.push(type === '' ? `area ${String(value)} ft.` : `area ${String(value)}-foot ${type}`);
  }
  return parts.join(', ');
}

/**
 * The ONE detail text a spell chip shows: the computed values at the cast rank
 * AND the rule's own provenance, with every warning and unparsed line
 * surfaced. A `prose-only` spell prints its note verbatim behind the rule's
 * loud marker and NO number (`spellAtRank` computed none). An unresolved chip
 * says so by name.
 *
 * Pure and byte-stable: the React chip's `title` and the PDF's printed line
 * both render exactly these bytes, so the two surfaces cannot drift.
 */
export function mobSpellChipDetail(chip: MobSpellChip): string {
  const label = chip.libraryName ?? chip.name;
  // Warnings ride BOTH the unanswered and the answered chip (docs/17 row 205):
  // they are notes about a field that does not apply, so they must survive a
  // rule refusal beside it (a cantrip with no caster level has BOTH a real
  // issue and, on a stray cross-system field, a warning).
  if (!chip.resolved || chip.result === null) {
    return [`${label} — ${chip.issues.join(' ')}`, ...chip.warnings].join('\n');
  }
  const result = chip.result;
  const lines: string[] = [];
  const values = mobSpellValuesText(result);
  const autoNote = result.cantripAuto
    ? "cantrip, auto-heightened from the caster's level"
    : result.cantripScaling
      ? "cantrip, scaled by the caster's character level"
      : result.focusAuto
        ? 'focus spell, auto-heightened'
        : null;
  // The noun is the payload's OWN system's (row 194): PF2e casts at a RANK,
  // dnd5e casts at a LEVEL — a 5e chip must not print the PF2e word.
  const noun = chip.system === 'dnd5e' ? 'level' : 'rank';
  const rankNote =
    autoNote === null
      ? `cast at ${noun} ${String(result.appliedRank)}`
      : `cast at ${noun} ${String(result.appliedRank)} (${autoNote})`;
  lines.push(values === '' ? `${label} — ${rankNote}` : `${label} — ${rankNote}: ${values}`);
  lines.push(
    chip.system === 'dnd5e'
      ? `upcasting: ${result.source} (values from ${result.valuesSource})`
      : `heightening: ${result.source} (values from ${result.valuesSource})`,
  );
  if (result.appliedSteps !== null) {
    lines.push(
      chip.system === 'dnd5e'
        ? `${String(result.appliedSteps)} scaling step(s) applied`
        : `${String(result.appliedSteps)} increment(s) applied${
            result.stepRemainder === null || result.stepRemainder === 0
              ? ''
              : `, ${String(result.stepRemainder)} rank(s) left over`
          }`,
    );
  }
  // The dnd5e source's OWN higher-level sentence, VERBATIM — printed whether
  // or not the structured scaling answered, so the owner sees the source's
  // words beside whatever the rule computed from its numbers.
  if (result.upcastProse !== null) lines.push(result.upcastProse);
  lines.push(...result.notes);
  lines.push(...result.warnings);
  lines.push(...chip.warnings);
  return lines.join('\n');
}

/**
 * The QUIET notes behind a mob's chips (docs/17 row 205) — the warning channel
 * beside `mobSpellIssues`, each naming both halves exactly like its loud
 * sibling, so a surface can say which mob the ignored field belongs to. NOT
 * used by the run boundary's repair path: a warning never spends the one
 * repair turn and never counts as a boundary failure.
 */
export function mobSpellWarnings(chips: readonly MobSpellChip[], mobName: string): string[] {
  return chips.flatMap((chip) =>
    chip.warnings.map((warning) => `the mob «${mobName}»: ${warning}`),
  );
}

/** PF2e's maximum castable spell rank for a creature of `level` — the SAME
 *  rule the heightening seam derives a cantrip's own rank with
 *  (`spellHeightening.pf2eCantripRankFor`, row 194), so the vocabulary's
 *  eligibility cap and the rank a cantrip is actually cast at can never
 *  disagree. */
export function maxCastableRank(level: number): number {
  return pf2eCantripRankFor(level);
}

export interface MobSpellVocabulary {
  /** One `Name — Cantrip` / `Name — Rank N` line per OFFERED spell. */
  lines: string[];
}

/**
 * A group of `items` sampled down to `Math.max(1, Math.ceil(items.length / 2))`
 * members, drawn WITHOUT replacement in draw order — the owner's half rule,
 * and the floor that keeps a one-spell level visible (docs/17 row 211). The
 * draw is the ONLY randomness in the vocabulary, and it comes from the
 * injected source; a source that yields `[0, 1)` never picks outside the pool,
 * and the clamp keeps a degenerate source from spinning rather than failing.
 */
function sampleHalf<T>(items: readonly T[], random: () => number): T[] {
  const count = Math.max(1, Math.ceil(items.length / 2));
  const pool = [...items];
  const picked: T[] = [];
  while (picked.length < count) {
    const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    picked.push(...pool.splice(index, 1));
  }
  return picked;
}

/**
 * The spells a caster of `casterLevel` may be given: for EACH applicable group
 * — the cantrip group, then every spell rank the caster can reach — a RANDOM
 * sample of half the group, never fewer than one (docs/17 row 211). A
 * rank-ordered prefix hid whole ranks in a large corpus, which the owner
 * refused; a per-group sample keeps every reachable rank present AND breaks
 * the attractor states a fixed list produces.
 *
 * THE GROUPS come from the `cantrip` FLAG first, then the `rank` for every
 * other spell: a PF2e cantrip is stored at `rank: 1` (upstream's own
 * `level.value`) and a dnd5e cantrip at `rank: 0`, so a rank key alone would
 * file a PF2e cantrip beside the rank-1 spells. The flag is the honest key for
 * both systems. Group order is deterministic (cantrips first, then ranks
 * ascending); membership and order WITHIN a group come from `random`.
 *
 * A cantrip is always eligible; a ranked spell must be within the caster's
 * maximum rank. An unknown level offers every spell — the honest "nothing to
 * filter by", never a guessed level. Duplicates are dropped BEFORE sampling by
 * the ONE name comparison (`domain/artifactAlias.comparableName`, first wins —
 * the resolver's own rule in `mobSpellIndex`), so the offer never shows the
 * same spell twice when two books carry it.
 *
 * NO CAP AND NO TRUNCATION NOTE. The list is exactly the sampled groups: a
 * level is never hidden, so a note claiming one was would be a lie.
 *
 * PURE: the randomness is injected (a `Math.random`-compatible source
 * returning `[0, 1)`), so a fixed source makes the whole vocabulary
 * byte-deterministic while two sources on the same corpus differ. The
 * production caller (`llm/runEngine.spellLibraryFor`) passes a fresh source
 * per prompt build — that difference is the attractor-breaking property.
 * Sampling narrows the OFFER only: the resolver still validates names against
 * the FULL library index, so a corpus spell outside the sample still resolves
 * when the model names it.
 */
export function mobSpellVocabulary(
  entries: readonly { name: string; rank: number; cantrip: boolean }[],
  casterLevel: number | null,
  random: () => number,
): MobSpellVocabulary {
  const maxRank = casterLevel === null ? null : maxCastableRank(casterLevel);
  const eligible = entries.filter(
    (entry) => entry.cantrip || maxRank === null || entry.rank <= maxRank,
  );
  const seen = new Set<string>();
  const unique = eligible.filter((entry) => {
    const key = comparableName(entry.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // A sentinel below every legal rank (0 in dnd5e, 1 in PF2e) groups cantrips
  // together whatever rank the corpus stored them at.
  const CANTRIP_GROUP = -1;
  const groups = new Map<number, (typeof unique)[number][]>();
  for (const entry of unique) {
    const key = entry.cantrip ? CANTRIP_GROUP : entry.rank;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [entry]);
    else group.push(entry);
  }
  const lines: string[] = [];
  for (const key of [...groups.keys()].sort((a, b) => a - b)) {
    const group = groups.get(key);
    if (group === undefined) continue;
    for (const entry of sampleHalf(group, random)) {
      lines.push(`${entry.name} — ${entry.cantrip ? 'Cantrip' : `Rank ${String(entry.rank)}`}`);
    }
  }
  return { lines };
}
