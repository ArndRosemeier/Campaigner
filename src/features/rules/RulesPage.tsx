import { useRef, useState } from 'react';
import type { JSX } from 'react';
import { BookOpenIcon, EllipsisVerticalIcon, PlusIcon, Trash2Icon } from 'lucide-react';

import { HelpButton } from '@/help/HelpButton';
import { EmbeddingLibraryPanel } from '@/features/rules/embedding-panel';
import { GAME_SYSTEM_LABELS, type GameSystem } from '@/domain/gameSystem';
import type { Rulebook } from '@/domain/rulebook';
import { Badge } from '@/components/ui/badge';
import { BlockedControl } from '@/components/blocked-control';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BestiaryRoster } from '@/features/bestiary/bestiary-roster';
import { BookDialogs } from '@/features/rules/book-dialogs';
import { PackImportDialog } from '@/features/rules/pack-import-dialog';
import { PdfBookView } from '@/features/rules/pdf-viewer';
import { useRulebookSummaries, type RulebookSummary } from '@/features/rules/hooks';
import { SearchBrowser } from '@/features/rules/search-browser';
import { ingestPdf, type IngestProgress } from '@/ingest/ingestFiles';
import type { PackImportProgress } from '@/ingest/packImport';
import { toastError, toastSuccess } from '@/lib/toast';
import { ensureEmbeddings, embeddingsActive } from '@/search';
import { listChunksByBook } from '@/db/chunkRepo';

/** Per-book ingestion/pack-import progress (0–100 while processing). */
export type ProgressMap = Record<string, { done: number; total: number }>;

/** Per-book embedding progress (0–100 while embedding whole book). */
type EmbedProgressMap = Record<string, { done: number; total: number }>;

/** The right pane's open PDF view: which book, at which page. */
interface PdfView {
  bookId: string;
  page: number;
}

const DEFAULT_BOOK_SYSTEM: GameSystem = 'generic-d20';

/**
 * WHY the library's import and embedding controls cannot act while one is
 * running (docs/18 §2.3, docs/05 §Why a control cannot act): `importing` and
 * `embedding` are the flags the gates below already read, and these sentences
 * are computed from those SAME flags, so a reason can never disagree with the
 * state it explains. Both name the way out honestly: NEITHER an ingest nor an
 * embedding run has a cancel seam (measured: `ingestPdf` and the embeddings
 * runner take no `AbortSignal`, and the progress dock does not carry either), so
 * the way out is to wait — a Stop button here would be a promise this screen
 * cannot keep.
 */
const PDF_IMPORT_RUNNING_REASON =
  'A PDF import is running right now — one import runs at a time here; wait for it to finish.';
const BOOK_EMBEDDING_REASON = 'This book is being embedded right now — wait for it to finish.';

/**
 * Rules library (05-UI.md §Rules): book list with import + embedding, and the
 * hybrid search browser with pin-to-assistant. A "View PDF" affordance on a
 * PDF-origin book (or "Open at p. N" on a search hit) swaps the right pane to
 * the retained-bytes PDF viewer; a book without retained bytes shows the
 * viewer's loud absent state there (owner-ratified: no attach affordance).
 */
