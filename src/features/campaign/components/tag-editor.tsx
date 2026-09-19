import { useState } from 'react';
import { XIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

export interface TagEditorProps {
  tags: readonly string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}

/**
 * Chip-input tag editor (05-UI header): Enter or comma adds a tag, × removes.
 * Tags are trimmed and deduplicated case-insensitively.
 */
export function TagEditor({ tags, onChange, placeholder = 'Add tag…' }: TagEditorProps) {
  const [draft, setDraft] = useState('');

  function commit(): void {
    const tag = draft.trim();
    if (tag === '') return;
    const exists = tags.some((existing) => existing.toLowerCase() === tag.toLowerCase());
    if (!exists) onChange([...tags, tag]);
    setDraft('');
  }

  function remove(tag: string): void {
    onChange(tags.filter((existing) => existing !== tag));
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map((tag) => (
        <Badge key={tag} variant="secondary" className="gap-1">
          {tag}
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            className="rounded-full outline-none hover:text-destructive"
            onClick={() => {
              remove(tag);
            }}
          >
            <XIcon aria-hidden className="size-3" />
          </button>
        </Badge>
      ))}
      <Input
        value={draft}
        placeholder={placeholder}
        className="h-7 w-28 border-none bg-transparent px-1 text-xs shadow-none dark:bg-transparent"
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}
