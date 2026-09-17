import type { GameSystem, MobSpellVocabulary } from '@/domain';
import {
  MOB_SPELL_CASTER_CLAUSE,
  MOB_SPELL_REPAIR_LEAD_IN,
  MOB_SPELL_SECTION_PREFIX,
  MOB_SPELL_SECTION_SUFFIX,
} from '@/llm/promptScaffolding';
import { spellEntryShape } from '@/llm/statBlockContract';

/**
 * The mob-spells prompt section (docs/17 rows 184, 200, 205 and 211, docs/18
 * §2.2).
 *
 * ONE composer for the ONE vocabulary the AI-authored mob paths are offered —
 * the NPC stat-block step, an encounter draft's inline monster block and the
 * Cartographer's inline monster blocks — so the lanes cannot drift apart on
 * what a caster may be given. Every half takes the CAMPAIGN'S SYSTEM, because
 * an assignment's own keys are system-specific: `autoHeightenLevel` is PF2e's
 * focus key and `casterLevel`/`characterLevel` are dnd5e's (row 194). The shape
 * comes from the ONE builder (`llm/statBlockContract.spellEntryShape`), the
 * SAME builder the strict response schema is built from, so the prose and the
 * contract cannot disagree (row 205's defect).
 *
 * The vocabulary itself is the PER-GROUP RANDOM SAMPLE built by
 * `domain/mobSpells.mobSpellVocabulary` (row 211): it is emitted verbatim,
 * with NO truncation note, because there is no window to truncate — every
 * applicable group is present.
 *
 * NULL WHEN THERE IS NOTHING TO OFFER. A campaign with no imported spells has
 * an empty window, so the section is omitted and those prompts keep their
 * pre-arc bytes exactly — the mob path still VALIDATES whatever the model
 * returns, and every unresolvable name is loud.
 */

/**
 * THE one corpus gate (docs/17 row 200): every half of the spell instruction —
 * the vocabulary section, the reply contract's `"spells"` clause and the
 * inline stat-block shape hint — renders only when the window carried an
 * eligible spell. An empty window means no invitation, never an empty list.
 *
 * Exported because `runEngine.statBlockSchemaHint` renders the contract's own
 * clause and must ask the SAME question: a second predicate there is exactly
 * the drift that would let one half render where another is withheld.
 */
export function mobSpellVocabularyRenders(vocabulary: MobSpellVocabulary): boolean {
  return vocabulary.lines.length > 0;
}

export function formatMobSpellSection(
  vocabulary: MobSpellVocabulary,
  system: GameSystem,
): string | null {
  if (!mobSpellVocabularyRenders(vocabulary)) return null;
  const header = `${MOB_SPELL_SECTION_PREFIX}${spellEntryShape(system)}${MOB_SPELL_SECTION_SUFFIX}`;
  // No truncation note (docs/17 row 211): the vocabulary is a per-group sample
  // with no cap, so every applicable level is already present.
  return [header, ...vocabulary.lines].join('\n');
}

/**
 * The reply-contract half of the SAME instruction (docs/17 row 200). The
 * stat-block/encounter contract enumerates the reply's fields; this renders the
 * `"spells"` field from the SAME per-system shape the vocabulary header embeds,
 * so a prompt can never invite a field its own "COMPLETE schema" line omits —
 * nor demand the OTHER system's fields in the strict response schema (row 205).
 *
 * NULL under the SAME gate as `formatMobSpellSection`, so a spell-less system's
 * contract bytes are unchanged.
 */
export function formatMobSpellContractClause(
  vocabulary: MobSpellVocabulary,
  system: GameSystem,
): string | null {
  if (!mobSpellVocabularyRenders(vocabulary)) return null;
  return `"spells": [${spellEntryShape(system)}]`;
}

/** The spell half of a repair turn: the named offenders, one per line. */
export function formatMobSpellRepair(issues: readonly string[]): string {
  return `${MOB_SPELL_REPAIR_LEAD_IN}\n- ${issues.join('\n- ')}`;
}

/**
 * THE caster-awareness clause (docs/17 row 201). The other half of row 200's
 * offer: the vocabulary tells the model WHICH spells exist; this tells it that a
 * creature the module presents as a caster MUST be given them. It lives in the
 * SAME composer as the vocabulary and the contract clause and reads the SAME
 * `mobSpellVocabularyRenders` corpus gate — so the rule and the list can never
 * be gated differently (a no-corpus prompt gets NEITHER), and the ONE literal is
 * declared once in `llm/promptScaffolding`.
 *
 * It is rendered by the NPC lane's TWO steps only — `runDraft`'s npc arm (where
 * the identity and prose are written) and `runStatblock` (where the spells and
 * the DC are written) — because a caster-awareness pass at the stat block alone
 * yields a mundane necromancer with a list bolted on. The Encounter Smith and
 * the Cartographer keep their existing OPTIONAL invitation and do NOT call this
 * (owner's scope). It names no theme and adds no filter: the owner's call is
 * that a spell which merely SOUNDS necromantic is fine.
 */
export function formatMobSpellCasterClause(vocabulary: MobSpellVocabulary): string | null {
  if (!mobSpellVocabularyRenders(vocabulary)) return null;
  return MOB_SPELL_CASTER_CLAUSE;
}
