import { useEffect, useMemo, useRef, useState } from 'react';
import type { FocusEvent, JSX } from 'react';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { AnyArtifact, Id } from '@/domain';
import { MarkdownBody } from '@/features/campaign/components/markdown-body';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import {
  findDraftMatches,
  replaceAllDraftMatches,
  replaceDraftMatch,
} from '@/features/modules/textMatches';

/**
 * Module part text editor (08-MODULE-DESIGNER M4-A): the find/replace toolbar
 * mounted in `PartBody`'s EDITING branch, operating on the `editDraft` string
 * state owned by `ModuleReaderPage`. The commit still flows through the
 * existing `savePartEdit` path (`patchModuleTextPart` on the module row:
 * `edited: true` + the "Part saved" toast + the rewrite-overwrite confirm),
 * so hand edits made here trip the rewrite warning exactly like blur-saves.
 *
 * Find UX mirrors `ReaderSearch` (match count as `active / total`, Enter /
 * Shift+Enter navigation, case-insensitive default) with one deliberate
 * difference: `ReaderSearch.findMatches` walks rendered DOM text via
 * TreeWalker, while this editor needs STRING offsets (textarea selection +
 * replacement), so `findDraftMatches` (`textMatches.ts`, the shared sibling
 * holding both paired find surfaces) is its string-offset counterpart with the
 * same non-overlapping loop semantics — not a second implementation of a
 * different behavior.
 */

/** Moves the textarea selection to [start, end) so the match is visible. */
function focusTextareaRange(container: HTMLElement | null, start: number, end: number): void {
  const textarea = container?.querySelector('textarea');
  if (textarea === null || textarea === undefined) return;
  textarea.focus();
  textarea.setSelectionRange(start, end);
}

