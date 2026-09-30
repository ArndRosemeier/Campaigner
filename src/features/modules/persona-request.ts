import type { EntityKind } from '@/domain';
import { ENTITY_KINDS } from '@/domain';
import { withAdditionalInstruction } from '@/llm/additionalInstruction';
import {
  ENTITY_BRIEF_INTRO_PREFIX,
  ENTITY_BRIEF_INTRO_SUFFIX,
  ENTITY_CONTEXT_LABEL,
  ENTITY_LEVEL_HINT_HIERARCHY,
  ENTITY_LEVEL_HINT_LABEL,
  ENTITY_NAME_VERBATIM_PREFIX,
  ENTITY_NAME_VERBATIM_SUFFIX,
  ENTITY_SCENE_CONTEXT_LABEL,
  ENTITY_SERVE_MODULE_TEXT,
  INTENT_HIERARCHY,
  INTENT_LABEL,
  MODULE_PREMISE_LABEL,
  OWNERSHIP_BOUNDARY_BY_KIND,
} from '@/llm/promptScaffolding';
import { fixedCastSectionFor, partyLevelLine, type FixedCastMember } from '@/llm/roomBudget';

/**
 * Stub-kind constants and brief builders for the entity workflow
 * (08-MODULE-DESIGNER M4-C). Single-entity generation itself lives in
 * `entity-detail.ts` (in place, shared progress bar); the batch lives in the
 * entity panel.
 */

/** Stub-able kinds — the entity kinds the generator records (08 §M4-C). */
export const STUB_KINDS = ENTITY_KINDS;
export type StubKind = EntityKind;

export const STUB_PERSONA_SLUGS: Readonly<Record<StubKind, string>> = {
  npc: 'npc-smith',
  location: 'worldbuilder',
  event: 'event-weaver',
  faction: 'faction-designer',
  note: 'plot-architect',
  encounter: 'encounter-smith',
};

/**
 * Stub kinds whose drafts carry the structured level context (docs/11):
 * encounters AND npcs. The npc kind covers NPCs and monsters alike (mob
 * artifacts are npc rows; the Smith details both) — a level-6 NPC drafted
 * for a level-1 part is caught at the source instead of ambushing the
 * encounter that features them. Every other stub kind has no level
 * semantics and stays byte-identical.
 */
export function stubKindCarriesPartyLevel(kind: StubKind): boolean {
  return kind === 'encounter' || kind === 'npc';
}

/**
 * The OWNERSHIP BOUNDARY itself, and every fixed sentence this brief is made
 * of, now live in `llm/promptScaffolding` — the ONE source the composer and the
 * scaffolding-echo detector both read (docs/17 row 142, AGENTS rule 4). The
 * boundaries' rendered bytes are unchanged (docs/17 row 140; the 14 pins in
 * `tests/llm/kindOwnershipBoundary.test.ts` are untouched): the constants moved,
 * nothing about their text did.
 *
 * WHY THE RECORD IS KEYED BY KIND AT ALL (row 140): a detail worker is handed
 * every paragraph of the module document that mentions the name
 * (`lib/wikilinks.surroundingParagraphs`), and a module's scene blocks are
 * written from the ENCOUNTER's point of view — `PART_SCENE_FIELD_LABELS`
 * ("Where", "If the party acts", "Secrets", "Outcome") are GM-facing field
 * labels and `Where` is instructed to link the location. Handed that text
 * together with "make this entity serve the module text", a location
 * elaborates the fight it reads about — including how to run it — which is the
 * owner's report verbatim: *"a few of the Location Details Detail the Mobs
 * that appear there and even give GM hints on how to handle the Encounter
 * there. Thats not what Location Details are for. We have Encounters for
 * that."* The context paragraphs are NOT filtered or shrunk (the module text is
 * the ground truth the worker reads); what the paragraph changes is what the
 * entity OWNS. The Record is EXHAUSTIVE over the entity kinds, so a new kind
 * cannot be added without deciding its boundary (the compiler refuses).
 *
 * WHY IT CANNOT LIVE IN THE PERSONA TEXT: personas are user-editable STORED
 * rows seeded once (`seed.seedBuiltInPersonas` / `personaRepo` — a slug that
 * already exists is never rewritten), so editing a built-in prompt reaches a
 * NEW install only (docs/18 §4, docs/17 row 140).
 */

