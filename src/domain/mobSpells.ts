import { z } from 'zod';

import { comparableName } from '@/domain/artifactAlias';
import type { GameSystem } from '@/domain/gameSystem';
import { spellTraitsAreFocus, type SpellData } from '@/domain/spellData';
import { spellAtRank, type SpellAtRank } from '@/domain/spellHeightening';

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

export const mobSpellAssignmentSchema = z.object({
  /** The spell's name as the library spells it (matched through `comparableName`). */
  name: z.string(),
  /**
   * The rank the spell is cast at. `null`/absent means "the spell's own rank"
   * for a ranked spell, and is IGNORED for a cantrip or a FOCUS spell (each
   * rule derives its rank and says so in its provenance; an explicit rank on a
   * focus spell is authoritative and wins).
   */
  castRank: z.number().int().positive().nullish(),
  /**
   * A FOCUS spell's fixed auto-heightened rank, carried from the source
   * CREATURE document (the item's `location.autoHeightenLevel`, else its
   * casting entry's `autoHeightenLevel.value` — the importer resolves that
   * order). It is stored HERE because the rules-pack `SpellData` the rule reads
   * never carries either field; absent for a cantrip, for a ranked spell and
   * for a focus spell whose source states none (which derives from the caster's
   * level). docs/17 row 191.
   */
  autoHeightenLevel: z.number().int().positive().max(10).nullish(),
  /**
   * A dnd5e assignment's caster level (row 194): the creature's own
   * `cantripLevel(spell)` resolved by the importer in upstream's order
   * (`system.attributes.spell.level`). It is carried on the ASSIGNMENT because
   * the rules-pack `SpellData` — what `spellAtRank` reads — never holds it, and
   * it is the 5e cantrip progression's input. Ignored for every PF2e spell.
   */
  casterLevel: z.number().int().positive().nullish(),
  /**
   * A dnd5e assignment's CHARACTER level (row 194), when the creature document
   * states one (`system.details.level` — a character-class NPC). Preferred over
   * `casterLevel` for a cantrip's tier; absent for monsters and for every PF2e
   * spell, which has no character level at all.
   */
  characterLevel: z.number().int().positive().nullish(),
});

export type MobSpellAssignment = z.infer<typeof mobSpellAssignmentSchema>;

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
  /** LOUD problems: an unresolved name, a missing caster level, a rule throw. */
  issues: string[];
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
      if (assignment.autoHeightenLevel !== undefined && assignment.autoHeightenLevel !== null) {
        request.autoHeightenLevel = assignment.autoHeightenLevel;
      }
      const isDnd5e = entry.spellData.system === 'dnd5e';
      if (!isDnd5e && (assignment.casterLevel != null || assignment.characterLevel != null)) {
        throw new Error(
          `the spell «${entry.name}» is ${entry.spellData.system}; a dnd5e caster/character level cannot apply to it`,
        );
      }
      if (isDnd5e) {
        // The dnd5e arm's OWN inputs (row 194): the cantrip progression reads
        // the creature's CHARACTER level, or the caster level from its
        // spellcasting attribute when the document states no character level.
        // The mob's printed challenge rating is NEITHER, so it is deliberately
        // not substituted — `spellAtRankDnd5e` then prints the source's own
        // structured scaling without choosing a tier rather than scaling a 5e
        // cantrip off a CR.
        const dnd5eLevel = assignment.characterLevel ?? assignment.casterLevel ?? null;
        if (dnd5eLevel !== null) request.characterLevel = dnd5eLevel;
      } else if (casterLevel !== null) {
        request.casterLevel = casterLevel;
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
  if (!chip.resolved || chip.result === null) {
    return `${label} — ${chip.issues.join(' ')}`;
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
  return lines.join('\n');
}

/**
 * How many spell lines a stat-block prompt may carry. The roster's own 300-line
 * prompt window (`llm/creatorRoster`) is the precedent: the library can hold
 * thousands of spells, and a window that says it is truncated is honest where a
 * silently-shortened list is not.
 */
export const MOB_SPELL_VOCABULARY_LIMIT = 300;

/** PF2e's maximum castable spell rank for a creature of `level` — the same
 *  `ceil(level / 2)` the heightening rule uses for a cantrip's own rank. */
export function maxCastableRank(level: number): number {
  return Math.min(10, Math.max(1, Math.ceil(level / 2)));
}

export interface MobSpellVocabulary {
  /** One `Name — Cantrip` / `Name — Rank N` line per OFFERED spell. */
  lines: string[];
  /** How many spells the corpus offered BEFORE the window was applied. */
  total: number;
}

/**
 * The spells a caster of `casterLevel` may be given, ordered by rank then name
 * (deterministic, and the low ranks a starting caster actually uses come
 * first). A cantrip is always eligible; a ranked spell must be within the
 * caster's maximum rank. An unknown level offers every spell — the honest
 * "nothing to filter by", never a guessed level.
 */
export function mobSpellVocabulary(
  entries: readonly { name: string; rank: number; cantrip: boolean }[],
  casterLevel: number | null,
): MobSpellVocabulary {
  const maxRank = casterLevel === null ? null : maxCastableRank(casterLevel);
  const eligible = entries.filter(
    (entry) => entry.cantrip || maxRank === null || entry.rank <= maxRank,
  );
  const sorted = [...eligible].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return {
    lines: sorted
      .slice(0, MOB_SPELL_VOCABULARY_LIMIT)
      .map((entry) => `${entry.name} — ${entry.cantrip ? 'Cantrip' : `Rank ${String(entry.rank)}`}`),
    total: sorted.length,
  };
}
