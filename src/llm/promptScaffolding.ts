import type { EntityKind } from '@/domain';
import { GROUNDING_SECTION_HEADER } from '@/llm/campaignGrounding';

/**
 * Our own prompt scaffolding, as ONE source (docs/17 row 142, AGENTS rule 4).
 *
 * WHY THIS MODULE EXISTS. The owner found our brief printed into his module:
 * *"The artifact \"name\" field must be exactly \"Nisselkraut\" — verbatim, with
 * no epithets, titles, or additions (put those in the body). Do not invent
 * unrelated sub-plots; make this entity serve the module text. Campaign
 * grounding (derived from wiki-links): -"* — a model echoed the instructions it
 * was handed and nothing detected the echo, so it was written to the artifact.
 *
 * The detection is a MECHANICAL string comparison, and it is only legitimate
 * because the strings compared are OURS, verbatim: *is this, or is this not,
 * one of the literal sentences we send?* is decidable, unlike the prose gates
 * `docs/18-ARCHITECTURE.md` forbids (a classifier guessing at a gate). It is
 * the `encounterSourceIssues` / `statBlockLevelIssues` / escape-debris pattern
 * (`lib/encodingHygiene`), applied to the prompt instead of to the reply's
 * shapes.
 *
 * WHY THE LITERALS LIVE HERE AND NOT INLINE AT THE COMPOSERS. Detection can
 * only be sound if the composer and the detector read the SAME bytes — a
 * hand-copied second list of marker strings is a list that rots the first time
 * a sentence is reworded, silently (the detector keeps flagging the old
 * sentence and stops flagging the new one). So every fixed sentence and section
 * label a brief or a schema-repair prompt is built from is exported from THIS
 * module, the composers (`features/modules/persona-request`,
 * `llm/runEngine`, `llm/moduleGen`, `llm/roomBudget`) import it, and
 * `SCAFFOLDING_MARKERS` below is DERIVED from those same constants. The two
 * cannot drift: `tests/llm/scaffoldingEcho.test.ts` pins that the composed
 * brief is itself detected as scaffolding, which fails the moment one side is
 * edited alone.
 */

/* -------------------------------------------------------------------------
 * The entity brief's own sentences and labels (features/modules/persona-request)
 * ---------------------------------------------------------------------- */

/** Intro line's slot: the entity's exact link name. */
export const ENTITY_BRIEF_INTRO_PREFIX = 'Detail the entity "';
export const ENTITY_BRIEF_INTRO_SUFFIX =
  '" for this module. It appears in the module text below — match it exactly by name.';

/** The brief for "Generate with persona": one entity, its mention, its premise. */
export function entityBriefIntro(name: string): string {
  return `${ENTITY_BRIEF_INTRO_PREFIX}${name}${ENTITY_BRIEF_INTRO_SUFFIX}`;
}

/** The context label: the paragraphs of module text that mention the entity. */
export const ENTITY_CONTEXT_LABEL = 'Where it is mentioned:';

/** The ENCOUNTER's context label (`encounterScene`, docs/11 / docs/17 row 89):
 * the surrounding text is not background the encounter merely happens near, it
 * is the scene the encounter must stage. */
export const ENTITY_SCENE_CONTEXT_LABEL =
  'The scene this encounter must stage — whatever it states about the opposition and the place is FIXED, and the roster and the map must match it:';

/** The module premise label — ALSO used by the module spine's normalization
 * prompt (`llm/moduleGen.normalizationMessages`), which is why it is shared
 * rather than inlined at either composer. */
export const MODULE_PREMISE_LABEL = 'Module premise for context:';

/** The verbatim-name rule (the artifact is linked from the module's wiki-link,
 * which resolves by exact name), with the name as its one slot. */
export const ENTITY_NAME_VERBATIM_PREFIX = 'The artifact "name" field must be exactly "';
export const ENTITY_NAME_VERBATIM_SUFFIX =
  '" — verbatim, with no epithets, titles, or additions (put those in the body).';

export function entityNameVerbatimSentence(name: string): string {
  return `${ENTITY_NAME_VERBATIM_PREFIX}${name}${ENTITY_NAME_VERBATIM_SUFFIX}`;
}

