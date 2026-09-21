import type { GameSystem } from '@/domain/gameSystem';
import type { EncounterBudgetPolicy } from '@/domain/encounterBudget';
import {
  DEFAULT_MODULE_DIFFICULTY,
  difficultyBudgetMultiplier,
  MODULE_DIFFICULTY_LABELS,
  type ModuleDifficulty,
} from '@/domain/moduleDifficulty';
import { FILL_GRADE_MAX, FILL_GRADE_MIN } from '@/domain/artifact';
import type { AnyArtifact, Id, Module, MonsterEntry, RuleChunk, StatBlock } from '@/domain';
import { comparableName } from '@/domain/artifactAlias';
import { sameAliasName } from '@/domain';
import { parseLevelSort } from '@/llm/encounterRoster';
import { levelWordsPattern } from '@/llm/language';
import { escapeRegExp } from '@/domain/escapeRegExp';
import {
  ENTITY_LEVEL_HINT_HIERARCHY,
  ENTITY_LEVEL_HINT_LABEL,
  FIXED_CAST_SECTION_FOOTER,
  FIXED_CAST_SECTION_HEADER,
} from '@/llm/promptScaffolding';
import type { SceneSubstitution } from '@/llm/schemas';
import { extractWikiLinks, resolveWikiLink, sentenceAround } from '@/lib/wikilinks';

/**
 * The per-room budget loop (docs/11 D12, owner-specified; amended by the
 * fill-grade arc): every layout room carries a `targetLevel` — the level
 * this room ALONE should challenge — and the assigned creatures' levels are
 * summed against a documented band for that target. The asymmetry differs
 * by SHAPE:
 *
 * - **Single arena — asymmetric by design, unchanged**: too easy ships
 *   silently (a quiet room is a feature — there is NO lower bound); too
 *   hard lowers the targetLevel a step (floor 1) and retries through the
 *   encounter brief's EXISTING single repair turn.
 * - **Complex (dungeon) — inverted asymmetry (fill-grade arc)**: a complex
 *   is a sequence of fights, so every room carries a stocking expectation
 *   derived from the encounter's `fillGrade` (docs/11 D12 amendment): a
 *   room with NO creatures is the repairable **'empty'** verdict on fresh
 *   complex briefs, a room well under its expected share is the loud
 *   **'under'** verdict, and both surface at finalize as `budgetAdvisory`
 *   entries naming the room and its expected-vs-shipped threat.
 * - **Too hard (both shapes)**: lower that room's `targetLevel` a step
 *   (floor 1) and retry through the encounter brief's EXISTING single
 *   repair turn — budget issues join the repair turn's issue list exactly
 *   like coverage/source issues (no new repair machinery).
 * - **Still over after the bounded retry ⇒ LOUD advisory** persisted on the
 *   step output and the artifact (`data.budgetAdvisory`) — never silent,
 *   never a failed run. The final (possibly lowered) `targetLevel` persists
 *   on the room, visible and owner-editable.
 *
 * Licensing shape (mirrors the treasure-ladder stance, docs/12 §13.2/§14):
 * Paizo's creature budgets (GM Core) and Wizards' DMG encounter-building
 * tables are both NOT licensable, so no licensed table is ever embedded in
 * code. WHICH numeric stance applies is now a CHOSEN policy (docs/17 row
 * 180, `encounterBudgetPolicy`), resolved once per run into the
 * `EncounterBudget` below — never re-derived from the system at each call
 * site:
 *
 * - **'system'** (compatibility) — dnd5e runs the documented band (our own
 *   paraphrase-free approximation, recorded in docs/11); pathfinder2e ships
 *   NO numbers and persists the loud verbatim advisory instead.
 * - **'pf2e-budget'** — PF2E's own numeric stocking rule, expressed as
 *   Campaigner's OWN documented approximation of a standard encounter budget
 *   at the encounter's party level and size (never a Paizo table). The prompt
 *   still directs the model to the retrieved GM Core excerpts VERBATIM when
 *   they are present; Campaigner's approximation is what the deterministic
 *   check uses, and the persisted advisory says so loudly.
 * - **'verbatim'** — ship no numbers at all; the prompt directs the model to
 *   the retrieved GM Core excerpts verbatim and the deterministic check is
 *   replaced by the always-on loud advisory (over-loud by design: whether an
 *   excerpt actually surfaced is not deterministically decidable from the
 *   retrieval output, so the advisory always persists — AGENTS rule 1).
 *
 * DIFFICULTY (docs/17 row 190) is a SIBLING of that policy, not a second
 * version of it: the policy decides WHICH rule bounds a room's challenge,
 * difficulty decides HOW HARD the module should be for this group and scales
 * whatever numeric budget the rule produces. `EncounterBudget` carries the
 * resolved difficulty, and `roomBudgetBandUpperFor` — the ONE seam that
 * computes the standard-encounter number for BOTH scales — applies
 * `difficultyBudgetMultiplier` there, so the check, the fill-grade expectation,
 * the stocking cap and the brief's numbers all move together and no second
 * budget formula exists. Under `'verbatim'` no number is computed at all, so
 * the multiplier has nothing to move: difficulty is stated to the model as a
 * DIRECTION only, and the no-numbers licensing stance is untouched.
 */

/** The band's headroom over the target level (our own dnd5e approximation). */
export const ROOM_BUDGET_OVER_MARGIN = 2;

/**
 * Structured level context (owner-directed: every module part has an explicit
 * level and every table seats a party of 4 — "thats what all modules do
 * normally"). The party size is THIS constant, used by both encounter
 * prompts (the Smith draft via `buildEntityBrief`, the Cartographer brief
 * via `runEncounterBrief`) — nobody re-derives it.
 */
export const PARTY_SIZE = 4;

/**
 * The one structured party line both encounter prompts carry when the
 * encounter's part level is known (docs/11): `Party of 4 adventurers at
 * level N.` — built from `PARTY_SIZE` so the size can never drift between
 * the two prompts.
 */
export function partyLevelLine(level: number): string {
  return `Party of ${String(PARTY_SIZE)} adventurers at level ${String(level)}.`;
}

/**
 * The brief text with the app's generated party-level lines REMOVED — the ONE
 * exclusion the stat-block fallback applies so a PARTY's level can never be
 * read as an ENTITY's own level (docs/17 row 206).
 *
 * WHY THIS EXISTS. `buildEntityBrief` renders `partyLevelLine(partLevel)` into
 * every encounter/npc brief ("Party of 4 adventurers at level N."), and the
 * legacy no-hint fallback in `runEngine.runStatblock` regexes `level N` out of
 * that same brief. The generated line is the PARTY's level — fed to the draft
 * so it can calibrate — and the owner's report is exactly that trap: an
 * unrelated "level 13" satisfied the entity's level with no entity
 * discrimination and no notice. The matcher is the line's own shape (the
 * `Party of <n> adventurers at level N.` sentence), so a write of the generated
 * line and a read of this exclusion cannot drift; a caller's own prose that
 * does NOT wear that shape is still the fallback's food, which is what keeps
 * the legacy free-text path (and its byte-identical pins) working. The module's
 * recorded level never rides this fallback either: when a record fixes one, the
 * structured value wins before the regex is consulted.
 */
export function withoutPartyLevelLines(brief: string): string {
  return brief.replace(/Party of \d+ adventurers at level \d{1,2}\./gi, '');
}

/**
 * The brief text with the app's generated ENTITY LEVEL-HINT paragraph removed
 * (docs/17 rows 282 and 285) — the sibling of `withoutPartyLevelLines` above,
 * applied by the stat-block step whenever a source that OUTRANKS the stored hint
 * actually won: the entity's MINTED block (row 282) or the owner's DIRECT
 * instruction (row 285).
 *
 * WHY THIS EXISTS. `buildEntityBrief` renders `ENTITY_LEVEL_HINT_LABEL` +
 * `ENTITY_LEVEL_HINT_HIERARCHY` ("The module fixes this entity's level: 7. Build
 * this entity at exactly that level; …") into a module entity's brief, and the
 * stat-block step hands that whole brief to the model. Once the entity already
 * has a minted block at another level, that paragraph is a LIE and a
 * contradiction: the step's own clause says "at level 1 — the module's author
 * fixed this entity's level", so the model would read two different exact
 * levels in one prompt (row 247 removed the PARTY line from this prompt for
 * exactly this class of reason). Row 285 closes the same hole for an INSTRUCTION
 * that faces a stored hint with NO minted block yet: the clause states the
 * instruction's number while this paragraph still states the hint's. The
 * matcher is built from the SAME two exported constants the brief writer uses,
 * so a write of the paragraph and a read of this exclusion cannot drift; the
 * trailing `.` after the digit is the paragraph's own shape.
 */
export function withoutEntityLevelHintLines(brief: string): string {
  const pattern = new RegExp(
    `${escapeRegExp(ENTITY_LEVEL_HINT_LABEL)}\\d{1,2}\\.${escapeRegExp(ENTITY_LEVEL_HINT_HIERARCHY)}`,
    'g',
  );
  return brief.replace(pattern, '');
}

