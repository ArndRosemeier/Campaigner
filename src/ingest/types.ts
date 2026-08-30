/** Shared shape types for the ingestion pipeline (02-INGESTION.md). */

/** One positioned text item from pdfjs `getTextContent()`. */
export interface ExtractedItem {
  str: string;
  x: number;
  y: number;
  /** Magnitude of transform[0]. */
  fontSize: number;
  fontName: string;
}

/** Per-page extraction result; `width` is the page width at scale 1. */
export interface ExtractedPage {
  page: number;
  width: number;
  items: ExtractedItem[];
}

/**
 * A reconstructed text line. `headingLevel` 0 = body text, 1–4 = heading
 * depth (assigned by clustering heading font sizes across the document).
 *
 * `cells` keeps the individual item strings (for the table detector) and
 * `fontSize`/`fontName` record the line's dominant item (heading detection).
 */
export interface Line {
  text: string;
  headingLevel: 0 | 1 | 2 | 3 | 4;
  page: number;
  cells: string[];
  fontSize: number;
  fontName: string;
}
