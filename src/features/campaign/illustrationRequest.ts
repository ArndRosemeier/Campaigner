import { create } from 'zustand';

import type { Id } from '@/domain';

/**
 * Cross-component request channel for the Illustrator persona (M3-A): the
 * artifact editor's "Illustrate…" button raises a request; the persona panel
 * consumes it (selects the Illustrator, targets the artifact, focuses the
 * Assistant tab) and clears it.
 */
interface IllustrationRequestState {
  artifactId: Id | null;
  /** Monotonic bump so repeated requests for the same artifact re-trigger. */
  requestedAt: number;
  request: (artifactId: Id) => void;
  clear: () => void;
}

export const useIllustrationRequest = create<IllustrationRequestState>()((set) => ({
  artifactId: null,
  requestedAt: 0,
  request: (artifactId) => {
    set({ artifactId, requestedAt: Date.now() });
  },
  clear: () => {
    set({ artifactId: null, requestedAt: 0 });
  },
}));
