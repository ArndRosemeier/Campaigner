import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { ChevronDownIcon, ChevronRightIcon, PinIcon, PinOffIcon, SearchIcon } from 'lucide-react';

import type { ChunkType, RuleChunk } from '@/domain/rulebook';
import { Badge } from '@/components/ui/badge';
import { HelpButton } from '@/help/HelpButton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatBlockCard } from '@/features/campaign/components/stat-block';
import { usePinnedChunksStore } from '@/features/rules/pinStore';
import { searchRules, type SearchHit } from '@/search';
import { toastSuccess } from '@/lib/toast';

/** Debounce for typing (Enter searches immediately) — 05-UI.md §Rules. */
const DEBOUNCE_MS = 300;

const CHUNK_TYPES: { value: ChunkType; label: string }[] = [
  { value: 'section', label: 'Sections' },
  { value: 'statblock', label: 'Stat blocks' },
  { value: 'table', label: 'Tables' },
];

/**
 * Right pane of the Rules screen (05-UI.md §Rules): search box, book/type
 * filters, result list with breadcrumb + snippet highlight + source badge,
 * expandable full chunk and Pin to Assistant.
 */
export function SearchBrowser({ books }: { books: { id: string; title: string }[] }): JSX.Element {
  const [query, setQuery] = useState('');
  const [bookIds, setBookIds] = useState<string[]>([]);
  const [chunkTypes, setChunkTypes] = useState<ChunkType[]>([]);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void runSearch();
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, bookIds, chunkTypes]);

  async function runSearch(): Promise<void> {
    setSearching(true);
    try {
      const results = await searchRules(query, {
        bookIds: bookIds.length > 0 ? bookIds : undefined,
        chunkTypes: chunkTypes.length > 0 ? chunkTypes : undefined,
      });
      setHits(results);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-2 border-b p-3">
        <div className="flex items-center gap-1">
          <div className="relative flex-1">
            <SearchIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              placeholder="Search the rules… (Enter to search)"
              aria-label="Search the rules"
              className="pl-8"
              data-testid="rules-search"
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void runSearch();
                }
              }}
            />
          </div>
          <HelpButton topic="search" label="rules search" />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <BookFilter books={books} selected={bookIds} onChange={setBookIds} />
          {CHUNK_TYPES.map(({ value, label }) => (
            <label key={value} className="flex items-center gap-1.5">
              <Checkbox
                checked={chunkTypes.includes(value)}
                onCheckedChange={(checked) => {
                  setChunkTypes((previous) =>
                    checked
                      ? [...previous, value]
                      : previous.filter((existing) => existing !== value),
                  );
                }}
              />
              {label}
            </label>
          ))}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-3" data-testid="search-results">
          {hits.length === 0 && query.trim() === '' && (
            <p className="mt-6 text-center text-sm text-muted-foreground">
              Type to search the imported rulebooks. Results fuse keyword and (when enabled)
              semantic matches.
            </p>
          )}
          {hits.length === 0 && query.trim() !== '' && (
            <p className="mt-6 text-center text-sm text-muted-foreground">
              {searching ? 'Searching…' : `No matches for “${query}”.`}
            </p>
          )}
          {hits.map((hit) => (
            <ResultCard
              key={hit.chunk.id}
              hit={hit}
              query={query}
              expanded={expandedId === hit.chunk.id}
              onToggle={() => {
                setExpandedId((previous) => (previous === hit.chunk.id ? null : hit.chunk.id));
              }}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function BookFilter({
  books,
  selected,
  onChange,
}: {
  books: { id: string; title: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (books.length === 0) return null;
  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen((previous) => !previous);
        }}
      >
        Books{selected.length > 0 ? ` (${selected.length})` : ''}
        <ChevronDownIcon aria-hidden />
      </Button>
      {open && (
        <div className="absolute top-full z-10 mt-1 flex flex-col gap-1.5 rounded-md border bg-popover p-2 text-xs shadow-md">
          {books.map((book) => (
            <label key={book.id} className="flex items-center gap-1.5">
              <Checkbox
                checked={selected.includes(book.id)}
                onCheckedChange={(checked) => {
                  onChange(
                    checked ? [...selected, book.id] : selected.filter((id) => id !== book.id),
                  );
                }}
              />
              {book.title}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function ResultCard({
  hit,
  query,
  expanded,
  onToggle,
}: {
  hit: SearchHit;
  query: string;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const { chunk } = hit;
  const pin = usePinnedChunksStore((state) => state.pin);
  const unpin = usePinnedChunksStore((state) => state.unpin);
  const isPinned = usePinnedChunksStore((state) => state.chunks.some((c) => c.id === chunk.id));

  return (
    <div className="rounded-md border p-2 text-sm" data-testid="search-hit">
      <button type="button" className="flex w-full items-start gap-1 text-left" onClick={onToggle}>
        {expanded ? (
          <ChevronDownIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-muted-foreground">
            {chunk.headingPath.length > 0 ? (
              <Breadcrumb path={chunk.headingPath} />
            ) : (
              <span>(no heading)</span>
            )}
          </span>
          {expanded ? null : <Snippet text={chunk.text} query={query} />}
        </span>
      </button>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Badge variant="secondary">p. {chunk.pageStart}</Badge>
        <Badge variant="outline">
          {hit.source === 'both' ? 'kw+sem' : hit.source === 'keyword' ? 'kw' : 'sem'}
        </Badge>
        {chunk.chunkType === 'statblock' && <Badge variant="outline">stat block</Badge>}
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (isPinned) {
              unpin(chunk.id);
            } else {
              pin(chunk);
              toastSuccess('Pinned to Assistant');
            }
          }}
        >
          {isPinned ? (
            <PinOffIcon aria-hidden data-icon="inline-start" />
          ) : (
            <PinIcon aria-hidden data-icon="inline-start" />
          )}
          {isPinned ? 'Unpin' : 'Pin to Assistant'}
        </Button>
      </div>
      {expanded && <ExpandedChunk chunk={chunk} />}
    </div>
  );
}

function Breadcrumb({ path }: { path: string[] }): JSX.Element {
  return (
    <span>
      {path.map((part, index) => (
        <span key={index}>
          {index > 0 && <span className="mx-1 text-muted-foreground/60">›</span>}
          <span className={index === path.length - 1 ? 'text-foreground' : ''}>{part}</span>
        </span>
      ))}
    </span>
  );
}

/** First ~200 chars of the chunk text with query terms highlighted. */
function Snippet({ text, query }: { text: string; query: string }): JSX.Element {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 1);
  const lower = text.toLowerCase();
  let start = 0;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at > 0) {
      start = Math.max(0, at - 60);
      break;
    }
  }
  const snippet = text.slice(start, start + 200).trim();
  return (
    <span className="line-clamp-2 text-sm">
      {start > 0 && '… '}
      <Highlight text={snippet} terms={terms} />
    </span>
  );
}

function Highlight({ text, terms }: { text: string; terms: string[] }): JSX.Element {
  if (terms.length === 0) return <>{text}</>;
  const pattern = new RegExp(
    `(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'gi',
  );
  const parts = text.split(pattern);
  return (
    <>
      {parts.map((part, index) =>
        terms.includes(part.toLowerCase()) ? (
          <mark key={index} className="rounded bg-primary/25 px-0.5">
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

function ExpandedChunk({ chunk }: { chunk: RuleChunk }): JSX.Element {
  return (
    <div className="mt-2 border-t pt-2" data-testid="expanded-chunk">
      {chunk.statBlock !== null ? (
        <StatBlockCard
          statBlock={chunk.statBlock}
          name={chunk.headingPath[chunk.headingPath.length - 1] ?? 'Stat block'}
        />
      ) : (
        <p className="whitespace-pre-wrap">{chunk.text}</p>
      )}
    </div>
  );
}
