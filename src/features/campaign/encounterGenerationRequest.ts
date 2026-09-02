import { create } from 'zustand';

import type { Id } from '@/domain';

interface EncounterGenerationRequestState {
  artifactId: Id | null;
  /** True when the encounter already has a battlemap — the panel then words
   * the pre-filled brief as a regeneration instead of a first generation. */
  regenerate: boolean;
  requestedAt: number;
  request: (artifactId: Id, regenerate: boolean) => void;
  clear: () => void;
}

/** Editor → PersonaPanel request channel for encounter map generation. */
export const useEncounterGenerationRequest = create<EncounterGenerationRequestState>()((set) => ({
  artifactId: null,
  regenerate: false,
  requestedAt: 0,
  request: (artifactId, regenerate) => {
    set({ artifactId, regenerate, requestedAt: Date.now() });
  },
  clear: () => {
    set({ artifactId: null, regenerate: false, requestedAt: 0 });
  },
}));