/**
 * The FIRST level a piece of text states, in ANY generation language, or
 * `undefined` when it states none — the ONE reader of a level out of the app's
 * own PROSE (docs/17 rows 247, 253, 285). Every reader of a level out of a
 * MODULE's prose goes through THIS function — one caller:
 *
 * - the NAME-SCOPED prose read (`nameScopedLevel`, the ONE seam the module
 *   prose rung and the legacy brief fallback both ride — docs/17 row 285).
 *
 * THE OWNER'S INSTRUCTION IS *NOT* READ HERE (docs/17 row 289, AGENTS rule 5).
 * An instruction is HUMAN free text and is read by a structured, zod-validated
 * MODEL call (`llm/instructionLevel.readInstructionLevel`); the pattern that
 * used to answer that question (`instructionLevel` = this function) is DELETED,
 * because "…level needs to be bumped to 3." resolved nothing through it and a
 * pattern over human phrasing is the defect the owner banned. What remains here
 * reads text the APP or its MODULE author generated, where the grammar and the
 * formatter stay paired.
 *
 * WHY ONE READER, NOT THREE REGEXES. The callers ask the same question of
 * different text, and a second level regex is exactly how the party-level trap
 * came back once already (docs/17 row 206): a copy that forgot the exclusion,
 * or that read `(\d+)` instead of the two-digit form, would disagree with the
 * others about what "level 5" means in the same sentence. The `1..20` bound is
 * the app's level domain (`ENTITY_LEVEL_HINT_*`), so a stray four-digit number
 * is NOT read as a level.
 *
 * WHY IT IS NO LONGER ENGLISH-ONLY (docs/17 row 253). The app GENERATES in
 * eleven languages (`languageDirective`), but this reader asked only for the
 * English word, so a German module's own `Stufe 5` was invisible to every
 * level source and the entity fell through to the module's band — the owner's
 * level-5 mob in a level-3 module. The vocabulary now comes from
 * `language.levelWordsPattern()` (the ONE place a language's level wording
 * lives) as a UNION over every supported language, so no caller threads the
 * active language and a caller that forgets an argument cannot lose the level.
 * English still resolves for English text regardless of the campaign's
 * setting, and a CJK spelling with no space (`レベル5`) resolves too.
 */
export function firstLevelInText(text: string): number | undefined {
  const digits = levelWordsPattern().exec(text)?.[2];
  if (digits === undefined) return undefined;
  const value = Number(digits);
  return value >= 1 && value <= 20 ? value : undefined;
}

/**
 * The level the MODULE ITSELF states for one entity, or `undefined` when it
 * states none (docs/17 rows 247, 282 and 285) — the ONE derivation, used by the
 * run engine's level resolution AND by the module spine's entity-level
 * recording (`moduleGen`), so the value a new module RECORDS and the value the
 * engine READS for an older module cannot disagree.
 *
 * STRUCTURE — PLUS A SENTENCE THAT NAMES THE FIGURE. THREE sources, all of them
 * NAME-SCOPED when a name is given (docs/17 row 285):
 *
 * 1. **The module's own PROSE about THIS figure** (`entityProseLevel`): the
 *    sentence around the figure's NAME in the first part that names it, else
 *    the sentence around the name in the premise. This is the rung that was
 *    missing — the owner's level-3 mob whose own paragraph said `level 5`
 *    shipped at 3, because the part's STRUCTURED band outranked the figure's
 *    own sentence and specificity was inverted (entity > part > module).
 * 2. **The level of the part that mentions the entity** (`partLevelForMention`
 *    — the spine's own structured `partPlan[].levelBand`), WHEN the caller
 *    names the entity. It is a statement about THIS entity, from STRUCTURED
 *    data and scoped BY NAME — which is the shape the owner's level-7 gnome
 *    needed (that gnome, not every mob). This is a MODULE statement read by
 *    NAME from the plan, never the rendered party-level line the brief carries;
 *    docs/17 row 206 keeps the generated LINE out of the fallback regex, and
 *    this function never touches it.
 * 3. **An EXACT band** (`levelMin === levelMax`). A single-level band IS a
 *    stated level; a RANGE is not, and inventing a number from it (a midpoint,
 *    a maximum) is the guessing AGENTS rule 1 forbids. So a range `undefined`s
 *    here and the engine bounds the reply with the band (or refuses loudly)
 *    instead of letting the model pick.
 *
 * THE HONEST REVIVAL OF THE PREMISE — NAME-SCOPED, NEVER MODULE-WIDE. Row 282
 * removed the premise source after the owner's ruling (*"Its very sloppy to
 * infer all mobs levels from a CAMPAIGN premise, thats not even module
 * instructive. Its a premise for the whole CAMPAIGN. And this was about 1
 * NPC."*): one sentence about ONE npc ("a level 7 gnome") became ONE
 * module-wide number stamped on every npc record, and a levels-1–2 module then
 * displayed `level 7` on mobs whose minted blocks were level 1. The defect was
 * the module-wide INFERENCE, not the premise as a text. Row 285 reads the
 * premise sentence only when it NAMES the figure (`entityProseLevel`), so "my
 * premise says the gnome is level 7" is honoured FOR THAT GNOME while a premise
 * sentence about no figure — or about another one — still resolves NOTHING.
 * The MODULE-WIDE stamping half stays dead where it lived: the spine-time call
 * (`moduleGen.normalizeAndSave` passes `parts: []` and NO name) reaches source
 * 3 only, so no prose is ever stamped onto every npc record.
 *
 * The per-entity channels keep the rest of row 247's honest half: the model's
 * own structured `levelHint` on a record (which the spine prompt already asks
 * for, and which is NAME-SCOPED) and the part's exact level by name above —
 * plus the owner's explicit instruction, which since docs/17 row 289 is read by
 * the MODEL (`llm/instructionLevel.readInstructionLevel`), never by a pattern.
 *
 * `name` may be omitted for the SPINE-TIME call, where the module has no parts
 * yet: only source 3 applies, and sources 1–2 genuinely do not exist.
 */
export function moduleStatedLevel(
  module: Pick<Module, 'spine' | 'parts' | 'levelMin' | 'levelMax'>,
  name = '',
): number | undefined {
  if (name.trim() !== '') {
    // The module's PROSE about THIS figure outranks either band: the figure's
    // own sentence is more specific than the part it sits in (docs/17 row 285).
    const fromProse = entityProseLevel(module, name);
    if (fromProse !== undefined) return fromProse;
    const fromPart = partLevelForMention(module, name);
    if (fromPart !== undefined) return fromPart;
  }
  return module.levelMin === module.levelMax ? module.levelMin : undefined;
}

/**
 * The FIRST part (plan order) whose markdown carries `[[name]]` — the ONE
 * "which part mentions this entity" rule that `partLevelMentionFor` and
 * `entityProseLevel` both ask (docs/17 row 285, AGENTS rule 4), so a figure's
 * STRUCTURED band and its PROSE sentence read the SAME part and cannot
 * disagree about where its paragraph is. `undefined` when no part mentions it.
 * Mention is decided by the ONE alias-aware pair (`extractWikiLinks` +
 * `sameAliasName`, so `[[Marten Graubruch|Marten]]` counts), never a substring
 * search that a display alias would defeat.
 */
function firstPartMentioning(
  module: Pick<Module, 'parts'>,
  name: string,
): Module['parts'][number] | undefined {
  const parts = module.parts.slice().sort((a, b) => a.planIndex - b.planIndex);
  return parts.find((part) =>
    extractWikiLinks(part.markdown).some((link) => sameAliasName(link.name, name)),
  );
}

/**
 * The part that MENTIONS an entity, with BOTH facts a surface needs: its plan
 * TITLE and its EXACT level (docs/17 row 291). `partLevelForMention` is this
 * function's level half, so "which part mentions it" and "what level is it"
 * can never be answered twice — the editor names the part the run sized the
 * fight from, and it reads the SAME pick.
 *
 * THE LEVEL IS THE PART'S EXACT LEVEL, never band math: a module generated for
 * a range builds exactly one part per level, each with an EXACT `levelBand`
 * ("2–4" is a 2-part, a 3-part and a 4-part). A pathological multi-level band
 * string on one part deterministically parses to its LOW end (the first digit
 * run) — a field the app itself defines, so reading it is a syntax read, never
 * a prose read. `undefined` when no part mentions the name, the spine has no
 * entry for the containing part, or its band carries no digits.
 */
export interface PartMention {
  /** The mentioning part's plan title — the part NAMED on the form. */
  partTitle: string;
  /** The mentioning part's EXACT level (its structured `levelBand`). */
  level: number;
}

export function partLevelMentionFor(
  module: Pick<Module, 'spine' | 'parts'>,
  name: string,
): PartMention | undefined {
  if (name.trim() === '') return undefined;
  // FIRST mention wins: the containing part decides, deterministically.
  const part = firstPartMentioning(module, name);
  if (part === undefined) return undefined;
  const plan = module.spine?.partPlan[part.planIndex];
  if (plan === undefined) return undefined;
  const digits = /(\d+)/.exec(plan.levelBand)?.[1];
  return digits === undefined ? undefined : { partTitle: plan.title, level: Number(digits) };
}

/**
 * The referencing part's EXACT level for an encounter mention (docs/17 rows 11
 * and 291) — `partLevelMentionFor`'s level half, the ONE answer to "what level
 * is this encounter made for" when a part mentions it. `undefined` when there
 * is no honest answer (no part mentions it, no spine entry for the containing
 * part, a band with no digits), which is a legitimate state: the caller then
 * reads the OWNER-SET structured level (`partyLevel` /
 * `StartRunInput.encounterPartyLevel`) and REFUSES loudly when that is unset
 * too. Never throws for data conditions.
 */
export function partLevelForMention(
  module: Pick<Module, 'spine' | 'parts'>,
  name: string,
): number | undefined {
  return partLevelMentionFor(module, name)?.level;
}

