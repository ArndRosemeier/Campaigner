import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, FileWarningIcon } from 'lucide-react';

import type { Id, StoredPdf } from '@/domain';
import { getRulebook } from '@/db/rulebookRepo';
import { getBookPdf } from '@/db/pdfRepo';
import { copyBytes, openPdfDocument, type PDFDocumentProxy } from '@/lib/pdfRuntime';import { errorMessage } from '@/lib/errors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * In-app PDF viewer (source-viewers arc): renders the RETAINED bytes of a
 * PDF-origin book with pdf.js on a canvas — open-at-page for the
 * chunk→page jump, fit-width default with a zoom multiplier, page nav.
 * `openPdfDocument` gets a COPY of the bytes: pdfjs transfers the buffer it
 * is handed. A book without retained bytes never reaches the viewer —
 * `PdfBookView` shows the loud absent state instead (no attach affordance:
 * retention happens at ingest or not at all, owner-ratified).
 */

function isRenderCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'RenderingCancelledException';
}

export function PdfViewer({ pdf, initialPage = 1 }: { pdf: StoredPdf; initialPage?: number | undefined }): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(initialPage);
  const [containerWidth, setContainerWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [failure, setFailure] = useState<string | null>(null);

  // Open the document once per retained payload (a copy — pdfjs detaches
  // what it is handed).
  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setNumPages(0);
    setFailure(null);
    void openPdfDocument(copyBytes(pdf.bytes))
      .then(({ doc: opened, destroy }) => {
        if (cancelled) {
          void destroy();
          return;
        }
        setDoc(opened);
        setNumPages(opened.numPages);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [pdf.id, pdf.bytes]);

  // Clamp the requested page into the document.
  useEffect(() => {
    if (numPages === 0) return;
    setPage((current) => Math.min(Math.max(1, current), numPages));
  }, [numPages]);

  // Track the container width for fit-width rendering.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) setContainerWidth(width);
    });
    observer.observe(container);
    setContainerWidth(container.clientWidth);
    return () => {
      observer.disconnect();
    };
  }, []);

  // Render the current page: cancel the previous task first (GM_Helper's
  // loop), fit-width scaled by the zoom multiplier, devicePixelRatio crisp.
  useEffect(() => {
    if (doc === null || containerWidth === 0) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    // A boxed flag defeats TS's closure narrowing (a bare `let cancelled`
    // reads as always-false inside the async IIFE).
    const state = { cancelled: false };
    void (async () => {
      const pdfPage = await doc.getPage(page);
      const base = pdfPage.getViewport({ scale: 1 });
      const cssScale = (Math.max(200, containerWidth - 16) / base.width) * zoom;
      const viewport = pdfPage.getViewport({ scale: cssScale });
      const dpr = window.devicePixelRatio;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${String(Math.floor(viewport.width))}px`;
      canvas.style.height = `${String(Math.floor(viewport.height))}px`;
      renderTaskRef.current?.cancel();
      const task = pdfPage.render({ canvas, viewport });
      renderTaskRef.current = task;
      try {
        await task.promise;
      } catch (error: unknown) {
        if (isRenderCancelled(error) || state.cancelled) return;
        setFailure(errorMessage(error));
      }
    })().catch((error: unknown) => {
      if (!state.cancelled) setFailure(errorMessage(error));
    });
    return () => {
      state.cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [doc, page, containerWidth, zoom]);

  function goToPage(raw: string): void {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) return;
    setPage(Math.min(Math.max(1, parsed), Math.max(1, numPages)));
  }

  return (
    <div className="flex h-full min-w-0 flex-col" data-testid="pdf-viewer">
      <div className="flex flex-wrap items-center gap-1.5 border-b p-2 text-sm">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => {
            setPage((current) => Math.max(1, current - 1));
          }}
        >
          <ChevronLeftIcon aria-hidden />
        </Button>
        <Input
          className="h-7 w-14 text-sm pointer-coarse:text-base"
          aria-label="Page number"
          value={String(page)}
          data-testid="pdf-page-input"
          onChange={(event) => {
            goToPage(event.target.value);
          }}
        />
        <span className="text-xs text-muted-foreground">of {String(numPages)}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next page"
          disabled={numPages === 0 || page >= numPages}
          onClick={() => {
            setPage((current) => Math.min(numPages, current + 1));
          }}
        >
          <ChevronRightIcon aria-hidden />
        </Button>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom out"
          disabled={zoom <= 0.5}
          onClick={() => {
            setZoom((current) => Math.max(0.5, current - 0.25));
          }}
        >
          −
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setZoom(1);
          }}
        >
          Fit width
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom in"
          disabled={zoom >= 3}
          onClick={() => {
            setZoom((current) => Math.min(3, current + 0.25));
          }}
        >
          +
        </Button>
      </div>
      {failure !== null && (
        <p className="border-b p-2 text-xs text-destructive" data-testid="pdf-viewer-error">
          {failure}
        </p>
      )}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-auto bg-muted/30 p-2">
        {doc === null && failure === null && (
          <p className="p-4 text-sm text-muted-foreground">Loading PDF…</p>
        )}
        <div className="mx-auto w-fit">
          <canvas ref={canvasRef} data-testid="pdf-canvas" />
        </div>
      </div>
    </div>
  );
}

/**
 * One book's PDF pane: header (title + back) and the viewer. The retained
 * bytes are loaded ONCE via the repo (not a live query): Dexie's liveQuery
 * re-clones rows and the re-clone of a binary payload is a prototype-only
 * fake whose typed-array getters throw — a plain `getBookPdf` read returns
 * the real cross-realm view, which `copyBytes` handles. A book without
 * retained bytes shows the LOUD absent state — the honest consequence of
 * ingesting before PDF retention; there is deliberately NO way to hand a
 * file to the existing book (re-import the PDF instead).
 */
export function PdfBookView({
  bookId,
  initialPage,
  onBack,
}: {
  bookId: Id;
  initialPage?: number | undefined;
  onBack: () => void;
}): JSX.Element {
  const book = useLiveQuery(async () => (await getRulebook(bookId)) ?? null, [bookId]);
  const [pdf, setPdf] = useState<StoredPdf | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setPdf(undefined);
    setLoadError(null);
    void getBookPdf(bookId)
      .then((row) => {
        if (active) setPdf(row ?? null);
      })
      .catch((error: unknown) => {
        // Loud: a failed bytes load must never masquerade as "not retained".
        if (active) setLoadError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [bookId]);

  if (loadError !== null) {
    return (
      <p className="p-4 text-sm text-destructive" data-testid="pdf-load-error">
        Could not load the retained PDF: {loadError}
      </p>
    );
  }
  if (book === undefined || pdf === undefined) {
    return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  }
  if (book === null) {
    return <p className="p-4 text-sm text-muted-foreground">This book no longer exists.</p>;
  }
  if (pdf === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" data-testid="pdf-absent">
        <FileWarningIcon aria-hidden className="size-8 text-muted-foreground" />
        <h2 className="text-sm font-medium">No PDF is retained for “{book.title}”</h2>
        <p className="max-w-[48ch] text-xs text-muted-foreground">
          This book was imported before PDF retention — its original bytes are not in the library,
          so it cannot be viewed here. Delete it and import the PDF again to get a fully viewable
          book.
        </p>
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeftIcon aria-hidden data-icon="inline-start" />
          Back to the library
        </Button>
      </div>
    );
  }
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center gap-2 border-b p-2">
        <Button variant="ghost" size="sm" onClick={onBack} data-testid="pdf-back">
          <ArrowLeftIcon aria-hidden data-icon="inline-start" />
          Library
        </Button>
        <h2 className="min-w-0 truncate text-sm font-semibold">{book.title}</h2>
      </div>
      <div className="min-h-0 flex-1">
        <PdfViewer pdf={pdf} initialPage={initialPage} />
      </div>
    </div>
  );
}
