import { create } from 'zustand';

import type { OnboardingStepId } from '@/domain';

/**
 * App-wide setup-wizard dialog state (mounted once in the AppShell, like the
 * help dialog). Any surface can open it via `openWizard()` — the first-run
 * auto-open, the campaign picker header, the workspace welcome panel and the
 * help 'setup' topic all funnel through here.
 */
interface OnboardingStore {
  open: boolean;
  /** Step the dialog expands on open; null = the first unresolved step. */
  focusStep: OnboardingStepId | null;
  openWizard: (focus?: OnboardingStepId) => void;
  closeWizard: () => void;
}

export const useOnboardingStore = create<OnboardingStore>((set) => ({
  open: false,
  focusStep: null,
  openWizard: (focus) => {
    set((state) => ({
      open: true,
      // An explicit focus always wins; a focusless open on an ALREADY open
      // wizard keeps the current focus (the first-run auto-open must not
      // clobber a re-open affordance that landed first).
      focusStep: focus ?? (state.open ? state.focusStep : null),
    }));
  },
  closeWizard: () => {
    set({ open: false, focusStep: null });
  },
}));
