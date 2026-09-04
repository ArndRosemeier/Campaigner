import { useState } from 'react';
import { XIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

export interface AliasEditorProps {
  /** The artifact's current name — an alias equal to it is rejected:
   * `resolveWikiLink` matches the name first, so such an alias could never
   * resolve and would only be dead weight. */
  name: string;
  aliases: readonly string[];
  onChange: (aliases: string[]) => void;
  placeholder?: string;
}

/**
 * Chip-input alias editor (08-MODULE-DESIGNER M4-A: "also known as",
 * adjacent to the tags row in the editor header): Enter or comma adds an
 * alias, × removes one. Mirrors TagEditor with alias-specific validation —
 * input is trimmed, empty input is ignored, and duplicates are rejected
 * case-insensitively against the artifact's own name AND the existing
 * aliases. Stored spelling is preserved verbatim (display fidelity):
 * resolution lowercases on its own, so values are never rewritten here.
 */
export function AliasEditor({
  name,
  aliases,
  onChange,
  placeholder = 'Add alias…',
}: AliasEditorProps) {
  const [draft, setDraft] = useState('');

  function commit(): void {
    const alias = draft.trim();
    setDraft('');
    if (alias === '') return;
    const duplicate =
      alias.toLowerCase() === name.trim().toLowerCase() ||
      aliases.some((existing) => existing.trim().toLowerCase() === alias.toLowerCase());
    if (duplicate) return;
    onChange([...aliases, alias]);
  }

  function remove(alias: string): void {
    onChange(aliases.filter((existing) => existing !== alias));
  }

  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="alias-editor">
      <span className="text-xs text-muted-foreground">Also known as</span>
      {aliases.map((alias) => (
        <Badge key={alias} variant="secondary" className="gap-1">
          {alias}
          <button
            type="button"
            aria-label={`Remove alias ${alias}`}
            className="rounded-full outline-none hover:text-destructive"
            onClick={() => {
              remove(alias);
            }}
          >
            <XIcon aria-hidden className="size-3" />
          </button>
        </Badge>
      ))}
      <Input
        value={draft}
        placeholder={placeholder}
        aria-label="Add alias"
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
