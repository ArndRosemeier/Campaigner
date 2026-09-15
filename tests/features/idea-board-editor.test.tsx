import { readFileSync } from 'node:fs';

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { expect, it } from 'vitest';

import { ideaBoardEditorExtensions } from '@/features/idea-board/editor';

/**
 * The board's REAL editor wiring, mounted (docs/17 row 174, docs/21).
 *
 * `tests/features/idea-board.test.tsx` mocks CodeMirror to drive the page's
 * document semantics, so the extension set is never BUILT there — an extension
 * list that throws, or one that lost `history()` when `basicSetup` was turned
 * off, would reach the owner's browser with every test green. This file builds
 * the real `EditorView` from the SAME set the page passes.
 */
it('mounts the real board editor: labelled content and working undo', () => {
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: 'first', extensions: ideaBoardEditorExtensions }),
    parent,
  });
  try {
    // The content attributes reach the DOM — the accessibility label the page
    // test also looks the editor up by.
    expect(view.contentDOM.getAttribute('aria-label')).toBe('Idea Board document');

    // `history()` is in the set: an edit is undoable through the `undo` command
    // the page's Undo button dispatches. With `basicSetup` off, a set missing
    // `history()` would make that control a silent no-op.
    view.dispatch({ changes: { from: 5, insert: ' second' } });
    expect(view.state.doc.toString()).toBe('first second');
    undo(view);
    expect(view.state.doc.toString()).toBe('first');
  } finally {
    view.destroy();
  }
});

/**
 * Plain text is the FEATURE, so it is pinned at the source: a wiki chip or a
 * markdown parse would have to arrive through this file, and neither seam may
 * appear in it. (A rendered-DOM absence assertion was rejected deliberately:
 * CodeMirror builds decorations from the live VIEWPORT, which jsdom does not
 * lay out, so "no chip in the DOM" could pass for the wrong reason.)
 */
it('installs no markdown language and no wiki decoration', () => {
  const source = readFileSync('src/features/idea-board/editor.ts', 'utf8');
  expect(source).not.toContain('@codemirror/lang-markdown');
  expect(source).not.toContain('wikiDecorations');
  expect(source).not.toContain('wikiLinkDecorations');
  // Non-vacuity: the file really is the extension seam (a renamed or emptied
  // file would otherwise satisfy the absences above).
  expect(source).toContain('ideaBoardEditorExtensions');
  expect(source).toContain('history()');
});
