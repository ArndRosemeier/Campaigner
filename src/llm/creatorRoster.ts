import type { Id } from '@/domain';
import { comparableName } from '@/domain/artifactAlias';
import { creatureNameSimilarity } from '@/domain/creatureName';
import { citationBookTitle } from '@/domain/encounterResolve';
import { listLibraryCreatures, type LibraryCreature } from '@/db/creatureRepo';
import { getRulebook } from '@/db/rulebookRepo';
import { libraryLevelOrder, parseLevelSort } from '@/llm/encounterRoster';

/**
 * THE MODULE CREATOR'S BESTIARY WINDOW (docs/17 row 114, docs/12 §7).
 *
 * The owner's report, verbatim: four of the twelve NPCs in one module failed
 * because the cast asked to borrow the stats of «Zombie-Schläger»,
 * «Zombie-Schlurfer» and a degenerate level-adapted variant of a name this
 * workspace's library does not hold. The request was not wrong — the prompt
 * OFFERED the bestiary slot and never showed the model a single creature it
 * could name (`llm/promptStyles.SPINE_BESTIARY` said only *'naming the library
 * creature's own name ("bestiary": { "creature": "Zombie" })'* — an example,
 * which is why a German module invented German example-shaped names). The
 * encounter/smith prompts have carried a capped roster window since §7
 * (`llm/encounterRoster`); the CREATOR was never wired to it.
 *
 * This module is that wire, and it is deliberately NOT the encounter roster:
 *
 * - **Source of truth.** It lists `db/creatureRepo.listLibraryCreatures()` —
 *   the SAME population the cast resolves against (`features/modules/
 *   entity-batch.libraryCitationForEntity`), i.e. every stat-block chunk of
 *   ANY book origin. The encounter roster narrows to ready PACK books of the
 *   campaign's system, which is right for "what can I field in this fight"
 *   and WRONG here: a library whose creatures came from an ordinary imported
 *   rulebook would produce an empty window while the slot stayed on offer, and
 *   the model would be inventing names again with the app's blessing.
 * - **Level.** `listLibraryCreatures` never returned a level, so the ordering
 *   reads the creature's OWN stat block (the same row the pool names) and
 *   parses it with the ONE parser (`encounterRoster.parseLevelSort` — a second
 *   level grammar is forbidden, docs/18 §2.2).
 * - **Ordering/cap.** Exactly the ratified §7 window: level distance to the
 *   module's target level through the SHARED comparator
 *   (`encounterRoster.libraryLevelOrder`), ties by `levelSort` then locale
 *   name, `—` (unparsable-to-Infinity) last, `CREATOR_ROSTER_LIMIT` lines with
 *   the `(roster truncated; N more)` note. Recomputed per run, never
 *   persisted: deterministic for an unchanged library.
 * - **Pack titles (docs/17 row 163, the owner's decision: *"Yes — show each
 *   creature's pack title in the vocabulary."*).** A line reads
 *   `Name — Pack Title`. Row 161 made the slot's `book` a DISAMBIGUATOR rather
 *   than a veto, so a unique name resolves whatever book the slot names — but
 *   where two installed books really do hold the same creature name, a model
 *   that cannot see a real title has to GUESS one, and a guessed title narrows
 *   nothing. Titles were withheld before because a names-only window was the
 *   ratified shape (row 114's own "considered and not taken"); with the
 *   decision taken, the model can COPY the string the resolver compares
 *   against, and `packTitle` is read with the SAME stamp reading row 155 uses
 *   for a citation (`domain/encounterResolve.citationBookTitle`), so what the
 *   prompt shows and what the cast matches are the same bytes.
 *
 * The window contains the library's OWN spelling of the name
 * (`canonicalCreatureName` — the innermost heading, the same one the cast
 * matches and the citation stamps), so a model that copies a line casts; the
 * name is rendered BARE (no `(level, traits)` decoration), because the value
 * the model must write is the name and nothing else.
 */

/** The window's cap — the §7 `ROSTER_LIMIT` of 300 lines, restated for this
 *  window because the two windows measure different populations. */
export const CREATOR_ROSTER_LIMIT = 300;

/**
 * The ONE definition of a line's shape (docs/17 row 163): the creature name,
 * then an em dash, then the pack title. Chosen over `Name (Pack Title)` because
 * a parenthesized qualifier is a REAL part of a creature name here
 * (`domain/creatureName` deliberately forgives a trailing `(…)`), so
 * `Zombie (Variant) (Monster Core)` would read as two qualifiers — while the
 * em dash is this repo's existing "aside follows" glyph (the `—` level
 * placeholder, the message prose). Three characters is also the cheapest
 * unambiguous inline separator, and the WINDOW IS A BUDGET: a per-book legend
 * (`Name [1]` + a title list) would cost a fraction of this, at the price of an
 * indirection a model can mis-map, so it is reported as the cheaper alternative
 * rather than taken (the owner asked for each creature's title, inline).
 */
export const CREATOR_ROSTER_TITLE_SEPARATOR = ' \u2014 ';

/** How many nearest creatures a refusal may name (bounded: a wall of
 *  suggestions is not an answer). */