/** The "serve the module text" rule — the sentence a location obeys by
 * retelling the fight it was handed, which is why the ownership boundary below
 * is appended AFTER it (docs/17 row 140). */
export const ENTITY_SERVE_MODULE_TEXT =
  'Do not invent unrelated sub-plots; make this entity serve the module text.';

/* -------------------------------------------------------------------------
 * The entity INTENT paragraph (docs/17 row 141; moved here by row 145)
 * ---------------------------------------------------------------------- */

/**
 * The intent paragraph's ONE form (08 §M4-C "Entity intent", docs/17 row 141):
 * `Additional instruction: …` and this are ONE form with two sources — that one
 * is TRANSIENT (a change request), this one PERSISTENT (the entity's recorded
 * intent).
 *
 * It states its own HIERARCHY, and that sentence is load-bearing: a steering
 * note that outranked the module text would be a second author, so the
 * paragraph says EMPHASIS and OWNERSHIP move while what the module text states
 * is fixed and the kind's own charter still governs what the artifact may
 * contain (which is what keeps the ownership boundary above it binding).
 *
 * WHY THESE TWO LITERALS LIVE HERE AND NOT IN
 * `features/modules/persona-request` (docs/17 row 145): row 142's
 * scaffolding-echo detector can only mark a sentence whose bytes it can READ
 * from the composer, and importing them from the feature into this module would
 * be an import cycle (the feature already imports this one). Moving the
 * literals down to the seam BOTH modules can see is what closed that gap; not
 * one byte of the composed paragraph moved (row 141's 31 pins stay green
 * unchanged).
 */
export const INTENT_LABEL = "The module's author intended: ";

export const INTENT_HIERARCHY =
  ' This steers EMPHASIS and OWNERSHIP; what the module text states is fixed, and your own charter still governs what this kind may contain.';

/* -------------------------------------------------------------------------
 * The entity LEVEL-HINT paragraph (docs/17 row 197)
 * ---------------------------------------------------------------------- */

/**
 * The level-hint paragraph's ONE form (owner request, docs/17 row 197): the
 * module author fixed a level for this entity in the prose, and this is how the
 * generator that builds the entity HEARS it — a structured number, not a
 * sentence the engine re-parses.
 *
 * The hierarchy sentence is load-bearing the same way the intent paragraph's is:
 * the hint OVERRIDES the party-level context the brief may also carry (the
 * recorded level is the author's own statement about THIS entity), and it binds
 * the generator to surface a deviation instead of drifting silently — which is
 * exactly the owner's symptom (a level-7 gnome generated at level 1).
 *
 * WHY THE TWO LITERALS LIVE HERE AND NOT IN `features/modules/persona-request`
 * (docs/17 row 145's rule): the scaffolding-echo detector can only mark a
 * sentence whose bytes it can READ from the composer, and the feature imports
 * this module, so an inline literal would be an undetectable one.
 */
export const ENTITY_LEVEL_HINT_LABEL = "The module fixes this entity's level: ";

export const ENTITY_LEVEL_HINT_HIERARCHY =
  ' Build this entity at exactly that level; it overrides the party level above, and a description or stat block that prints another level must say so rather than drift.';

/* -------------------------------------------------------------------------
 * The KIND ownership boundaries (docs/17 row 140 — moved here UNCHANGED)
 * ---------------------------------------------------------------------- */

/**
 * The OWNERSHIP BOUNDARY for the NON-COMBAT kinds (docs/17 row 140): what a
 * location, an event or a faction detail owns, and what the encounter owns.
 *
 * WHY IT IS ENFORCED IN CODE AND NOT IN THE PERSONA TEXT. The rule is not new —
 * the Worldbuilder and Event Weaver built-in prompts have carried a version of
 * it since `fe1d365`, and `promptStyles.PARTS_MECHANICS` states it to the module
 * writer itself. The persona layer cannot carry it: personas are user-editable
 * STORED rows seeded once by `seed.seedBuiltInPersonas` / `personaRepo` (a slug
 * that already exists is never rewritten), so editing a built-in prompt reaches
 * a NEW install only and every existing install keeps the old bytes forever
 * (docs/18 §4, docs/17 row 140). This seam is the ONE place every entity detail
 * passes through, so the rule is keyed by KIND, in code, and cannot be outrun by
 * a stored row.
 *
 * ONE FACT, ONE OWNER is the reason the paragraph states: the same fact written
 * in two artifacts is two accounts of one fight, and the encounter artifact is
 * the one a GM reads for it.
 *
 * Scoped to exactly the three kinds the report's class covers (`location`,
 * `event`, `faction`). `npc` legitimately owns stat blocks and `encounter` owns
 * the opposition, so both render `null` and their briefs stay BYTE-IDENTICAL —
 * as does every brief built without a kind. The Record is EXHAUSTIVE over the
 * entity kinds, so a new entity kind cannot be added without deciding its
 * boundary (the compiler refuses).
 */
