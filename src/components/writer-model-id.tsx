import type { JSX } from 'react';

import { recordedWritingModel } from '@/domain';
import { cn } from '@/lib/utils';

/**
 * PROVENANCE (owner request, docs/17 row 93): "put a very small id below
 * generated texts … indicating which model wrote this. And a small id below
 * images indicating the image model."
 *
 * ONE presentational surface for both halves, so every place it appears looks
 * the same: the id ITSELF, in the repo's smallest muted type, selectable
 * (the id is the point — the owner copies it), with no label words.
 *
 * The display rule lives in `recordedWritingModel`: `''`/null/undefined means
 * NOT RECORDED, and then this renders NOTHING AT ALL — never a placeholder,
 * never an id derived from current settings (owner decision: text written
 * before this change has no recorded model, so show nothing there). The
 * attribute is always emitted so a test can prove the negative.
 *
 * APP ONLY (owner decision): this component never reaches a PDF — the
 * delivered documents are built by `lib/modulePdf` / `lib/pdfExport` from
 * domain rows and pre-rendered strings, and neither imports this file
 * (pinned by `tests/lib/provenance-export.test.ts`).
 */
export function WriterModelId({
  model,
  className,
  testId = 'writer-model-id',
  label = 'Writing model',
}: {
  /** The recorded model id; `''`/null renders nothing. */
  model: string | null | undefined;
  className?: string;
  testId?: string;
  /** Accessible name for the id (a screen reader hears "Writing model X");
   * never rendered as visible text. */
  label?: string;
}): JSX.Element | null {
  const recorded = recordedWritingModel(model);
  if (recorded === null) return null;
  return (
    <p
      data-testid={testId}
      data-model={recorded}
      aria-label={`${label}: ${recorded}`}
      className={cn(
        'mt-1 font-mono text-[11px] leading-4 text-muted-foreground/70 select-all',
        className,
      )}
    >
      {recorded}
    </p>
  );
}
