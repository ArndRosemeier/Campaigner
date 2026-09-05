import type { GameSystem } from '@/domain/gameSystem';
import type { Id, Rulebook, RuleChunk } from '@/domain';
import { listChunksByBooks } from '@/db/chunkRepo';
import { listRulebooks } from '@/db/rulebookRepo';
import { errorMessage } from '@/lib/errors';

/**
 * Encounter roster index (12-BESTIARY-PACKS §7): a compact "name (level,
 * traits)" listing of every imported pack creature for the campaign's
 * system, injected into the Encounter Smith's prompt so it picks real
 * bestiary entries (cited by exact `sourceName`) instead of inventing names.
 * The 300-line PROMPT WINDOW is ordered by level distance to the run's
 * target level when one exists (ratified §7 amendment), so a huge bestiary
 * import surfaces creatures that could actually threaten the party instead
 * of the first 300 low-CR entries; without a target the order stays
 * level/name ascending. Pure selection/formatting here; the run-engine
 * wiring is M-B.
 */

export const ROSTER_LIMIT = 300;

export interface PackRosterEntry {
  name: string;
  level: string;
  traits: string;
  chunkId: Id;
  levelSort: number;
  /** Owning pack book — drives deterministic duplicate-name resolution. */
  bookId: Id;
  /** The owning pack book's title — the duplicate-name line suffix (fix-02 decision 5). */
  bookTitle: string;
}

export interface PackRoster {
  lines: string[];
  total: number;
  truncated: number;
}

/**
 * Case-insensitive exact name → chunkId index over the roster (§7). Duplicate
 * names resolve deterministically: the most recently updated pack book wins
 * (`bookRank` is 0-based by recency — `listRulebooks` returns that order),
 * then the level/name-sorted order inside a book. The origin badge names the
 * book (§8), so a duplicate pick stays visible to the user.
 */
export function rosterNameIndex(
  entries: readonly PackRosterEntry[],
  bookRank: ReadonlyMap<Id, number> = new Map(),
): Map<string, Id> {
  const index = new Map<string, Id>();
  const rankOf = (entry: PackRosterEntry): number => bookRank.get(entry.bookId) ?? Number.MAX_SAFE_INTEGER;
  const sorted = [...entries].sort(
    (a, b) => rankOf(a) - rankOf(b) || a.levelSort - b.levelSort || a.name.localeCompare(b.name),
  );
  for (const entry of sorted) {
    const key = entry.name.trim().toLowerCase();
    if (!index.has(key)) index.set(key, entry.chunkId);
  }
  return index;
}

/** Prompt section (§7): the roster listing plus the citation instruction. */
export function formatRosterSection(lines: readonly string[], truncated: number): string | null {
  if (lines.length === 0) return null;
  return [
    'Bestiary roster — creatures available in the imported pack books:',
    ...lines,
    truncated > 0 ? `(roster truncated; ${String(truncated)} more)` : null,
    'For each monster: cite a stat-block excerpt via "sourceChunkIndex", or pick a creature from this roster by its exact name via "sourceName" (the creature name itself — never the parenthesized level/traits or a " — book" suffix), or output an inline "statBlock".',
  ]
    .filter((part) => part !== null)
    .join('\n');
}

/**
 * Numeric ordering key for printed d20 levels: "3", "-1", "1/2", "1/4".
 * The dnd5e system prints "—" for the CR-less summons (avatar of death,
 * animated objects — `details.cr: null`), which sort after every leveled
 * creature: their exact printed level IS "—", and they are temporary extras.
 */
export function parseLevelSort(level: string): number {
  const trimmed = level.trim();
  if (trimmed === '—') return Number.POSITIVE_INFINITY;
  const fraction = /^(-?\d+)\s*\/\s*(\d+)$/.exec(trimmed);
  if (fraction !== null) {
    const numerator = fraction[1];
    const denominator = fraction[2];
    if (numerator !== undefined && denominator !== undefined && Number(denominator) !== 0) {
      return Number(numerator) / Number(denominator);
    }
  }
  const value = Number(trimmed);
  if (trimmed !== '' && Number.isFinite(value)) return value;
  throw new Error(`cannot order creatures by level "${level}"`);
}