export const PLACE_OWNERSHIP_BOUNDARY = `What this artifact OWNS — one fact, one owner: the module prose draws this line itself ("encounters live in separate encounter artifacts"), so the OPPOSITION belongs to the encounter artifact — its creatures, their counts, its tactics and how the fight is run are that artifact's content, and that is where a GM gets them. If the story needs the opposition, point at where it is fought by the name the module text's own wiki-link uses instead of describing the opposition here, and write no tactics, no encounter-handling advice and no GM guidance on running the fight. "inhabitants" means the people and factions who are here — never monsters. And when the module text you are given is written from the encounter's point of view (fields such as "If the party acts", "Secrets" or "Outcome"), that material belongs to that encounter: do not restate it, do not extend it, and do not turn it into this artifact's own detail.`;

export const FACTION_OWNERSHIP_BOUNDARY = `What this artifact OWNS — one fact, one owner: the module prose draws this line itself ("encounters live in separate encounter artifacts"), so the OPPOSITION belongs to the encounter artifact — its creatures, their counts, its tactics and how the fight is run are that artifact's content, and that is where a GM gets them. If the story needs the opposition, point at where it is fought by the name the module text's own wiki-link uses instead of describing the opposition here, and write no tactics, no encounter-handling advice and no GM guidance on running the fight. A faction row owns what this faction wants, how it operates, what it controls and how it is ranked — the "order of battle" the module text asks for is the encounter's material, so write no preferred tactics and no encounter-handling advice for it. And when the module text you are given is written from the encounter's point of view (fields such as "If the party acts", "Secrets" or "Outcome"), that material belongs to that encounter: do not restate it, do not extend it, and do not turn it into this artifact's own detail.`;

/**
 * ONE paragraph per kind, or `null` for the kinds that own their boundary.
 * `event` is not a copy of `location` by accident: its draft contract IS the
 * location's (`llm/schemas.eventDraftSchema = locationDraftSchema`) and its
 * built-in persona carries the mirrored clause, so the two share ONE constant
 * and cannot drift.
 */
export const OWNERSHIP_BOUNDARY_BY_KIND: Readonly<Record<EntityKind, string | null>> = {
  npc: null,
  encounter: null,
  note: null,
  location: PLACE_OWNERSHIP_BOUNDARY,
  event: PLACE_OWNERSHIP_BOUNDARY,
  faction: FACTION_OWNERSHIP_BOUNDARY,
};

/* -------------------------------------------------------------------------
 * Other brief / repair-prompt literals the boundary reads
 * ---------------------------------------------------------------------- */

/** The fixed-cast section's framing (encounter stubs, `llm/roomBudget`). */
export const FIXED_CAST_SECTION_HEADER =
  'Fixed cast — these named participants MUST appear in this encounter roster (one roster entry each, exact names):';
export const FIXED_CAST_SECTION_FOOTER =
  'Design the REST of the roster as usual — only the fixed cast above is pinned.';

/** The schema-repair lead-ins — the sentence a one-repair turn opens with when
 * the previous reply failed the contract. Shared so the composer's bytes and
 * the detector's bytes are the same bytes. */
export const SCHEMA_REPAIR_LEAD_IN = 'Your previous reply was invalid JSON for the schema:';
export const ENCOUNTER_SOURCE_REPAIR_LEAD_IN =
  'Your previous reply left monsters without a resolvable stat-block source:';
export const PART_TOO_SHORT_REPAIR_SENTENCE = 'Your previous reply was too short. Write the full part now.';

