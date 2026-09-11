import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { JSX } from 'react';
import { TriangleAlertIcon } from 'lucide-react';

import { WriterModelId } from '@/components/writer-model-id';
import type { AnyArtifact, Id, Module } from '@/domain';
import {
  splitPartsDocument,
  ModulePartsDocumentError,
  type ModulePartsSection,
} from '@/domain/modulePartsDocument';
import {
  resolveSelectionRange,
  WikiMarkdown,
} from '@/features/campaign/components/wiki-markdown';
import type { PreviewSelectionCapture } from '@/features/modules/canvas/previewStore';

/**
 * The canvas PREVIEW (canvas v3, 08-MODULE-DESIGNER §Module canvas): the
 * whole-document editor rendered as the READER sees it — the
 * `==========`/label scaffolding is editor chrome and is stripped here; each
 * part's text renders through the shared `WikiMarkdown` (the reader's exact
 * renderer, reader parity by construction) with the reader pool and
 * clickable entity chips (`onOpenArtifact` → the peek modal).
 *
 * The preview renders the document AS OF THE TOGGLE (v1: while it is open
 * the editor is hidden and every writing surface is disabled, so the doc
 * cannot drift — EXCEPT the chat, which stays live in preview and applies
 * to the snapshot string the preview renders from). A doc whose scaffolding
 * no longer parses shows the splitter's loud reason instead of a silent
 * best-effort render (AGENTS 1).
 *
 * SELECTION → SOURCE (docs/17 row 102): the preview is where the owner reads
 * the module text, so "Refine selection" has to work HERE — and it needs an
 * exact SOURCE range for whatever was selected. This component therefore
 * renders each part with `WikiMarkdown`'s OPT-IN `sourceOffsets` (the reader
 * passes nothing, and its output is unchanged), and captures the browser
 * selection where the DOM is: `resolveSelectionRange` turns it into
 * part-relative source offsets, `textFrom` makes them whole-document
 * offsets, and the capture is reported upward. A capture is either MAPPED
 * (byte-exact) or REFUSED BY NAME — nothing is stored, no AI call happens
 * and no document is touched by making a selection.
 *
 * A COLLAPSED selection reports nothing: every click on a header button
 * collapses the browser selection, and the capture has to survive the click
 * that consumes it.
 *
 * Layout: the preview fills its pane (comfortable padding, no centered
 * narrow measure) — the chat sidebar persists beside it unchanged.
 */

export interface CanvasPreviewHighlight {
  /** The part (planIndex) the highlight lives in. */
  planIndex: number;
  /** Part-relative range of the last chat replacement. */
  from: number;
  to: number;
}

export interface CanvasPreviewProps {
  /** The whole-document editor doc captured when preview opened (or the
   * live preview snapshot while the chat applies in preview). */
  doc: string;
  module: Module;
  artifacts: readonly AnyArtifact[];
  moduleId: Id;
  /** Resolved-chip click — the reader's peek-modal affordance. */
  onOpenArtifact: (artifact: AnyArtifact) => void;
  /** The last chat replacement, mapped to its part (whole-doc coords are
   * the page's; the preview forwards the part-relative range). */
  highlight?: CanvasPreviewHighlight | null | undefined;
  /** Reports every non-collapsed selection made inside this preview, mapped
   * to the document source or refused by name (see the header comment). */
  onSelectionChange?: ((capture: PreviewSelectionCapture) => void) | undefined;
}

/**
 * The named refusal for a selection that starts in one part and ends in
 * another: a refine replaces ONE span, and a range across parts is not one
 * source span — the scaffolding between the parts would have to be replaced
 * too, which is a guess this feature never makes (docs/17 row 102).
 */
export const CROSS_PART_SELECTION_REASON =
  'The selection spans more than one part — a refine replaces one span inside a single part. Select text within one part.';

/** One part as the capture needs it: its text, its document offset, its root. */
interface PartSource {
  planIndex: number;
  text: string;
  textFrom: number;
  root: HTMLElement;
}

interface ParsedDoc {
  sections: ModulePartsSection[];
  /** The splitter's loud message when the scaffolding no longer parses. */
  error: string | null;
}

