import { create } from 'zustand';

import type { Id } from '@/domain';

interface EncounterGenerationRequestState {
  artifactId: Id | null;
  requestedAt: number;
  request: (artifactId: Id) => void;
  clear: () => void;
}

/** Editor → PersonaPanel request channel for encounter regeneration. */
export const useEncounterGenerationRequest = create<EncounterGenerationRequestState>()((set) => ({
  artifactId: null,
  requestedAt: 0,
  request: (artifactId) => {
    set({ artifactId, requestedAt: Date.now() });
  },
  clear: () => {
    set({ artifactId: null, requestedAt: 0 });
  },
}));