/* -------------------------------------------------------------------------
 * The mob-spells section (docs/17 rows 184 and 200, the mob half of the arc)
 * ---------------------------------------------------------------------- */

/**
 * The ONE `spells` ENTRY SHAPE (docs/17 row 200). The vocabulary header and
 * the reply contract's own schema clause are TWO HALVES of one instruction and
 * must spell the entry identically, so the shape lives HERE once and both
 * halves render it through `llm/mobSpellPrompt`. Re-typing it at a call site is
 * the exact drift that let row 184's contract omit the field its vocabulary
 * section invited (docs/18 §2.4).
 */
export const MOB_SPELL_ENTRY_SHAPE =
  '{ "name": <copied EXACTLY from this prompt\'s spell list>, "castRank": <the rank it is cast at, or null for the spell\'s own rank; a cantrip ignores it — a cantrip\'s rank is derived from the creature\'s level> }';

/**
 * The stat-block/encounter prompt's spell vocabulary header. Rendered ONLY when
 * the campaign's system actually has imported spells, so a dnd5e (or
 * spell-less) prompt keeps its pre-arc bytes exactly.
 *
 * It states the contract the boundary enforces: a name must be copied from the
 * list, the cast rank is optional, and a cantrip's rank is derived rather than
 * chosen — the heightening rule's own shape (`domain/spellHeightening`), never
 * a second instruction. Its entry shape is `MOB_SPELL_ENTRY_SHAPE`, the SAME
 * one the reply contract's `"spells"` clause renders.
 */
export const MOB_SPELL_SECTION_HEADER = `Spells (optional): to give this creature spells, add a "spells" array to its stat block. Each entry is ${MOB_SPELL_ENTRY_SHAPE}. Assign ONLY names from this list of the campaign's imported spells: the app checks every name against the library and reports any spell it cannot find.`;

/** The honest truncation note (a slot-free literal pair around the counts). */
export const MOB_SPELL_TRUNCATION_PREFIX = '(the list is TRUNCATED — showing ';
export const MOB_SPELL_TRUNCATION_SUFFIX =
  '; assign only from the names listed above)';

/** The spell repair lead-in: same form as the schema/source repairs. */
export const MOB_SPELL_REPAIR_LEAD_IN =
  'Your previous reply assigned spells that are not in this campaign\'s imported spell library:';

/* -------------------------------------------------------------------------
 * The detector
 * ---------------------------------------------------------------------- */

/** One scaffolding marker: a human-readable label plus the matcher DERIVED from
 * the composer's own literal (never a second copy of it). */
interface ScaffoldingMarker {
  /** What the model was told, in the words of the brief — named in the issue. */
  readonly label: string;
  readonly pattern: RegExp;
}

function escapeLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A marker with NO interpolation slot: the whole literal sentence or header. */
function literalMarker(label: string, literal: string): ScaffoldingMarker {
  return { label, pattern: new RegExp(escapeLiteral(literal), 'g') };
}

/**
 * A marker whose ONE slot is a value the composer substitutes (the entity's
 * name). Still a full-sentence match — the literal prefix and the literal
 * suffix must both be present, in order, with only the slot between them — so
 * it can never fire on a fragment or a keyword, and it is built FROM the
 * composer's own prefix/suffix pair rather than re-typed here.
 */
function slottedMarker(
  label: string,
  prefix: string,
  suffix: string,
): ScaffoldingMarker {
  return {
    label,
    // `[^\n"]+` — the slot is the quoted name the composer interpolated; it
    // cannot span a line break or another quote (so a marker can never swallow
    // two unrelated sentences into a "match").
    pattern: new RegExp(`${escapeLiteral(prefix)}[^\\n"]+${escapeLiteral(suffix)}`, 'g'),
  };
}

/**
 * EVERY scaffolding literal the boundary watches, each derived from the
 * constant its composer renders. Adding a sentence to a brief WITHOUT adding it
 * here leaves it undetected; removing a constant from here while the composer
 * keeps emitting it fails the one-source pin
 * (`tests/llm/scaffoldingEcho.test.ts`, "the brief we send is itself
 * scaffolding").
 */
