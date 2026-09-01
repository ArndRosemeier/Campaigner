import { create } from 'zustand';

import type { ArtifactKind, EntityKind, Id } from '@/domain';
import { ENTITY_KINDS } from '@/domain';

/**
 * "Generate with persona" request bridge (08-MODULE-DESIGNER M4-C): the
 * module reader asks the workspace persona panel for a prefilled run — the
 * panel lives on another route, so the request rides a zustand store
 * (mirrors the illustration-request pattern). The normal run pipeline, with
 * its autonomy setting, does the rest; the panel stamps the produced
 * artifact with `moduleTag` on finalize.
 */

export interface PersonaBriefRequest {
  /** Preferred persona slug ('npc-smith'…), resolved when personas load. */
  personaSlug: string;
  /** Stub kind of the entity (fallback persona match by producesKind). */
  kind: StubKind;
  /** The fully built brief (link name + context paragraphs + premise). */
  brief: string;
  /** Tag stamped on the produced artifact, e.g. `module:<title>`. */
  moduleTag: string;
  /** Campaign the run must start in (guard against stale requests). */
  campaignId: Id;
  /** Bumped on every request so repeat requests re-trigger the effect. */
  requestedAt: number;
}

interface PersonaRequestStore {
  request: PersonaBriefRequest | null;
  requestPersona: (request: Omit<PersonaBriefRequest, 'requestedAt'>) => void;
  clear: () => void;
}

export const usePersonaBriefRequest = create<PersonaRequestStore>((set) => ({
  request: null,
  requestPersona: (request) => {
    set({ request: { ...request, requestedAt: Date.now() } });
  },
  clear: () => {
    set({ request: null });
  },
}));

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
    'Do not invent unrelated sub-plots; make this entity serve the module text.',
  ]
    .filter((part) => part !== null)
    .join('\n\n');
}

/** `ArtifactKind` narrowing for the stub kinds (stub ⊂ artifact kinds). */
export function asStubKind(kind: ArtifactKind): StubKind | undefined {
  return (STUB_KINDS as readonly string[]).includes(kind) ? (kind as StubKind) : undefined;
}