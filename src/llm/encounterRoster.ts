import type { GameSystem } from '@/domain/gameSystem';
import type { Id, Rulebook, RuleChunk } from '@/domain';
import { listChunksByBooks } from '@/db/chunkRepo';
import { listRulebooks } from '@/db/rulebookRepo';

/**
 * Encounter roster index (12-BESTIARY-PACKS §7): a compact, level-ordered
 * "name (level, traits)" listing of every imported pack creature for the
 * campaign's system, injected into the Encounter Smith's prompt so it picks
 * real bestiary entries (cited by exact `sourceName`) instead of inventing
 * names. Pure selection/formatting here; the run-engine wiring is M-B.
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
    'For each monster: cite a stat-block excerpt via "sourceChunkIndex", or pick a creature from this roster by its exact name via "sourceName", or output an inline "statBlock".',
  ]
    .filter((part) => part !== null)
    .join('\n');
}

/** Numeric ordering key for printed d20 levels: "3", "-1", "1/2", "1/4". */
export function parseLevelSort(level: string): number {
  const trimmed = level.trim();
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

function rosterLine(entry: PackRosterEntry): string {
  return `${entry.name} (${entry.level}${entry.traits === '' ? '' : `, ${entry.traits}`})`;
}

export function buildPackRoster(entries: readonly PackRosterEntry[]): PackRoster {
  const sorted = [...entries].sort(
    (a, b) => a.levelSort - b.levelSort || a.name.localeCompare(b.name),
  );
  return {
    lines: sorted.slice(0, ROSTER_LIMIT).map(rosterLine),
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
 * loud data error, not a skip.
 */
export async function collectPackRoster(
  system: GameSystem,
  deps: PackRosterDeps = defaultDeps,
): Promise<PackRoster & { entries: PackRosterEntry[]; chunkByName: Map<string, Id> }> {
  const books = (await deps.listBooks()).filter(
    (book) => book.system === system && book.origin === 'pack' && book.status === 'ready',
  );
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
    });
  }
  return { entries, chunkByName: rosterNameIndex(entries, bookRank), ...buildPackRoster(entries) };
}