/**
 * THE level a piece of prose states ABOUT `name` — the ONE name-scoped read of
 * a level out of free text (docs/17 row 285). It reads the SENTENCE around the
 * figure's NAME through the ONE sentence reader (`lib/wikilinks.sentenceAround`)
 * and the ONE grammar (`firstLevelInText`, above) — no second sentence reader,
 * no second level regex — so a sentence that does NOT carry the figure's name
 * is NOT evidence about that figure. That is the rule that makes a prose
 * statement about ONE figure honest instead of the module-wide inference
 * docs/17 row 282 banned.
 *
 * WHY A SENTENCE AND NOT THE WHOLE TEXT. The owner's level-3 mob carried
 * `level 5` in its own paragraph while its part was banded 3, and the band won.
 * The paragraph NAMES the mob, so the sentence that names it is evidence; the
 * first `level N` anywhere in a multi-figure text (the next figure's sentence,
 * or a premise about the whole campaign) is not.
 *
 * `whenUnnamed` decides what a text that names NO figure at all says:
 *
 * - `'nothing'` — MODULE prose (a part's markdown, the premise): a module is
 *   about MANY figures, so a sentence that names nobody is evidence about
 *   nobody, and the caller falls through to its next source. This is the arm
 *   that keeps row 282's ban alive — a premise stating one gnome's level, with
 *   no name in the sentence, resolves NOTHING.
 * - `'whole-text'` — the RUN'S OWN BRIEF (`StartRunInput.brief`): it IS the
 *   instruction for this run's entity by construction, and the owner may type
 *   "a level 5 goblin boss" before any figure has a name. When the brief DOES
 *   name the figure, only the sentence around that name is read — so a level
 *   about another figure still cannot win (the docs/17 row 285 class E); when
 *   it names nobody, the brief's own first level stands, exactly as before this
 *   slice.
 */
export function nameScopedLevel(
  text: string,
  name: string,
  whenUnnamed: 'nothing' | 'whole-text',
): number | undefined {
  const sentence = sentenceAround(text, name);
  if (sentence !== '') return firstLevelInText(sentence);
  return whenUnnamed === 'whole-text' ? firstLevelInText(text) : undefined;
}

/**
 * The level the MODULE states for one entity IN PROSE — the sentence around the
 * figure's name in the FIRST part (plan order) that names it, else the sentence
 * around the name in the premise. `undefined` when no sentence that NAMES the
 * figure states a level (docs/17 row 285).
 *
 * THE RUNG THAT WAS MISSING. `partLevelForMention` reads the part's STRUCTURED
 * `levelBand` and never the part's own sentence, so a mob whose paragraph said
 * `level 5` in a part banded 3 shipped at 3 — the band outranked the figure's
 * own prose, inverting specificity (entity > part > module). `moduleStatedLevel`
 * consults THIS before either band.
 *
 * NAME-SCOPED, ALWAYS (`nameScopedLevel` with `'nothing'`): the part is read
 * because it MENTIONS the name, and then only the sentence around that name is
 * read; the premise is read only through the same name-scoped reader. A premise
 * sentence about a DIFFERENT figure, or about no figure at all, resolves NOTHING
 * here — the module-wide premise inference the owner banned in docs/17 row 282
 * stays dead, while "my premise says the gnome is level 7" is honoured FOR THAT
 * GNOME.
 *
 * PART BEFORE PREMISE, and the FIRST mentioning part decides (the SAME
 * FIRST-mention rule `firstPartMentioning` gives the band): the part is where a
 * stat-block figure is actually written, and a deterministic pick cannot depend
 * on which paragraph a reader happens to scan first.
 */
export function entityProseLevel(
  module: Pick<Module, 'spine' | 'parts'>,
  name: string,
): number | undefined {
  if (name.trim() === '') return undefined;
  const part = firstPartMentioning(module, name);
  if (part !== undefined) {
    const fromPart = nameScopedLevel(part.markdown, name, 'nothing');
    if (fromPart !== undefined) return fromPart;
  }
  return nameScopedLevel(module.spine?.premise ?? '', name, 'nothing');
}

/**
 * The ONE party-level resolver every encounter-sizing path asks — the roster
 * WINDOW, the Cartographer's brief guidance, the Smith's content guidance and
 * the room `targetLevel` stamping (docs/17 rows 180 and 291).
 *
 * THE PART IS THE LEVEL. A module generated for a level range builds exactly
 * one part per level, each with an EXACT `levelBand`, and the first part (plan
 * order) whose markdown carries the encounter's `[[Name]]` supplies ITS level.
 * There is no midpoint, no band arithmetic and no free text: an earlier version
 * fell through to a regex over a model-written `levelHint` string and, in one
 * fallback, to `(levelMin + levelMax) / 2` — two invented answers to a question
 * the part already answers.
 *
 * When NO part mentions the encounter (a campaign-level encounter, a module
 * with no parts, a module that never names it) the ONLY other honest source is
 * the OWNER's structured number — `EncounterArtifactData.partyLevel` for an
 * existing row, `StartRunInput.encounterPartyLevel` for a run that creates one.
 * `undefined` means the owner has not stated one, and the SIZING steps refuse
 * loudly rather than invent it (AGENTS rule 1); the context-only callers (the
 * roster window's ordering, a guidance line) simply carry no level.
 *
 * Every caller reads THIS function, so "ordered by level distance to the
 * target", "budgeted at the party level" and "the rooms default to" cannot come
 * to mean three different levels for the same encounter (the resolver
 * divergence the policy arc folded, docs/17 row 180).
 */
export function encounterPartyLevel(
  module: Pick<Module, 'spine' | 'parts'> | undefined,
  encounterName: string,
  ownerSetLevel: number | undefined,
): number | undefined {
  const fromPart = module === undefined ? undefined : partLevelForMention(module, encounterName);
  return fromPart ?? ownerSetLevel;
}

/**
 * The lower verdicts' slack (fill-grade arc): a complex room ships 'under'
 * when its creature-level sum is MORE than this margin below its expected
 * share. One creature-level of slack keeps fractional levels (1/2, 1/4) and
 * off-by-one band arithmetic from flapping the verdict; anything further
 * under is a stocking failure the owner hears about loudly.
 */
export const ROOM_BUDGET_UNDER_MARGIN = 1;

/**
 * The ONE resolved encounter budget for a run (docs/17 row 180): the chosen
 * policy plus the two facts every budget consumer needs, derived exactly once.
 * It replaces the old `roomBudgetMode(system)` hard-code — callers pass THIS
 * value, never the system, so a second `system === 'pathfinder2e'` branch
 * cannot reappear at a call site.
 */
export interface EncounterBudget {
  /** The persisted policy this run resolved (module row, else 'system'). */
  policy: EncounterBudgetPolicy;
  /**
   * The persisted module difficulty this run resolved (docs/17 row 190): how
   * hard the module should be for the party. The sibling of `policy`, not a
   * second version of it — it does not choose a rule, it scales whatever
   * numeric budget the rule produces (`difficultyBudgetMultiplier`).
   */
  difficulty: ModuleDifficulty;
  /** 'band' runs a numeric per-room check; 'verbatim' ships no numbers. */
  mode: 'band' | 'verbatim';
  /** WHICH numeric approximation a 'band' check uses. */
  scale: 'dnd5e' | 'pf2e';
  /**
   * Whether an under-strength COMPLEX room is a repairable issue. Only
   * `'pf2e-budget'` sets this: the owner's report was rooms that were too
   * easy, so that mode must make the under-strength case repairable rather
   * than shipping it silently. The dnd5e band keeps its shipped asymmetry
   * ('empty' repairable, 'under' advisory-only) byte-identically.
   */
  repairUnder: boolean;
}

/**
 * Resolves the policy into the run's ONE budget value (pure). `'system'` is
 * the compatibility mapping: dnd5e → the numeric band, pathfinder2e →
 * verbatim. `'pf2e-budget'` and `'verbatim'` are explicit and ignore the
 * system, which is what makes the policy a real choice rather than a
 * re-spelled system check.
 *
 * `difficulty` (docs/17 row 190) is the sibling seam: it defaults to the
 * middle step, so a caller that does not pass one gets today's numbers exactly.
 * Callers resolve it once per run through the domain resolver.
 */
export function encounterBudgetFor(
  policy: EncounterBudgetPolicy,
  system: GameSystem,
  difficulty: ModuleDifficulty = DEFAULT_MODULE_DIFFICULTY,
): EncounterBudget {
  const pf2e = system === 'pathfinder2e';
  switch (policy) {
    case 'pf2e-budget':
      return { policy, difficulty, mode: 'band', scale: 'pf2e', repairUnder: true };
    case 'verbatim':
      return {
        policy,
        difficulty,
        mode: 'verbatim',
        scale: pf2e ? 'pf2e' : 'dnd5e',
        repairUnder: false,
      };
    case 'system':
      return {
        policy,
        difficulty,
        mode: pf2e ? 'verbatim' : 'band',
        scale: pf2e ? 'pf2e' : 'dnd5e',
        repairUnder: false,
      };
  }
}

/**
 * dnd5e band (Campaigner's own documented approximation): a room tuned for
 * target level T is over budget when its assigned creatures' levels (CR)
 * sum to MORE than T + 2 — roughly a hard single fight's worth of creature
 * levels. Fractional levels (1/2, 1/4) count fractionally; "—" (CR-less
 * summons) counts as 0. The band is UPPER-only by itself; the LOWER side is
 * a separate expectation: single arenas have none (a quiet room is a
 * feature), complexes derive one from the encounter's fillGrade
 * (`expectedRoomThreat` — docs/11 D12 amendment).
 */
