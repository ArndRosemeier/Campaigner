import { useEffect, useRef, useState } from 'react';
import type { JSX, RefObject } from 'react';
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Reader search (08-MODULE-DESIGNER M4-C, module-mode-as-play): a find box on
 * top of the left sidebar. Matches are located in the RENDERED document (so
 * chip text and markdown both count); next/previous cycle through them,
 * scrolling the match into view and flashing a highlight on its containing
 * block. The highlight is a transient class on an existing element — React
 * owns the tree, so no nodes are added or removed here.
 */

interface TextMatch {
  node: Text;
  offset: number;
}

/** Collects the matches of `needle` (case-insensitive) in document order. */
function findMatches(container: HTMLElement, needle: string): TextMatch[] {
  const matches: TextMatch[] = [];
  const lower = needle.toLowerCase();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current !== null) {
    const text = current.nodeValue?.toLowerCase() ?? '';
    let index = text.indexOf(lower);
    while (index !== -1) {
      matches.push({ node: current as Text, offset: index });
      index = text.indexOf(lower, index + lower.length);
    }
    current = walker.nextNode();
  }
  return matches;
}

/** The block-level element to flash-highlight for a match. */
function hitBlock(match: TextMatch, length: number): HTMLElement | undefined {
  const range = document.createRange();
  range.setStart(match.node, match.offset);
  try {
    range.setEnd(match.node, match.offset + length);
  } catch {
    return undefined;
  }
  const parent = range.startContainer.parentElement;
  if (parent === null || !containerConnected(parent)) return undefined;
  return (
    parent.closest('p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, section') ?? parent
  );
}

function containerConnected(element: HTMLElement): boolean {
  return element.isConnected;
}

export function ReaderSearch({
  containerRef,
}: {
  containerRef: RefObject<HTMLElement | null>;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [total, setTotal] = useState(0);
  const [active, setActive] = useState(0);
  const highlightedRef = useRef<HTMLElement | null>(null);

  const needle = query.trim();

  // Recount whenever the query (or the rendered document, via re-render)
  // changes. The container ref is read inside the effect: refs attach after
  // the first render, so a render-time read would be null on mount.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null || needle === '') {
      setTotal(0);
      return;
    }
    setTotal(findMatches(container, needle).length);
    setActive(0);
    return () => {
      highlightedRef.current?.classList.remove('search-hit');
      highlightedRef.current = null;
    };
  }, [containerRef, needle, query]);

  function navigate(step: 1 | -1): void {
    const container = containerRef.current;
    if (container === null || needle === '') return;
    const matches = findMatches(container, needle);
    if (matches.length === 0) return;
    const nextIndex = ((active + step) % matches.length + matches.length) % matches.length;
    const match = matches[nextIndex];
    if (match === undefined) return;
    const block = hitBlock(match, needle.length);
    highlightedRef.current?.classList.remove('search-hit');
    highlightedRef.current = null;
    if (block !== undefined) {
      block.scrollIntoView({ behavior: 'smooth', block: 'center' });
      block.classList.add('search-hit');
      highlightedRef.current = block;
    }
    setActive(nextIndex);
  }

  return (
    <div className="mb-2" data-testid="reader-search">
      <div className="relative">
        <SearchIcon
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              navigate(event.shiftKey ? -1 : 1);
            }
          }}
          placeholder="Search the module…"
          aria-label="Search the module"
          className="h-7 pl-7 text-xs"
          data-testid="reader-search-input"
        />
        {query !== '' && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Clear search"
            className="absolute top-1/2 right-1 -translate-y-1/2"
            data-testid="reader-search-clear"
            onClick={() => {
              setQuery('');
              setActive(0);
            }}
          >
            <XIcon aria-hidden />
          </Button>
        )}
      </div>
      <div className="mt-1 flex items-center justify-end gap-1 px-1">
        <span
          className="text-[11px] text-muted-foreground tabular-nums"
          data-testid="reader-search-count"
        >
          {needle === '' || total === 0 ? '–' : `${String(active + 1)} / ${String(total)}`}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Previous match"
          disabled={needle === '' || total === 0}
          data-testid="reader-search-prev"
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
          disabled={needle === '' || total === 0}
          data-testid="reader-search-next"
          onClick={() => {
            navigate(1);
          }}
        >
          <ChevronDownIcon aria-hidden />
        </Button>
      </div>
    </div>
  );
}
