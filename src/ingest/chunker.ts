import type { GameSystem } from '@/domain/gameSystem';
import type { Line } from '@/ingest/types';
import type { ChunkType, UnhashedChunk } from '@/domain/rulebook';
import { detectStatBlock, parseStatBlock } from '@/ingest/statblock';

/**
 * Chunking (02-INGESTION.md step 3). Pure function: heading-path tracking,
 * section accumulation with 1500-char sentence-boundary splits, header/
 * footer stripping, stat-block spans, and table runs.
 */

/** Flush threshold for section chunks. */
const MAX_SECTION_CHARS = 1500;
/** Minimum section chunk size (page numbers, footers). */
const MIN_SECTION_CHARS = 40;
/** A line occurring on more than this fraction of pages is dropped. */
const REPEATED_LINE_FRACTION = 0.6;

export function chunkLines(
  lines: readonly Line[],
  system: GameSystem = 'generic-d20',
): UnhashedChunk[] {
  const kept = stripRepeatingLines(lines);
  const chunks: UnhashedChunk[] = [];
  const headingPath: string[] = [];
  let section: { lines: Line[]; text: string; path: string[] } | null = null;

  function flushSection(): void {
    if (section === null) return;
    if (section.text.trim().length >= MIN_SECTION_CHARS) {
      chunks.push(makeChunk('section', section.lines, section.text, section.path, system));
    }
    section = null;
  }

  let i = 0;
  while (i < kept.length) {
    const line = kept[i];
    if (line === undefined) break;

    if (line.headingLevel > 0) {
      flushSection();
      // Level n replaces the stack from depth n on.
      const depth = Math.min(line.headingLevel - 1, headingPath.length);
      headingPath.length = depth;
      headingPath.push(line.text);
      i += 1;
      continue;
    }

    const span = detectStatBlock(kept, i);
    if (span !== null && span.start === i) {
      flushSection();
      const blockLines = kept.slice(span.start, span.end);
      const text = blockLines.map((blockLine) => blockLine.text).join('\n');
      chunks.push(makeChunk('statblock', blockLines, text, [...headingPath], system));
      i = span.end;
      continue;
    }

    const tableEnd = tableRunEnd(kept, i);
    if (tableEnd !== null) {
      flushSection();
      const tableLines = kept.slice(i, tableEnd);
      const text = tableLines.map((tableLine) => tableLine.cells.join(' | ')).join('\n');
      chunks.push(makeChunk('table', tableLines, text, [...headingPath], system));
      i = tableEnd;
      continue;
    }

    section ??= { lines: [], text: '', path: [...headingPath] };
    section.lines.push(line);
    section.text = section.text === '' ? line.text : `${section.text}\n${line.text}`;

    // Overflow: split at the nearest sentence boundary, snapped back to the
    // end of a whole line (a raw sentence boundary can fall mid-line, which
    // desynced section.lines from section.text and later produced chunks
    // with no lines — their page range collapsed to ±Infinity).
    if (section.text.length >= MAX_SECTION_CHARS) {
      const window = section.text.slice(0, MAX_SECTION_CHARS);
      let target = lastSentenceBoundary(window);
      if (target < MIN_SECTION_CHARS) target = MAX_SECTION_CHARS - 1;
      let headLineCount = 0;
      let consumed = 0;
      for (const line of section.lines) {
        if (consumed + line.text.length - 1 > target) break;
        headLineCount += 1;
        consumed += line.text.length + 1; // +1 for the joining '\n'
      }
      let headLines: Line[];
      let restLines: Line[];
      const first = section.lines[0];
      if (headLineCount === 0 && first !== undefined) {
        // Single line longer than the window: split the line itself so both
        // sides keep their lines in sync with the text (same page).
        headLines = [{ ...first, text: first.text.slice(0, target + 1) }];
        restLines = [{ ...first, text: first.text.slice(target + 1) }, ...section.lines.slice(1)];
      } else {
        headLines = section.lines.slice(0, headLineCount);
        restLines = section.lines.slice(headLineCount);
      }
      chunks.push(
        makeChunk(
          'section',
          headLines,
          headLines.map((headLine) => headLine.text).join('\n'),
          section.path,
          system,
        ),
      );
      section = {
        lines: restLines,
        text: restLines.map((restLine) => restLine.text).join('\n'),
        path: [...headingPath],
      };
    }
    i += 1;
  }
  flushSection();

  return chunks;
}

function makeChunk(
  chunkType: ChunkType,
  spanLines: readonly Line[],
  text: string,
  headingPath: string[],
  system: GameSystem,
): UnhashedChunk {
  // Guard against empty spans (would yield ±Infinity, which the schema
  // rejects); after the line-synced split this should never trigger.
  const pages = spanLines.map((line) => line.page).filter((page) => Number.isFinite(page));
  return {
    chunkType,
    pageStart: pages.length === 0 ? 1 : Math.min(...pages),
    pageEnd: pages.length === 0 ? 1 : Math.max(...pages),
    headingPath,
    text,
    statBlock: chunkType === 'statblock' ? parseStatBlock(text, system) : null,
  };
}

/**
 * Drops lines that occur (as exact text) on more than 60% of pages —
 * headers/footers/page numbers. Only applied from 3 pages up, so short
 * documents don't lose everything.
 */
function stripRepeatingLines(lines: readonly Line[]): Line[] {
  const pageCount = new Set(lines.map((line) => line.page)).size;
  if (pageCount < 3) return [...lines];

  const pagesWith = new Map<string, Set<number>>();
  lines.forEach((line) => {
    if (line.text.trim() === '') return;
    const seen = pagesWith.get(line.text) ?? new Set<number>();
    seen.add(line.page);
    pagesWith.set(line.text, seen);
  });

  const threshold = pageCount * REPEATED_LINE_FRACTION;
  return lines.filter((line) => {
    const seen = pagesWith.get(line.text);
    return seen === undefined || seen.size <= threshold;
  });
}

/** Run of ≥ 3 consecutive non-heading lines with ≥ 3 cells each → table. */
function tableRunEnd(lines: readonly Line[], start: number): number | null {
  const isRow = (line: Line | undefined): boolean =>
    line?.headingLevel === 0 && line.cells.length >= 3;
  const firstThree = [lines[start], lines[start + 1], lines[start + 2]];
  if (firstThree.some((line) => !isRow(line))) {
    return null;
  }
  let end = start;
  while (isRow(lines[end])) end += 1;
  return end;
}

function lastSentenceBoundary(text: string): number {
  for (let i = text.length - 2; i >= 0; i -= 1) {
    const char = text[i];
    if ((char === '.' || char === '!' || char === '?') && text[i + 1] === ' ') {
      return i;
    }
  }
  return -1;
}
