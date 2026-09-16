import type { MobSpellVocabulary } from '@/domain';
import {
  MOB_SPELL_ENTRY_SHAPE,
  MOB_SPELL_REPAIR_LEAD_IN,
  MOB_SPELL_SECTION_HEADER,
  MOB_SPELL_TRUNCATION_PREFIX,
  MOB_SPELL_TRUNCATION_SUFFIX,
} from '@/llm/promptScaffolding';

/**
 * The mob-spells prompt section (docs/17 rows 184 and 200, docs/18 §2.4).
 *
 * ONE composer for the ONE vocabulary the AI-authored mob paths are offered —
 * the NPC stat-block step, an encounter draft's inline monster block and the
 * Cartographer's inline monster blocks — so the lanes cannot drift apart on
 * what a caster may be given.
 *
 * NULL WHEN THERE IS NOTHING TO OFFER. A dnd5e campaign has no imported spells
 * at all (`docs/12` §9: that adapter skips spell documents), so the section is
 * omitted and those prompts keep their pre-arc bytes exactly — the mob path
 * still VALIDATES whatever the model returns, and every unresolvable name is
 * loud.
 */

/**
 * THE one corpus gate (docs/17 row 200): both halves of the spell instruction —
 * the vocabulary section AND the reply contract's `"spells"` clause — render
 * only when the window carried an eligible spell. An empty window means no
 * invitation, never an empty list.
 */
function mobSpellVocabularyRenders(vocabulary: MobSpellVocabulary): boolean {
  return vocabulary.lines.length > 0;
}

export function formatMobSpellSection(vocabulary: MobSpellVocabulary): string | null {
  if (!mobSpellVocabularyRenders(vocabulary)) return null;
  const parts = [MOB_SPELL_SECTION_HEADER, ...vocabulary.lines];
  if (vocabulary.total > vocabulary.lines.length) {
    parts.push(
      `${MOB_SPELL_TRUNCATION_PREFIX}${String(vocabulary.lines.length)} of ${String(vocabulary.total)}${MOB_SPELL_TRUNCATION_SUFFIX}`,
    );
  }
  return parts.join('\n');
}

/**
 * The reply-contract half of the SAME instruction (docs/17 row 200). The
 * stat-block/encounter contract enumerates the reply's fields; this renders the
 * `"spells"` field from the ONE `MOB_SPELL_ENTRY_SHAPE`, so a prompt can never
 * invite a field its own "COMPLETE schema" line omits — row 184's defect, where
 * the vocabulary section offered spells and the schema line excluded them.
 *
 * NULL under the SAME gate as `formatMobSpellSection`, so a spell-less system's
 * contract bytes are unchanged.
 */
export function formatMobSpellContractClause(vocabulary: MobSpellVocabulary): string | null {
  if (!mobSpellVocabularyRenders(vocabulary)) return null;
  return `"spells": [${MOB_SPELL_ENTRY_SHAPE}]`;
}

/** The spell half of a repair turn: the named offenders, one per line. */
export function formatMobSpellRepair(issues: readonly string[]): string {
  return `${MOB_SPELL_REPAIR_LEAD_IN}\n- ${issues.join('\n- ')}`;
}
