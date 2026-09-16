import type {
  Id,
  RuleChunk,
  Rulebook,
  SpellData,
  SpellHeighteningEntry,
  SpellTradition,
} from '@/domain';

/**
 * Spell list rows (docs/17 row 182, docs/12 §15): every `spell` chunk of a
 * campaign's READY, SAME-SYSTEM books becomes a clickable spell row — or,
 * when the spells arc's exactness invariant is violated, a LOUD per-row
 * data-error row. This is the bestiary roster's shape (`features/bestiary/
 * roster.ts`) for the spell payload, and it is PURE: the page owns reads, this
 * module owns the ordering and filtering rules, and a unit test can exercise
 * both without a database.
 *
 * THE MISSING-RANK POLICY IS EXPLICIT. `spellData.rank` is required by
 * `spellDataSchema`, so the only way a row can lack a rank is a `spell` chunk
 * whose `spellData` is absent/null — a CORRUPT row (the adapter that stamps
 * `chunkType: 'spell'` always stamps the payload beside it). Such a chunk is
 * NEVER dropped: it renders a named `data-error` row pinned to the top, the
 * `roster.ts` precedent, because a spell list that silently loses rows is the
 * exact failure rule 1 forbids.
 */

export interface SpellEntry {
  kind: 'entry';
  chunkId: Id;
  bookId: Id;
  /** The document's own name (the last `headingPath` element). */
  name: string;
  /** List order: a cantrip is 0 (docs/12 §15). */
  rank: number;
  /** `Cantrip` or `Rank N` — the ONE display spelling. */
  rankLabel: string;
  cantrip: boolean;
  traditions: readonly SpellTradition[];
  /** The validated payload, carried whole so the card renders from data. */
  data: SpellData;
  /** Human origin label: the book's own title. */
  origin: string;
}

export interface SpellDataError {
  kind: 'data-error';
  chunkId: Id;
  bookId: Id;
  message: string;
}

export type SpellRow = SpellEntry | SpellDataError;

/** `Cantrip` or `Rank N` — the page's ONE rank wording. */
export function spellRankLabel(rank: number, cantrip: boolean): string {
  return cantrip ? 'Cantrip' : `Rank ${String(rank)}`;
}

/** One-based English ordinal for a fixed heightening rank (`3rd`, `11th`). */
function ordinal(value: number): string {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${String(value)}th`;
  switch (value % 10) {
    case 1:
      return `${String(value)}st`;
    case 2:
      return `${String(value)}nd`;
    case 3:
      return `${String(value)}rd`;
    default:
      return `${String(value)}th`;
  }
}

/**
 * The heading a heightening note renders under — the corpus's own shape
 * (`Heightened (3rd)` for a fixed rank, `Heightened (+1)` for an interval).
 * It labels the entry's OWN rank/interval; it never computes a cast rank (the
 * mob arc's policy), so no number here is invented.
 */
export function spellHeighteningLabel(entry: SpellHeighteningEntry): string {
  return entry.kind === 'fixed'
    ? `Heightened (${ordinal(entry.rank)})`
    : `Heightened (+${String(entry.increment)})`;
}

export function buildSpellRows(
  books: readonly Rulebook[],
  chunks: readonly RuleChunk[],
): SpellRow[] {
  const titleById = new Map(books.map((book) => [book.id, book.title]));
  const entries: SpellEntry[] = [];
  const errors: SpellDataError[] = [];
  for (const chunk of chunks) {
    if (chunk.chunkType !== 'spell') continue;
    const name = chunk.headingPath[chunk.headingPath.length - 1]?.trim() ?? '';
    const data = chunk.spellData;
    if (data === undefined || data === null) {
      errors.push({
        kind: 'data-error',
        chunkId: chunk.id,
        bookId: chunk.bookId,
        message: `chunk ${chunk.id} has no validated spell payload — re-import the rules pack`,
      });
      continue;
    }
    if (name === '') {
      errors.push({
        kind: 'data-error',
        chunkId: chunk.id,
        bookId: chunk.bookId,
        message: `chunk ${chunk.id} has no spell name in its heading`,
      });
      continue;
    }
    entries.push({
      kind: 'entry',
      chunkId: chunk.id,
      bookId: chunk.bookId,
      name,
      rank: data.rank,
      rankLabel: spellRankLabel(data.rank, data.cantrip),
      cantrip: data.cantrip,
      traditions: data.traditions,
      data,
      origin: titleById.get(chunk.bookId) ?? '',
    });
  }
  entries.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  // Data errors pinned to the top — the loud state is the first thing seen.
  return [...errors, ...entries];
}

/**
 * Tradition multi-filter (a spell carries 0..n traditions). An EMPTY selection
 * is "no filter" — every entry stays; a non-empty selection keeps entries
 * carrying at least one of the chosen traditions (a union, never an
 * intersection — the owner filters by "these traditions", not "all of them").
 * A spell with no traditions is kept by no selection, which is honest: it is
 * not of any tradition the user asked for. Data errors always stay visible.
 */
export function filterSpellRows(
  rows: readonly SpellRow[],
  traditions: readonly SpellTradition[],
): SpellRow[] {
  if (traditions.length === 0) return [...rows];
  return rows.filter(
    (row) =>
      row.kind === 'data-error' ||
      row.traditions.some((tradition) => traditions.includes(tradition)),
  );
}
