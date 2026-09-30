import type { ExtractedItem, ExtractedPage, Line } from '@/ingest/types';

/**
 * Line & heading reconstruction (02-INGESTION.md step 2). Pure function over
 * extracted items — unit-testable without a worker or a real PDF.
 *
 * - Items are grouped into lines by y (tolerance 2), read left-to-right.
 * - The body font size/name is the per-page mode; a line is a heading
 *   candidate when its font size ≥ body × 1.15, or its font differs from the
 *   body font and the line is < 60 chars.
 * - Heading levels are clustered across the whole document: largest size =
 *   level 1, next = level 2, … (max 4).
 * - Two-column pages are read left column fully before the right one.
 */
export function buildLines(pages: readonly ExtractedPage[]): Line[][] {
  const pageLines = pages.map((page) => linesForPage(page));

  // Cluster candidate heading font sizes across the document → levels.
  const candidates: { line: Line; fontSize: number }[] = [];
  pageLines.forEach((lines, pageIndex) => {
    const page = pages[pageIndex];
    if (page === undefined) return;
    const bodySize = modeOf(page.items.map((item) => round1(item.fontSize)));
    const bodyFont = modeOf(page.items.map((item) => item.fontName));
    lines.forEach((line) => {
      const isCandidate =
        line.fontSize >= bodySize * 1.15 || (line.fontName !== bodyFont && line.text.length < 60);
      if (isCandidate && line.text.trim() !== '')
        candidates.push({ line, fontSize: line.fontSize });
    });
  });

  const levels = clusterHeadingSizes(candidates.map((candidate) => candidate.fontSize));
  candidates.forEach((candidate) => {
    candidate.line.headingLevel = levels.get(round1(candidate.fontSize)) ?? 0;
  });

  return pageLines;
}

/** Groups one page's items into text lines (with two-column handling). */
function linesForPage(page: ExtractedPage): Line[] {
  const columns = splitColumns(page.items, page.width);
  const lines: Line[] = [];
  columns.forEach((columnItems) => {
    lines.push(...groupIntoLines(columnItems, page.page));
  });
  return lines;
}

/**
 * Two-column detection: if the x-positions of items cluster into two groups
 * separated by a gap > 40% of the page width, read left before right.
 */
function splitColumns(items: ExtractedItem[], width: number): ExtractedItem[][] {
  const xs = [...new Set(items.map((item) => item.x))].sort((a, b) => a - b);
  let bestGap = 0;
  let bestSplit = -1;
  for (let i = 1; i < xs.length; i += 1) {
    const gap = (xs[i] ?? 0) - (xs[i - 1] ?? 0);
    if (gap > bestGap) {
      bestGap = gap;
      bestSplit = i;
    }
  }
  const splitX = bestSplit > 0 ? ((xs[bestSplit - 1] ?? 0) + (xs[bestSplit] ?? 0)) / 2 : 0;
  if (bestGap <= width * 0.4 || splitX <= 0) return [items];

  const left = items.filter((item) => item.x < splitX);
  const right = items.filter((item) => item.x >= splitX);
  // A split is only meaningful if both sides hold real content.
  if (left.length < 3 || right.length < 3) return [items];
  return [left, right];
}

function groupIntoLines(items: ExtractedItem[], page: number): Line[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x); // top to bottom
  const groups: ExtractedItem[][] = [];
  let current: ExtractedItem[] = [];
  let currentY = Number.NaN;

  sorted.forEach((item) => {
    if (Number.isNaN(currentY) || Math.abs(item.y - currentY) <= 2) {
      current.push(item);
      currentY = Number.isNaN(currentY)
        ? item.y
        : (currentY * (current.length - 1) + item.y) / current.length;
    } else {
      if (current.length > 0) groups.push(current);
      current = [item];
      currentY = item.y;
    }
  });
  if (current.length > 0) groups.push(current);

  return groups.map((group) => {
    const ordered = [...group].sort((a, b) => a.x - b.x);
    const texts = ordered.map((item) => item.str.trim()).filter((str) => str !== '');
    const biggest = ordered.reduce((max, item) => (item.fontSize > max.fontSize ? item : max));
    return {
      text: texts.join(' '),
      headingLevel: 0 as const,
      page,
      cells: texts,
      fontSize: biggest.fontSize,
      fontName: biggest.fontName,
    };
  });
}

/**
 * Assigns heading levels: distinct candidate sizes (clustered within 0.5)
 * sorted largest-first become levels 1..4.
 */
function clusterHeadingSizes(sizes: number[]): Map<number, 1 | 2 | 3 | 4> {
  const distinct = [...new Set(sizes.map(round1))].sort((a, b) => b - a);
  const clusters: number[] = [];
  distinct.forEach((size) => {
    const last = clusters[clusters.length - 1];
    if (last === undefined || Math.abs(last - size) > 0.5) clusters.push(size);
  });
  const levels = new Map<number, 1 | 2 | 3 | 4>();
  clusters.slice(0, 4).forEach((size, index) => {
    levels.set(size, (index + 1) as 1 | 2 | 3 | 4);
  });
  return levels;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function modeOf(values: number[]): number;
function modeOf(values: string[]): string;
function modeOf(values: (number | string)[]): number | string {
  if (values.length === 0) return 0;
  const counts = new Map<string, { count: number; value: number | string }>();
  let best = { count: 0, value: 0 as number | string };
  values.forEach((value) => {
    const key = String(value);
    const entry = counts.get(key) ?? { count: 0, value };
    entry.count += 1;
    counts.set(key, entry);
    if (entry.count > best.count) best = entry;
  });
  return best.value;
}
