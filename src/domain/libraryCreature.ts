import { comparableName } from '@/domain/artifactAlias';
import type { GameSystem } from '@/domain/gameSystem';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { creatureLibraryName, sameCreatureName } from '@/domain/creatureName';
import { contentIdentityFor, rulebookDisplayTitle } from '@/domain/encounterResolve';
import type { CreatureCitation } from '@/domain/encounterResolve';
import type { EntityBestiarySlot } from '@/domain/module';
import type { Id, RuleChunk, Rulebook } from '@/domain';

/**
 * THE library-creature resolution seam (docs/17 row 248's remaining slice).
 *
 * ONE algorithm answers "which library creature does this NAME mean?", and it
 * exists so the answer can be given from BOTH a live read (the module creator's
 * cast, `features/modules/entity-batch.libraryCitationForEntity`) and from
 * INSIDE A DEXIE TRANSACTION (the v24 mob-copy migration's module arm, which
 * runs before the upgraded `db` instance is usable). Before this seam the
 * algorithm lived in the feature and read `db` directly, so the migration could
 * not reach it — and a second copy of the name match is exactly the
 * fragmentation AGENTS §Centralization forbids.
 *
 * THE POOL DERIVATION IS PART OF THE SEAM, not a second thing beside it: a
 * caller hands in the raw `chunks` and (when it knows the campaign's system) the
 * `books` the chunks come from, and gets the same pool `db/creatureRepo
 * .listLibraryCreatures` returns — one filter (a stat block, a usable heading, a
 * book of the requested system) and one sort. `listLibraryCreatures` itself now
 * CALLS this, so the tx-backed arm and the live arm cannot drift.
 *
 * The module owns NO IO: callers inject the pool and the two book-title reads.
 * That is what makes it callable from a transaction. Both title reads are the
 * SAME `rulebookDisplayTitle` / `citationBookTitle` rules the rest of the app
 * uses, applied to the books the caller already read.
 */

/** One library creature of the pool — a chunk-derived fact, never a row. */
export interface LibraryCreature {
  chunkId: Id;
  name: string;
  contentHash: string;
  headingPath: readonly string[];
  statBlock: RuleChunk['statBlock'];
  bookId: Id;
}

/** The books a pool's chunks belong to, indexed by the chunk they cover — what
 * a caller with the chunks in hand reads once (`bulkGet`) and hands in. */
export type BookIndex = ReadonlyMap<Id, Rulebook>;

/** The book row a chunk names, or `undefined` when it is absent. */
function bookOf(chunk: RuleChunk, books: BookIndex): Rulebook | undefined {
  return books.get(chunk.bookId);
}

/**
 * The READER-FACING title of the book a chunk names — `rulebookDisplayTitle`'s
 * own reading (the row's title, or the `Rulebook` stand-in when it is absent or
 * blank), which is what a bestiary slot's `book` is compared against. THE one
 * such read for the seam, so a caller never spells the placeholder itself.
 */
export function bookDisplayTitleOf(chunkId: Id, chunks: readonly RuleChunk[], books: BookIndex): string {
  const chunk = chunks.find((row) => row.id === chunkId);
  return rulebookDisplayTitle(chunk === undefined ? undefined : bookOf(chunk, books));
}

/**
 * The title a citation STAMPS for the book a chunk names (`citationBookTitle`:
 * the row's own title, or `undefined` when the row is absent or blank — never
 * the placeholder). THE one such read for the seam.
 */
export function bookStampTitleOf(
  chunkId: Id,
  chunks: readonly RuleChunk[],
  books: BookIndex,
): string | undefined {
  const chunk = chunks.find((row) => row.id === chunkId);
  const title = chunk === undefined ? '' : (bookOf(chunk, books)?.title.trim() ?? '');
  return title === '' ? undefined : title;
}

/** The book rows a set of chunks names, read once from the caller's own table —
 * what `libraryCreaturePool`'s optional `books` wants, and what the two title
 * readers above read. Kept here so a caller does not spell the dedupe twice. */
export function bookIdsOf(chunks: readonly RuleChunk[]): Id[] {
  return [...new Set(chunks.map((chunk) => chunk.bookId))];
}

/**
 * THE pool derivation: every stat-block chunk as a library creature, optionally
 * narrowed to one game system by the OWNING BOOK (a chunk carries no system of
 * its own — docs/17 row 207; its stat block's `system` is the ADAPTER's reading
 * and would answer the wrong question).
 *
 * Pure and synchronous: `books` is what the caller's own table read produced, so
 * a transaction can supply the tx's table. The sort is by name then chunk id,
 * which is what makes the wiki-link resolver's first-wins answer stable rather
 * than a race.
 */
export function libraryCreaturePool(
  chunks: readonly RuleChunk[],
  options: { system?: GameSystem | undefined; books?: BookIndex | undefined },
): LibraryCreature[] {
  const system = options.system;
  const books = options.books ?? new Map<Id, Rulebook>();
  const creatures: LibraryCreature[] = [];
  for (const chunk of chunks) {
    if (chunk.statBlock === null) continue;
    if (system !== undefined && bookOf(chunk, books)?.system !== system) continue;
    const name = creatureLibraryName(chunk);
    if (name === null) continue;
    creatures.push({
      chunkId: chunk.id,
      name,
      contentHash: chunk.contentHash,
      headingPath: chunk.headingPath,
      statBlock: chunk.statBlock,
      bookId: chunk.bookId,
    });
  }
  creatures.sort((left, right) => {
    const byName = comparableName(left.name).localeCompare(comparableName(right.name));
    return byName !== 0 ? byName : left.chunkId.localeCompare(right.chunkId);
  });
  return creatures;
}