/**
 * The intent paragraph for one entity, or `null` when there is no intent — and
 * `null`, `undefined`, `''` and a whitespace-only note ALL mean no intent, so
 * none of them renders an empty paragraph and an entity without a note produces
 * the brief it produced before this field existed, BYTE FOR BYTE (the same
 * property `withAdditionalInstruction` has for an empty instruction).
 *
 * Its two literals live in `llm/promptScaffolding` (docs/17 row 145) so the
 * scaffolding-echo detector can read the SAME bytes from the SAME seam; the
 * composed paragraph is byte-identical to the one this module built before the
 * move. The paragraph's WHY stayed with the constants.
 */
function intentParagraph(intent: string | null | undefined): string | null {
  const note = intent?.trim() ?? '';
  return note === '' ? null : `${INTENT_LABEL}${note}.${INTENT_HIERARCHY}`;
}

/**
 * The level-hint paragraph (owner request, docs/17 row 197), or `null` when the
 * module recorded no level for this entity — and `null`/`undefined` BOTH render
 * nothing, so an entity without a hint produces the brief it produced before
 * this field existed, BYTE FOR BYTE (the compatibility property this whole slice
 * pins). Its two literals live in `llm/promptScaffolding` so the
 * scaffolding-echo detector reads the SAME bytes the composer renders.
 */
function levelHintParagraph(levelHint: number | null | undefined): string | null {
  return levelHint === null || levelHint === undefined
    ? null
    : `${ENTITY_LEVEL_HINT_LABEL}${String(levelHint)}.${ENTITY_LEVEL_HINT_HIERARCHY}`;
}

/**
 * The brief for "Generate with persona" (08 §M4-C): link name + the
 * paragraphs surrounding its occurrences (cap ~1200 chars) + module premise.
 * No numeric entity quotas — the persona details exactly this one entity.
 *
 * `partyLevel` carries the structured level context (docs/11) for encounter
 * and npc drafts: the referencing part's exact level, resolved by the caller
 * with `partLevelForMention` at the same mention position `contextParagraphs`
 * was excerpted from. When defined, the brief states the party as
 * `partyLevelLine(partyLevel)`; when undefined the brief is byte-identical
 * to the level-free form (other stub kinds never pass one).
 *
 * `fixedCast` carries the encounter's fixed cast (docs/11, encounter stubs
 * only): already-drafted NPCs/monsters whose mentions share the encounter's
 * scene context, with the must-appear instruction. Empty (the default)
 * renders nothing, so every non-encounter brief stays byte-identical.
 *
 * `encounterScene` is the ASSERTION RULE's brief-side framing (docs/11, docs/17
 * row 89), set true by the encounter path in `entity-batch.ts` and false
 * everywhere else: for an encounter the surrounding text is not background it
 * merely happens near, it is THE SCENE THIS ENCOUNTER MUST STAGE — fixed in
 * whatever it states about the opposition and the place. The label is the whole
 * change: every non-encounter brief renders the same bytes as before, pinned by
 * `tests/features/persona-request.test.ts`.
 *
 * `kind` keys the OWNERSHIP BOUNDARY (`llm/promptScaffolding`, docs/17 row
 * 140). The caller's
 * entity kind is the only thing that decides it: `location`, `event` and
 * `faction` briefs carry the boundary paragraph last; `npc`, `encounter` and
 * `note` — and every brief built with no kind at all — render the
 * pre-boundary bytes EXACTLY (one slot in one `.filter`, nothing else about
 * the brief moves), pinned by `tests/features/persona-request.test.ts`.
 *
 * `instruction` is the change seam's free-text request (docs/17 row 101,
 * `features/modules/change-artifact`): it is appended as its own final
 * paragraph in the ONE `Additional instruction: …` form
 * (`llm/additionalInstruction`) and NOTHING ELSE about the brief moves — an
 * empty instruction returns the brief BYTE-IDENTICAL, so every existing
 * generation, batch and automation pins the bytes it always did. The
 * instruction only ever ADDS a paragraph: the name-verbatim rule below and the
 * rest of the charter still govern, and a reply that violates them fails loud.
 *
 * `intent` is the module author's recorded note about what this entity is FOR
 * (docs/17 row 141), read off the module's entity RECORD by the CALLER through
 * `domain/module.entityIntentFor` — the ONE read of that field — and rendered
 * as its own paragraph immediately BEFORE the `Additional instruction: …` one,
 * after the ownership boundary. Absent/`null`/`''` render NOTHING and leave the
 * brief byte-identical, pinned by `tests/features/persona-request.test.ts` and
 * `tests/llm/kindOwnershipBoundary.test.ts` as they stood before this field.
 *
 * `levelHint` is the module author's recorded LEVEL for this entity (owner
 * request, docs/17 row 197), read off the SAME record by the caller through
 * `domain/module.entityLevelHintFor`. It renders its own paragraph immediately
 * AFTER the party-level line (so its "overrides the party level above" sentence
 * reads true) and `null`/`undefined` render NOTHING — a module with no hints
 * produces the pre-field brief BYTE FOR BYTE, which is the compatibility pin.
 */