export function roomBudgetBandUpper(targetLevel: number): number {
  return Math.max(1, targetLevel) + ROOM_BUDGET_OVER_MARGIN;
}

/**
 * The reference creature for the approximate mob count: a creature of
 * roughly HALF the room's target level (floor 1). A full band (T + 2
 * creature levels) then carries ~2–4 such creatures for T ∈ [1, 10] — the
 * documented reading of "a hard single fight" the band already ships. Our
 * own constant, no licensed table behind it.
 */
export function roomBudgetReferenceCreatureLevel(targetLevel: number): number {
  return Math.max(1, Math.ceil(Math.max(1, targetLevel) / 2));
}

/**
 * PF2E standard-encounter budget, Campaigner's OWN documented approximation
 * (docs/11 D12 amendment, docs/17 row 180). Paizo's encounter-building XP
 * table is NOT licensable and is never embedded here. Our approximation, in
 * our own words and our own units:
 *
 * A standard encounter for a party of four at level L is one worth
 * `PF2E_STANDARD_ON_LEVEL_CREATURES` on-level creatures — i.e. a
 * creature-level sum of `2 × L` — and that budget scales linearly with the
 * party size (`× partySize / PARTY_SIZE`). A creature's contribution is its
 * printed level, exactly like the dnd5e band's creature-level sum, so the
 * fill grade reads as the share of one standard fight for BOTH systems.
 *
 * This is deliberately NOT the dnd5e `T + 2` band: PF2E's threat scale is the
 * level DIFFERENCE between creature and party, and reusing dnd5e's CR
 * headroom would apply D&D math to Paizo's system (the boundary docs/17 row
 * 180 pins). The retrieved GM Core excerpts remain the authority in the
 * prompt; this number only bounds the deterministic check, and the advisory
 * says so.
 */
export const PF2E_STANDARD_ON_LEVEL_CREATURES = 2;

export function pf2eStandardThreatLevels(
  partyLevel: number,
  partySize: number = PARTY_SIZE,
): number {
  const level = Math.max(1, partyLevel);
  return PF2E_STANDARD_ON_LEVEL_CREATURES * level * (partySize / PARTY_SIZE);
}

/** The pf2e band's upper bound: the full standard encounter budget. */
export function pf2eBandUpper(targetLevel: number): number {
  return pf2eStandardThreatLevels(targetLevel);
}

/**
 * The pf2e reference creature for the approximate count: an ON-LEVEL creature
 * (level = party level), so a standard budget of `2 × L` reads as ≈2
 * on-level creatures for a party of four.
 */
export function pf2eReferenceCreatureLevel(targetLevel: number): number {
  return Math.max(1, Math.round(Math.max(1, targetLevel)));
}

/**
 * The band upper for the budget's numeric scale — THE ONE SEAM that computes a
 * room's standard-encounter number for BOTH systems, and therefore the one
 * place the module difficulty scales it (docs/17 row 190). The base functions
 * above are the STANDARD (multiplier 1) approximations in our own units; the
 * resolved difficulty multiplies the result here, so the 'over' verdict, the
 * fill-grade expectation, the stocking cap and the brief's stated numbers all
 * move together — never a second budget formula. The reference creature level
 * below is deliberately NOT scaled: it is a property of the target level, and
 * scaling it would cancel the multiplier out of the approximate creature count.
 */
export function roomBudgetBandUpperFor(budget: EncounterBudget, targetLevel: number): number {
  const standard =
    budget.scale === 'pf2e' ? pf2eBandUpper(targetLevel) : roomBudgetBandUpper(targetLevel);
  return standard * difficultyBudgetMultiplier(budget.difficulty);
}

/** The reference creature level for the budget's numeric scale. */
export function roomBudgetReferenceLevelFor(budget: EncounterBudget, targetLevel: number): number {
  return budget.scale === 'pf2e'
    ? pf2eReferenceCreatureLevel(targetLevel)
    : roomBudgetReferenceCreatureLevel(targetLevel);
}

export interface RoomThreatExpectation {
  /** The creature-level sum this room should carry. */
  expectedLevels: number;
  /** `expectedLevels` rounded against the reference creature level. */
  approximateCreatureCount: number;
}

/**
 * The deterministic per-room stocking expectation (docs/11 D12 amendment,
 * pure): a room carrying `fillGrade`% of a standard single-encounter threat
 * budget at target level T expects `fillGrade/100 × bandUpper(T)` creature
 * levels — the same band constants the 'over' verdict uses, so the
 * expectation can never exceed the band and the fill grade reads as a share
 * of one fight. `bandUpper` follows the budget's numeric scale (dnd5e's
 * `T + 2` or Campaigner's pf2e `2 × T`).
 *
 * Returns null in 'verbatim' mode: no numbers ship, so there is no per-room
 * expectation (docs/12 §13.2/§14 stance). Throws on an out-of-range
 * fillGrade: callers pass zod-validated rows (0–100 integer), so a violation
 * is a programming error, never a data condition.
 */
export function expectedRoomThreat(
  fillGrade: number,
  targetLevel: number,
  budget: EncounterBudget,
): RoomThreatExpectation | null {
  if (budget.mode === 'verbatim') return null;
  if (!Number.isInteger(fillGrade) || fillGrade < FILL_GRADE_MIN || fillGrade > FILL_GRADE_MAX) {
    throw new Error(
      `expectedRoomThreat: fillGrade must be an integer in ${String(FILL_GRADE_MIN)}–${String(FILL_GRADE_MAX)}, got ${String(fillGrade)}`,
    );
  }
  const expectedLevels = (fillGrade / 100) * roomBudgetBandUpperFor(budget, targetLevel);
  const reference = roomBudgetReferenceLevelFor(budget, targetLevel);
  const approximateCreatureCount = Math.max(
    fillGrade > 0 ? 1 : 0,
    Math.round(expectedLevels / reference),
  );
  // Kept to two decimals so prompts and verdicts read stably (float
  // artifacts like 4.8999999999999995 never reach a GM or a model).
  return { expectedLevels: Math.round(expectedLevels * 100) / 100, approximateCreatureCount };
}

export type ParsedBudgetLevel =
  | { kind: 'level'; value: number }
  | { kind: 'unparseable'; raw: string }
  | { kind: 'unknown' };

/**
 * Creature level for budget sums — the SAME parser that orders the bestiary
 * roster (`parseLevelSort`, the one level parser in the codebase), with two
 * budget-specific readings: '—' (CR-less summons) contributes 0, and a
 * level the parser cannot read is reported as `unparseable` (the room
 * becomes loud-unverified — never silently dropped, AGENTS rule 1).
 */
export function parseBudgetLevel(level: string | undefined): ParsedBudgetLevel {
  if (level === undefined || level.trim() === '') return { kind: 'unknown' };
  const trimmed = level.trim();
  if (trimmed === '—') return { kind: 'level', value: 0 };
  try {
    return { kind: 'level', value: parseLevelSort(trimmed) };
  } catch {
    return { kind: 'unparseable', raw: trimmed };
  }
}

export interface BudgetCreature {
  name: string;
  count: number;
  /** The creature's printed level string, when its stats resolved. */
  level: string | undefined;
}

export interface BudgetRoomInput {
  roomIndex: number;
  roomName: string;
  targetLevel: number | undefined;
  creatures: readonly BudgetCreature[];
  /**
   * The encounter's fill grade (docs/11 D12 amendment) — the per-room
   * stocking share the lower verdicts check against. Callers pass it ONLY
   * for numeric-band budgets (a 'verbatim' budget passes none: no numbers
   * ship, so no expectation is computed). Inert unless `complex` is true.
   */
  fillGrade?: number | undefined;
  /**
   * Whether this room belongs to a multi-room complex. The lower verdicts
   * ('empty'/'under') apply to COMPLEX rooms only — a single arena keeps
   * the original asymmetric call byte-identical (a quiet room is a feature).
   */
  complex: boolean;
  /** The run's ONE resolved budget (docs/17 row 180) — never re-derived. */
  budget: EncounterBudget;
}

export interface RoomBudgetVerdict {
  roomIndex: number;
  roomName: string;
  status: 'ok' | 'over' | 'empty' | 'under' | 'unverified';
  /** Sum of assigned creature levels (0 for unverified rooms). */
  sumLevels: number;
  /** Band upper used for the verdict; null when no target was derivable. */
  bandUpper: number | null;
  targetLevel: number | null;
  /** One step below the target (floor 1) — set only for 'over' verdicts. */
  loweredTargetLevel: number | null;
  /** The room's stocking expectation (fill-grade arc); null when none applies. */
  expectedLevels: number | null;
  /** Approximate creature count for the expectation; null when none applies. */
  approximateCreatureCount: number | null;
  /**
   * Repair-turn issue text: 'over', and (on complex briefs) 'empty' — plus
   * 'under' in the `'pf2e-budget'` mode, where an under-strength room is
   * repairable rather than silent.
   */
  issue: string | null;
  /** Loud advisory text ('over' after the final pass; 'empty'; 'under'; 'unverified'). */
  advisory: string | null;
}

