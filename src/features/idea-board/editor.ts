import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { EditorView, keymap } from '@codemirror/view';

import { plainEditorTheme } from '@/lib/editorTheme';

/**
 * The Idea Board editor's ONE extension set (`docs/21-IDEA-BOARD.md`): plain
 * text, on the app's theme, with real undo.
 *
 * Plain text is the feature: there is NO markdown language extension and NO
 * wiki-link decoration, so a `[[token]]` the owner types stays the literal
 * characters they typed (the whole difference from the module canvas).
 *
 * @uiw's `basicSetup` is OFF and its pieces are listed explicitly, the way
 * `canvasEditor.tsx` wires the module canvas. Two reasons that matter:
 *
 * - the colors are owned by ONE layer (`lib/editorTheme.plainEditorTheme`,
 *   every value a CSS custom property), so the board follows the app theme in
 *   light and dark with no JS — `basicSetup` would also apply CodeMirror's own
 *   default highlight style, a second color authority;
 * - `history()` must be present because the page's Undo/Redo controls call the
 *   `undo`/`redo` commands against this exact view; turning `basicSetup` off
 *   removes the history and keymaps it used to supply, so they are listed here.
 */
export const ideaBoardEditorExtensions = [
  plainEditorTheme,
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({ 'aria-label': 'Idea Board document' }),
];