export const CREATURE_SUGGESTION_LIMIT = 3;

/** Below this similarity a name is not close enough to be worth showing. */
export const CREATURE_SUGGESTION_FLOOR = 0.4;

/** One line of the creator's window: the creature as the cast will look it up. */
export interface CreatorRosterEntry {
  chunkId: Id;
  /** The library's own spelling of the creature's name — the castable value. */
  name: string;
  /** The printed level the ordering used (`statBlock.level`, verbatim). */
  level: string;
  levelSort: number;
  /** The book the creature's chunk belongs to — the carried row fact the
   *  window's pack title is read from (`LibraryCreature.bookId`). */
  bookId: Id;
}

/** The pack title of each book a window covers, keyed by the BOOK's id (one
 *  entry per book, never per line: a window over 300 creatures from eight packs
 *  reads eight books). A book the library has no row for, or whose own title is
 *  blank, is simply ABSENT — the line then prints its name alone (docs/17 row
 *  163): a placeholder would be a value a model could copy as if it were a
 *  title. */
export type CreatorBookTitles = ReadonlyMap<Id, string>;

export interface CreatorRoster {
  /** The window's lines, in prompt order. */
  lines: string[];
  /** Every creature the library holds (not just the window). */
  entries: CreatorRosterEntry[];
  total: number;
  truncated: number;
}

/** Loads the library pool this window is built from. Injected for tests; the
 *  production default is the ONE pool the cast resolves against. */
export type CreatorRosterDeps = () => Promise<LibraryCreature[]>;

/** Reads one book row's COPYABLE title — `undefined` when this library records
 *  none. Injected for tests; the production default is the ONE stamping read. */
export type CreatorBookTitleDeps = (bookId: Id) => Promise<string | undefined>;

const defaultDeps: CreatorRosterDeps = () => listLibraryCreatures();

/**
 * The pack title a window line may print, from the book row the chunk names:
 * the STAMP reading `domain/encounterResolve.citationBookTitle`, which is
 * `undefined` for a missing book or a blank title.
 *
 * Deliberately NOT the LABEL reading `rulebookDisplayTitle`, whose whole job is
 * to print the `Rulebook` stand-in exactly when nothing is known — correct for
 * a surface that MUST name a book, forbidden here: the model copies what it
 * sees, so a stand-in becomes a fabricated book in a module (AGENTS rule 1).
 *
 * The two private readers in `features/modules/entity-batch` (`creatureBookTitle`
 * → the LABEL reading, `citationBookTitleFor` → this stamp) are the same idea in
 * the resolver's file, which this slice must not touch (docs/17 row 163); the
 * stamp reading itself is still the ONE shared rule, so there is no second
 * answer to "which book is this chunk's" — only a `getRulebook` + one-domain-
 * function call site beside theirs, named here so the next reader sees it.
 */
const defaultBookTitleDeps: CreatorBookTitleDeps = async (bookId) =>
  citationBookTitle(await getRulebook(bookId));

/**
 * Maps the library pool into sortable entries. `listLibraryCreatures` already
 * filters to stat-block chunks carrying a name, so its own invariant (the
 * chunk it pools HAS a stat block) is what `parseLevelSort` reads — an
 * entry without one would be a broken read of the pool, not a creature to
 * skip silently. `parseLevelSort` handles the printed level ("3", "1/2", "—");
 * a level string it cannot order (empty, or junk in an imported chunk) is an
 * ERROR and fails the run loudly (AGENTS rule 1), never a creature dropped
 * from a window the model is told is the list of what exists.
 */
export function creatorRosterEntries(
  creatures: readonly LibraryCreature[],
): CreatorRosterEntry[] {
  return creatures.map((creature) => {
    const level = creature.statBlock?.level ?? '';
    return {
      chunkId: creature.chunkId,
      name: creature.name,
      level,
      levelSort: parseLevelSort(level),
      bookId: creature.bookId,
    };
  });
}

/**
 * ONE window line (docs/17 row 163): `Name — Pack Title`, or the NAME ALONE
 * when this library records no title for it. No trailing separator, no empty
 * dash, no `Unknown`: the absent half is absent (AGENTS rule 1). A title is
 * trimmed, so a whitespace-only row title prints nothing rather than a gap.
 */
export function creatorRosterLine(name: string, bookTitle: string | undefined): string {
  const title = bookTitle?.trim() ?? '';
  return title === '' ? name : `${name}${CREATOR_ROSTER_TITLE_SEPARATOR}${title}`;
}

/** The window's order (§7) and its capped slice — the ONE place the shared
 *  comparator, the tie rules and `CREATOR_ROSTER_LIMIT` are applied, so the
 *  lines and the titles read for them cannot describe different cuts. */
function creatorRosterWindow(
  entries: readonly CreatorRosterEntry[],
  targetLevel?: number,
): { sorted: CreatorRosterEntry[]; window: CreatorRosterEntry[] } {
  const sorted = [...entries].sort(
    targetLevel === undefined
      ? (left, right) => left.levelSort - right.levelSort || left.name.localeCompare(right.name)
      : libraryLevelOrder<CreatorRosterEntry>(targetLevel),
  );
  return { sorted, window: sorted.slice(0, CREATOR_ROSTER_LIMIT) };
}

