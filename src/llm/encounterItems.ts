import type { GameSystem } from '@/domain/gameSystem';
import type { Id, Rulebook, RuleChunk } from '@/domain';
import { listChunksByBooks } from '@/db/chunkRepo';
import { listRulebooks } from '@/db/rulebookRepo';
import { errorMessage } from '@/lib/errors';

/**
 * Encounter item pool (12-BESTIARY-PACKS §13): a compact "name (category,
 * level, price)" listing of every imported pack item for the campaign's
 * system, injected into the Encounter Smith's prompt so it can reward the
 * party with real equipment (cited by exact item name) instead of inventing
 * magic items. The roster's item counterpart, sharing its conventions:
 * deterministic ordering, a hard prompt-window cap, a case-insensitive name
 * index, counted truncation, and automatic retry. Pure selection/formatting
 * here; the run-engine wiring is the item-corpus arc's commit 6.
 */

export const ITEM_POOL_LIMIT = 120;

/** One automatic retry on a failing pool build, then loud (mirrors the roster). */
export const ITEM_POOL_ATTEMPTS = 2;

export interface ItemPoolFilter {
  /** Only items at or below this level (leveled systems; null-level items drop out). */
  level?: number;
  /** Only items with a stated price at or below this many cp. */
  priceCp?: number;
  /** Only items whose verbatim rarity is in this set ('' included for mundane). */
  rarities?: readonly string[];
  /** Only items whose verbatim category is in this set. */
  categories?: readonly string[];
}

export interface ItemPoolEntry {
  name: string;
  category: string;
  /** Printed level label — dnd5e items store none, rendering as "—". */
  level: string;
  priceDisplay: string;
  rarity: string;
  chunkId: Id;
  /** Ordering keys: a null level/price sorts after every leveled/priced item. */
  levelSort: number;
  priceSort: number;
  /** Owning pack book — drives deterministic duplicate-name resolution. */
  bookId: Id;
  /** The owning pack book's title — the duplicate-name line suffix. */
  bookTitle: string;
}

export interface ItemPool {
  lines: string[];
  total: number;
  truncated: number;
}

/**
 * Case-insensitive exact name → chunkId index over the pool (the roster's
 * convention). Duplicate names resolve deterministically: the most recently
 * updated pack book wins (`bookRank` is 0-based by recency — `listRulebooks`
 * returns that order), then the pool's sorted order inside a book.
 */
export function itemPoolNameIndex(
  entries: readonly ItemPoolEntry[],
  bookRank: ReadonlyMap<Id, number> = new Map(),
): Map<string, Id> {
  const index = new Map<string, Id>();
  const rankOf = (entry: ItemPoolEntry): number => bookRank.get(entry.bookId) ?? Number.MAX_SAFE_INTEGER;
  const sorted = [...entries].sort(
    (a, b) =>
      rankOf(a) - rankOf(b) ||
      a.levelSort - b.levelSort ||
      a.priceSort - b.priceSort ||
      a.name.localeCompare(b.name),
  );
  for (const entry of sorted) {
    const key = entry.name.trim().toLowerCase();
    if (!index.has(key)) index.set(key, entry.chunkId);
  }
  return index;
}

/** Prompt section (§13): the pool listing plus the item-grounding instruction. */
export function formatItemPoolSection(lines: readonly string[], truncated: number): string | null {
  if (lines.length === 0) return null;
  return [
    'Item pool — equipment available in the imported pack books:',
    ...lines,
    truncated > 0 ? `(pool truncated; ${String(truncated)} more)` : null,
    'For treasure and equipment rewards: when the encounter includes treasure, name items from this pool verbatim in the "treasure" field (exact item names — never the parenthesized details or a " — book" suffix). Never invent magic items that are not in this pool.',
  ]
    .filter((part) => part !== null)
    .join('\n');
}

/**
 * The item ordering key for printed levels: pf2e items print real integer
 * levels; dnd5e items print none (null levelData → "—"), which sort after
 * every leveled item exactly like the roster's CR-less creatures.
 */
export function itemLevelSort(level: string): number {
  const trimmed = level.trim();
  if (trimmed === '—') return Number.POSITIVE_INFINITY;
  const value = Number(trimmed);
  if (trimmed !== '' && Number.isFinite(value)) return value;
  throw new Error(`cannot order items by level "${level}"`);
}

function levelDistance(levelSort: number, targetLevel: number): number {
  return Number.isFinite(levelSort) ? Math.abs(levelSort - targetLevel) : Number.POSITIVE_INFINITY;
}

function itemLine(entry: ItemPoolEntry, duplicatedNames: ReadonlySet<string>): string {
  const details = [
    entry.category,
    entry.level === '—' ? null : `Level ${entry.level}`,
    entry.priceDisplay,
    entry.rarity === '' ? null : entry.rarity,
  ]
    .filter((part) => part !== null)
    .join(', ');
  const base = `${entry.name} (${details})`;
  // The " — <bookTitle>" suffix appears ONLY when the name occurs in more
  // than one ready pack book — unique names stay bare (fix-02 decision 5).
  if (!duplicatedNames.has(entry.name.trim().toLowerCase())) return base;
  return `${base} — ${entry.bookTitle}`;
}

/**
 * Lowercased names that occur in more than one distinct ready pack book.
 * Same-book duplicates resolve by the landed recency order and never get a
 * suffix — the disambiguator is for cross-book ambiguity only.
 */
