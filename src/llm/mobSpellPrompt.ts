import type { MobSpellVocabulary } from '@/domain';
import {
  MOB_SPELL_REPAIR_LEAD_IN,
  MOB_SPELL_SECTION_HEADER,
  MOB_SPELL_TRUNCATION_PREFIX,
  MOB_SPELL_TRUNCATION_SUFFIX,
} from '@/llm/promptScaffolding';

/**
 * The mob-spells prompt section (docs/17 row 184, docs/18 §2.4).
 *
 * ONE composer for the ONE vocabulary the AI-authored mob paths are offered —
 * the NPC stat-block step and an encounter's inline monster block — so the two
 * cannot drift apart on what a caster may be given. The literals live in
 * `llm/promptScaffolding` (its own rule: a fixed sentence a brief is built from
 * lives where the echo detector can read it).
 *
 * NULL WHEN THERE IS NOTHING TO OFFER. A dnd5e campaign has no imported spells
 * at all (`docs/12` §9: that adapter skips spell documents), so the section is
 * omitted and those prompts keep their pre-arc bytes exactly — the mob path
 * still VALIDATES whatever the model returns, and every unresolvable name is
 * loud.
 */
export function formatMobSpellSection(vocabulary: MobSpellVocabulary): string | null {
  if (vocabulary.lines.length === 0) return null;
  const parts = [MOB_SPELL_SECTION_HEADER, ...vocabulary.lines];
  if (vocabulary.total > vocabulary.lines.length) {
    parts.push(
      `${MOB_SPELL_TRUNCATION_PREFIX}${String(vocabulary.lines.length)} of ${String(vocabulary.total)}${MOB_SPELL_TRUNCATION_SUFFIX}`,
    );
  }
  return parts.join('\n');
}

/** The spell half of a repair turn: the named offenders, one per line. */
export function formatMobSpellRepair(issues: readonly string[]): string {
  return `${MOB_SPELL_REPAIR_LEAD_IN}\n- ${issues.join('\n- ')}`;
}
