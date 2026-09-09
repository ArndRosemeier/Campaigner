import { create } from 'zustand';

/**
 * Canvas PREVIEW toggle state (canvas v3, 08-MODULE-DESIGNER §Module
 * canvas): session-only zustand keyed per MODULE — same owner model as the
 * chat sidebar's `open` (dies on reload, resets when the canvas's module
 * changes). Deliberately NOT persisted (no zodPersistStorage): the preview
 * is a reading mode over the live doc, not a preference.
 */

interface CanvasPreviewState {
  ownerModuleId: string | null;
  openByModule: Record<string, boolean>;
  /** Clears the toggle when the canvas page's module changes (Board precedent). */
  resetFor: (moduleId: string) => void;
  setOpen: (moduleId: string, open: boolean) => void;
}

export const useCanvasPreviewStore = create<CanvasPreviewState>((set, get) => ({
  ownerModuleId: null,
  openByModule: {},
  resetFor: (moduleId) => {
    if (get().ownerModuleId === moduleId) return;
    set({ ownerModuleId: moduleId, openByModule: {} });
  },
  setOpen: (moduleId, open) => {
    set((state) => ({ openByModule: { ...state.openByModule, [moduleId]: open } }));
  },
}));
