import { create } from 'zustand';

/**
 * Open-state of the Ctrl+K quick-find palette (M3-C): shared between the
 * AppShell hotkey and the Play page's "Set focus…" button so both open the
 * same dialog instance.
 */
interface QuickFindStore {
  open: boolean;
  openQuickFind: () => void;
  close: () => void;
}

export const useQuickFindStore = create<QuickFindStore>((set) => ({
  open: false,
  openQuickFind: () => {
    set({ open: true });
  },
  close: () => {
    set({ open: false });
  },
}));
