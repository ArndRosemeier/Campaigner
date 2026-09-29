import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { plainEditorTheme } from '@/lib/editorTheme';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/**
 * Canvas editor theme (owner report: the unthemed CM6 mount rendered its
 * default light chrome — a white slab inside the themed page). EVERYTHING
 * here is a CSS custom property, so the editor follows the app theme in
 * light AND dark with zero JS: the same mechanism wikiDecorations already
 * uses for the chips. Exported as a plain spec so tests can pin the tokens
 * (jsdom computes no styles).
 */
export { editorThemeSpec as canvasThemeSpec } from '@/lib/editorTheme';

/** Markdown highlighting on app tokens — restrained, theme-following. */
export const canvasHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700', fontSize: '1.5em', color: 'var(--foreground)' },
  { tag: t.heading2, fontWeight: '700', fontSize: '1.3em', color: 'var(--foreground)' },
  { tag: t.heading3, fontWeight: '650', fontSize: '1.15em', color: 'var(--foreground)' },
  { tag: t.heading, fontWeight: '650', color: 'var(--foreground)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.monospace, backgroundColor: 'var(--muted)', color: 'var(--card-foreground)' },
  { tag: t.link, color: 'var(--primary)', textDecoration: 'underline' },
  { tag: t.url, color: 'var(--muted-foreground)' },
  { tag: t.quote, color: 'var(--muted-foreground)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--foreground)' },
]);

/** Level-divider band (see `levelDividerDecorations`) — tokens only. */
const canvasDividerTheme = EditorView.theme({
  '& .cm-level-divider': {
    color: 'var(--muted-foreground)',
    backgroundColor: 'color-mix(in oklab, var(--muted) 60%, transparent)',
    borderTop: '1px solid var(--border)',
    fontSize: '0.8125rem',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    marginTop: '0.75rem',
  },
});

/** The full theme extension wired into the canvas editor. */
export const canvasTheme = [
  plainEditorTheme,
  canvasDividerTheme,
  syntaxHighlighting(canvasHighlightStyle),
];
