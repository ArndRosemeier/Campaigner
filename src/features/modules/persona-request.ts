import type { EntityKind } from '@/domain';
import { ENTITY_KINDS } from '@/domain';
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
 */
export function buildEntityBrief(
  name: string,
  contextParagraphs: string,
  premise: string,
  partyLevel: number | undefined,
  fixedCast: readonly FixedCastMember[] = [],
  encounterScene = false,
): string {
  const contextLabel = encounterScene
    ? 'The scene this encounter must stage — whatever it states about the opposition and the place is FIXED, and the roster and the map must match it:'
    : 'Where it is mentioned:';
  return [
    `Detail the entity "${name}" for this module. It appears in the module text below — match it exactly by name.`,
    contextParagraphs === '' ? null : `${contextLabel}\n\n${contextParagraphs}`,
    premise === '' ? null : `Module premise for context:\n\n${premise}`,
    partyLevel === undefined ? null : partyLevelLine(partyLevel),
    fixedCastSectionFor(fixedCast),
    // The artifact is linked back from the module's wiki-link, which resolves
    // by exact name — the name field must be verbatim; epithets go in the body.
    `The artifact "name" field must be exactly "${name}" — verbatim, with no epithets, titles, or additions (put those in the body).`,
    'Do not invent unrelated sub-plots; make this entity serve the module text.',
  ]
    .filter((part) => part !== null)
    .join('\n\n');
}