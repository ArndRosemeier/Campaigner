import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
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
export const canvasThemeSpec = {
  '&': {
    backgroundColor: 'var(--card)',
    color: 'var(--card-foreground)',
  },
  '&.cm-focused': {
    outline: '1px solid var(--ring)',
  },
  '& .cm-content': {
    caretColor: 'var(--foreground)',
  },
  '& .cm-scroller': {
    fontFamily: 'var(--font-sans, inherit)',
    lineHeight: '1.7',
  },
  '& .cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'color-mix(in oklab, var(--primary) 22%, transparent)',
  },
  '& .cm-cursor, & .cm-dropCursor': {
    borderLeftColor: 'var(--foreground)',
  },
  '& .cm-activeLine': {
    backgroundColor: 'color-mix(in oklab, var(--muted) 45%, transparent)',
  },
  '& .cm-activeLineGutter': {
    backgroundColor: 'color-mix(in oklab, var(--muted) 45%, transparent)',
  },
};

/** Markdown highlighting on app tokens — restrained, theme-following. */
export const canvasHighlightStyle = HighlightStyle.define([
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

/** The full theme extension wired into the canvas editor. */
export const canvasTheme = [
  EditorView.theme(canvasThemeSpec),
  syntaxHighlighting(canvasHighlightStyle),
];