export function RulesPage(): JSX.Element {
  const summaries = useRulebookSummaries();
  const [progress, setProgress] = useState<ProgressMap>({});
  const [embedProgress, setEmbedProgress] = useState<EmbedProgressMap>({});
  const [importing, setImporting] = useState(false);
  /** The one reason the two header import buttons state while `importing`. */
  const importBlockedReason = importing ? PDF_IMPORT_RUNNING_REASON : null;
  const [packOpen, setPackOpen] = useState(false);
  const [pdfView, setPdfView] = useState<PdfView | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function trackProgress(p: IngestProgress): void {
    setProgress((previous) => ({
      ...previous,
      [p.bookId]: { done: p.page, total: p.pageCount },
    }));
  }

  const packProgressBookRef = useRef<string | null>(null);

  function trackPackProgress(p: PackImportProgress | null): void {
    setProgress((previous) => {
      if (p === null) {
        const bookId = packProgressBookRef.current;
        packProgressBookRef.current = null;
        if (bookId === null) return previous;
        const { [bookId]: _removed, ...rest } = previous;
        return rest;
      }
      packProgressBookRef.current = p.bookId;
      return { ...previous, [p.bookId]: { done: p.done, total: p.total } };
    });
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
          <h1 className="flex items-center gap-1 text-base font-semibold">
            Rulebooks
            <HelpButton topic="rules" label="rulebooks" />
          </h1>
          <div className="flex flex-wrap items-center justify-end gap-1">
            <BlockedControl testId="import-pdfs" reason={importBlockedReason}>
              <Button
                size="sm"
                disabled={importing}
                onClick={() => fileInputRef.current?.click()}
                data-testid="import-pdfs"
              >
                <PlusIcon aria-hidden data-icon="inline-start" />
                Import PDFs
              </Button>
            </BlockedControl>
            <BlockedControl testId="import-pack" reason={importBlockedReason}>
              <Button
                size="sm"
                variant="outline"
                disabled={importing}
                onClick={() => {
                  setPackOpen(true);
                }}
                data-testid="import-pack"
              >
                <PlusIcon aria-hidden data-icon="inline-start" />
                Import bestiary pack
              </Button>
            </BlockedControl>
          </div>
          {importInput}
          <PackImportDialog
            open={packOpen}
            onOpenChange={setPackOpen}
            onProgress={trackPackProgress}
          />
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
            onViewPdf={(bookId, page) => {
              setPdfView({ bookId, page });
            }}
          />
        </div>
      </div>
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {pdfView === null ? (
          <Tabs defaultValue="search" className="min-h-0 flex-1">
            <TabsList className="mx-2 mt-2">
              <TabsTrigger value="search">Search</TabsTrigger>
              <TabsTrigger value="bestiary">Bestiary</TabsTrigger>
            </TabsList>
            <TabsContent value="search" className="min-h-0">
              <SearchBrowser
                books={(summaries ?? []).map((summary) => ({
                  id: summary.book.id,
                  title: summary.book.title,
                }))}
                onOpenPdf={(bookId, page) => {
                  setPdfView({ bookId, page });
                }}
              />
            </TabsContent>
            <TabsContent value="bestiary" className="min-h-0">
              <BestiaryRoster />
            </TabsContent>
          </Tabs>
        ) : (
          <PdfBookView
            bookId={pdfView.bookId}
            initialPage={pdfView.page}
            onBack={() => {
              setPdfView(null);
            }}
          />
        )}
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
  onViewPdf: (bookId: string, page: number) => void;
}

function BookList({
  summaries,
  progress,
  embedProgress,
  importing,
  onRetry,
  onEmbedBook,
  onViewPdf,
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
            onViewPdf={onViewPdf}
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
  onViewPdf: (bookId: string, page: number) => void;
}

function BookCard({
  summary,
  progress,
  embedProgress,
  importing,
  onRetry,
  onEmbedBook,
  onViewPdf,
}: BookCardProps) {
  const { book, chunkCount } = summary;
  const [menuAction, setMenuAction] = useState<'rename' | 'system' | 'license' | 'delete' | null>(null);
  const retryInputRef = useRef<HTMLInputElement | null>(null);
  const ingest = progress[book.id];
  const embed = embedProgress[book.id];
  const embedding = embed !== undefined;
  /**
   * The two reasons this card's controls state while they are held (docs/18
   * §2.3) — computed from the SAME flags their gates read:
   * - `importing` is the page-level flag one PDF ingest raises, and it holds
   *   every card's delete AND the failed book's "Retry…" (the retry starts
   *   another import, and only one import runs at a time);
   * - `embedding` is THIS book's own embedding run (`embedProgress[book.id]`).
   * Self-evident states get no reason: every other control here is un-gated.
   */
  const importBlockedReason = importing ? PDF_IMPORT_RUNNING_REASON : null;
  const embeddingReason = embedding ? BOOK_EMBEDDING_REASON : null;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="min-w-0 text-sm [overflow-wrap:anywhere]">{book.title}</CardTitle>
          <CardAction className="flex items-center gap-1">
            {book.origin === 'pdf' && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`View PDF of ${book.title}`}
                data-testid={`view-pdf-${book.id}`}
                onClick={() => {
                  onViewPdf(book.id, 1);
                }}
              >
                <BookOpenIcon aria-hidden />
              </Button>
            )}
            <BlockedControl testId={`delete-book-${book.id}`} reason={importBlockedReason}>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-destructive"
                aria-label={`Delete ${book.title}`}
                data-testid={`delete-book-${book.id}`}
                disabled={importing}
                onClick={() => {
                  setMenuAction('delete');
                }}
              >
                <Trash2Icon aria-hidden />
              </Button>
            </BlockedControl>
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
                {book.origin === 'pack' && (
                  <DropdownMenuItem
                    onClick={() => {
                      setMenuAction('license');
                    }}
                  >
                    License
                  </DropdownMenuItem>
                )}
                {book.status === 'ready' && (
                  <BlockedControl
                    testId={`embed-book-${book.id}`}
                    reason={embeddingReason}
                  >
                    <DropdownMenuItem
                      disabled={embedding}
                      data-testid={`embed-book-${book.id}`}
                      onClick={() => {
                        onEmbedBook(book);
                      }}
                    >
                      Embed whole book
                    </DropdownMenuItem>
                  </BlockedControl>
                )}
                {book.status === 'error' && (
                  <BlockedControl
                    testId={`retry-book-${book.id}`}
                    reason={importBlockedReason}
                  >
                    <DropdownMenuItem
                      disabled={importing}
                      data-testid={`retry-book-${book.id}`}
                      onClick={() => retryInputRef.current?.click()}
                    >
                      Retry…
                    </DropdownMenuItem>
                  </BlockedControl>
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
            {book.origin === 'pack' && <Badge variant="outline">Pack</Badge>}
            <Badge variant="secondary">{GAME_SYSTEM_LABELS[book.system]}</Badge>
            <StatusChip book={book} />
            <span>
              {chunkCount} chunk{chunkCount === 1 ? '' : 's'}
            </span>
          </div>
          {book.status === 'processing' && ingest !== undefined && ingest.total > 0 && (
            <Progress value={(ingest.done / ingest.total) * 100} />
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
      />    </>
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
