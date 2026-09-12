import type { Id } from '@/domain';
import { creatureNameSimilarity } from '@/domain/creatureName';
import { listLibraryCreatures, type LibraryCreature } from '@/db/creatureRepo';
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
}

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

const defaultDeps: CreatorRosterDeps = () => listLibraryCreatures();

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
    };
  });
}

/**
 * Builds the window: ordered by level distance to `targetLevel` (the module's
 * `levelMin`/`levelMax` band midpoint, resolved by the caller — for a spine
 * run that is `(levelMin + levelMax) / 2`), else level/name ascending exactly
 * as the pre-amendment §7 window did. Capped at `CREATOR_ROSTER_LIMIT` with
 * the truncation count the formatter renders.
 */
export function buildCreatorRoster(
  entries: readonly CreatorRosterEntry[],
  targetLevel?: number,
): CreatorRoster {
  const sorted = [...entries].sort(
    targetLevel === undefined
      ? (left, right) => left.levelSort - right.levelSort || left.name.localeCompare(right.name)
      : libraryLevelOrder<CreatorRosterEntry>(targetLevel),
  );
  return {
    lines: sorted.slice(0, CREATOR_ROSTER_LIMIT).map((entry) => entry.name),
    entries: sorted,
    total: sorted.length,
    truncated: Math.max(0, sorted.length - CREATOR_ROSTER_LIMIT),
  };
}

/** Collects and builds the window in one call — the seam `moduleGen` uses. */
export async function collectCreatorRoster(
  targetLevel?: number,
  load: CreatorRosterDeps = defaultDeps,
): Promise<CreatorRoster> {
  return buildCreatorRoster(creatorRosterEntries(await load()), targetLevel);
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
    const key = candidate.creature.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(candidate.creature);
    if (suggestions.length >= limit) break;
  }
  return suggestions;
}