/** The verdict for one room against the documented band. */
export function checkRoomBudget(room: BudgetRoomInput): RoomBudgetVerdict {
  const base: RoomBudgetVerdict = {
    roomIndex: room.roomIndex,
    roomName: room.roomName,
    status: 'ok',
    sumLevels: 0,
    bandUpper: null,
    targetLevel: null,
    loweredTargetLevel: null,
    expectedLevels: null,
    approximateCreatureCount: null,
    issue: null,
    advisory: null,
  };
  const problems: string[] = [];
  let sum = 0;
  let instances = 0;
  for (const creature of room.creatures) {
    instances += creature.count;
    const parsed = parseBudgetLevel(creature.level);
    if (parsed.kind === 'level') {
      sum += parsed.value * creature.count;
      continue;
    }
    if (parsed.kind === 'unknown') {
      problems.push(`"${creature.name}" has no readable level`);
    } else {
      problems.push(`"${creature.name}" has an unreadable level "${parsed.raw}"`);
    }
  }
  if (problems.length > 0) {
    return {
      ...base,
      status: 'unverified',
      sumLevels: sum,
      advisory:
        `Room "${room.roomName}": challenge not budget-verified — ${problems.join(', ')}. ` +
        'Review the room by hand or re-run with resolvable stat sources.',
    };
  }
  if (room.targetLevel === undefined) {
    return {
      ...base,
      status: 'unverified',
      sumLevels: sum,
      advisory:
        `Room "${room.roomName}": no target level is derivable (the room carries no targetLevel and the ` +
        "encounter states no party level) — challenge not budget-verified. Set the Party level in the editor.",
    };
  }
  const expectation = room.complex && room.fillGrade !== undefined
    ? expectedRoomThreat(room.fillGrade, room.targetLevel, room.budget)
    : null;
  const expectedLabel = expectation === null
    ? null
    : `~${sumLabel(expectation.expectedLevels)} creature-levels (≈${String(expectation.approximateCreatureCount)} creatures)`;
  const bandUpper = roomBudgetBandUpperFor(room.budget, room.targetLevel);
  if (sum > bandUpper) {
    const lowered = Math.max(1, room.targetLevel - 1);
    return {
      ...base,
      status: 'over',
      sumLevels: sum,
      bandUpper,
      targetLevel: room.targetLevel,
      loweredTargetLevel: lowered,
      expectedLevels: expectation?.expectedLevels ?? null,
      approximateCreatureCount: expectation?.approximateCreatureCount ?? null,
      issue:
        `rooms[${String(room.roomIndex)}].targetLevel ("${room.roomName}"): the assigned creatures sum to ` +
        `${sumLabel(sum)} creature-levels, over the band of at most ${String(bandUpper)} for target level ` +
        `${String(room.targetLevel)} — the room alone would overpower the party. Lower this room to ` +
        `"targetLevel": ${String(lowered)} and field weaker or fewer creatures so it fits its band.`,
      advisory:
        `Room "${room.roomName}" ships over its challenge budget: the assigned creatures sum to ` +
        `${sumLabel(sum)} creature-levels against a band of at most ${String(bandUpper)} for target level ` +
        `${String(room.targetLevel)}. Review the room or regenerate the map.`,
    };
  }
  // The lower verdicts (fill-grade arc): complex rooms only, and only when
  // a numeric expectation exists (band systems; fillGrade present). A
  // fillGrade of 0 is an owner-sanctioned empty room and never trips them.
  if (expectation !== null && expectation.expectedLevels > 0 && instances === 0) {
    return {
      ...base,
      status: 'empty',
      sumLevels: sum,
      bandUpper,
      targetLevel: room.targetLevel,
      expectedLevels: expectation.expectedLevels,
      approximateCreatureCount: expectation.approximateCreatureCount,
      issue:
        `rooms[${String(room.roomIndex)}] ("${room.roomName}"): a dungeon-complex room with NO creatures ` +
        `assigned — shipped 0, expected ${expectedLabel} for this room's share of the fill grade. ` +
        'Assign at least one creature to this room (move roster entries between rooms or expand the ' +
        'roster within the complex\'s budget).',
      advisory:
        `Room "${room.roomName}" ships empty: no creatures are assigned to it (shipped 0, ` +
        `expected ${expectedLabel}). Review the room or regenerate the map.`,
    };
  }
  if (
    expectation !== null &&
    sum < expectation.expectedLevels - ROOM_BUDGET_UNDER_MARGIN
  ) {
    return {
      ...base,
      status: 'under',
      sumLevels: sum,
      bandUpper,
      targetLevel: room.targetLevel,
      expectedLevels: expectation.expectedLevels,
      approximateCreatureCount: expectation.approximateCreatureCount,
      // 'pf2e-budget' makes the under-strength case REPAIRABLE: the owner's
      // report was rooms that were too easy, so this mode must ask for a fix
      // in the existing bounded repair turn instead of shipping silently. The
      // dnd5e band keeps its shipped asymmetry (issue stays null: advisory
      // only) byte-identically.
      issue: room.budget.repairUnder
        ? `rooms[${String(room.roomIndex)}] ("${room.roomName}"): the assigned creatures sum to ` +
          `${sumLabel(sum)} creature-levels, under this room's expected ${expectedLabel} ` +
          `(fill grade ${String(room.fillGrade)}%) — the room would not challenge the party. Assign ` +
          'stronger or more creatures to this room (move roster entries between rooms or expand the ' +
          "roster within the complex's budget) so it reaches its share."
        : null,
      advisory:
        `Room "${room.roomName}" ships under its expected challenge: the assigned creatures sum to ` +
        `${sumLabel(sum)} creature-levels, expected ${expectedLabel} (fill grade ${String(room.fillGrade)}%). ` +
        'Review the room or regenerate the map.',
    };
  }
  return {
    ...base,
    sumLevels: sum,
    bandUpper,
    targetLevel: room.targetLevel,
    expectedLevels: expectation?.expectedLevels ?? null,
    approximateCreatureCount: expectation?.approximateCreatureCount ?? null,
  };
}

function sumLabel(sum: number): string {
  return Number.isInteger(sum) ? String(sum) : sum.toFixed(1);
}

/** The loud advisory for the 'verbatim' policy (deterministic replacement for the numeric check). */
export const PF2E_BUDGET_ADVISORY =
  'Per-room challenge was not deterministically budget-checked: pathfinder2e encounter budgets are ' +
  'Paizo\'s (GM Core) and no numeric budget ships with Campaigner. The Cartographer was directed to the ' +
  'retrieved GM Core excerpts verbatim when present; review each room\'s challenge.';

/**
 * The same loud advisory for a NON-pf2e run whose owner explicitly chose the
 * `'verbatim'` policy: no numeric budget ships by that choice, so the stat
 * blocks are used as written. It must not name Paizo on a system whose budgets
 * are not Paizo's.
 */
export const VERBATIM_BUDGET_ADVISORY =
  'Per-room challenge was not deterministically budget-checked: the verbatim budget policy ships no ' +
  'numeric budget, so the assigned stat blocks are used as written. Review each room\'s challenge.';

/**
 * The loud advisory for the `'pf2e-budget'` policy: the deterministic check
 * ran, but against Campaigner's OWN documented approximation — never a Paizo
 * table. Whether the retrieved GM Core excerpts actually surfaced is not
 * deterministically decidable from the retrieval output, so this persists on
 * every such run (over-loud by design, exactly like the verbatim advisory).
 */
export const PF2E_APPROXIMATION_ADVISORY =
  "Room challenge was checked against Campaigner's OWN documented PF2e approximation of a standard " +
  'encounter budget (a party of four at level T: 2 × T creature-levels, scaled by party size) — not ' +
  "against Paizo's GM Core table, which is not licensable and never ships with Campaigner. Where the " +
  'retrieved GM Core excerpts are in context they are the authority and were followed verbatim; review ' +
  'the numbers by hand if they were absent.';

/** The verification advisory a run's budget policy owes the owner, or null. */
export function budgetVerificationAdvisory(budget: EncounterBudget): string | null {
  if (budget.mode === 'verbatim') {
    return budget.scale === 'pf2e' ? PF2E_BUDGET_ADVISORY : VERBATIM_BUDGET_ADVISORY;
  }
  if (budget.policy === 'pf2e-budget') return PF2E_APPROXIMATION_ADVISORY;
  return null;
}

/**
 * The module-difficulty clause the encounter brief carries (docs/17 row 190):
 * the owner's five-step setting, stated where challenge is designed. In a
 * numeric-band mode it names the multiplier so the model aims at the SAME
 * scaled numbers the deterministic check uses; under `'verbatim'` no number is
 * computed at all, so the clause states the DIRECTION only — the multiplier
 * applies only where numbers are computed at all, and no numeric budget is
 * invented (docs/11 D12 licensing stance).
 */
export function moduleDifficultyGuidanceFor(budget: EncounterBudget): string {
  const label = MODULE_DIFFICULTY_LABELS[budget.difficulty];
  const head =
    `MODULE DIFFICULTY (the owner's setting for this whole module — NOT the per-encounter ` +
    `"difficulty" field of your reply): ${label}.`;
  const multiplier = difficultyBudgetMultiplier(budget.difficulty);
  if (budget.mode === 'verbatim') {
    const direction =
      multiplier === 1
        ? "This module is tuned for the party's baseline: size each room as the excerpts state."
        : `This module is tuned ${label.toUpperCase()} than the party's baseline — design each room's challenge accordingly.`;
    return (
      `${head} ${direction} No numeric budget is computed under this module's policy, so this is a ` +
      'DIRECTIONAL instruction only; where the retrieved rule excerpts are in context they remain the law.'
    );
  }
  if (multiplier === 1) {
    return `${head} Size every room exactly as the standard band below states (1× the standard encounter budget).`;
  }
  return (
    `${head} This module is tuned ${label.toUpperCase()} than the party's baseline: the standard band below ` +
    `is scaled by ×${String(multiplier)} here, and both the per-room expectation and the deterministic ` +
    'check use the SCALED number — aim at that, not at the bare standard.'
  );
}

