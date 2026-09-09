import type { JSX } from 'react';
import { TriangleAlertIcon } from 'lucide-react';

import type { AnyArtifact, Id, Module } from '@/domain';
import { splitPartsDocument, ModulePartsDocumentError } from '@/domain/modulePartsDocument';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';

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
 * cannot drift). A doc whose scaffolding no longer parses shows the
 * splitter's loud reason instead of a silent best-effort render (AGENTS 1).
 */

export interface CanvasPreviewProps {
  /** The whole-document editor doc captured when preview opened. */
  doc: string;
  module: Module;
  artifacts: readonly AnyArtifact[];
  moduleId: Id;
  /** Resolved-chip click — the reader's peek-modal affordance. */
  onOpenArtifact: (artifact: AnyArtifact) => void;
}

export function CanvasPreview({
  doc,
  module,
  artifacts,
  moduleId,
  onOpenArtifact,
}: CanvasPreviewProps): JSX.Element {
  let sections;
  try {
    sections = splitPartsDocument(doc, module.spine?.partPlan ?? []);
  } catch (error) {
    const reason = error instanceof ModulePartsDocumentError ? error.message : String(error);
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl">
          <div
            className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive"
            data-testid="canvas-preview-error"
            role="alert"
          >
            <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0">
              <p className="font-medium">The preview cannot render this document.</p>
              <p className="mt-1 break-words text-muted-foreground">{reason}</p>
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
    <div className="min-h-0 flex-1 overflow-y-auto p-6" data-testid="canvas-preview">
      <div className="mx-auto flex max-w-3xl flex-col gap-10">
        {sections.map((section) => (
          <article key={String(section.planIndex)} data-testid={`canvas-preview-part-${String(section.planIndex)}`}>
            {section.title !== '' && (
              <h2 className="mb-3 font-heading text-2xl font-bold tracking-tight">{section.title}</h2>
            )}
            <div className="prose-module">
              <WikiMarkdown
                value={section.text === '' ? '*Nothing written yet.*' : section.text}
                artifacts={artifacts}
                moduleId={moduleId}
                onOpenArtifact={onOpenArtifact}
              />
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
