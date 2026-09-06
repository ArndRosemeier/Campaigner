import { useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useVirtualizer } from '@tanstack/react-virtual';
import { SkullIcon, TriangleAlertIcon } from 'lucide-react';

import type { Id, RuleChunk, StatBlock } from '@/domain';
import { GAME_SYSTEM_LABELS, type GameSystem } from '@/domain/gameSystem';
import { listChunksByBooks } from '@/db/chunkRepo';
import { listRulebooks } from '@/db/rulebookRepo';
import { StatBlockCard } from '@/features/campaign/components/stat-block';
import {
  buildBestiaryRows,
  filterRosterRows,
  type RosterEntry,
  type RosterRow,
} from '@/features/bestiary/roster';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Bestiary roster tab (source-viewers arc; 12-BESTIARY-PACKS): every ready
 * book's stat-block chunks as a virtualized, level-ordered, name-filterable
 * creature list (~50k rows must stay smooth), with the selected creature's
 * full stat block in a detail panel (StatBlockCard + the encounterResolve
 * origin label). Pack chunks violating the exactness invariant show as loud
 * data-error rows pinned to the top (per-row, not a thrown whole-viewer
 * failure). The tab is player-safe: it shows only book content that any
 * table could read from the source — nothing campaign-hidden.
 */

/** Row height estimate for the virtualizer (compact two-line rows). */
const ROW_HEIGHT = 56;

export function BestiaryRoster(): JSX.Element {
  const [query, setQuery] = useState('');
  const [system, setSystem] = useState<GameSystem | 'all'>('all');
  const [selectedId, setSelectedId] = useState<Id | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const loaded = useLiveQuery(async () => {
    const books = (await listRulebooks()).filter((book) => book.status === 'ready');
    const chunks = await listChunksByBooks(books.map((book) => book.id));
    return { books, chunks };
  }, []);

  const rows: RosterRow[] = useMemo(() => {
    if (loaded === undefined) return [];
    const usable = loaded.books.filter((book) => system === 'all' || book.system === system);
    const usableIds = new Set(usable.map((book) => book.id));
    const chunks = loaded.chunks.filter((chunk) => usableIds.has(chunk.bookId));
    return filterRosterRows(buildBestiaryRows(usable, chunks), query);
  }, [loaded, system, query]);

  const chunkById = useMemo(() => {
    const map = new Map<Id, RuleChunk>();
    for (const chunk of loaded?.chunks ?? []) map.set(chunk.id, chunk);
    return map;
  }, [loaded]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const selected: { entry: RosterEntry; statBlock: StatBlock } | null = useMemo(() => {
    if (selectedId === null) return null;
    const row = rows.find((candidate) => candidate.kind === 'entry' && candidate.chunkId === selectedId);
    if (row?.kind !== 'entry') return null;
    const chunk = chunkById.get(row.chunkId);
    if (chunk?.statBlock == null) return null;
    return { entry: row, statBlock: chunk.statBlock };
  }, [selectedId, rows, chunkById]);

  const errorCount = rows.filter((row) => row.kind === 'data-error').length;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b p-2">
        <Input
          className="h-8 w-56 text-sm"
          placeholder="Filter creatures…"
          aria-label="Filter creatures by name"
          value={query}
          data-testid="roster-name-filter"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        <Select
          value={system}
          onValueChange={(value) => {
            if (value === null) return;
            setSystem(value);
          }}
        >
          <SelectTrigger className="h-8 w-44 text-sm" aria-label="Filter by game system" data-testid="roster-system-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All systems</SelectItem>
            {(Object.keys(GAME_SYSTEM_LABELS) as GameSystem[]).map((key) => (
              <SelectItem key={key} value={key}>
                {GAME_SYSTEM_LABELS[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground" data-testid="roster-count">
          {String(rows.filter((row) => row.kind === 'entry').length)} creatures
          {errorCount > 0 && (
            <span className="ml-2 text-destructive">
              {String(errorCount)} data error{errorCount === 1 ? '' : 's'}
            </span>
          )}
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div ref={listRef} className="min-w-0 flex-1 overflow-auto" data-testid="roster-list">
          {loaded === undefined ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <SkullIcon aria-hidden className="size-8 text-muted-foreground" />
              <h2 className="text-sm font-medium">No creatures in the bestiary</h2>
              <p className="max-w-[40ch] text-xs text-muted-foreground">
                Import a bestiary pack or a rulebook PDF with stat blocks — every ready book's
                monsters appear here, ordered by level.
              </p>
            </div>
          ) : (
            <div style={{ height: `${String(virtualizer.getTotalSize())}px`, position: 'relative' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                if (row === undefined) return null;
                return (
                  <div
                    key={row.chunkId}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: `${String(item.size)}px`,
                      transform: `translateY(${String(item.start)}px)`,
                    }}
                  >
                    {row.kind === 'data-error' ? (
                      <p
                        className="flex items-center gap-2 px-3 py-2 text-xs text-destructive"
                        data-testid="roster-data-error"
                      >
                        <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
                        {row.message}
                      </p>
                    ) : (
                      <button
                        type="button"
                        className="w-full px-3 py-1.5 text-left transition-colors hover:bg-muted/50"
                        data-testid="roster-row"
                        aria-pressed={selectedId === row.chunkId}
                        onClick={() => {
                          setSelectedId(row.chunkId);
                        }}
                      >
                        <span className="flex items-baseline gap-2">
                          <span className="min-w-0 truncate text-sm font-medium">{row.name}</span>
                          {row.level !== '' && (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              Lv {row.level}
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {row.origin}
                        </span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="w-96 shrink-0 overflow-auto border-l p-3" data-testid="roster-detail">
          {selected === null ? (
            <p className="text-sm text-muted-foreground">Select a creature to see its stat block.</p>
          ) : (
            <div data-testid="roster-detail-card">
              <p className="mb-2 text-xs text-muted-foreground" data-testid="roster-origin">
                {selected.entry.origin}
              </p>
              <StatBlockCard statBlock={selected.statBlock} name={selected.entry.name} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
