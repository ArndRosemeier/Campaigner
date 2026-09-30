import type { JSX } from 'react';

import { moduleWritingSummary } from '@/domain';
import type { Module } from '@/domain';

/**
 * PROVENANCE (owner decision, docs/17 row 93 amendment): "i do want to see who
 * wrote the module text and i dont think i can see that elsewhere. So… please
 * put it below the module text." The canvas is where he notices the question —
 * it is the only place the module text is read as ONE text — so the answer
 * lives in the canvas FOOTER, outside the editable document.
 *
 * HARD CONSTRAINT: this component reads `module.parts[].writerModel` and
 * `module.spine.writerModel` and renders them as SIBLING text. It must never
 * feed an id back into the canvas document, a part's `markdown`, or anything a
 * save could capture: the document IS the module text, it is persisted to the
 * parts and re-sent to models, so an id in it would become model INPUT
 * (docs/18 §4, the same reason provenance never enters an LLM contract). The
 * placement rule is pinned by `tests/features/canvas-provenance.test.tsx`.
 *
 * Three honest states, all decided in `moduleWritingSummary`:
 *   - nothing recorded anywhere → render NOTHING (never a settings-derived id);
 *   - every scope recorded and equal → ONE id, "Written by <id>";
 *   - otherwise → the per-scope list, including scopes that are NOT recorded,
 *     so a part another model wrote is never hidden behind the majority id.
 */
export function CanvasWriterModel({ module }: { module: Module }): JSX.Element | null {
  const summary = moduleWritingSummary(module.spine?.writerModel, module.parts);
  if (summary.kind === 'none') return null;

  if (summary.kind === 'single') {
    return (
      <footer
        className="flex shrink-0 items-baseline gap-2 border-t px-4 py-1 text-[11px] leading-4 text-muted-foreground/70"
        data-testid="canvas-writer-model"
        data-model={summary.model}
      >
        <span>Written by</span>
        <span className="font-mono select-all" aria-label={`Writing model: ${summary.model}`}>
          {summary.model}
        </span>
      </footer>
    );
  }

  return (
    <footer
      className="flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t px-4 py-1 text-[11px] leading-4 text-muted-foreground/70"
      data-testid="canvas-writer-model"
      data-model="mixed"
    >
      <span>Written by</span>
      {summary.scopes.map((scope) => (
        <span
          key={scope.id}
          className="flex items-baseline gap-1"
          data-testid={`canvas-writer-model-scope-${scope.id}`}
          data-scope={scope.label}
          data-model={scope.model ?? ''}
        >
          <span className="text-muted-foreground/50">{scope.label}</span>
          <span className="font-mono select-all">{scope.model ?? 'not recorded'}</span>
        </span>
      ))}
    </footer>
  );
}
