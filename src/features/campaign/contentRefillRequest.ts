import { create } from 'zustand';

import { ARTIFACT_KIND_SINGULAR, type ArtifactKind, type Id } from '@/domain';

/**
 * The app's own framing for a refill of `kind` (docs/17 rows 287/288). It is a
 * PURE function of the kind and whether the artifact already has a body — the
 * two facts the hand-off already carries — so the panel DERIVES it at
 * `start()` from the target on screen rather than remembering a copy that can
 * drift from the target it names. It lives HERE, beside the request channel
 * whose `kind`/`regenerate` it reads, so the sentence has ONE home and the
 * panel's pins can assert the derivation through it.
 */
export function refillBrief(kind: ArtifactKind, regenerate: boolean): string {
  const noun = ARTIFACT_KIND_SINGULAR[kind].toLowerCase();
  return regenerate
    ? `Regenerate the full content of this ${noun} — summary, body and details. Its name, relations and images are preserved.`
    : `Generate the full content of this ${noun}: summary, body and details. Its name, relations and images are preserved.`;
}

interface ContentRefillRequestState {
  artifactId: Id | null;
  /** The artifact's kind — the panel selects the smith persona producing it. */
  kind: ArtifactKind | null;
  /** True when the artifact already has body content. The panel DERIVES the
   * framing from the target it is about to run against (`refillBrief`), so
   * this stays the editor's record of WHY it asked, never the panel's source
   * for the wording (docs/17 row 288). */
  regenerate: boolean;
  requestedAt: number;
  request: (artifactId: Id, kind: ArtifactKind, regenerate: boolean) => void;
  clear: () => void;
}

/**
 * Editor → PersonaPanel request channel for in-place AI refills (the
 * counterpart of `useEncounterGenerationRequest`): a targeted GENERATE run
 * that writes summary, body and the draft's details INTO the existing
 * artifact, preserving its identity (docs/08 §M4-C stub section: "the
 * artifact editor fills it with AI later").
 */
export const useContentRefillRequest = create<ContentRefillRequestState>()((set) => ({
  artifactId: null,
  kind: null,
  regenerate: false,
  requestedAt: 0,
  request: (artifactId, kind, regenerate) => {
    set({ artifactId, kind, regenerate, requestedAt: Date.now() });
  },
  clear: () => {
    set({ artifactId: null, kind: null, regenerate: false, requestedAt: 0 });
  },
}));
