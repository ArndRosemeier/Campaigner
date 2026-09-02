import { create } from 'zustand';

/**
 * Open-state of the app-wide Ctrl+K quick-find palette.
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
