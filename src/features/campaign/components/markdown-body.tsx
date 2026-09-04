import { useState } from 'react';

import type { AnyArtifact, Id } from '@/domain';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';

export interface MarkdownBodyProps {
  value: string;
  onChange: (value: string) => void;
  /** Campaign artifacts for wiki-link resolution (M4-A). */
  artifacts?: readonly AnyArtifact[] | undefined;
  /** Owning module id for tier-0 resolution — see WikiMarkdownProps. */
  moduleId?: Id | undefined;
  /** Resolved wiki-chip click (e.g. open the peek modal). */
  onOpenArtifact?: ((artifact: AnyArtifact) => void) | undefined;
  /** Forwarded to the textarea (module parts save on blur — 08 §M4-A). */
  onTextareaBlur?: (() => void) | undefined;
  /** Hides the section heading (module reader embeds its own labels). */
  hideHeading?: boolean | undefined;
}

/**
 * Markdown body editor (05-UI): plain `<textarea>` with a Preview toggle.
 * The preview renders through the shared `WikiMarkdown` pipeline so artifact
 * bodies show wiki-link chips everywhere (08-MODULE-DESIGNER M4-A).
 */
export function MarkdownBody({
  value,
  onChange,
  artifacts,
  onOpenArtifact,
  onTextareaBlur,
  hideHeading = false,
}: MarkdownBodyProps) {
  const [previewing, setPreviewing] = useState(false);

  return (
    <section className="flex flex-col gap-2">
      {hideHeading ? null : (
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Body (Markdown)</h2>
          <Button
            variant={previewing ? 'secondary' : 'ghost'}
            size="xs"
            onClick={() => {
              setPreviewing((preview) => !preview);
            }}
          >
            {previewing ? 'Edit' : 'Preview'}
          </Button>
        </div>
      )}
      {previewing ? (
        <div className="min-h-[240px] rounded-lg border bg-card p-3 text-sm leading-relaxed [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_p]:my-1.5">
          <WikiMarkdown
            value={value === '' ? '*Nothing written yet.*' : value}
            artifacts={artifacts ?? []}
            onOpenArtifact={onOpenArtifact}
          />
        </div>
      ) : (
        <Textarea
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          onBlur={onTextareaBlur}
          placeholder="Free-text content, written in Markdown…"
          className="min-h-[240px] font-mono text-sm"
        />
      )}
    </section>
  );
}