/**
 * The prompt window's target level parsed from an encounter's free-text
 * `levelHint` (§7 ratified chain, step (a)): the FIRST digit run in the
 * string, deterministically — "5" → 5, "4–6" → 4, "CR 5" → 5. A hint with no
 * digits ("", "mid") → undefined. This is a graceful preference chain, not a
 * silent fallback of erroneous data: the hint is a user preference string,
 * and "no parseable target" is a legitimate state that falls to the next
 * preference in the chain.
 */
export function parseRosterTargetLevel(levelHint: string): number | undefined {
  const match = /(\d+)/.exec(levelHint);
  const digits = match?.[1];
  return digits === undefined ? undefined : Number(digits);
}

/**
 * Distance from the window's target level. The CR-less "—" creatures
 * (`levelSort` +Infinity) sit at +Infinity so they always sort after every
 * leveled creature, exactly as today — the guard keeps `∞ − ∞` from becoming
 * a NaN comparator result when two of them tie.
 */
function levelDistance(levelSort: number, targetLevel: number): number {
  return Number.isFinite(levelSort) ? Math.abs(levelSort - targetLevel) : Number.POSITIVE_INFINITY;
}

function rosterLine(entry: PackRosterEntry, duplicatedNames: ReadonlySet<string>): string {
  const base = `${entry.name} (${entry.level}${entry.traits === '' ? '' : `, ${entry.traits}`})`;
  // fix-02 (decision 5): the " — <bookTitle>" suffix appears ONLY when the
  // name occurs in more than one ready pack book — unique names stay bare.
  if (!duplicatedNames.has(entry.name.trim().toLowerCase())) return base;
  return `${base} — ${entry.bookTitle}`;
}

/**
 * Lowercased names that occur in more than one distinct ready pack book
 * (fix-02 decision 5). Same-book duplicates resolve by the landed recency
 * order and never get a suffix — the disambiguator is for cross-book
 * ambiguity only.
 */
function duplicatedAcrossBooks(entries: readonly PackRosterEntry[]): Set<string> {
  const booksPerName = new Map<string, Set<Id>>();
  for (const entry of entries) {
    const key = entry.name.trim().toLowerCase();
    const books = booksPerName.get(key) ?? new Set<Id>();
    books.add(entry.bookId);
    booksPerName.set(key, books);
  }
  return new Set(
    [...booksPerName.entries()].filter(([, books]) => books.size > 1).map(([key]) => key),
  );
}

/**
 * Builds the prompt roster (§7). Without a `targetLevel` the window keeps the
 * historical level/name-ascending order byte-identically. With one, the
 * window orders by `|levelSort − target|` ascending — the creatures that
 * could actually threaten the target-level party — with ties broken by
 * `levelSort` ascending, then name (locale-compare): fully deterministic.
 * The cap, the line format and the truncation count are unaffected; the
 * name index is built over ALL entries by the caller, so creatures outside
 * the visible window stay resolvable.
 */
export function buildPackRoster(entries: readonly PackRosterEntry[], targetLevel?: number): PackRoster {
  const sorted = [...entries].sort(
    targetLevel === undefined
      ? (a, b) => a.levelSort - b.levelSort || a.name.localeCompare(b.name)
      : (a, b) =>
          levelDistance(a.levelSort, targetLevel) - levelDistance(b.levelSort, targetLevel) ||
          a.levelSort - b.levelSort ||
          a.name.localeCompare(b.name),
  );
  const duplicatedNames = duplicatedAcrossBooks(entries);
  return {
    // Ordering is unaffected by the suffix: lines render from the
    // sorted order (fix-02 acceptance criteria).
    lines: sorted.slice(0, ROSTER_LIMIT).map((entry) => rosterLine(entry, duplicatedNames)),
    total: sorted.length,
    truncated: Math.max(0, sorted.length - ROSTER_LIMIT),
  };
}

