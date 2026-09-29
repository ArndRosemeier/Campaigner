import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { JSX } from 'react';
import { TriangleAlertIcon } from 'lucide-react';

import { WriterModelId } from '@/components/writer-model-id';
import type { AnyArtifact, Id, Module } from '@/domain';
import {
  ModuleDocumentError,
  moduleDocumentSections,
  type ModuleDocumentSection,
} from '@/domain/moduleDocument';
import { resolveSelectionRange, WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import {
  PART_FROM_ATTRIBUTE,
  caretForClick,
  previewScrollAnchor,
  scrollPreviewToPos,
  type EditHandoff,
} from '@/features/modules/canvas/editHandoff';
import { WIKI_RAW_ATTRIBUTE } from '@/lib/remark-wikilinks';
import type { PreviewSelectionCapture } from '@/features/modules/canvas/previewStore';

/**
 * The canvas PREVIEW (canvas v3, 08-MODULE-DESIGNER §Module canvas; THE MODULE
 * DOCUMENT since docs/17 row 384): the whole-document editor rendered as the
 * READER sees it — the `=====Level N=====` separator lines are editor chrome
 * and are stripped here (their caption line is ordinary prose and renders as
 * the markdown heading it is); each level's text renders through the shared
 * `WikiMarkdown` (the reader's exact renderer, reader parity by construction)
 * with the reader pool and clickable entity chips (`onOpenArtifact` → the peek
 * modal). Level 0 (the premise) renders too — it is a section of the document
 * like any other.
 *
 * The preview renders the document AS OF THE TOGGLE (v1: while it is open
 * the editor is hidden and every writing surface is disabled, so the doc
 * cannot drift — EXCEPT the chat, which stays live in preview and applies
 * to the snapshot string the preview renders from). A doc whose separators
 * no longer parse shows the parser's loud reason instead of a silent
 * best-effort render (AGENTS 1).
 *
 * SELECTION → SOURCE (docs/17 row 102): the preview is where the owner reads
 * the module text, so "Refine selection" has to work HERE — and it needs an
 * exact SOURCE range for whatever was selected. This component therefore
 * renders each level with `WikiMarkdown`'s OPT-IN `sourceOffsets` (the reader
 * passes nothing, and its output is unchanged), and captures the browser
 * selection where the DOM is: `resolveSelectionRange` turns it into
 * section-relative source offsets, `textFrom` makes them whole-document
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
  /** The level (its `planIndex`, level − 1) the highlight lives in. */
  planIndex: number;
  /** Section-relative ranges of the last chat turn's replacements. */
  ranges: readonly { from: number; to: number }[];
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
  /** The last chat replacement, mapped to its level (whole-doc coords are
   * the page's; the preview forwards the section-relative range). */
  highlights?: readonly CanvasPreviewHighlight[] | undefined;
  /** Reports every non-collapsed selection made inside this preview, mapped
   * to the document source or refused by name (see the header comment). */
  onSelectionChange?: ((capture: PreviewSelectionCapture) => void) | undefined;
  /**
   * Click-to-edit (docs/17 row 399): a COLLAPSED click on prose asks the page to
   * open the editor at the mapped caret and the same scroll position. Absent =
   * the preview stays read-only (no caller today).
   */
  onRequestEdit?: ((handoff: EditHandoff) => void) | undefined;
  /** Whole-document offset to scroll to on mount (the return from the editor). */
  scrollToPos?: number | null | undefined;
}

/**
 * The named refusal for a selection that starts in one level and ends in
 * another: a refine replaces ONE span, and a range across levels is not one
 * source span — the separator between them would have to be replaced too,
 * which is a guess this feature never makes (docs/17 row 102).
 */
export const CROSS_PART_SELECTION_REASON =
  'The selection spans more than one level — a refine replaces one span inside a single level. Select text within one level.';

/** One level as the capture needs it: its text, its document offset, its root. */
interface PartSource {
  planIndex: number;
  text: string;
  textFrom: number;
  root: HTMLElement;
}

