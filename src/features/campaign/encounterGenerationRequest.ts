import { create } from 'zustand';

import type { Id } from '@/domain';

/** Which AI pass the editor asked for. */
export type EncounterGenerationVariant = 'map' | 'content';

interface EncounterGenerationRequestState {
  artifactId: Id | null;
  /** True when the encounter already has the thing being generated — the
   * panel then words the pre-filled brief as a regeneration. */
  regenerate: boolean;
  /** 'map' → Encounter Cartographer (layout + battlemap); 'content' →
   * Encounter Smith (roster, terrain, tactics, treasure, prose). */
  variant: EncounterGenerationVariant;
  requestedAt: number;
  request: (artifactId: Id, regenerate: boolean, variant?: EncounterGenerationVariant) => void;
  clear: () => void;
}

/** Editor → PersonaPanel request channel for encounter AI generation. */
export const useEncounterGenerationRequest = create<EncounterGenerationRequestState>()((set) => ({
  artifactId: null,
  regenerate: false,
  variant: 'map',
  requestedAt: 0,
  request: (artifactId, regenerate, variant = 'map') => {
    set({ artifactId, regenerate, variant, requestedAt: Date.now() });
  },
  clear: () => {
    set({ artifactId: null, regenerate: false, variant: 'map', requestedAt: 0 });
  },
}));