function duplicatedAcrossBooks(entries: readonly ItemPoolEntry[]): Set<string> {
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
 * Builds the prompt pool (§13). The optional filter narrows BEFORE ordering
 * and the cap — a filtered-out item is outside the encounter's context, not
 * a truncated tail. Without a `targetLevel` the window keeps the
 * level/price/name-ascending order. With one, the window orders by
 * `|levelSort − target|` ascending — equipment relevant to the target-level
 * party — with ties broken by `levelSort`, then price (unpriced last), then
 * name (locale-compare): fully deterministic. The name index is built over
 * ALL entries by the caller, so items outside the visible window stay
 * resolvable.
 */
export function buildItemPool(
  entries: readonly ItemPoolEntry[],
  filter: ItemPoolFilter = {},
  targetLevel?: number,
): ItemPool {
  const narrowed = entries.filter((entry) => {
    if (filter.level !== undefined && entry.levelSort > filter.level) return false;
    if (filter.priceCp !== undefined && entry.priceSort > filter.priceCp) return false;
    if (filter.rarities !== undefined && !filter.rarities.includes(entry.rarity)) return false;
    if (filter.categories !== undefined && !filter.categories.includes(entry.category)) return false;
    return true;
  });
  const sorted = [...narrowed].sort(
    targetLevel === undefined
      ? (a, b) =>
          a.levelSort - b.levelSort || a.priceSort - b.priceSort || a.name.localeCompare(b.name)
      : (a, b) =>
          levelDistance(a.levelSort, targetLevel) - levelDistance(b.levelSort, targetLevel) ||
          a.levelSort - b.levelSort ||
          a.priceSort - b.priceSort ||
          a.name.localeCompare(b.name),
  );
  const duplicatedNames = duplicatedAcrossBooks(entries);
  return {
    lines: sorted.slice(0, ITEM_POOL_LIMIT).map((entry) => itemLine(entry, duplicatedNames)),
    total: sorted.length,
    truncated: Math.max(0, sorted.length - ITEM_POOL_LIMIT),
  };
}

export interface ItemPoolDeps {
  listBooks: () => Promise<Rulebook[]>;
  listChunks: (bookIds: Id[]) => Promise<RuleChunk[]>;
}

const defaultDeps: ItemPoolDeps = {
  listBooks: () => listRulebooks(),
  listChunks: (bookIds) => listChunksByBooks(bookIds),
};

/**
 * Collects the item pool for a campaign system over every ready pack book
 * that actually imported items (§13: origin 'pack', matching system, status
 * 'ready', packMeta.itemsImported > 0 — books arrive most recently updated
 * first). Only item chunks are considered; a chunk typed `item` without
 * validated item data must not exist (the importer enforces it), so
 * encountering one is a loud data error, not a skip. Creature-only books of
 * the same system contribute nothing (the roster's input, not the pool's).
 */
export async function collectItemPool(
  system: GameSystem,
  deps: ItemPoolDeps = defaultDeps,
  filter: ItemPoolFilter = {},
  targetLevel?: number,
): Promise<ItemPool & { entries: ItemPoolEntry[]; chunkByName: Map<string, Id> }> {
  const books = (await deps.listBooks()).filter(
    (book) =>
      book.system === system &&
      book.origin === 'pack' &&
      book.status === 'ready' &&
      (book.packMeta?.itemsImported ?? 0) > 0,
  );
  const titleById = new Map(books.map((book) => [book.id, book.title]));
  const bookRank = new Map(books.map((book, index) => [book.id, index]));
  const chunks = await deps.listChunks(books.map((book) => book.id));
  const entries: ItemPoolEntry[] = [];
  for (const chunk of chunks) {
    if (chunk.chunkType !== 'item') continue;
    const item = chunk.itemData;
    if (item === null || item === undefined) {
      throw new Error(`pack chunk ${chunk.id} has no validated item data — re-import the pack`);
    }
    const name = chunk.headingPath[0];
    if (name === undefined || name.trim() === '') {
      throw new Error(`pack chunk ${chunk.id} has no item name in its heading`);
    }
    const level = item.level === null ? '—' : String(item.level);
    entries.push({
      name,
      category: item.category,
      level,
      priceDisplay: item.priceDisplay,
      rarity: item.rarity,
      chunkId: chunk.id,
      levelSort: itemLevelSort(level),
      priceSort: item.priceCp ?? Number.POSITIVE_INFINITY,
      bookId: chunk.bookId,
      bookTitle: titleById.get(chunk.bookId) ?? '',
    });
  }
  return { entries, chunkByName: itemPoolNameIndex(entries, bookRank), ...buildItemPool(entries, filter, targetLevel) };
}

/**
 * A failing item pool build retries automatically — bounded, 2 attempts
 * total — so a transient read failure does not kill an otherwise runnable
 * encounter. A persistent failure throws a NAMED error identifying the pool
 * and system, with the underlying cause (which names the offending book/
 * chunk) attached. There is no silent inline-only fallback: the caller fails
 * the run loudly.
 */
export async function collectItemPoolWithRetry(
  system: GameSystem,
  deps: ItemPoolDeps = defaultDeps,
  attempts: number = ITEM_POOL_ATTEMPTS,
  filter: ItemPoolFilter = {},
  targetLevel?: number,
): Promise<ItemPool & { entries: ItemPoolEntry[]; chunkByName: Map<string, Id> }> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await collectItemPool(system, deps, filter, targetLevel);
    } catch (error) {
      lastError = error;
    }
  }
  const cause = errorMessage(lastError);
  throw new Error(
    `Item pack pool for system "${system}" failed after ${String(attempts)} attempts: ${cause}`,
    { cause: lastError ?? undefined },
  );
}
