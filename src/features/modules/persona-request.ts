import type { EntityKind } from '@/domain';
import { ENTITY_KINDS } from '@/domain';
import { withAdditionalInstruction } from '@/llm/additionalInstruction';
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
 * Cheap kind heuristic — INSTANT PLACEHOLDER ONLY (08 §M4-C): the real kind
 * comes from the generator's recorded `module.entityKinds`, or from a
 * one-shot classification call for hand-typed names. This regex never
 * persists anything; the popover kind is always user-confirmable.
 */
export function guessKindFromSentence(sentence: string): StubKind {
  const text = sentence.toLowerCase();
  if (/\b(at|in|inside|near|beneath|under|above|beyond|through)\b/.test(text)) {
    return 'location';
  }
  if (/\b(guild|order|court|cult|clan|company|syndicate|crew|government|council)\b/.test(text)) {
    return 'faction';
  }
  return 'npc';
}

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
 * The OWNERSHIP BOUNDARY for the NON-COMBAT kinds (docs/17 row 140): what a
 * location, an event or a faction detail owns, and what the encounter owns.
 *
 * WHY IT LIVES HERE AND NOT IN THE PERSONA TEXT. The rule is not new — the
 * Worldbuilder and Event Weaver built-in prompts have carried a version of it
 * since `fe1d365`, and `promptStyles.PARTS_MECHANICS` states it to the module
 * writer itself ("Encounters live in separate encounter artifacts … no monster
 * roster with counts, no tactics or terrain rules"). The persona layer cannot
 * carry it: personas are user-editable STORED rows seeded once by
 * `seed.seedBuiltInPersonas` / `personaRepo` (a slug that already exists is
 * never rewritten), so editing a built-in prompt reaches a NEW install only
 * and every existing install keeps the old bytes forever (docs/18 §4, docs/17
 * row 140). This seam is the ONE place every entity detail passes through —
 * the batch, post-generation's automation, the stub popover's single-entity
 * delegation and the change/refill seam all build their brief here — so the
 * rule is keyed by KIND, in code, and cannot be outrun by a stored row.
 *
 * WHY THE NON-COMBAT KINDS NEED IT AT ALL. A detail worker is handed every
 * paragraph of the module document that mentions the name
 * (`lib/wikilinks.surroundingParagraphs`), and a module's scene blocks are
 * written from the ENCOUNTER's point of view — `PART_SCENE_FIELD_LABELS`
 * ("Where", "If the party acts", "Secrets", "Outcome") are GM-facing field
 * labels and `Where` is instructed to link the location. Handed that text
 * together with "make this entity serve the module text", a location
 * elaborates the fight it reads about — including how to run it — which is the
 * owner's report verbatim: *"a few of the Location Details Detail the Mobs
 * that appear there and even give GM hints on how to handle the Encounter
 * there. Thats not what Location Details are for. We have Encounters for
 * that."* The context paragraphs are NOT filtered or shrunk to fix this (the
 * module text is the ground truth the worker reads); what changes is what the
 * entity OWNS.
 *
 * ONE FACT, ONE OWNER is the reason the paragraph states: the same fact
 * written in two artifacts is two accounts of one fight, and the encounter
 * artifact is the one a GM reads for it (`encounterDraftSchema` already holds
 * difficulty, levelHint, `monsters[]`, terrain, tactics, treasure and the
 * per-room layout — nothing is lost by stopping).
 *
 * Scoped to exactly the three kinds the report's class covers (`location`,
 * `event`, `faction`). `npc` legitimately owns stat blocks and `encounter`
 * owns the opposition, so both render `null` and their briefs stay
 * BYTE-IDENTICAL — as does every brief built without a kind. The Record is
 * EXHAUSTIVE over `StubKind`, so a new entity kind cannot be added without
 * deciding its boundary (the compiler refuses).
 */
