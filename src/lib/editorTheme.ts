import { EditorView } from '@codemirror/view';

/** Theme tokens shared by plain text and markdown editors; no language extensions. */
export const editorThemeSpec = {
  '&': { backgroundColor: 'var(--card)', color: 'var(--card-foreground)' },
  '&.cm-focused': { outline: '1px solid var(--ring)' },
  '& .cm-content': { caretColor: 'var(--foreground)' },
  '& .cm-scroller': { fontFamily: 'var(--font-sans, inherit)', lineHeight: '1.7' },
  '& .cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'color-mix(in oklab, var(--primary) 22%, transparent)' },
  '& .cm-cursor, & .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '& .cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--muted) 45%, transparent)' },
  '& .cm-activeLineGutter': { backgroundColor: 'color-mix(in oklab, var(--muted) 45%, transparent)' },
};
export const plainEditorTheme = EditorView.theme(editorThemeSpec);