export function PartTextEditor({
  value,
  onChange,
  onSave,
  onCancel,
  artifacts,
  moduleId,
  onOpenArtifact,
  onStub,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Commits the draft (the existing `savePartEdit` path). */
  onSave: () => void;
  /** Discards the draft — the module row is untouched, no `edited` flag. */
  onCancel: () => void;
  artifacts: readonly AnyArtifact[];
  moduleId: Id;
  onOpenArtifact: (artifact: AnyArtifact) => void;
  onStub: (name: string, anchor: { x: number; y: number }) => void;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [findQuery, setFindQuery] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  /** A post-change selection to apply once the new draft renders. */
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null);

  const matches = useMemo(
    () => findDraftMatches(value, findQuery, caseSensitive),
    [value, findQuery, caseSensitive],
  );
  const active = matches.length === 0 ? 0 : Math.min(activeIndex, matches.length - 1);

  // A new query restarts at the first match (ReaderSearch parity).
  useEffect(() => {
    setActiveIndex(0);
  }, [findQuery, caseSensitive]);

  useEffect(() => {
    const pending = pendingSelectionRef.current;
    if (pending === null) return;
    pendingSelectionRef.current = null;
    focusTextareaRange(containerRef.current, pending.start, pending.end);
  }, [value]);

  function navigate(step: 1 | -1): void {
    if (matches.length === 0) return;
    const nextIndex = ((active + step) % matches.length + matches.length) % matches.length;
    const match = matches[nextIndex];
    if (match === undefined) return;
    setActiveIndex(nextIndex);
    focusTextareaRange(containerRef.current, match.start, match.end);
  }

  function replaceOne(): void {
    const match = matches[active];
    if (match === undefined) return;
    pendingSelectionRef.current = {
      start: match.start,
      end: match.start + replaceText.length,
    };
    onChange(replaceDraftMatch(value, match, replaceText));
  }

  function replaceAll(): void {
    const { text } = replaceAllDraftMatches(value, findQuery, replaceText, caseSensitive);
    onChange(text);
  }

  /**
   * Blur-save with toolbar awareness: `MarkdownBody` types this as
   * `() => void` but React still passes the FocusEvent at runtime. A blur
   * whose focus lands INSIDE this container (find/replace inputs, Preview,
   * Save/Cancel) must not commit — otherwise touching the toolbar would save
   * and unmount the editor mid-find. A blur anywhere else (or a programmatic
   * blur with no target) commits through `onSave`.
   */
  function handleTextareaBlur(event?: FocusEvent<HTMLTextAreaElement>): void {
    const next = event?.relatedTarget as Node | null | undefined;
    if (next !== null && next !== undefined && containerRef.current?.contains(next) === true) {
      return;
    }
    onSave();
  }

  return (
    <div ref={containerRef} className="flex flex-col gap-2" data-testid="part-text-editor">
      <div className="flex flex-wrap items-center gap-1.5" role="search" aria-label="Find in part">
        <Input
          value={findQuery}
          onChange={(event) => {
            setFindQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              navigate(event.shiftKey ? -1 : 1);
            } else if (event.key === 'Escape') {
              onCancel();
            }
          }}
          placeholder="Find in part…"
          aria-label="Find in part"
          data-testid="part-find-input"
          className="h-7 min-w-36 flex-1 text-xs pointer-coarse:text-base"
        />
        <span
          className="text-[11px] text-muted-foreground tabular-nums"
          data-testid="part-find-count"
        >
          {findQuery === '' || matches.length === 0 ? '–' : `${String(active + 1)} / ${String(matches.length)}`}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Previous match"
          disabled={matches.length === 0}
          data-testid="part-find-prev"
          onClick={() => {
            navigate(-1);
          }}
        >
          <ChevronUpIcon aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Next match"
          disabled={matches.length === 0}
          data-testid="part-find-next"
          onClick={() => {
            navigate(1);
          }}
        >
          <ChevronDownIcon aria-hidden />
        </Button>
        <div className="flex items-center gap-1.5">
          <Switch
            id="part-case-toggle"
            size="sm"
            checked={caseSensitive}
            onCheckedChange={setCaseSensitive}
            aria-label="Case sensitive"
            data-testid="part-case-toggle"
          />
          <Label htmlFor="part-case-toggle" className="text-xs text-muted-foreground">
            Aa
          </Label>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          value={replaceText}
          onChange={(event) => {
            setReplaceText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              replaceOne();
            } else if (event.key === 'Escape') {
              onCancel();
            }
          }}
          placeholder="Replace with…"
          aria-label="Replace with"
          data-testid="part-replace-input"
          className="h-7 min-w-36 flex-1 text-xs pointer-coarse:text-base"
        />
        <Button
          variant="outline"
          size="xs"
          disabled={matches.length === 0}
          data-testid="part-replace-one"
          onClick={replaceOne}
        >
          Replace
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={findQuery === '' || matches.length === 0}
          data-testid="part-replace-all"
          onClick={replaceAll}
        >
          Replace all
        </Button>
      </div>
      {previewing ? (
        <div
          className="min-h-[240px] rounded-lg border bg-card p-3 text-sm leading-relaxed [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_p]:my-1.5"
          data-testid="part-draft-preview"
        >
          <WikiMarkdown
            value={value === '' ? '*Nothing written yet.*' : value}
            artifacts={artifacts}
            moduleId={moduleId}
            onOpenArtifact={onOpenArtifact}
            onStub={onStub}
          />
        </div>
      ) : (
        <MarkdownBody
          value={value}
          onChange={onChange}
          onTextareaBlur={handleTextareaBlur}
          hideHeading
          textareaTestId="part-draft"
          artifacts={artifacts}
          moduleId={moduleId}
        />
      )}
      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="xs"
          data-testid="part-edit-preview"
          onClick={() => {
            setPreviewing((preview) => !preview);
          }}
        >
          {previewing ? 'Edit' : 'Preview'}
        </Button>
        <span className="flex-1" />
        <Button variant="outline" size="xs" data-testid="part-edit-cancel" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" data-testid="part-edit-save" onClick={onSave}>
          Save part
        </Button>
      </div>
    </div>
  );
}
