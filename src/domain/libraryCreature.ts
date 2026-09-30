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
 * THE refusal that means "no creature of this NAME answers in the library" —
 * either the library holds none, or it holds several and the caller named no
 * book to disambiguate them (docs/17 row 349).
 *
 * It is a NAMED class for the same reason its level-filtered sibling below is:
 * the answer to it can be DESIGNED rather than exceptional. The module batch
 * lets it propagate (a cast it cannot make fails the batch loudly), but the
 * clean-cut ROSTER REPAIR (`db/mobStatRepair`) must record it as the honest
 * "this row stays statless" arm and carry on with the other rows — and it may
 * not do that by catching everything, which would swallow a real failure (a
 * broken pool read) as if it were an unresolvable name (AGENTS rule 1). A
 * caller catches exactly THIS class and nothing else.
 *
 * The MESSAGE is unchanged by the class: every pre-349 pin matches on the
 * sentence, not the type.
 */
export class NoLibraryCreatureError extends Error {
  /** The caller that asked (a module entity, or a roster row being repaired). */
  readonly entityName: string;
  /** The creature name the caller asked for. */
  readonly wanted: string;

  constructor(entityName: string, wanted: string, message: string) {
    super(message);
    this.name = 'NoLibraryCreatureError';
    this.entityName = entityName;
    this.wanted = wanted;
  }
}

/**
 * THE refusal that means "the library holds nothing this entity can be cast
 * from AT ITS RECORDED LEVEL" (docs/17 row 302).
 *
 * It is a NAMED class, not a sentence a caller matches on, because the batch's
 * answer to it is DESIGNED rather than exceptional: the entity takes the
 * AUTHORED path and a block is minted at the recorded level, and the run NAMES
 * what happened on the batch's report funnel. A caller catches exactly this
 * class and nothing else, so a real failure (a broken pool read, an unreadable
 * level) can never be mistaken for the fallback (AGENTS rule 1: no catch-all).
 * It is thrown ONLY when a level was supplied — with no level the seam keeps
 * its pre-302 refusals byte for byte.
 */
export class NoLevelAppropriateCreatureError extends Error {
  /** The entity whose slot asked for the cast. */
  readonly entityName: string;
  /** The creature name the slot asked to borrow the stats of. */
  readonly wanted: string;
  /** The recorded level the cast had to honour. */
  readonly level: number;

