import { useRef, useState } from 'react';
import type { JSX } from 'react';
import { BookOpenIcon, EllipsisVerticalIcon, PlusIcon, Trash2Icon } from 'lucide-react';

import { EmbeddingLibraryPanel } from '@/features/rules/embedding-panel';
import { GAME_SYSTEM_LABELS, type GameSystem } from '@/domain/gameSystem';
import type { Rulebook } from '@/domain/rulebook';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import { BookDialogs } from '@/features/rules/book-dialogs';
import { useRulebookSummaries, type RulebookSummary } from '@/features/rules/hooks';
import { SearchBrowser } from '@/features/rules/search-browser';
import { ingestPdf, type IngestProgress } from '@/ingest/ingestFiles';
import { toastError, toastSuccess } from '@/lib/toast';
import { ensureEmbeddings, embeddingsActive } from '@/search';
import { listChunksByBook } from '@/db/chunkRepo';

/** Per-book ingestion progress (0–100 while processing). */
export type ProgressMap = Record<string, { page: number; pageCount: number }>;

/** Per-book embedding progress (0–100 while embedding whole book). */
type EmbedProgressMap = Record<string, { done: number; total: number }>;

const DEFAULT_BOOK_SYSTEM: GameSystem = 'generic-d20';

/**
 * Rules library (05-UI.md §Rules): book list with import + embedding, and the
 * hybrid search browser with pin-to-assistant.
 */
export function RulesPage(): JSX.Element {
  const summaries = useRulebookSummaries();
  const [progress, setProgress] = useState<ProgressMap>({});
  const [embedProgress, setEmbedProgress] = useState<EmbedProgressMap>({});
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function trackProgress(p: IngestProgress): void {
    setProgress((previous) => ({
      ...previous,
      [p.bookId]: { page: p.page, pageCount: p.pageCount },
    }));
  }

  async function handleFiles(files: FileList | null): Promise<void> {
    if (files === null || files.length === 0) return;
    setImporting(true);
    try {
      for (const file of Array.from(files)) {
        if (!file.name.toLowerCase().endsWith('.pdf')) continue;
        try {
          const result = await ingestPdf(file, DEFAULT_BOOK_SYSTEM, trackProgress);
          toastSuccess(`Imported “${result.book.title}” (${result.chunkCount} chunks)`);
          if (result.emptyPages > 0) {
            toastError(`No extractable text on ${result.emptyPages} pages (scanned PDF?)`);
          }
        } catch (error) {
          toastError(`Could not import “${file.name}”`, error);
        }
      }
    } finally {
      setImporting(false);
      setProgress({});
      if (fileInputRef.current !== null) fileInputRef.current.value = '';
    }
  }

  async function handleRetry(book: Rulebook, files: FileList | null): Promise<void> {
    const file = files?.[0];
    if (file === undefined) return;
    setImporting(true);
    try {
      const result = await ingestPdf(file, book.system, trackProgress);
      toastSuccess(`Re-imported “${result.book.title}” (${result.chunkCount} chunks)`);
    } catch (error) {
      toastError(`Could not import “${file.name}”`, error);
    } finally {
      setImporting(false);
      setProgress({});
    }
  }

  async function handleEmbedBook(book: Rulebook): Promise<void> {
    if (!(await embeddingsActive())) {
      toastError('Enable embeddings and set an API key in Settings first');
      return;
    }
    const chunks = await listChunksByBook(book.id);
    if (chunks.length === 0) {
      toastError('This book has no chunks to embed');
      return;
    }
    try {
      await ensureEmbeddings(chunks, (done, total) => {
        setEmbedProgress((previous) => ({ ...previous, [book.id]: { done, total } }));
      });
      toastSuccess(`Embedded “${book.title}” (${chunks.length} chunks)`);
    } catch (error) {
      toastError(`Could not embed “${book.title}”`, error);
    } finally {
      setEmbedProgress((previous) => {
        const { [book.id]: _removed, ...rest } = previous;
        return rest;
      });
    }
  }

  const importInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept="application/pdf,.pdf"
      multiple
      className="hidden"
      data-testid="import-input"
      onChange={(event) => void handleFiles(event.target.files)}
    />
  );

  return (
    <div className="flex h-full">
      <div className="flex h-full w-80 shrink-0 flex-col overflow-hidden border-r">
        <div className="flex items-center justify-between border-b p-3">
          <h1 className="text-base font-semibold">Rulebooks</h1>
          <Button
            size="sm"
            disabled={importing}
            onClick={() => fileInputRef.current?.click()}
            data-testid="import-pdfs"
          >
            <PlusIcon aria-hidden data-icon="inline-start" />
            Import PDFs
          </Button>
          {importInput}
        </div>
        <EmbeddingLibraryPanel />
        <div className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="book-list">
          <BookList
            summaries={summaries}
            progress={progress}
            embedProgress={embedProgress}
            importing={importing}
            onRetry={handleRetry}
            onEmbedBook={(book) => {
              void handleEmbedBook(book);
            }}
          />
        </div>
      </div>
      <div className="h-full min-w-0 flex-1">
        <SearchBrowser
          books={(summaries ?? []).map((summary) => ({
            id: summary.book.id,
            title: summary.book.title,
          }))}
        />
      </div>
    </div>
  );
}

