import type { ExtractedItem, ExtractedPage, Line } from '@/ingest/types';

/** Fixture builders for ingestion unit tests (no real PDF needed). */

export function item(
  str: string,
  x: number,
  y: number,
  fontSize = 10,
  fontName = 'F1',
): ExtractedItem {
  return { str, x, y, fontSize, fontName };
}

export function page(items: ExtractedItem[], pageNo = 1, width = 612): ExtractedPage {
  return { page: pageNo, width, items };
}

export function line(
  text: string,
  opts: { headingLevel?: 0 | 1 | 2 | 3 | 4; page?: number; cells?: string[] } = {},
): Line[] {
  const heading = (opts.headingLevel ?? 0) > 0;
  return [
    {
      text,
      headingLevel: opts.headingLevel ?? 0,
      page: opts.page ?? 1,
      cells: opts.cells ?? [text],
      fontSize: heading ? 16 : 10,
      fontName: heading ? 'F2' : 'F1',
    },
  ];
}
