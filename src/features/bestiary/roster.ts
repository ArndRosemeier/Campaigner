import type { Id, RuleChunk, Rulebook, StatBlock } from '@/domain';
import { parseLevelSort } from '@/llm/encounterRoster';

/**
 * Bestiary roster rows (12-BESTIARY-PACKS; the viewer variant of the
 * encounter-pipeline roster): every stat-block chunk of every ready book
 * becomes a clickable creature row — or, when the pack pipeline's exactness
 * invariant is violated, a LOUD data-error row. PDF books are different by
 * design: their stat-block detection is best-effort (02-INGESTION §Step 3),
 * so a PDF chunk with `statBlock: null` is simply not a creature entry,
 * while a PACK chunk with `statBlock: null` cannot legitimately exist and
 * is surfaced as a data error ("re-import the pack"), mirroring
 * `collectPackRoster`'s throw but per-row, so one bad chunk does not blank
 * the whole viewer.
 */

export interface RosterEntry {
  kind: 'entry';
  chunkId: Id;
  bookId: Id;
  name: string;
  level: string;
  /** Ordering key: exact for packs, best-effort for PDFs (unparseable PDF
   * levels sort last without flagging the row — the documented best-effort
   * reality, not a hidden failure). */
  levelSort: number;
  /** Human origin label, identical to encounterResolve's rulebook branch:
   * `"<book>: <creature>"` for packs (no pages), `"<book> p.<page>"` else. */
  origin: string;
}

export interface RosterDataError {
  kind: 'data-error';
  chunkId: Id;
  bookId: Id;
  message: string;
}

export type RosterRow = RosterEntry | RosterDataError;

export function buildBestiaryRows(books: readonly Rulebook[], chunks: readonly RuleChunk[]): RosterRow[] {
  const titleById = new Map(books.map((book) => [book.id, book.title]));
  const originById = new Map(books.map((book) => [book.id, book.origin]));
  const entries: RosterEntry[] = [];
  const errors: RosterDataError[] = [];
  for (const chunk of chunks) {
    if (chunk.chunkType !== 'statblock') continue;
    const isPack = originById.get(chunk.bookId) === 'pack';
    const name = chunk.headingPath[0]?.trim() ?? '';
    const title = titleById.get(chunk.bookId) ?? '';
    if (chunk.statBlock === null) {
      if (isPack) {
        errors.push({
          kind: 'data-error',
          chunkId: chunk.id,
          bookId: chunk.bookId,
          message: `chunk ${chunk.id} has no validated stat block — re-import the pack`,
        });
      }
      continue;
    }
    if (name === '') {
      errors.push({
        kind: 'data-error',
        chunkId: chunk.id,
        bookId: chunk.bookId,
        message: `chunk ${chunk.id} has no creature name in its heading`,
      });
      continue;
    }
    const statBlock: StatBlock = chunk.statBlock;
    let levelSort: number;
    if (isPack) {
      // Pack pipeline guarantee (12-BESTIARY-PACKS §1): exact levels. A
      // parse failure here is a data error, not an ordering guess.
      try {
        levelSort = parseLevelSort(statBlock.level);
      } catch (error) {
        errors.push({
          kind: 'data-error',
          chunkId: chunk.id,
          bookId: chunk.bookId,
          message: `chunk ${chunk.id}: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
    } else {
      try {
        levelSort = parseLevelSort(statBlock.level);
      } catch {
        levelSort = Number.POSITIVE_INFINITY;
      }
    }
    entries.push({
      kind: 'entry',
      chunkId: chunk.id,
      bookId: chunk.bookId,
      name,
      level: statBlock.level,
      levelSort,
      origin: isPack
        ? `${title}: ${name}`
        : `${title} p.${String(chunk.pageStart)}`,
    });
  }
  entries.sort((a, b) => a.levelSort - b.levelSort || a.name.localeCompare(b.name));
  // Data errors pinned to the top — the loud state is the first thing seen.
  return [...errors, ...entries];
}

/** Name-substring filter (case-insensitive); data errors always stay visible. */
export function filterRosterRows(rows: readonly RosterRow[], query: string): RosterRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...rows];
  return rows.filter(
    (row) => row.kind === 'data-error' || row.name.toLowerCase().includes(needle),
  );
}