function rosterFromWindow(
  sorted: readonly CreatorRosterEntry[],
  window: readonly CreatorRosterEntry[],
  bookTitles: CreatorBookTitles,
): CreatorRoster {
  return {
    lines: window.map((entry) => creatorRosterLine(entry.name, bookTitles.get(entry.bookId))),
    entries: [...sorted],
    total: sorted.length,
    truncated: Math.max(0, sorted.length - CREATOR_ROSTER_LIMIT),
  };
}

/**
 * Builds the window: ordered by level distance to `targetLevel` (the module's
 * `levelMin`/`levelMax` band midpoint, resolved by the caller — for a spine
 * run that is `(levelMin + levelMax) / 2`), else level/name ascending exactly
 * as the pre-amendment §7 window did. Capped at `CREATOR_ROSTER_LIMIT` with
 * the truncation count the formatter renders.
 *
 * `bookTitles` carries the pack titles the lines print; without it (or for a
 * book it does not cover) a line is its name alone. This is the shape a caller
 * with no library titles builds — which is why the title pins cannot pass
 * against it (they are read over `collectCreatorRoster`, the real path).
 */
export function buildCreatorRoster(
  entries: readonly CreatorRosterEntry[],
  targetLevel?: number,
  bookTitles: CreatorBookTitles = new Map<Id, string>(),
): CreatorRoster {
  const { sorted, window } = creatorRosterWindow(entries, targetLevel);
  return rosterFromWindow(sorted, window, bookTitles);
}

/**
 * Reads the pack titles for the WINDOW's books only — the lines the prompt will
 * actually carry (the cap is the prompt budget, so a 1,000-creature library
 * still costs at most `CREATOR_ROSTER_LIMIT` lines and the books behind them).
 * Read concurrently; a rejection propagates (a failed read is a loud failure,
 * never a window that silently drops its titles).
 */
async function windowBookTitles(
  window: readonly CreatorRosterEntry[],
  loadBookTitle: CreatorBookTitleDeps,
): Promise<CreatorBookTitles> {
  const titles = new Map<Id, string>();
  await Promise.all(
    [...new Set(window.map((entry) => entry.bookId))].map(async (bookId) => {
      const title = await loadBookTitle(bookId);
      if (title !== undefined) titles.set(bookId, title);
    }),
  );
  return titles;
}

/** Collects and builds the window in one call — the seam `moduleGen` uses. */
export async function collectCreatorRoster(
  targetLevel?: number,
  load: CreatorRosterDeps = defaultDeps,
  loadBookTitle: CreatorBookTitleDeps = defaultBookTitleDeps,
): Promise<CreatorRoster> {
  const entries = creatorRosterEntries(await load());
  const { sorted, window } = creatorRosterWindow(entries, targetLevel);
  return rosterFromWindow(sorted, window, await windowBookTitles(window, loadBookTitle));
}

/**
 * The library creatures closest to a name that resolved to NOTHING — the
 * actionable half of the cast refusal (docs/17 row 114). Message-only: the
 * caller renders these next to the refusal, and nothing here can cast.
 *
 * A candidate is kept only when it shares the query's LOOSE reading beyond a
 * floor (`CREATURE_SUGGESTION_FLOOR`) — token overlap or a near-miss edit —
 * so a query with nothing in the library close to it yields an EMPTY list and
 * the refusal says nothing rather than misleading (the owner's rule: if the
 * closest match is garbage, stay quiet). Ranking is by score, ties by the
 * library's own name order; the result is capped at
 * `CREATURE_SUGGESTION_LIMIT` and never repeats a name.
 *
 * Casing, whitespace, umlauts/diacritics, hyphen-vs-space and a trailing
 * parenthesized qualifier are all normalized away (`domain/creatureName`) —
 * for the RANKING only; the names returned are the library's own spellings.
 *
 * KEY SPACE `LIBRARY_CREATURE_NAME_KEY` (docs/17 row 167), the suggestion
 * half: one library creature is suggested ONCE, whatever the composition of the
 * name the cast asked for (the census half is `db/creatureCitations`).
 */
export function nearestLibraryCreatures(
  wanted: string,
  creatures: readonly LibraryCreature[],
  limit: number = CREATURE_SUGGESTION_LIMIT,
): LibraryCreature[] {
  const scored: { creature: LibraryCreature; score: number; rank: number }[] = [];
  creatures.forEach((creature, rank) => {
    const score = creatureNameSimilarity(wanted, creature.name);
    if (score >= CREATURE_SUGGESTION_FLOOR) scored.push({ creature, score, rank });
  });
  scored.sort((left, right) => right.score - left.score || left.rank - right.rank);
  const seen = new Set<string>();
  const suggestions: LibraryCreature[] = [];
  for (const candidate of scored) {
    const key = comparableName(candidate.creature.name);
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(candidate.creature);
    if (suggestions.length >= limit) break;
  }
  return suggestions;
}