export function buildEntityBrief(
  name: string,
  contextParagraphs: string,
  premise: string,
  partyLevel: number | undefined,
  fixedCast: readonly FixedCastMember[] = [],
  encounterScene = false,
  kind?: StubKind,
  instruction = '',
  intent: string | null | undefined = null,
  levelHint: number | null | undefined = null,
): string {
  const contextLabel = encounterScene ? ENTITY_SCENE_CONTEXT_LABEL : ENTITY_CONTEXT_LABEL;
  return withAdditionalInstruction(
    [
      `${ENTITY_BRIEF_INTRO_PREFIX}${name}${ENTITY_BRIEF_INTRO_SUFFIX}`,
      contextParagraphs === '' ? null : `${contextLabel}\n\n${contextParagraphs}`,
      premise === '' ? null : `${MODULE_PREMISE_LABEL}\n\n${premise}`,
      partyLevel === undefined ? null : partyLevelLine(partyLevel),
      // Immediately after the party level, whose override it states (docs/17
      // row 197). Rendered for every kind that passes one; `null` renders
      // nothing, so a no-hint brief is byte-identical to the pre-field one.
      levelHintParagraph(levelHint),
      fixedCastSectionFor(fixedCast),
      // The artifact is linked back from the module's wiki-link, which resolves
      // by exact name — the name field must be verbatim; epithets go in the body.
      `${ENTITY_NAME_VERBATIM_PREFIX}${name}${ENTITY_NAME_VERBATIM_SUFFIX}`,
      ENTITY_SERVE_MODULE_TEXT,
      // LAST, so the boundary reads as the qualification of everything above
      // it — including that "serve the module text" line, which is the
      // instruction a location otherwise obeys by retelling the fight it was
      // handed (docs/17 row 140).
      kind === undefined ? null : OWNERSHIP_BOUNDARY_BY_KIND[kind],
      // The author's own note LAST of the body — immediately before the
      // transient `Additional instruction: …` paragraph the seam below appends,
      // and AFTER the boundary so the boundary still closes the charter it
      // qualifies (docs/17 rows 140/141).
      intentParagraph(intent),
    ]
      .filter((part) => part !== null)
      .join('\n\n'),
    instruction,
  );
}