export interface PackRosterDeps {
  listBooks: () => Promise<Rulebook[]>;
  listChunks: (bookIds: Id[]) => Promise<RuleChunk[]>;
}

const defaultDeps: PackRosterDeps = {
  listBooks: () => listRulebooks(),
  listChunks: (bookIds) => listChunksByBooks(bookIds),
};

/**
 * Collects the roster for a campaign system over every ready pack book
 * (§7: origin 'pack', matching system, status 'ready' — books arrive most
 * recently updated first). Chunks without a validated stat block must not
 * exist in pack books (the importer enforces it), so encountering one is a
 * loud data error, not a skip. `targetLevel` orders the PROMPT WINDOW by
 * level distance (§7 ratified amendment); undefined keeps the ascending
 * order. The name index always covers every entry.
 */
export async function collectPackRoster(
  system: GameSystem,
  deps: PackRosterDeps = defaultDeps,
  targetLevel?: number,
): Promise<PackRoster & { entries: PackRosterEntry[]; chunkByName: Map<string, Id> }> {
  const books = (await deps.listBooks()).filter(
    (book) => book.system === system && book.origin === 'pack' && book.status === 'ready',
  );
  const titleById = new Map(books.map((book) => [book.id, book.title]));
  const bookRank = new Map(books.map((book, index) => [book.id, index]));
  const chunks = await deps.listChunks(books.map((book) => book.id));
  const entries: PackRosterEntry[] = [];
  for (const chunk of chunks) {
    if (chunk.chunkType !== 'statblock' || chunk.statBlock === null) {
      throw new Error(`pack chunk ${chunk.id} has no validated stat block — re-import the pack`);
    }
    const name = chunk.headingPath[0];
    if (name === undefined || name.trim() === '') {
      throw new Error(`pack chunk ${chunk.id} has no creature name in its heading`);
    }
    entries.push({
      name,
      level: chunk.statBlock.level,
      traits: chunk.statBlock.extras.Traits ?? '',
      chunkId: chunk.id,
      levelSort: parseLevelSort(chunk.statBlock.level),
      bookId: chunk.bookId,
      bookTitle: titleById.get(chunk.bookId) ?? '',
    });
  }
  return { entries, chunkByName: rosterNameIndex(entries, bookRank), ...buildPackRoster(entries, targetLevel) };
}

/** ROSTER_ATTEMPTS (fix-02 decision 4): one automatic retry, then loud. */
export const ROSTER_ATTEMPTS = 2;

/**
 * fix-02 (decision 4): a failing roster build retries automatically —
 * bounded, 2 attempts total — so a transient read failure does not kill an
 * otherwise runnable encounter. A persistent failure throws a NAMED error
 * identifying the roster and system, with the underlying cause (which names
 * the offending book/chunk, e.g. "pack chunk <id> has no validated stat
 * block — re-import the pack") attached. There is no silent inline-only
 * fallback: the caller fails the run loudly.
 */
export async function collectPackRosterWithRetry(
  system: GameSystem,
  deps: PackRosterDeps = defaultDeps,
  attempts: number = ROSTER_ATTEMPTS,
  targetLevel?: number,
): Promise<PackRoster & { entries: PackRosterEntry[]; chunkByName: Map<string, Id> }> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await collectPackRoster(system, deps, targetLevel);
    } catch (error) {
      lastError = error;
    }
  }
  const cause = errorMessage(lastError);
  throw new Error(
    `Bestiary pack roster for system "${system}" failed after ${String(attempts)} attempts: ${cause}`,
    { cause: lastError ?? undefined },
  );
}
