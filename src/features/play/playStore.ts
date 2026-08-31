import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';

import type { Id } from '@/domain';
import { zodPersistStorage } from '@/lib/persisted';

/**
 * Session Mode (play view) state (07-MILESTONE-3 M3-C): focus artifact and
 * its breadcrumb history, active session, rail collapse. Device-local
 * ephemera — persisted per campaign in localStorage (zustand persist with a
 * zod-validated envelope), NOT Dexie.
 */

const PLAY_STORAGE_KEY = 'campaigner.play-state';

const playStateSchema = z.object({
  focusArtifactId: z.string().nullable(),
  focusHistory: z.array(z.string()),
  activeSessionId: z.string().nullable(),
  railCollapsed: z.boolean(),
});

export type PlayState = z.infer<typeof playStateSchema>;

const persistedSchema = z.object({
  byCampaign: z.record(z.string(), playStateSchema),
});

const EMPTY: PlayState = {
  focusArtifactId: null,
  focusHistory: [],
  activeSessionId: null,
  railCollapsed: false,
};

interface PlayStore extends z.infer<typeof persistedSchema> {
  /** Sets a new focus, pushing the previous one onto the history trail. */
  setFocus: (campaignId: Id, artifactId: Id) => void;
  /** Jumps back to a previous focus (removes newer trail entries). */
  backTo: (campaignId: Id, artifactId: Id) => void;
  setActiveSession: (campaignId: Id, sessionId: Id | null) => void;
  toggleRail: (campaignId: Id) => void;
  stateOf: (campaignId: Id) => PlayState;
}

export const usePlayStore = create<PlayStore>()(
  persist(
    (set, get) => ({
      byCampaign: {},
      setFocus: (campaignId, artifactId) => {
        set((state) => {
          const current = state.byCampaign[campaignId] ?? EMPTY;
          if (current.focusArtifactId === artifactId) return state;
          return {
            byCampaign: {
              ...state.byCampaign,
              [campaignId]: {
                ...current,
                focusArtifactId: artifactId,
                // Newest first, capped trail of recent foci.
                focusHistory: current.focusArtifactId === null
                  ? current.focusHistory
                  : [current.focusArtifactId, ...current.focusHistory].slice(0, 5),
              },
            },
          };
        });
      },
      backTo: (campaignId, artifactId) => {
        set((state) => {
          const current = state.byCampaign[campaignId] ?? EMPTY;
          return {
            byCampaign: {
              ...state.byCampaign,
              [campaignId]: {
                ...current,
                focusArtifactId: artifactId,
                focusHistory: current.focusHistory.filter((id) => id !== artifactId),
              },
            },
          };
        });
      },
      setActiveSession: (campaignId, sessionId) => {
        set((state) => {
          const current = state.byCampaign[campaignId] ?? EMPTY;
          return {
            byCampaign: {
              ...state.byCampaign,
              [campaignId]: { ...current, activeSessionId: sessionId },
            },
          };
        });
      },
      toggleRail: (campaignId) => {
        set((state) => {
          const current = state.byCampaign[campaignId] ?? EMPTY;
          return {
            byCampaign: {
              ...state.byCampaign,
              [campaignId]: { ...current, railCollapsed: !current.railCollapsed },
            },
          };
        });
      },
      stateOf: (campaignId) => get().byCampaign[campaignId] ?? EMPTY,
    }),
    {
      name: PLAY_STORAGE_KEY,
      storage: zodPersistStorage(persistedSchema),
      partialize: (state) => ({ byCampaign: state.byCampaign }),
    },
  ),
);