export function CanvasPreview({
  doc,
  module,
  artifacts,
  moduleId,
  onOpenArtifact,
  highlight,
  onSelectionChange,
}: CanvasPreviewProps): JSX.Element {
  const partRoots = useRef(new Map<number, HTMLElement>());
  const parts = useRef<PartSource[]>([]);

  const parsed = useMemo((): ParsedDoc => {
    try {
      return { sections: splitPartsDocument(doc, module.spine?.partPlan ?? []), error: null };
    } catch (error) {
      return {
        sections: [],
        error: error instanceof ModulePartsDocumentError ? error.message : String(error),
      };
    }
  }, [doc, module.spine]);

  // Refreshed after every render: the roots exist by then (ref callbacks run
  // before effects), and the capture below only ever reads this ref — which
  // keeps the DOM listener stable across the preview's re-renders.
  useEffect(() => {
    parts.current = parsed.sections.flatMap((section) => {
      const root = partRoots.current.get(section.planIndex);
      return root === undefined
        ? []
        : [
            {
              planIndex: section.planIndex,
              text: section.text,
              textFrom: section.textFrom,
              root,
            },
          ];
    });
  });

  /**
   * Reads the CURRENT browser selection and reports it. Wired to the
   * document's `selectionchange` AND to mouse/key release over the pane:
   * jsdom (and any engine that does not emit `selectionchange` for a
   * programmatic range) drives the same code path through the pane handlers,
   * so what the tests exercise is what production runs.
   */
  const captureSelection = useCallback((): void => {
    if (onSelectionChange === undefined) return;
    const selection = window.getSelection();
    const range = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    // A collapsed cursor is not a selection: keep the last capture (the very
    // click on the header button collapses the browser selection).
    if (range === null || range.collapsed) return;
    const startPart = partSourceOf(parts.current, range.startContainer);
    const endPart = partSourceOf(parts.current, range.endContainer);
    // Both ends outside every part root: this selection is not the preview's
    // (the chat sidebar, the module title, the CodeMirror editor in Edit).
    if (startPart === null && endPart === null) return;
    const bothInOnePart =
      startPart !== null && endPart !== null && startPart.planIndex === endPart.planIndex;
    if (!bothInOnePart) {
      // One end inside a part and the other outside it, or the two ends in
      // different parts: this is not one source span of this document.
      onSelectionChange({ kind: 'refused', reason: CROSS_PART_SELECTION_REASON, doc });
      return;
    }
    const result = resolveSelectionRange(
      startPart.text,
      { node: range.startContainer, offset: range.startOffset },
      { node: range.endContainer, offset: range.endOffset },
    );
    if (result.status === 'mapped') {
      onSelectionChange({
        kind: 'mapped',
        planIndex: startPart.planIndex,
        from: startPart.textFrom + result.from,
        to: startPart.textFrom + result.to,
        doc,
      });
      return;
    }
    onSelectionChange({ kind: 'refused', reason: result.reason, doc });
  }, [doc, onSelectionChange]);

  useEffect(() => {
    if (onSelectionChange === undefined) return;
    document.addEventListener('selectionchange', captureSelection);
    return () => {
      document.removeEventListener('selectionchange', captureSelection);
    };
  }, [captureSelection, onSelectionChange]);

  if (parsed.error !== null) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div>
          <div
            className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive"
            data-testid="canvas-preview-error"
            role="alert"
          >
            <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0">
              <p className="font-medium">The preview cannot render this document.</p>
              <p className="mt-1 break-words text-muted-foreground">{parsed.error}</p>
              <p className="mt-2 text-muted-foreground">
                Switch back to Edit and fix the separator / label lines — the preview only renders
                a document whose parts-document scaffolding parses.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto p-6"
      data-testid="canvas-preview"
      onMouseUp={captureSelection}
      onKeyUp={captureSelection}
    >
      <div className="flex flex-col gap-10">
        {parsed.sections.map((section) => (
          <article
            key={String(section.planIndex)}
            id={`part-${String(section.planIndex)}`}
            data-testid={`canvas-preview-part-${String(section.planIndex)}`}
          >
            {section.title !== '' && (
              <h2 className="mb-3 font-heading text-2xl font-bold tracking-tight">{section.title}</h2>
            )}
            {/*
             * The mapping root (docs/17 row 102): a capture walks THIS div, and
             * `WikiMarkdown`'s opt-in `sourceOffsets` is what makes its runs
             * carry source ranges. The `prose-module` class stays on
             * `WikiMarkdown` itself (the reader's exact wrapper) — this adds
             * one block box and never changes the rendered text.
             */}
            <div
              data-canvas-part-source={String(section.planIndex)}
              ref={(node) => {
                if (node === null) partRoots.current.delete(section.planIndex);
                else partRoots.current.set(section.planIndex, node);
              }}
            >
              <WikiMarkdown
                className="prose-module"
                sourceOffsets
                value={section.text === '' ? '*Nothing written yet.*' : section.text}
                artifacts={artifacts}
                moduleId={moduleId}
                onOpenArtifact={onOpenArtifact}
                highlight={
                  highlight?.planIndex === section.planIndex
                    ? { from: highlight.from, to: highlight.to }
                    : undefined
                }
              />
            </div>
            {/*
             * PROVENANCE (owner decision, docs/17 row 93 amendment): the owner
             * reversed the earlier "the canvas shows no id" decision — "i do
             * want to see who wrote the module text … please put it below the
             * module text". The id comes from the SAVED PART ROW, never from
             * the document: `doc` is the editable module text and is persisted
             * to the parts and re-sent to models, so an id placed in it would
             * become model INPUT (docs/18 §4). Reading the row keeps the doc
             * byte-identical to what the owner edits.
             */}
            <WriterModelId
              model={module.parts.find((part) => part.planIndex === section.planIndex)?.writerModel}
              testId={`canvas-preview-part-model-${String(section.planIndex)}`}
              label={`Part ${String(section.planIndex + 1)} writing model`}
            />
          </article>
        ))}
      </div>
    </div>
  );
}

/** The part whose mapping root contains `node`, or null when none does. */
function partSourceOf(parts: readonly PartSource[], node: Node): PartSource | null {
  for (const part of parts) {
    if (part.root.contains(node)) return part;
  }
  return null;
}
