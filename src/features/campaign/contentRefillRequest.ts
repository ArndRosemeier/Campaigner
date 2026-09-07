import { create } from 'zustand';

import type { ArtifactKind, Id } from '@/domain';

interface ContentRefillRequestState {
  artifactId: Id | null;
  /** The artifact's kind — the panel selects the smith persona producing it. */
  kind: ArtifactKind | null;
  /** True when the artifact already has body content — the panel words the
   * pre-filled brief as a regeneration. */
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
