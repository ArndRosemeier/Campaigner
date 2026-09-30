import type { EditorView } from '@codemirror/view';

/**
 * The one live canvas editor view (null when no canvas editor is mounted).
 * The canvas page's AI toolbar, decision bar and leave-guard live OUTSIDE
 * the editor component and need the real CodeMirror view (selection capture,
 * proposal dispatches) — one current view per canvas page, the board slice's
 * page-owned-view precedent. The editor component publishes on create and
 * clears on unmount.
 */
export const activeCanvasView: { current: EditorView | null } = { current: null };

/**
 * The last deep-link SCROLL the canvas page requested (canvas v3: `?part=`
 * and `#part-<n>` are scroll targets, not scopes). `top` = scroll to the
 * document start (the `premise` target and the no-target default); `doc` =
 * scroll the editor to the whole-document offset of a part's section. The
 * actual scrolling is CodeMirror's (`EditorView.scrollIntoView`); this
 * published ref is the test/debug surface for the resolution semantics.
 */
export const lastCanvasScroll: { current: { target: 'top' | 'doc'; offset: number } | null } = {
  current: null,
};