interface BookListProps {
  summaries: RulebookSummary[] | undefined;
  progress: ProgressMap;
  embedProgress: EmbedProgressMap;
  importing: boolean;
  onRetry: (book: Rulebook, files: FileList | null) => Promise<void>;
  onEmbedBook: (book: Rulebook) => void;
}

function BookList({
  summaries,
  progress,
  embedProgress,
  importing,
  onRetry,
  onEmbedBook,
}: BookListProps) {
  if (summaries === undefined) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (summaries.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <BookOpenIcon aria-hidden className="size-8 text-muted-foreground" />
        <h2 className="text-sm font-medium">No rulebooks yet</h2>
        <p className="max-w-[32ch] text-xs text-muted-foreground">
          Import a rulebook PDF to make its rules searchable and available to personas.
        </p>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {summaries.map((summary) => (
        <li key={summary.book.id}>
          <BookCard
            summary={summary}
            progress={progress}
            embedProgress={embedProgress}
            importing={importing}
            onRetry={onRetry}
            onEmbedBook={onEmbedBook}
          />
        </li>
      ))}
    </ul>
  );
}

interface BookCardProps {
  summary: RulebookSummary;
  progress: ProgressMap;
  embedProgress: EmbedProgressMap;
  importing: boolean;
  onRetry: (book: Rulebook, files: FileList | null) => Promise<void>;
  onEmbedBook: (book: Rulebook) => void;
}

function BookCard({
  summary,
  progress,
  embedProgress,
  importing,
  onRetry,
  onEmbedBook,
}: BookCardProps) {
  const { book, chunkCount } = summary;
  const [menuAction, setMenuAction] = useState<'rename' | 'system' | 'delete' | null>(null);
  const retryInputRef = useRef<HTMLInputElement | null>(null);
  const ingest = progress[book.id];
  const embed = embedProgress[book.id];
  const embedding = embed !== undefined;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{book.title}</CardTitle>
          <CardAction className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              aria-label={`Delete ${book.title}`}
              disabled={importing}
              onClick={() => {
                setMenuAction('delete');
              }}
            >
              <Trash2Icon aria-hidden />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
                aria-label={`Menu for ${book.title}`}
              >
                <EllipsisVerticalIcon aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => {
                    setMenuAction('rename');
                  }}
                >
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setMenuAction('system');
                  }}
                >
                  Set system
                </DropdownMenuItem>
                {book.status === 'ready' && (
                  <DropdownMenuItem
                    disabled={embedding}
                    onClick={() => {
                      onEmbedBook(book);
                    }}
                  >
                    Embed whole book
                  </DropdownMenuItem>
                )}
                {book.status === 'error' && (
                  <DropdownMenuItem
                    disabled={importing}
                    onClick={() => retryInputRef.current?.click()}
                  >
                    Retry…
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => {
                    setMenuAction('delete');
                  }}
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <input
              ref={retryInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(event) => {
                void onRetry(book, event.target.files);
                event.target.value = '';
              }}
            />
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{GAME_SYSTEM_LABELS[book.system]}</Badge>
            <StatusChip book={book} />
            <span>
              {chunkCount} chunk{chunkCount === 1 ? '' : 's'}
            </span>
          </div>
          {book.status === 'processing' && ingest !== undefined && ingest.pageCount > 0 && (
            <Progress value={(ingest.page / ingest.pageCount) * 100} />
          )}
          {embed !== undefined && (
            <Progress
              value={(embed.done / Math.max(1, embed.total)) * 100}
              aria-label="Embedding progress"
            />
          )}
          {book.status === 'error' && (
            <p className="text-destructive" title={book.errorMessage}>
              {book.errorMessage}
            </p>
          )}
        </CardContent>
      </Card>

      <BookDialogs
        book={book}
        action={menuAction}
        onOpenChange={(open) => {
          if (!open) setMenuAction(null);
        }}
      />
    </>
  );
}

function StatusChip({ book }: { book: Rulebook }): JSX.Element {
  if (book.status === 'ready') {
    return <Badge className="bg-emerald-600/15 text-emerald-500">ready</Badge>;
  }
  if (book.status === 'error') {
    return <Badge variant="destructive">error</Badge>;
  }
  return <Badge variant="outline">processing…</Badge>;
}
