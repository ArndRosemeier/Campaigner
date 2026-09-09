import { useEffect } from 'react';
import type { JSX } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { EditorView, keymap } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import type { AnyArtifact, Id } from '@/domain';
import { canvasTheme } from '@/features/modules/canvas/canvasTheme';
import { activeCanvasView } from '@/features/modules/canvas/canvasView';
import { wikiLinkDecorations } from '@/features/modules/canvas/wikiDecorations';
import {
  acceptSuggestionEffect,
  canvasShowPreviousField,
  canvasSuggestionField,
  invalidatedSuggestionIds,
  suggestionDecorations,
} from '@/features/modules/canvas/suggestions';

/**
 * The canvas markdown editor (08-MODULE-DESIGNER §Module canvas): ONE
 * CodeMirror 6 document per part — THE text-first substrate. The editor doc
 * string IS the markdown (byte-exact fidelity for [[wiki-links]], code and
 * tables by construction; there is NO parse→serialize round-trip anywhere).
 *
 * Extensions: GFM markdown (the default `markdownLanguage` dialect),
 * line wrapping, undo/redo history (the suggestion accept must ride ONE
 * history unit), wiki-link chip decorations (atomic ranges, reader-pool
 * coloring), and the suggestion machinery.
 *
 * The live view is published in `activeCanvasView` because the page's AI
 * toolbar, decision bar and guard live OUTSIDE this component and need the
 * real editor (selection capture, proposal dispatches) — the board slice's
 * page-owned-view precedent, one current view per canvas page.
 */

export interface CanvasEditorProps {
  /** Initial doc (the part's markdown) — the doc string is the truth. */
  initialMarkdown: string;
  artifacts: readonly AnyArtifact[];
  moduleId: Id | undefined;
  /** Doc string changed (every keystroke) — the page tracks dirty state. */
  onChange?: (doc: string) => void;
  /** Suggestion accepted through the in-editor Accept control (or Mod-y). */
  onSuggestionAccepted?: (id: string) => void;
  /** A suggestion was invalidated by typing inside its range. */
  onSuggestionInvalidated?: () => void;
  /** The suggestion field changed (propose/stream/accept/drop) — page mirror. */
  onSuggestionsChanged?: () => void;
}

export function CanvasEditor({
  initialMarkdown,
  artifacts,
  moduleId,
  onChange,
  onSuggestionAccepted,
  onSuggestionInvalidated,
  onSuggestionsChanged,
}: CanvasEditorProps): JSX.Element {
  useEffect(() => {
    return () => {
      activeCanvasView.current = null;
    };
  }, []);

  return (
    <div
      className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-card"
      data-testid="canvas-editor"
    >
      <CodeMirror
        value={initialMarkdown}
        height="100%"
        // 'none' disables the wrapper's default light chrome — the canvas
        // theme extension below owns ALL colors from the app's CSS vars
        // (owner report: the unthemed mount rendered a white slab).
        theme="none"
        style={{ height: '100%', fontSize: '0.9375rem' }}
        basicSetup={false}
        onCreateEditor={(view) => {
          activeCanvasView.current = view;
        }}
        extensions={[
          canvasTheme,
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown({ base: markdownLanguage }),
          EditorView.lineWrapping,
          // The suggestion + show-previous state fields MUST be registered
          // here — the decorations plugin reads them with a safe fallback,
          // so a missing field would silently render nothing.
          canvasSuggestionField,
          canvasShowPreviousField,
          wikiLinkDecorations(artifacts, moduleId),
          suggestionDecorations(),
          EditorView.updateListener.of((update) => {
            const accepted: string[] = [];
            for (const tr of update.transactions) {
              for (const effect of tr.effects) {
                if (effect.is(acceptSuggestionEffect)) accepted.push(effect.value);
              }
            }
            if (accepted.length > 0) {
              for (const id of accepted) onSuggestionAccepted?.(id);
            }
            if (
              update.startState.field(canvasSuggestionField, false) !==
              update.state.field(canvasSuggestionField, false)
            ) {
              onSuggestionsChanged?.();
            }
            if (invalidatedSuggestionIds(update).length > 0) {
              onSuggestionInvalidated?.();
            }
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChange?.(update.state.doc.toString());
          }),
        ]}
      />
    </div>
  );
}