/**
 * Resolve a module entity's bestiary SLOT to a library CREATURE CITATION — the
 * ONE name match (docs/17 row 161's rules, docs/17 row 166's one comparison).
 *
 * `pool` is the library creature pool the caller already holds (live read or
 * tx-backed). `bookTitleOf` answers each candidate's READER-FACING book title
 * (`rulebookDisplayTitle`: the row's own title, or the `Rulebook` stand-in) and
 * is read only when the name is AMBIGUOUS or a failure has to name the
 * candidates — never on the unique-name arm, so the common case costs nothing
 * and a slot's book cannot veto a unique answer. `stampBookTitleOf` answers the
 * title a citation STAMPS (`citationBookTitle`: the row's own title, or nothing
 * — never the placeholder) and is read once for the resolved candidate.
 *
 * Every failure is LOUD and NAMES both halves (AGENTS rules 1-3): a name the
 * library cannot supply, or an ambiguity the slot's book does not narrow to
 * exactly one candidate. `nearest` is the caller's suggestion list (a MESSAGE,
 * never a resolution) and is omitted where no suggestion is wanted — the
 * migration reports the failure into `settings.mobCopyRepair` and needs the
 * reason, not a "did you mean".
 */
export async function libraryCitationForSlot(
  entityName: string,
  slot: EntityBestiarySlot,
  pool: readonly LibraryCreature[],
  options: {
    bookTitleOf: (chunkId: Id) => Promise<string | undefined>;
    stampBookTitleOf: (chunkId: Id) => Promise<string | undefined>;
    system?: GameSystem | undefined;
    nearest?:
      | ((wanted: string, pool: readonly LibraryCreature[]) => readonly LibraryCreature[])
      | undefined;
  },
): Promise<CreatureCitation> {
  const wanted = slot.creature.trim();
  const book = slot.book?.trim() ?? '';
  const named = `the entity «${entityName}» asks to borrow the stats of «${wanted}»`;
  // The ONE creature-name comparison (docs/17 row 166, never re-stated here).
  const sameName = pool.filter((creature) => sameCreatureName(creature.name, wanted));
  const titleOf = new Map<string, string>();
  const titleFor = async (chunkId: Id): Promise<string> => {
    const cached = titleOf.get(chunkId);
    if (cached !== undefined) return cached;
    const title = (await options.bookTitleOf(chunkId)) ?? rulebookDisplayTitle(undefined);
    titleOf.set(chunkId, title);
    return title;
  };
  const describe = async (entries: readonly LibraryCreature[]): Promise<string> => {
    const lines = await Promise.all(
      entries.map(async (entry) => `${entry.name} (${await titleFor(entry.chunkId)})`),
    );
    return lines.join(', ');
  };
  if (sameName.length === 0) {
    const nearest = options.nearest?.(wanted, pool) ?? [];
    const suggestion =
      nearest.length === 0
        ? ''
        : ` — the nearest creatures this library holds: ${await describe(nearest)}`;
    const system = options.system;
    throw new Error(
      `bestiary cast: ${named}, but this workspace's library holds no creature of that name` +
        `${system === undefined ? '' : ` for ${GAME_SYSTEM_LABELS[system]}`} — ` +
        'import the book it comes from, or name a creature the library has (never a guess)' +
        suggestion,
    );
  }
  let resolved: LibraryCreature | undefined;
  if (sameName.length === 1) {
    // EXACTLY ONE — RESOLVE IT (docs/17 row 161, rule 2). The slot's book has
    // nothing to disambiguate and is not consulted at all.
    resolved = sameName[0];
  } else {
    let candidates = sameName;
    if (book !== '') {
      candidates = [];
      for (const entry of sameName) {
        if ((await titleFor(entry.chunkId)).toLowerCase() === book.toLowerCase()) {
          candidates.push(entry);
        }
      }
    }
    if (candidates.length !== 1) {
      throw new Error(
        `bestiary cast: ${named}, but this workspace's library holds ${String(sameName.length)} creatures ` +
          `of that name (${await describe(sameName)}) — name the book in the entity's bestiary slot ` +
          '("book": the book\'s title) so the cast is unambiguous',
      );
    }
    resolved = candidates[0];
  }
  if (resolved === undefined) {
    throw new Error(`bestiary cast: ${named}, and no library creature answered the name`);
  }
  // Built the way every other citation site builds one — through the ONE
  // `contentIdentityFor` constructor (docs/17 row 155) — so a cast made here
  // and a cast made from the bestiary browser share ONE identity.
  return {
    chunkId: resolved.chunkId,
    ...contentIdentityFor(
      resolved.contentHash,
      resolved.name,
      resolved.name,
      await options.stampBookTitleOf(resolved.chunkId),
    ),
  };
}
