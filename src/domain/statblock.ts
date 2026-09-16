import { z } from 'zod';

import type { GameSystem } from '@/domain/gameSystem';
import { statBlockBaseFields, storedMobSpellAssignmentSchema } from '@/domain/statblockFields';

/**
 * The field definitions live in `domain/statblockFields` (ONE definition, see
 * there); re-exported here because this module has always been their public
 * surface.
 */
export { abilitiesSchema, namedTextSchema, numericStat } from '@/domain/statblockFields';
export type { NamedText } from '@/domain/statblockFields';

/**
 * Normalized d20 stat block (01-DATA-MODEL §StatBlock): one shared shape for
 * all d20 systems; system-specific bits go into `extras` (key = label as
 * printed). Sections a model may legitimately leave out (traits, actions,
 * reactions, legendary, extras, the two notes) default to empty — the prompt
 * defines empty as "section does not apply", so a missing section is the
 * same meaning, not a masked failure; identity/defense fields stay required.
 *
 * THE FIELDS ARE DECLARED ONCE. `domain/statblockFields` owns the field set
 * (shared with the system-aware REQUEST contract builder in
 * `llm/statBlockContract`, which cannot reuse this INSTANCE — strict mode
 * refuses zod's `$ref`); this schema is the STORED superset every row parses
 * through, `spells` included, whatever system wrote it (docs/17 row 205).
 * `spells` is `.nullish()` — NOT a default — the `itemData`/`spellData`
 * precedent: a stat block written before the arc genuinely lacks the key, and
 * "no field" must stay distinguishable from "authored, no spells" so a legacy
 * row renders exactly as it did (no chip section, no error, no migration).
 * The values a chip shows are never stored here: they come from
 * `domain/mobSpells.mobSpellChips` over the library's own `spellData` at
 * render/validation time, so a re-imported spell row cannot disagree with the
 * mob that names it.
 */
export const statBlockSchema = z.object({
  ...statBlockBaseFields(),
  spells: z.array(storedMobSpellAssignmentSchema()).nullish(),
});

export type StatBlock = z.infer<typeof statBlockSchema>;

/** Standard d20 ability modifier: floor((score - 10) / 2). */
export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** Formats a modifier for display: 3 → '+3', -1 → '-1'. */
export function formatModifier(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

/**
 * The LOUD marker a caster that states no spell DC prints (docs/17 row 201) —
 * the owner's own words: a GM needs the DC to play the spell, and the app must
 * never derive a plausible-looking one from the level. The exact bytes are
 * pinned; the card and both PDF boxes render this SAME string.
 */
export const SPELL_DC_MISSING_MARKER = 'this caster states no spell DC';

/**
 * Whether a stat block presents itself as a CASTER (docs/17 row 201). The
 * signal is the block's own stated evidence — assigned spells, a spell DC, a
 * spell attack bonus or a tradition — because the app has no caster flag and
 * inventing one from a creature's name would be exactly the guess this arc
 * refuses. A legacy block with none of them is NOT a caster and renders exactly
 * as it did (no caster line, no marker).
 */
export function statBlockIsCaster(statBlock: StatBlock): boolean {
  return (
    (statBlock.spells !== null && statBlock.spells !== undefined && statBlock.spells.length > 0) ||
    (statBlock.spellDC !== null && statBlock.spellDC !== undefined) ||
    (statBlock.spellAttack !== null && statBlock.spellAttack !== undefined) ||
    (statBlock.tradition !== null &&
      statBlock.tradition !== undefined &&
      statBlock.tradition.trim() !== '')
  );
}

/**
 * Whether a caster's block states NO spell DC — the loud case. `false` for a
 * non-caster, so a mundane creature never shows a marker about a spell DC it
 * does not need.
 */
export function statBlockStatesNoSpellDc(statBlock: StatBlock): boolean {
  return statBlockIsCaster(statBlock) && (statBlock.spellDC === null || statBlock.spellDC === undefined);
}

/**
 * THE caster line a stat block renders (docs/17 row 201): the stated numbers,
 * or the LOUD marker when the caster stated no DC. `null` for a non-caster, so
 * every surface is unchanged for a mundane or legacy block. ONE composer — the
 * card and both PDF stat boxes render exactly these bytes, so the screen and
 * the printed book cannot disagree about a mob's spell DC.
 */
export function casterStatLine(statBlock: StatBlock): string | null {
  if (!statBlockIsCaster(statBlock)) return null;
  const parts: string[] = [
    statBlock.spellDC === null || statBlock.spellDC === undefined
      ? SPELL_DC_MISSING_MARKER
      : `Spell DC ${String(statBlock.spellDC)}`,
  ];
  if (statBlock.spellAttack !== null && statBlock.spellAttack !== undefined) {
    parts.push(`spell attack ${formatModifier(statBlock.spellAttack)}`);
  }
  const tradition = statBlock.tradition?.trim() ?? '';
  if (tradition !== '') parts.push(`tradition ${tradition}`);
  return parts.join(' · ');
}

/**
 * The d20 SCORE a PRINTED ability modifier stands for: `10 + 2·modifier`, the
 * exact inverse of `abilityModifier` (docs/12 §5 is the authority — Pathfinder
 * 2e's `system.abilities.*.mod` is stored this way by the pack importer, and
 * the stat-block editor converts an owner-typed modifier with the same
 * function, so nothing derives the conversion a second time).
 */
export function abilityScoreFromModifier(modifier: number): number {
  return 10 + 2 * modifier;
}

/**
 * How a system PRINTS an ability (docs/12 §5, docs/05 §Artifact editor): the
 * app STORES d20-scale SCORES in every system — including Pathfinder 2e, whose
 * own stat blocks print signed MODIFIERS instead — and this predicate is the
 * ONE switch that decides which of the two a surface shows. It is display
 * only: no consumer may branch on it to change what is stored or computed.
 */
export function printsAbilityModifiers(system: GameSystem): boolean {
  return system === 'pathfinder2e';
}

/**
 * One ability as the shared stat-block display prints it: `"14 (+2)"` for
 * every system that prints scores, `"+2"` for Pathfinder 2e (which prints the
 * bonus only — owner decision, docs/17 row 95). The compact PDF stat boxes
 * keep their own one-value layout and compose `printsAbilityModifiers` with
 * `formatModifier` instead.
 */
export function formatAbilityValue(system: GameSystem, score: number): string {
  const modifier = formatModifier(abilityModifier(score));
  return printsAbilityModifiers(system) ? modifier : `${String(score)} (${modifier})`;
}