/** The prompt clause teaching the per-room challenge contract. */
export function roomBudgetGuidanceFor(budget: EncounterBudget): string {
  const shared = [
    'Per-room challenge: every room must ALONE challenge the party — a complex is a sequence of fights, not one fight spread thin.',
    'Each room carries a "targetLevel": the party level this room alone should challenge. When you omit it, the encounter\'s own level is used. A DUNGEON COMPLEX requires a targetLevel on EVERY room — a complex room without one is rejected.',
  ].join('\n');
  const difficultyClause = moduleDifficultyGuidanceFor(budget);
  const multiplier = difficultyBudgetMultiplier(budget.difficulty);
  if (budget.mode === 'verbatim') {
    return [
      shared,
      difficultyClause,
      'pathfinder2e budget: the GM Core encounter-building rules are the law — when the retrieved rule excerpts include them, follow those budgets VERBATIM per room (exact XP values, never a paraphrase of a Paizo number). When the excerpts do NOT include the encounter-budget rules, set each room\'s "targetLevel" from the party level and describe the intended difficulty without inventing XP amounts.',
    ].join('\n');
  }
  if (budget.scale === 'pf2e') {
    const bandRule =
      multiplier === 1
        ? `a standard encounter for a party of four at level T is worth ${String(PF2E_STANDARD_ON_LEVEL_CREATURES)} × T creature-levels, scaled by party size — a room is over budget above that and its fill-grade share is the expectation below.`
        : `a standard encounter for a party of four at level T is worth ${String(PF2E_STANDARD_ON_LEVEL_CREATURES)} × T creature-levels, scaled by party size; this module's difficulty scales that standard budget by ×${String(multiplier)}, so a room is over budget above ×${String(multiplier)} of that standard and its fill-grade share is the expectation below.`;
    return [
      shared,
      difficultyClause,
      `pathfinder2e budget (policy 'pf2e-budget'): the GM Core encounter-building rules are the law — when the retrieved rule excerpts include them, follow those budgets VERBATIM per room (exact XP values, never a paraphrase of a Paizo number). When they are NOT in context, Campaigner's own documented approximation applies: ${bandRule} A DUNGEON COMPLEX must stock every room: a complex room with no creatures is a repairable defect, and a room that cannot reach its drawn share is ALSO repairable. The brief carries the exact per-room expected numbers when they apply.`,
    ].join('\n');
  }
  const bandRule =
    multiplier === 1
      ? `a room is over budget when its assigned creatures' levels (CR) sum to more than targetLevel + ${String(ROOM_BUDGET_OVER_MARGIN)}.`
      : `this module's difficulty scales the standard band by ×${String(multiplier)}, so a room is over budget when its assigned creatures' levels (CR) sum to more than (targetLevel + ${String(ROOM_BUDGET_OVER_MARGIN)}) × ${String(multiplier)}.`;
  return [
    shared,
    difficultyClause,
    `dnd5e band (Campaigner's own documented approximation; the DMG encounter-building tables are not licensable, so no DMG text is quoted or restated): ${bandRule} Fractional levels (1/2, 1/4) count fractionally; "—" (CR-less summons) counts as 0. Stay at or under the band. For a SINGLE arena, under is fine (a quiet room is a feature); in a DUNGEON COMPLEX every room stocks a real fight — a complex room with no creatures is a repairable defect and a room well under its expected share ships with a loud advisory. The brief carries the exact per-room expected numbers when they apply.`,
  ].join('\n');
}

/**
 * The per-room stocking numbers for the Cartographer brief prompt (docs/11
 * D12 amendment, fill-grade arc): the fill-grade share rendered as concrete
 * creature-levels and an approximate creature count at `promptLevel` — the
 * level the rooms' targetLevels will default to. Returns null when no
 * honest number exists: a 'verbatim' budget (licensing) or a level-less
 * brief (no digit to anchor the band to) — the qualitative clause still
 * applies, never an invented number.
 */
export function fillGradeStockingFor(
  fillGrade: number,
  promptLevel: number | undefined,
  budget: EncounterBudget,
): string | null {
  if (promptLevel === undefined) return null;
  const expectation = expectedRoomThreat(fillGrade, promptLevel, budget);
  if (expectation === null) return null;
  // The standard-encounter number comes from the ONE budget seam
  // (`roomBudgetBandUpperFor`), so the module's difficulty scales the number
  // the model is told exactly as it scales the deterministic check
  // (docs/17 row 190) — a hand-spelled `pf2eStandardThreatLevels` here would
  // have drifted the moment difficulty existed.
  const multiplier = difficultyBudgetMultiplier(budget.difficulty);
  const bandSentence = budget.scale === 'pf2e'
    ? `Campaigner's PF2e approximation gives a standard encounter at party level T a budget of ` +
      `${sumLabel(roomBudgetBandUpperFor(budget, promptLevel))} creature-levels ` +
      `(${String(PF2E_STANDARD_ON_LEVEL_CREATURES)} on-level creatures for a party of four, scaled by party size` +
      `${multiplier === 1 ? '' : `, ×${String(multiplier)} for this module's difficulty`}), ` +
      'so each room here should carry roughly '
    : multiplier === 1
      ? `a room at targetLevel T holds at most T + ${String(ROOM_BUDGET_OVER_MARGIN)} creature-levels, ` +
        'so each room here should carry roughly '
      : `a room at targetLevel T holds at most (T + ${String(ROOM_BUDGET_OVER_MARGIN)}) × ${String(multiplier)} ` +
        "creature-levels (the standard band scaled by this module's difficulty), so each room here should carry roughly ";
  const tail = budget.repairUnder
    ? 'at the party level. Every room stocks a real fight: a complex room with no creatures is a repairable defect, ' +
      'and a room that cannot reach its drawn share is ALSO repairable.'
    : 'at the party level. Every room stocks a real fight: a complex room with no creatures is a repairable defect, ' +
      'and a room well under its expected share ships with a loud advisory.';
  return (
    `Stocking: this dungeon's fill grade is ${String(fillGrade)}% — ${bandSentence}` +
    `${sumLabel(expectation.expectedLevels)} creature-levels (≈${String(expectation.approximateCreatureCount)} creatures) ` +
    tail
  );
}

// --- Fixed cast ------------------------------------------------------------

/**
 * A named, already-drafted participant the prose pins into an encounter
 * (docs/11 fixed cast): an npc-kind artifact whose `[[Name]]` mention falls in
 * the encounter's scene context. That includes a CAST CREATURE npc (docs/11 D4)
 * — a real `npc` row with its own prose whose numbers come from a library
 * creature — so `statBlock` here is the block the encounter should actually
 * use, derived from the citation when the row has none of its own.
 */
export interface FixedCastMember {
  /** Exact artifact name — the roster entry must carry it verbatim. */
  name: string;
  /** Printed level from the NPC's stat block; undefined when statless. */
  level: string | undefined;
  /** Brief-ready one-liner: name + key stats + level. */
  summary: string;
  /** Full stat block for the as-is inline path; null when statless. */
  statBlock: StatBlock | null;
}

/**
 * The module-side context the OUT-OF-BAND target check needs (docs/17 row 283):
 * the module's OWN band, and the module's recorded GENERATION TARGET for a
 * figure by name. Kept as ONE optional argument so the pre-283 callers (and
 * every existing pin) render the same advisories BYTE-IDENTICALLY — omitting it
 * means no band check at all.
 *
 * `targetLevelFor` is a LOOKUP rather than a pre-joined map deliberately: the
 * caller already holds the module row, so the ONE reader of the field
 * (`domain/module.entityLevelHintFor`, over the module's entity records) is
 * consulted here instead of a second name-keyed copy of it being built.
 */
export interface EncounterTargetContext {
  /** The owning module's own band, inclusive (`Module.levelMin`/`levelMax`). */
  levelMin: number;
  levelMax: number;
  /** The module's recorded target level for a figure, or null when it states none. */
  targetLevelFor: (name: string) => number | null;
}

function fixedCastSummary(name: string, statBlock: StatBlock | null): string {
  if (statBlock === null) return `${name} (no stat block on file)`;
  return (
    `${name} — level ${statBlock.level}, ` +
    `AC ${String(statBlock.ac)}, HP ${String(statBlock.hp)}`
  );
}

/**
 * The fixed cast for an encounter mention (docs/11, pure): every `[[Name]]`
 * in the encounter's scene context that resolves to a drafted npc-kind
 * artifact. The encounter's own name never counts (its row — when drafted
 * yet — is kind `encounter`, and the name check belts it regardless).
 * Order = first mention in the scene text. Never throws for data
 * conditions: undrafted names and other kinds yield no member, ambiguity
 * follows the reader's winner — and the caller keeps today's behavior when
 * the cast is empty.
 *
 * KEY SPACE `MODULE_NAME_KEY` (docs/17 row 167): a name of something the MODULE
 * itself holds — an encounter roster entry, a module entity record and its
 * aliases — matched against another such name inside the SAME module (the
 * `[[link]]` the module prose writes, the roster row the encounter carries).
 * This is NOT the pack pool's key space (`PACK_POOL_NAME_KEY`): a pack
 * creature's name is a LIBRARY lookup, a roster name is this campaign's own row.
 */