interface ParsedDoc {
  sections: ModuleDocumentSection[];
  /** The parser's loud message when the document no longer parses. */
  error: string | null;
}

export function CanvasPreview({
  doc,
  module,
  artifacts,
  moduleId,
  onOpenArtifact,
  highlights,
  onSelectionChange,
  onRequestEdit,
  scrollToPos,
}: CanvasPreviewProps): JSX.Element {
  const partRoots = useRef(new Map<number, HTMLElement>());
  const parts = useRef<PartSource[]>([]);

  const parsed = useMemo((): ParsedDoc => {
    try {
      return {
        sections: moduleDocumentSections(doc, module.spine?.partPlan ?? []),
        error: null,
      };
    } catch (error) {
      return {
        sections: [],
        error: error instanceof ModuleDocumentError ? error.message : String(error),
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

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (scrollToPos === null || scrollToPos === undefined) return;
    if (scrollerRef.current !== null) scrollPreviewToPos(scrollerRef.current, scrollToPos);
    // Once per mount: the position is the editor's at the moment of the switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * A plain click on prose enters the editor. NOT a click: a drag-selection
   * (non-collapsed — it feeds Refine selection), a chip / link / button (the
   * peek and the links keep their meaning), a click outside every part.
   */
  const handleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (onRequestEdit === undefined || event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest(`a, button, [${WIKI_RAW_ATTRIBUTE}], [data-wiki-name]`) !== null) return;
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0 || !selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const part = partSourceOf(parts.current, range.startContainer);
    if (part === null || scrollerRef.current === null) return;
    const anchor = previewScrollAnchor(scrollerRef.current);
    onRequestEdit({
      caret: caretForClick(part.root, part.text, {
        node: range.startContainer,
        offset: range.startOffset,
      }),
      scrollPos: anchor?.pos ?? part.textFrom,
      scrollOffsetPx: anchor?.offsetPx ?? 0,
    });
  };

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
                Switch to Edit (the header toggle) and fix the separator line it names — the preview
                only renders a document whose level separators parse.
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
      ref={scrollerRef}
      onClick={handleClick}
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
            {/*
             * The mapping root (docs/17 row 102): a capture walks THIS div, and
             * `WikiMarkdown`'s opt-in `sourceOffsets` is what makes its runs
             * carry source ranges. The `prose-module` class stays on
             * `WikiMarkdown` itself (the reader's exact wrapper) — this adds
             * one block box and never changes the rendered text.
             */}
            <div
              data-canvas-part-source={String(section.planIndex)}
              {...{ [PART_FROM_ATTRIBUTE]: String(section.textFrom) }}
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
                  highlights?.find((entry) => entry.planIndex === section.planIndex)?.ranges
                }
              />
            </div>
            {/*
             * PROVENANCE (owner decision, docs/17 row 93 amendment): the owner
             * reversed the earlier "the canvas shows no id" decision — "i do
             * want to see who wrote the module text … please put it below the
             * module text". The id comes from the SAVED ROW (the level's run
             * state / the premise's own provenance), never from the document:
             * `doc` is the editable module text and is persisted to the row and
             * re-sent to models, so an id placed in it would become model INPUT
             * (docs/18 §4). Reading the row keeps the doc byte-identical to
             * what the owner edits.
             */}
            <WriterModelId
              model={
                section.number === 0
                  ? module.spine?.writerModel
                  : module.parts.find((part) => part.planIndex === section.planIndex)?.writerModel
              }
              testId={`canvas-preview-part-model-${String(section.planIndex)}`}
              label={
                section.number === 0
                  ? 'Premise writing model'
                  : `Level ${String(section.number)} writing model`
              }
            />
          </article>
        ))}
      </div>
    </div>
  );
}

/** The level whose mapping root contains `node`, or null when none does. */
function partSourceOf(parts: readonly PartSource[], node: Node): PartSource | null {
  for (const part of parts) {
    if (part.root.contains(node)) return part;
  }
  return null;
}