const PLACE_OWNERSHIP_BOUNDARY = `What this artifact OWNS — one fact, one owner: the module prose draws this line itself ("encounters live in separate encounter artifacts"), so the OPPOSITION belongs to the encounter artifact — its creatures, their counts, its tactics and how the fight is run are that artifact's content, and that is where a GM gets them. If the story needs the opposition, point at where it is fought by the name the module text's own wiki-link uses instead of describing the opposition here, and write no tactics, no encounter-handling advice and no GM guidance on running the fight. "inhabitants" means the people and factions who are here — never monsters. And when the module text you are given is written from the encounter's point of view (fields such as "If the party acts", "Secrets" or "Outcome"), that material belongs to that encounter: do not restate it, do not extend it, and do not turn it into this artifact's own detail.`;

const FACTION_OWNERSHIP_BOUNDARY = `What this artifact OWNS — one fact, one owner: the module prose draws this line itself ("encounters live in separate encounter artifacts"), so the OPPOSITION belongs to the encounter artifact — its creatures, their counts, its tactics and how the fight is run are that artifact's content, and that is where a GM gets them. If the story needs the opposition, point at where it is fought by the name the module text's own wiki-link uses instead of describing the opposition here, and write no tactics, no encounter-handling advice and no GM guidance on running the fight. A faction row owns what this faction wants, how it operates, what it controls and how it is ranked — the "order of battle" the module text asks for is the encounter's material, so write no preferred tactics and no encounter-handling advice for it. And when the module text you are given is written from the encounter's point of view (fields such as "If the party acts", "Secrets" or "Outcome"), that material belongs to that encounter: do not restate it, do not extend it, and do not turn it into this artifact's own detail.`;

/**
 * ONE paragraph per kind, or `null` for the kinds that own their boundary.
 * `event` is not a copy of `location` by accident: its draft contract IS the
 * location's (`llm/schemas.eventDraftSchema = locationDraftSchema`) and its
 * built-in persona carries the mirrored clause, so the two share ONE constant
 * and cannot drift.
 */
const OWNERSHIP_BOUNDARY_BY_KIND: Readonly<Record<StubKind, string | null>> = {
  npc: null,
  encounter: null,
  note: null,
  location: PLACE_OWNERSHIP_BOUNDARY,
  event: PLACE_OWNERSHIP_BOUNDARY,
  faction: FACTION_OWNERSHIP_BOUNDARY,
};

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
 */
const INTENT_LABEL = "The module's author intended: ";

const INTENT_HIERARCHY =
  ' This steers EMPHASIS and OWNERSHIP; what the module text states is fixed, and your own charter still governs what this kind may contain.';

/**
 * The intent paragraph for one entity, or `null` when there is no intent — and
 * `null`, `undefined`, `''` and a whitespace-only note ALL mean no intent, so
 * none of them renders an empty paragraph and an entity without a note produces
 * the brief it produced before this field existed, BYTE FOR BYTE (the same
 * property `withAdditionalInstruction` has for an empty instruction).
 */
function intentParagraph(intent: string | null | undefined): string | null {
  const note = intent?.trim() ?? '';
  return note === '' ? null : `${INTENT_LABEL}${note}.${INTENT_HIERARCHY}`;
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
 * `kind` keys the OWNERSHIP BOUNDARY above (docs/17 row 140). The caller's
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
): string {
  const contextLabel = encounterScene
    ? 'The scene this encounter must stage — whatever it states about the opposition and the place is FIXED, and the roster and the map must match it:'
    : 'Where it is mentioned:';
  return withAdditionalInstruction(
    [
      `Detail the entity "${name}" for this module. It appears in the module text below — match it exactly by name.`,
      contextParagraphs === '' ? null : `${contextLabel}\n\n${contextParagraphs}`,
      premise === '' ? null : `Module premise for context:\n\n${premise}`,
      partyLevel === undefined ? null : partyLevelLine(partyLevel),
      fixedCastSectionFor(fixedCast),
      // The artifact is linked back from the module's wiki-link, which resolves
      // by exact name — the name field must be verbatim; epithets go in the body.
      `The artifact "name" field must be exactly "${name}" — verbatim, with no epithets, titles, or additions (put those in the body).`,
      'Do not invent unrelated sub-plots; make this entity serve the module text.',
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