export function fixedCastForEncounter(
  encounterName: string,
  sceneContext: string,
  artifacts: readonly AnyArtifact[],
  moduleId: Id | null,
): FixedCastMember[] {
  const self = comparableName(encounterName);
  const seen = new Set<string>();
  const cast: FixedCastMember[] = [];
  for (const link of extractWikiLinks(sceneContext)) {
    const key = comparableName(link.name);
    if (key === '' || key === self || seen.has(key)) continue;
    seen.add(key);
    const artifact = resolveWikiLink(
      link.name,
      artifacts,
      moduleId === null ? undefined : { moduleId },
    ).artifact;
    if (artifact?.kind !== 'npc') continue;
    cast.push({
      name: artifact.name,
      ...fixedCastStatsFor(artifact),
    });
  }
  return cast;
}

/**
 * The stats ONE cast member contributes, and where they came from.
 *
 * An authored block is used as-is. A row with NO block but a `creatureRef` is a
 * CAST CREATURE (docs/11 D3/D4): its numbers are the library creature's, read
 * through the ONE creature seam (uuid, then the content-hash fallback — docs/11
 * D9). Reporting `null` there would put "no stat block is on file — design
 * their stats" into the brief for a creature the bestiary fully describes, which
 * is the silent hole AGENTS rule 1 forbids. A reference that resolves to nothing
 * keeps `null`: the brief then says so, honestly.
 */
function fixedCastStatsFor(
  artifact: Extract<AnyArtifact, { kind: 'npc' }>,
): { level: string | undefined; summary: string; statBlock: StatBlock | null } {
  if (artifact.data.statBlock !== null) {
    const statBlock = artifact.data.statBlock;
    return {
      level: statBlock.level,
      summary: fixedCastSummary(artifact.name, statBlock),
      statBlock,
    };
  }
  // A cast creature OWNS its copy (docs/17 row 255b), and since the clean cut
  // (docs/17 row 278) there is no `creatureRef` pointer to fall back to: an npc
  // with no block on its row has no numbers to offer the budget brief, and the
  // brief says so honestly rather than deriving them from a library read.
  return { level: undefined, summary: fixedCastSummary(artifact.name, null), statBlock: null };
}

/**
 * The FIXED CAST brief section (docs/11): the must-appear instruction for
 * the encounter draft — the cast MUST appear by exact name with their stats
 * used as-is via the inline-statblock path (never substituted with generic
 * equivalents), while the pipeline fills the REST of the roster as today.
 * Null when the cast is empty, so briefs without one stay byte-identical.
 */
export function fixedCastSectionFor(cast: readonly FixedCastMember[]): string | null {
  if (cast.length === 0) return null;
  const lines = cast.map((member) =>
    member.statBlock === null
      ? `- "${member.name}" (${member.summary}): no stat block is on file — design their stats at the party level above.`
      : `- "${member.name}" (${member.summary}): use these stats as-is — embed them as this monster's ` +
        `complete inline "statBlock" (never substitute a generic equivalent):\n${JSON.stringify(member.statBlock)}`,
  );
  return [FIXED_CAST_SECTION_HEADER, ...lines, FIXED_CAST_SECTION_FOOTER].join('\n');
}

/**
 * Fixed-cast finalize advisories (docs/11, pure): after the roster
 * finalizes, the encounter's cast is checked and every finding rides the
 * existing advisory block/seam (`data.budgetAdvisory`, the 'under' precedent)
 * — all loud, never blocking, none of them fails anything:
 *
 * - cast-coverage: a fixed-cast name absent from the roster (the encounter
 *   was supposed to feature them — prose said so, the roster does not).
 * - level-mismatch: a FIELDed cast member (present in the roster) whose
 *   level sits more than one band step (`ROOM_BUDGET_OVER_MARGIN`) off the
 *   party level. Absent members get the coverage advisory instead of this
 *   one — their level matters once they actually fight. Deliberate
 *   mismatches stay legal: the brief stated levels honestly, this flags
 *   them loudly.
 * - target-out-of-band (docs/17 row 283): the level the module ASKS its
 *   generators to build a FIELDED cast member at (`targets.targetLevelFor`,
 *   the module record's `levelHint`) sits more than one band step outside the
 *   module's OWN range. This is the BALANCE half of the two-case aiming rule
 *   the spine prompt states: a figure that TAKES PART in an encounter is a
 *   balance question, so an out-of-band TARGET is a signal — while a figure
 *   the encounter never fields (a bystander, an official, a child) is a
 *   REALISM question, its out-of-band level is EXPECTED, and it is silent
 *   here BY CONSTRUCTION: the check lives under the same `fielded` guard the
 *   party-level check uses, so no second "is this a combatant" test exists.
 *   Suppressed when the party-level advisory already named this figure: one
 *   sentence per figure about its level, never two.
 *
 * Unjudgeable states yield nothing: no party level (unmentioned encounter,
 * digit-free hint), no owning-module band, or an unreadable cast level is a
 * legitimate state, never a failure. The party level is consulted FIRST and
 * the target check stands on its own when there is none.
 */
export function fixedCastAdvisories(
  encounterName: string,
  cast: readonly FixedCastMember[],
  roster: readonly { name: string }[],
  partyLevel: number | undefined,
  targets?: EncounterTargetContext,
): string[] {
  const advisories: string[] = [];
  const rosterNames = new Set(
    roster.map((entry) => comparableName(entry.name)).filter((name) => name !== ''),
  );
  for (const member of cast) {
    const key = comparableName(member.name);
    if (key === '') continue;
    const fielded = rosterNames.has(key);
    if (!fielded) {
      advisories.push(
        `Fixed cast member "${member.name}" is missing from the roster of "${encounterName}" — ` +
          `the module prose names them as a participant ([[${member.name}]] shares the encounter's scene), ` +
          'but no roster entry carries that name. Add them by hand or regenerate the encounter.',
      );
      continue;
    }
    let levelFlagged = false;
    if (partyLevel !== undefined) {
      const castLevel = parseBudgetLevel(member.level);
      if (
        castLevel.kind === 'level' &&
        Math.abs(castLevel.value - partyLevel) > ROOM_BUDGET_OVER_MARGIN
      ) {
        advisories.push(
          `Fixed cast member "${member.name}" (level ${String(castLevel.value)}) is far from the party ` +
            `level (${String(partyLevel)}) for "${encounterName}" — deliberate mismatches are legal, ` +
            "but review this fight's difficulty by hand.",
        );
        levelFlagged = true;
      }
    }
    if (!levelFlagged && targets !== undefined) {
      const target = targets.targetLevelFor(member.name);
      if (
        target !== null &&
        (target < targets.levelMin - ROOM_BUDGET_OVER_MARGIN ||
          target > targets.levelMax + ROOM_BUDGET_OVER_MARGIN)
      ) {
        advisories.push(
          `The module targets level ${String(target)} for "${member.name}", who takes part in ` +
            `"${encounterName}" — more than ${String(ROOM_BUDGET_OVER_MARGIN)} levels outside this ` +
            `module's own range of ${String(targets.levelMin)}–${String(targets.levelMax)}. A figure the ` +
            `party fights is a balance question, so review this fight's difficulty — a figure the party ` +
            `never fights is a realism question and its level is expected to be whatever it is.`,
        );
      }
    }
  }
  return advisories;
}

/**
 * Scene-assertion substitution advisories (docs/11 assertion rule, docs/17
 * row 89, pure): the encounter DECLARED that the module text states one thing
 * and the roster carries another — a stated creature with no citable stat
 * source, a stated count it could not stock, a place it could not map. Rendered
 * through the SAME advisory seam the fixed-cast checks above use
 * (`data.budgetAdvisory` + the step notice), so the GM reads
 * *"your text says two risen lumberjacks; the roster uses ghouls — here is
 * why"* instead of meeting a silent substitution in play.
 *
 * Never blocking and never a failure: it reports a declaration the model made,
 * which is the whole point of asking for it. An entry carrying no assertion and
 * no substitution (all three fields blank) says nothing and renders nothing.
 */
export function substitutionAdvisories(
  encounterName: string,
  substitutions: readonly SceneSubstitution[],
): string[] {
  return substitutions
    .map((entry) => ({
      asserted: entry.asserted.trim(),
      used: entry.used.trim(),
      reason: entry.reason.trim(),
    }))
    .filter((entry) => entry.asserted !== '' || entry.used !== '')
    .map((entry) => {
      const asserted =
        entry.asserted === '' ? 'a creature or place in the scene' : `"${entry.asserted}"`;
      const used = entry.used === '' ? 'something else' : `"${entry.used}"`;
      const reason = entry.reason === '' ? 'no reason given' : entry.reason;
      return (
        `The module text for "${encounterName}" states ${asserted} and the roster uses ${used} instead. ` +
        `The encounter declared this substitution itself — reason: ${reason}. ` +
        'Review this roster (or regenerate the encounter) against the prose: a stated creature or place is never swapped silently.'
      );
    });
}

// --- Roster level resolution -------------------------------------------------
export interface BriefLevelLookups {
  /** Chunk stat blocks by id (the retrieval pool + roster citations). */
  chunkById: ReadonlyMap<Id, RuleChunk>;
  rosterChunkByName: Readonly<Record<string, Id>>;
  statblockChunkIds: readonly Id[];
}

/**
 * Level strings for a FRESH brief's monsters: inline stat block → roster
 * name citation → excerpt index citation (the M-B §7 precedence). Entries
 * with no resolvable stats yield undefined (the room becomes loud-unverified).
 * The roster-name lookup asks in the index's OWN key space
 * (`PACK_POOL_NAME_KEY`, docs/17 row 167 — the index is keyed by the
 * comparable form, `encounterRoster.rosterNameIndex`); without it a
 * sourceName-cited creature's level silently missed the index and the room
 * read loud-unverified for no reason — and a `.toLowerCase()`-only lookup
 * would miss an entry whose stored spelling differs only by composition.
 */
