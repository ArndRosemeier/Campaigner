import type { EditorView } from '@codemirror/view';

/**
 * The one live canvas editor view (null when no canvas editor is mounted).
 * The canvas page's AI toolbar, decision bar and part-switch guard live
 * OUTSIDE the editor component and need the real CodeMirror view (selection
 * capture, proposal dispatches) — one current view per canvas page, the
 * board slice's page-owned-view precedent. The editor component publishes on
 * create and clears on unmount.
 */
export const activeCanvasView: { current: EditorView | null } = { current: null };