export const SCAFFOLDING_MARKERS: readonly { label: string; pattern: RegExp }[] = [
  slottedMarker(
    'the entity-brief intro line',
    ENTITY_BRIEF_INTRO_PREFIX,
    ENTITY_BRIEF_INTRO_SUFFIX,
  ),
  literalMarker('the "Where it is mentioned:" context label', ENTITY_CONTEXT_LABEL),
  literalMarker('the encounter-scene context label', ENTITY_SCENE_CONTEXT_LABEL),
  literalMarker('the module-premise label', MODULE_PREMISE_LABEL),
  slottedMarker(
    'the verbatim-name rule',
    ENTITY_NAME_VERBATIM_PREFIX,
    ENTITY_NAME_VERBATIM_SUFFIX,
  ),
  literalMarker('the "do not invent unrelated sub-plots" rule', ENTITY_SERVE_MODULE_TEXT),
  literalMarker('the location/event ownership boundary', PLACE_OWNERSHIP_BOUNDARY),
  literalMarker('the faction ownership boundary', FACTION_OWNERSHIP_BOUNDARY),
  // The intent paragraph (docs/17 rows 141/145). TWO literal markers, one per
  // composer constant — NOT the slotted form the entity-brief intro uses,
  // because THIS slot is a free-text note (the module author's intent, up to
  // 400 chars of model-written prose) and the slotted form's `[^\n"]+` slot
  // cannot span a quote: a note reading `the "bustle" is a cover` would make
  // the marker silently dead, which is the failure mode this file exists to
  // prevent. A label literal is the same class of marker the context and
  // premise labels already use.
  literalMarker('the entity-intent label', INTENT_LABEL),
  literalMarker('the entity-intent hierarchy sentence', INTENT_HIERARCHY),
  // The level-hint paragraph (docs/17 row 197): TWO literal markers, one per
  // composer constant, for the same reason the intent pair uses literals — the
  // slot is a NUMBER, so the label sentence is the stable bytes.
  literalMarker('the entity-level-hint label', ENTITY_LEVEL_HINT_LABEL),
  literalMarker('the entity-level-hint hierarchy sentence', ENTITY_LEVEL_HINT_HIERARCHY),
  literalMarker('the grounding section header', GROUNDING_SECTION_HEADER),
  literalMarker('the fixed-cast section header', FIXED_CAST_SECTION_HEADER),
  literalMarker('the fixed-cast section footer', FIXED_CAST_SECTION_FOOTER),
  literalMarker('the schema-repair lead-in', SCHEMA_REPAIR_LEAD_IN),
  literalMarker('the encounter-source repair lead-in', ENCOUNTER_SOURCE_REPAIR_LEAD_IN),
  literalMarker('the part-too-short repair sentence', PART_TOO_SHORT_REPAIR_SENTENCE),
  literalMarker('the mob-spells section header', MOB_SPELL_SECTION_HEADER),
  literalMarker('the mob-spells repair lead-in', MOB_SPELL_REPAIR_LEAD_IN),
];

/** One echo of our own scaffolding found in generated text. */
export interface ScaffoldingEcho {
  /** The marker's label — what the model was told, named in the loud issue. */
  label: string;
  /** The offending text exactly as it appeared (the full sentence matched). */
  match: string;
}

/** Same-length neutral filler: reflowed prose must not hide a marker whose
 * sentence was wrapped across lines by the model, so runs of whitespace
 * collapse to ONE space on both sides before matching. Nothing else is
 * normalized — this stays a FULL-LITERAL comparison. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * Flags every echo of OUR OWN scaffolding in `text`, in marker order. Pure: no
 * I/O, no normalization of the text itself, no repair — the caller decides the
 * loud failure. Ordinary prose that merely TALKS about the same things ("do not
 * invent new factions", "the party is level 3") yields [] by construction: the
 * match is the whole literal sentence or section header, never a fragment.
 */
export function findScaffoldingEcho(text: string): ScaffoldingEcho[] {
  const haystack = normalizeWhitespace(text);
  const hits: ScaffoldingEcho[] = [];
  for (const marker of SCAFFOLDING_MARKERS) {
    marker.pattern.lastIndex = 0;
    const match = marker.pattern.exec(haystack);
    if (match === null) continue;
    hits.push({ label: marker.label, match: match[0] });
  }
  return hits;
}
