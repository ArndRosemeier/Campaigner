import { useState } from 'react';
import Markdown from 'react-markdown';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export interface MarkdownBodyProps {
  value: string;
  onChange: (value: string) => void;
}

/**
 * Markdown body editor (05-UI): plain `<textarea>` with a Preview toggle
 * rendering via react-markdown. No WYSIWYG editor in M1.
 */
export function MarkdownBody({ value, onChange }: MarkdownBodyProps) {
  const [previewing, setPreviewing] = useState(false);

  return (
    <section className="flex flex-col gap-2">
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
      {previewing ? (
        <div className="min-h-[240px] rounded-lg border bg-card p-3 text-sm leading-relaxed [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_p]:my-1.5">
          <Markdown>{value === '' ? '*Nothing written yet.*' : value}</Markdown>
        </div>
      ) : (
        <Textarea
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          placeholder="Free-text content, written in Markdown…"
          className="min-h-[240px] font-mono text-sm"
        />
      )}
    </section>
  );
}
