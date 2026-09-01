import type { ArtifactKind, EntityKind } from '@/domain';
import { ENTITY_KINDS } from '@/domain';

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
  faction: 'faction-designer',
  note: 'plot-architect',
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
 * The brief for "Generate with persona" (08 §M4-C): link name + the
 * paragraphs surrounding its occurrences (cap ~1200 chars) + module premise.
 * No numeric entity quotas — the persona details exactly this one entity.
 */
export function buildEntityBrief(
  name: string,
  contextParagraphs: string,
  premise: string,
): string {
  return [
    `Detail the entity "${name}" for this module. It appears in the module text below — match it exactly by name.`,
    contextParagraphs === '' ? null : `Where it is mentioned:\n\n${contextParagraphs}`,
    premise === '' ? null : `Module premise for context:\n\n${premise}`,
    // The artifact is linked back from the module's wiki-link, which resolves
    // by exact name — the name field must be verbatim; epithets go in the body.
    `The artifact "name" field must be exactly "${name}" — verbatim, with no epithets, titles, or additions (put those in the body).`,
    'Do not invent unrelated sub-plots; make this entity serve the module text.',
  ]
    .filter((part) => part !== null)
    .join('\n\n');
}

/** `ArtifactKind` narrowing for the stub kinds (stub ⊂ artifact kinds). */
export function asStubKind(kind: ArtifactKind): StubKind | undefined {
  return (STUB_KINDS as readonly string[]).includes(kind) ? (kind as StubKind) : undefined;
}