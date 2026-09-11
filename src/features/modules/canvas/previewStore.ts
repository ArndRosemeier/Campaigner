import { create } from 'zustand';

/**
 * Canvas PREVIEW toggle state (canvas v3, 08-MODULE-DESIGNER §Module
 * canvas): session-only zustand keyed per MODULE — same owner model as the
 * chat sidebar's `open` (dies on reload, resets when the canvas's module
 * changes). Deliberately NOT persisted (no zodPersistStorage): the preview
 * is a reading mode over the live doc, not a preference.
 *
 * It ALSO holds the last PREVIEW SELECTION the owner made (docs/17 row 102):
 * the canvas AI actions read their target from an EXPLICIT input, and in the
 * preview that input is a rendered DOM selection — captured where it is made
 * (the preview pane) and consumed where the action is confirmed (the page's
 * instruction dialog). Reasons this is session state rather than a prop:
 * - a click on the header's button collapses the browser selection, so the
 *   capture has to survive the click that consumes it;
 * - the dialog must state the SAME text it captured, so the capture carries
 *   the document string it was made against (a selection is only meaningful
 *   for the document it was made in);
 * - like `openByModule`, it is per module and dies with the page.
 */

/**
 * What the preview captured from the browser selection. `mapped` carries
 * WHOLE-DOCUMENT offsets (the page applies edits to the whole-document
 * snapshot); `refused` carries the NAMED reason the selection cannot be
 * mapped byte-exactly — a value, never a guess, and never a write.
 */
export type PreviewSelectionCapture =
  | { kind: 'mapped'; planIndex: number; from: number; to: number; doc: string }
  | { kind: 'refused'; reason: string; doc: string };

interface CanvasPreviewState {
  ownerModuleId: string | null;
  openByModule: Record<string, boolean>;
  selectionByModule: Record<string, PreviewSelectionCapture | null>;
  /** Clears the toggle when the canvas page's module changes (Board precedent). */
  resetFor: (moduleId: string) => void;
  setOpen: (moduleId: string, open: boolean) => void;
  setSelection: (moduleId: string, selection: PreviewSelectionCapture | null) => void;
}

export const useCanvasPreviewStore = create<CanvasPreviewState>((set, get) => ({
  ownerModuleId: null,
  openByModule: {},
  selectionByModule: {},
  resetFor: (moduleId) => {
    if (get().ownerModuleId === moduleId) return;
    set({ ownerModuleId: moduleId, openByModule: {}, selectionByModule: {} });
  },
  setOpen: (moduleId, open) => {
    set((state) => ({ openByModule: { ...state.openByModule, [moduleId]: open } }));
  },
  setSelection: (moduleId, selection) => {
    set((state) => ({ selectionByModule: { ...state.selectionByModule, [moduleId]: selection } }));
  },
}));