  constructor(entityName: string, wanted: string, level: number, message: string) {
    super(message);
    this.name = 'NoLevelAppropriateCreatureError';
    this.entityName = entityName;
    this.wanted = wanted;
    this.level = level;
  }
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
 * THE ENTITY'S RECORDED LEVEL IS AN OPTIONAL FIFTH ARGUMENT (docs/17 row 302,
 * the owner: *"Level should really be honored since difficulty is tuned to it.
 * If no mob can be found at that level that is close enough, generate one."*).
 * ABSENT it, every byte of this function's behaviour is the pre-302 behaviour:
 * the same name match, the same two refusals, the same citation. SUPPLIED, the
 * name matches are FILTERED to candidates whose own stat block is AT that level
 * — the level read through the caller's injected `levelSortOf`, which binds the
 * ONE grammar (`encounterRoster.libraryCreatureLevelSort`) — and the resolution
 * then runs over what is left: exactly one resolves, several still need the
 * slot's book. The filter is a FILTER, never a new fuzzy match and never a new
 * constant: the candidate set is still the resolution's own strict name match
 * (`sameCreatureName`), so a level can never make the seam cast a DIFFERENT
 * creature than the module asked for.
 *
 * WHEN THE FILTER LEAVES NOTHING the seam REFUSES with
 * `NoLevelAppropriateCreatureError` — the caller's cue to author the entity at
 * that level instead (the module's recorded slot STAYS; the decision is
 * re-evaluated per run, so importing the right-level creature later casts it).
 * That arm covers both spellings of "nothing at that level": the name exists
 * only at other levels, and the name is not in the library at all. Both name the
 * facts: the levels the library DOES hold for that name, or `nearest`'s
 * suggestions when it holds the name nowhere.
 *
 * Every failure is LOUD and NAMES both halves (AGENTS rules 1-3): a name the
 * library cannot supply, an ambiguity the slot's book does not narrow to
 * exactly one candidate, or a level nothing answers. `nearest` is the caller's
 * suggestion list (a MESSAGE, never a resolution) and is omitted where no
 * suggestion is wanted.
 *
 * THE TWO UNRESOLVED ARMS ARE A NAMED CLASS (`NoLibraryCreatureError`, docs/17
 * row 349), not a bare `Error` a caller has to read the sentence of: the
 * clean-cut roster repair must record "this row stays statless" and carry on
 * with the other rows, and catching exactly this class is what keeps that from
 * becoming a catch-all that swallows a real failure (a broken pool read) as if
 * it were an unresolvable name. The MESSAGE is byte-unchanged by the class.
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
    /**
     * The candidate's own level as an ORDERING KEY, or `undefined` when its
     * stat block states none. Injected so this module stays a tx-callable leaf
     * with no `llm/**` dependency; the ONE implementation is
     * `encounterRoster.libraryCreatureLevelSort`. REQUIRED whenever `level` is
     * supplied: a level with no reader is a loud refusal, never a silent skip.
     */
    levelSortOf?: ((creature: LibraryCreature) => number | undefined) | undefined;
  },
  level?: number,
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
  // THE LEVEL FILTER (docs/17 row 302). ABSENT a level, `atLevel` IS `sameName`
  // (the same array), so every line below behaves exactly as before. SUPPLIED,
  // the candidate set is the name matches whose own stat block is AT that level,
  // read through the caller's injected ONE grammar — the level is a FILTER over
  // the resolution's own strict name match, never a fuzzy resolution.
  let atLevel = sameName;
  if (level !== undefined) {
    const levelSortOf = options.levelSortOf;
    if (levelSortOf === undefined) {
      throw new Error(
        `bestiary cast: ${named}, and a recorded level (${String(level)}) was supplied, but no level ` +
          'reader was — the seam cannot compare levels without the ONE grammar (docs/17 row 302)',
      );
    }
    atLevel = sameName.filter((creature) => levelSortOf(creature) === level);
    if (atLevel.length === 0) {
      // NOTHING AT THAT LEVEL — the designed miss the CALLER turns into the
      // authored path. The message names WHICH nothing: the levels the library
      // does hold for that name, or (when it holds the name nowhere) the row-114
      // suggestions through the SAME `nearest` seam — never a second matcher.
      const held = sameName
        .map((creature) => creature.statBlock?.level ?? '')
        .filter((printed) => printed.trim() !== '');
      const nearest = options.nearest?.(wanted, pool) ?? [];
      const detail =
        held.length > 0
          ? ` — the library holds «${wanted}» at ${held.join(', ')}`
          : nearest.length === 0
            ? ''
            : ` — the nearest creatures this library holds: ${await describe(nearest)}`;
      throw new NoLevelAppropriateCreatureError(
        entityName,
        wanted,
        level,
        `bestiary cast: ${named}, but this workspace's library holds no creature of that name at ` +
          `level ${String(level)}${detail} — the entity is authored at that level instead`,
      );
    }
  }
  if (sameName.length === 0) {
    const nearest = options.nearest?.(wanted, pool) ?? [];
    const suggestion =
      nearest.length === 0
        ? ''
        : ` — the nearest creatures this library holds: ${await describe(nearest)}`;
    const system = options.system;
    throw new NoLibraryCreatureError(
      entityName,
      wanted,
      `bestiary cast: ${named}, but this workspace's library holds no creature of that name` +
        `${system === undefined ? '' : ` for ${GAME_SYSTEM_LABELS[system]}`} — ` +
        'import the book it comes from, or name a creature the library has (never a guess)' +
        suggestion,
    );
  }
  let resolved: LibraryCreature | undefined;
  if (atLevel.length === 1) {
    // EXACTLY ONE — RESOLVE IT (docs/17 row 161, rule 2). The slot's book has
    // nothing to disambiguate and is not consulted at all.
    resolved = atLevel[0];
  } else {
    let candidates = atLevel;
    if (book !== '') {
      candidates = [];
      for (const entry of atLevel) {
        if ((await titleFor(entry.chunkId)).toLowerCase() === book.toLowerCase()) {
          candidates.push(entry);
        }
      }
    }
    if (candidates.length !== 1) {
      // The candidates are the level-filtered set when a level was supplied, so
      // the sentence names THAT set (and its level); with no level `atLevel` IS
      // `sameName`, and these bytes are the pre-302 refusal exactly.
      const atLevelClause = level === undefined ? '' : ` at level ${String(level)}`;
      throw new NoLibraryCreatureError(
        entityName,
        wanted,
        `bestiary cast: ${named}, but this workspace's library holds ${String(atLevel.length)} creatures ` +
          `of that name${atLevelClause} (${await describe(atLevel)}) — name the book in the entity's bestiary slot ` +
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
