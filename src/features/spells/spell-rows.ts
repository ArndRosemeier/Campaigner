import type {
  Id,
  RuleChunk,
  Rulebook,
  SpellData,
  SpellFilterAxis,
  SpellHeighteningEntry,
} from '@/domain';
import {
  spellChunkName,
  spellCorpusEntries,
  spellFilterValues,
  spellRankLabelFor,
  type SpellCorpusEntry,
} from '@/domain';

/**
 * The spell-corpus projection MOVED to `domain/spellData.ts` (docs/17 row 184,
 * docs/18 §2.1): `db/spellRepo` needed it and a `db` module importing this
 * FEATURE was the same layering inversion as importing the retrieval barrel.
 * Re-exported here so this feature keeps its public surface and no consumer
 * has to change twice.
 */
export { spellCorpusEntries, type SpellCorpusEntry };

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
  /** The OWN system's display spelling: `Cantrip`, `Rank N` (PF2e) or
   *  `Level N` (dnd5e) — row 194. */
  rankLabel: string;
  cantrip: boolean;
  /** The source's own dnd5e school code (`''` when it states none). */
  school: string;
  /** Which axis this row can be filtered by, from the payload (row 194);
   *  `null` = the row states none and the list says so. */
  filterAxis: SpellFilterAxis | null;
  /** The values on that axis (traditions, or the one school) — `[]` when the
   *  source states none. */
  filterValues: readonly string[];
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

/**
 * `Cantrip` or `Rank N` — the PF2e wording the pre-row-194 page used, kept as
 * the PF2e spelling of ONE system-aware rule (`domain/spellData
 * .spellRankLabelFor`); a dnd5e row goes through `spellRankLabelFor` and
 * prints `Level N`.
 */
export function spellRankLabel(rank: number, cantrip: boolean): string {
  return spellRankLabelFor(rank, cantrip, 'tradition');
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
    const name = spellChunkName(chunk);
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
      rankLabel: spellRankLabelFor(data.rank, data.cantrip, data.filterAxis),
      cantrip: data.cantrip,
      school: data.school,
      filterAxis: data.filterAxis ?? null,
      filterValues: spellFilterValues(data),
      data,
      origin: titleById.get(chunk.bookId) ?? '',
    });
  }
  entries.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  // Data errors pinned to the top — the loud state is the first thing seen.
  return [...errors, ...entries];
}


/**
 * Axis multi-filter (row 194) — the ONE filter rule for BOTH systems. A row
 * contributes `filterValues` from its OWN payload (PF2e traditions, or the one
 * dnd5e school), so a dnd5e spell can never be matched by a PF2e tradition and
 * vice versa. An EMPTY selection is "no filter" — every entry stays; a
 * non-empty selection keeps entries carrying at least one of the chosen values
 * (a union, never an intersection — the owner filters by "these values", not
 * "all of them"). A spell with NO value on its axis is kept by no selection,
 * which is honest: the row states no school/tradition, so it is not of any the
 * user asked for, and the page labels such rows as having no filter axis.
 * Data errors always stay visible.
 */
export function filterSpellRows(
  rows: readonly SpellRow[],
  selected: readonly string[],
): SpellRow[] {
  if (selected.length === 0) return [...rows];
  return rows.filter(
    (row) =>
      row.kind === 'data-error' ||
      row.filterValues.some((value) => selected.includes(value)),
  );
}