export function resolveBriefMonsterLevels(
  monsters: readonly {
    statBlock?: StatBlock | undefined;
    sourceName?: string | undefined;
    sourceChunkIndex?: number | undefined;
  }[],
  lookups: BriefLevelLookups,
): (string | undefined)[] {
  return monsters.map((monster) => {
    if (monster.statBlock !== undefined) return monster.statBlock.level;
    if (monster.sourceName !== undefined) {
      const chunkId = lookups.rosterChunkByName[comparableName(monster.sourceName)];
      const chunk = chunkId === undefined ? undefined : lookups.chunkById.get(chunkId);
      return chunk?.statBlock?.level;
    }
    if (monster.sourceChunkIndex !== undefined) {
      const chunkId = lookups.statblockChunkIds[monster.sourceChunkIndex];
      const chunk = chunkId === undefined ? undefined : lookups.chunkById.get(chunkId);
      return chunk?.statBlock?.level;
    }
    return undefined;
  });
}

export interface EntryLevelLookups {
  /** Resolves an npc-ref entry's stat block (null when missing/statless). */
  getArtifactStatBlock: (artifactId: Id) => Promise<StatBlock | null>;
}

/**
 * Level strings for persisted roster entries (MonsterEntry sources) — used
 * by the in-place Smith fill, whose reconciled roster is the real thing. A
 * copied mob's level is its own block's (docs/17 row 278); the library-citation
 * arm is gone.
 */
export async function resolveEntryLevels(
  entries: readonly MonsterEntry[],
  lookups: EntryLevelLookups,
): Promise<(string | undefined)[]> {
  const npcCache = new Map<Id, StatBlock | null>();
  return Promise.all(
    entries.map(async (entry) => {
      switch (entry.source.type) {
        case 'inline':
          return entry.source.statBlock.level;
        case 'npc-ref': {
          const cached = npcCache.get(entry.source.artifactId);
          if (cached !== undefined) return cached?.level;
          const statBlock = await lookups.getArtifactStatBlock(entry.source.artifactId);
          npcCache.set(entry.source.artifactId, statBlock);
          return statBlock?.level;
        }
        case 'none':
          return undefined;
      }
    }),
  );
}

// --- In-place fill reconciliation -------------------------------------------

export interface ReconciledRoomAssignment {
  roomId: string;
  monsterIndexes: number[];
}

export interface ReconcilePackingOptions {
  /**
   * Expected creature-levels per room (the fill-grade expectation, same
   * order as `rooms`) — the threat-fit packing target. When provided and
   * FINITE for every room, unclaimed entries pack by nearest-band fit; when
   * absent or incomplete, the documented round-robin fallback applies (a
   * verbatim-mode system ships no numbers — Paizo licensing — so there is
   * no fit to compute).
   */
  expectedLevels?: readonly (number | undefined)[] | undefined;
  /**
   * Printed level string per NEW roster entry (same index order) — the
   * entry threat the packing fits. Unreadable/missing levels count as 0
   * threat for PACKING only (the budget verdict reports the room
   * loud-unverified separately — never silently dropped, AGENTS rule 1).
   */
  levels?: readonly (string | undefined)[] | undefined;
}

/**
 * Reconciles the room→roster partition for the in-place Smith content fill
 * (docs/11 D12; packing amended by the fill-grade arc): the fill rewrites
 * `data.monsters` while the layout keeps its rooms byte-identical, so
 * `room.monsterIndexes` would dangle, shift or skip against the NEW roster.
 * Exact rules (deterministic, disclosed):
 *
 * 1. **Preserve by name-match** — every existing assignment (an OLD roster
 *    index) whose creature name (trim/case-insensitive) still exists in the
 *    new roster is kept on its room, remapped to the new roster index; the
 *    FIRST room to claim a name wins (rooms in layout order), so a name is
 *    never assigned to two rooms.
 * 2. **Pack the unclaimed by nearest-band fit** (fill-grade arc — replaces
 *    the old blind round-robin): with per-room `expectedLevels` supplied,
 *    unclaimed entries are processed biggest-threat-first (ties keep roster
 *    order). Each entry lands in the room whose remaining headroom
 *    (expected − shipped) it brings NEAREST its band
 *    (`min |expected − currentSum − entryThreat|`, ties to the lowest room
 *    index) — preferring rooms STILL UNDER their expectation, so a fitted
 *    room is never topped up while another room waits for its fight; only
 *    when every room is at or over its expectation may an entry overflow
 *    the least-wrong room. Big creatures claim the rooms that fit them;
 *    leftover entries concentrate where they fit rather than spreading one
 *    per room (the round-robin spread was the sparse-roster bug). A room
 *    left EMPTY by packing is a legitimate outcome — the budget loop
 *    reports it as the loud 'empty' verdict, never silently.
 *    **Round-robin fallback**: when `expectedLevels` is absent/incomplete
 *    (verbatim systems, pre-expectation callers), the unclaimed entries
 *    append in roster order, one room per entry, cycling rooms[0..n-1] —
 *    the documented pre-arc behavior, byte-identical.
 * 3. **Drop the gone** — assignments whose name no longer exists in the new
 *    roster are removed.
 *
 * The result keeps the layout invariant every roster entry belongs to
 * exactly one room. Room CAPACITY is not re-derived here (the rooms keep
 * their rectangles): an overfull room fails loudly at seed via the layout
 * validation, never silently.
 */
export function reconcileRoomAssignments(
  rooms: readonly { id: string; monsterIndexes: readonly number[] }[],
  oldRoster: readonly { name: string }[],
  newRoster: readonly { name: string; count?: number | undefined }[],
  options: ReconcilePackingOptions = {},
): ReconciledRoomAssignment[] {
  // KEY SPACE `MODULE_NAME_KEY` (docs/17 row 167): BOTH rosters are this
  // campaign's own rows (the encounter's old and new monster lists), and the
  // remap must ask both sides in the SAME key space — one side keyed by a
  // hand-rolled `.toLowerCase()` would strand a room whose creature kept its
  // name but changed composition. Producer and consumer are the two loops
  // below; both go through `comparableName`.
  const newIndexByName = new Map<string, number>();
  for (const [index, entry] of newRoster.entries()) {
    const key = comparableName(entry.name);
    if (!newIndexByName.has(key)) newIndexByName.set(key, index);
  }
  const claimed = new Set<number>();
  const perRoom: number[][] = rooms.map(() => []);
  // 1. preserve by name-match, room order first
  for (const [roomIndex, room] of rooms.entries()) {
    for (const oldIndex of room.monsterIndexes) {
      const oldEntry = oldRoster[oldIndex];
      if (oldEntry === undefined) continue;
      const key = comparableName(oldEntry.name);
      const newIndex = newIndexByName.get(key);
      if (newIndex === undefined || claimed.has(newIndex)) continue; // gone / already claimed
      claimed.add(newIndex);
      perRoom[roomIndex]?.push(newIndex);
    }
  }
  const entryThreat = (index: number): number => {
    const parsed = parseBudgetLevel(options.levels?.[index]);
    const count = newRoster[index]?.count ?? 1;
    return parsed.kind === 'level' ? parsed.value * count : 0;
  };
  const expected = options.expectedLevels;
  const threatFit =
    expected !== undefined &&
    rooms.length > 0 &&
    rooms.every((_, roomIndex) => typeof expected[roomIndex] === 'number');
  // 2a. nearest-band packing (fill-grade arc)
  if (threatFit) {
    const currentSum = perRoom.map((assignments) =>
      assignments.reduce((total, index) => total + entryThreat(index), 0),
    );
    const unclaimed = newRoster
      .map((_, index) => index)
      .filter((index) => !claimed.has(index))
      .sort((a, b) => entryThreat(b) - entryThreat(a) || a - b);
    for (const index of unclaimed) {
      const threat = entryThreat(index);
      // Rooms still UNDER their expectation are the preferred candidates —
      // a fitted room is never topped up while another waits for its fight.
      // Only when every room is at or over its expectation may an entry
      // overflow the least-wrong room (the roster must go somewhere).
      const openRooms = rooms
        .map((_, roomIndex) => roomIndex)
        .filter((roomIndex) => (expected[roomIndex] ?? 0) - (currentSum[roomIndex] ?? 0) > 0);
      const candidates = openRooms.length > 0 ? openRooms : rooms.map((_, roomIndex) => roomIndex);
      let bestRoom = candidates[0] ?? 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const roomIndex of candidates) {
        const target = expected[roomIndex] ?? 0;
        const after = (currentSum[roomIndex] ?? 0) + threat;
        const distance = Math.abs(target - after);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestRoom = roomIndex;
        }
      }
      claimed.add(index);
      perRoom[bestRoom]?.push(index);
      currentSum[bestRoom] = (currentSum[bestRoom] ?? 0) + threat;
    }
  } else {
    // 2b. round-robin fallback (the documented pre-arc behavior)
    let cursor = 0;
    for (const [index] of newRoster.entries()) {
      if (claimed.has(index)) continue;
      const roomIndex = rooms.length === 0 ? null : cursor % rooms.length;
      cursor += 1;
      if (roomIndex === null) break;
      claimed.add(index);
      perRoom[roomIndex]?.push(index);
    }
  }
  return rooms.map((room, roomIndex) => ({
    roomId: room.id,
    monsterIndexes: perRoom[roomIndex] ?? [],
  }));
}
