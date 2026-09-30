import type { Id, MonsterEntry, Rulebook, SeedFighter } from '@/domain';
import { db } from '@/db/db';
import { getArtifact, updateArtifact } from '@/db/artifactRepo';
import { getBattle, updateBattle } from '@/db/battleRepo';
import { expandRosterEntries } from '@/db/battleSeed';
import { listLibraryCreatures } from '@/db/creatureRepo';
import { copiedMobEntryFrom, copyCreatureStatsFromDb } from '@/db/libraryCopy';
import { matchesSlotLabel } from '@/domain/battle/board';
import { citationBookTitle, rulebookDisplayTitle } from '@/domain/encounterResolve';
import { libraryCitationForSlot, NoLibraryCreatureError } from '@/domain/libraryCreature';
import { NotFoundError } from '@/lib/errors';

/**
 * THE ONE repair for the rows the clean cut left STATLESS (docs/17 row 349).
 *
 * THE OWNER'S REPORT, verbatim: *"Spawned mobs say they don't have combat
 * attributes although they do have them. So initiative and damaging does not
 * work. These were standard core mobs"*. The measured cause is
 * `db/cleanCut.normaliseLibraryArtifactData`: the library-isolation purge
 * rewrote a roster entry whose `source.type === 'rulebook'` — a library
 * CITATION — into `{ type: 'none' }`, i.e. NAME ONLY. The creature is still in
 * the installed library with a full block; the purge removed the row's ACCESS
 * to it without copying anything, so `expandRosterEntries` takes its statless
 * branch: a token with `currentHp: null`, `initiativeBonus: null` and NO frozen
 * seed row, badged "No combat stats — excluded from initiative" and refusing
 * damage.
 *
 * THE OWNER'S DECISION (A): heal the row by COPYING the library creature's
 * block ONTO it — never by pointing at it. Isolation stands (the row must make
 * sense with the pack uninstalled), so the numbers are copied at repair time
 * exactly as the app's own citation rule copies them at write time.
 *
 * WHAT IT RIDES — ONE mechanism per idea, never a second (AGENTS rule 4). This
 * module is the only NEW thing in the slice; every idea inside it is an
 * existing seam:
 *
 * - the copy is `db/libraryCopy.copyCreatureStatsFromDb`, and the entry SHAPE
 *   is `db/libraryCopy.copiedMobEntryFrom` — the very shape the battle spawn
 *   path builds (`features/play/battle/spawn-picker-logic.buildMobPickEntry`
 *   delegates to the same builder since this row). A repair that minted its own
 *   shape is the defect this project keeps paying for;
 * - the name match is `domain/libraryCreature.libraryCitationForSlot` — the ONE
 *   algorithm that answers "which library creature does this NAME mean?", the
 *   same one the module generator's cast uses. No new matcher, no fuzzy match,
 *   and NEVER an invented creature for a name that does not resolve (AGENTS
 *   rule 5: the roster name is a structured field, but the resolver is still the
 *   ONLY authority);
 * - the battle side re-derives a statless token's stats by running the SAME
 *   `db/battleSeed.expandRosterEntries` a fresh spawn runs, so the frozen seed
 *   row and the token's HP are what the spawn would have produced — not a
 *   re-implementation of it;
 * - the ONE TRIGGER is the battle surface's heal-on-open effect, the same
 *   pattern the battlemap heal uses (docs/17 row 328): the moment the owner
 *   first opens the battle he reported.
 *
 * THE JOURNAL, HONESTLY. There is no surviving stored journal to write to: the
 * `settings.mobCopyRepair` report and its worklist were DELETED with the whole
 * migration layer by `89c55e8` (the clean-cut commit). A new stored journal is
 * deliberately NOT invented here — this slice adds no settings field. The
 * report below is what the LOUD surface says (the surface raises it through the
 * ONE toast seam, AGENTS rule 2), and the durable visible state of an
 * unhealed row is the row itself: it stays name-only and its token keeps the
 * "No combat stats" badge. Never silent, never an invented block.
 *
 * THE HONEST LIMIT OF (A), stated rather than discovered later: with the pack
 * uninstalled there is nothing to copy, so such a row STAYS statless and is
 * NAMED in `unresolved` with the seam's own reason. An honest absence, never a
 * placeholder (AGENTS rule 1).
 *
 * IDEMPOTENT AND NON-DESTRUCTIVE. A second pass finds no `none` row and no
 * token without a backing row, computes nothing and writes NOTHING (the guard
 * below returns before any write). An entry that already carries a block is
 * never touched — the loop skips every source arm but `none` — and a healed
 * row keeps its name, count, notes and treasure (only the copy's `source`,
 * `sourceLine` and `originToken` are transplanted).
 */

/** What ONE repair pass did — the whole of what a surface can say out loud. */
export interface MobStatRepairReport {
  /** Roster rows this pass healed, by their entry name. */
  healed: string[];
  /**
   * Roster rows that could NOT be healed, each NAMED with the seam's own
   * reason: the library holds no creature of that name (the pack is gone), it
   * holds several and the row names no book to pick one, or the resolved chunk
   * carries no block. These rows stay name-only and stay badged.
   */
  unresolved: { name: string; reason: string }[];
  /** Battle tokens this pass gave combat stats to, by their board label. */
  tokensHealed: string[];
}

/**
 * THE name → library-creature reader, wired over the ONE pool read.
 *
 * The pool is `db/creatureRepo.listLibraryCreatures()` UNSCOPED, and that is a
 * decision rather than an oversight (docs/17 row 207's system scoping is about
 * GENERATION): a roster entry naming a creature is an explicit reference the
 * owner's own encounter carried, exactly like a `[[Zombie]]` wiki link, and the
 * wiki-link pool is unscoped for the same reason. Scoping it here would turn a
 * resolvable row into a statless one because the campaign's system and the
 * book's differ.
 *
 * The two book readers are the seam's OWN exported readings
 * (`rulebookDisplayTitle` / `citationBookTitle`), fed from the book rows the
 * pool's chunks name — read once (`bulkGet`), never one read per candidate.
 * The repair never uses the citation's stamped `bookTitle` (it copies a block,
 * it does not store a citation); the readers exist because the seam needs them
 * to disambiguate and to NAME its refusal, which is exactly what the journal
 * above reports.
 */
async function openLibraryNameReader(): Promise<{
  resolve: (name: string) => Promise<{ chunkId: Id } | { reason: string }>;
}> {
  const pool = await listLibraryCreatures();
  const bookIdByChunk = new Map(pool.map((creature) => [creature.chunkId, creature.bookId]));
  const books = new Map<Id, Rulebook>();
  for (const book of await db.rulebooks.bulkGet([...new Set(pool.map((creature) => creature.bookId))])) {
    if (book !== undefined) books.set(book.id, book);
  }
  const bookFor = (chunkId: Id): Rulebook | undefined => {
    const bookId = bookIdByChunk.get(chunkId);
    return bookId === undefined ? undefined : books.get(bookId);
  };
  return {
    resolve: async (name: string): Promise<{ chunkId: Id } | { reason: string }> => {
      try {
        const citation = await libraryCitationForSlot(name, { creature: name }, pool, {
          bookTitleOf: (chunkId) => Promise.resolve(rulebookDisplayTitle(bookFor(chunkId))),
          stampBookTitleOf: (chunkId) => Promise.resolve(citationBookTitle(bookFor(chunkId))),
        });
        return citation.chunkId === undefined
          ? { reason: `the library answered «${name}» without naming a chunk` }
          : { chunkId: citation.chunkId };
      } catch (error) {
        // EXACTLY the seam's designed refusal, nothing else: a real failure
        // (a broken pool read, an unreadable book) must propagate loudly rather
        // than be recorded as an unresolvable name (AGENTS rule 1).
        if (error instanceof NoLibraryCreatureError) return { reason: error.message };
        throw error;
      }
    },
  };
}

/**
 * Heal every NAME-ONLY roster entry of one encounter, in place, returning a NEW
 * array (the caller decides whether to store it). An already-statful entry is
 * passed through BY REFERENCE — byte-identical, never rewritten (requirement 5
 * of the row-349 slice).
 */
async function healedRosterEntries(
  entries: readonly MonsterEntry[],
  resolveName: (name: string) => Promise<{ chunkId: Id } | { reason: string }>,
): Promise<{
  entries: MonsterEntry[];
  healed: string[];
  unresolved: { name: string; reason: string }[];
}> {
  const healed: string[] = [];
  const unresolved: { name: string; reason: string }[] = [];
  const next: MonsterEntry[] = [];
  for (const entry of entries) {
    if (entry.source.type !== 'none') {
      next.push(entry);
      continue;
    }
    const resolved = await resolveName(entry.name);
    if ('reason' in resolved) {
      unresolved.push({ name: entry.name, reason: resolved.reason });
      next.push(entry);
      continue;
    }
    const copy = await copyCreatureStatsFromDb({ chunkId: resolved.chunkId }, entry.name);
    if (copy.status === 'unresolved') {
      unresolved.push({ name: entry.name, reason: copy.reason });
      next.push(entry);
      continue;
    }
    // THE ONE ENTRY SHAPE, transplanted: the copy's three fields onto the
    // EXISTING row, whose name/count/notes/treasure ride along untouched.
    const built = copiedMobEntryFrom(entry.name, copy.copy);
    healed.push(entry.name);
    next.push({
      ...entry,
      source: built.source,
      sourceLine: built.sourceLine,
      originToken: built.originToken,
    });
  }
  return { entries: next, healed, unresolved };
}

/** The statless token a pass will back with a frozen seed row. */
interface StatlessTokenHeal {
  tokenId: string;
  artifactId: Id;
  currentHp: number;
  /** The creature identity a fresh spawn would key the row and token on. */
  creatureKey?: string;
}

/**
 * Re-derive the stats for the statless tokens of one board by running the SAME
 * expansion a fresh spawn runs, one instance at a time.
 *
 * The token's roster entry is found with `domain/battle/board.matchesSlotLabel`
 * — the ONE slot-label grammar both spawn paths count with (docs/17 row 295),
 * anchored at both ends so "Goblin" never claims "Goblin Chief"'s slots. The
 * expansion is `expandRosterEntries([{...entry, count: 1}])`, so the seed row
 * and the numbers are literally the spawn path's, including the copied-mob
 * dedupe by creature identity and the spell stamping.
 *
 * Nothing is invented for a token whose entry still does not resolve: the
 * expansion answers no seed row and the token is skipped, keeping its honest
 * badge (the entry is already NAMED in the report by the roster pass).
 */
async function statlessTokenHeals(
  tokens: readonly { id: string; label: string; x: number; y: number }[],
  entries: readonly MonsterEntry[],
): Promise<{ patches: StatlessTokenHeal[]; seedFighters: SeedFighter[]; labels: string[] }> {
  const patches: StatlessTokenHeal[] = [];
  const seedFighters: SeedFighter[] = [];
  const labels: string[] = [];
  const byIdentity = new Map<string, SeedFighter>();
  for (const token of tokens) {
    const entry = entries.find((candidate) => matchesSlotLabel(token.label, candidate.name));
    if (entry === undefined) continue;
    const expansion = await expandRosterEntries([{ ...entry, count: 1 }], {
      visible: true,
      placeAt: () => ({ x: token.x, y: token.y }),
      numberFrom: 1,
      forceNumbering: true,
    });
    const seed = expansion.seedFighters[0];
    if (seed === undefined) continue;
    const key = seed.creatureKey;
    let row = seed;
    if (key !== undefined) {
      // ONE seed row per creature identity, shared by every instance — what a
      // fresh seed of the whole group produces. A row without an identity is
      // per-instance by construction and is kept as it came.
      const known = byIdentity.get(key);
      if (known === undefined) {
        byIdentity.set(key, seed);
        seedFighters.push(seed);
      } else {
        row = known;
      }
    } else {
      seedFighters.push(seed);
    }
    patches.push({
      tokenId: token.id,
      artifactId: row.id,
      currentHp: row.maxHp,
      ...(row.creatureKey === undefined ? {} : { creatureKey: row.creatureKey }),
    });
    labels.push(token.label);
  }
  return { patches, seedFighters, labels };
}

/**
 * Apply a computed heal to the battle row through the ONE read-modify-write
 * battle seam (docs/17 row 336, `battleRepo.updateBattle`, the same call the
 * spawn path makes when the BOARD and the frozen SEED ROSTER move together): the
 * change is applied to the row read INSIDE the write's transaction, so a token
 * spawned or moved since the pass read the board is appended to, never
 * clobbered. Positions, conditions, veils, effects and the initiative order are
 * untouched — only the healed tokens' `artifactId`, `currentHp` and creature
 * identity move, and the missing seed rows are added.
 */
async function applyStatlessTokenHeals(
  battleId: Id,
  heals: { patches: StatlessTokenHeal[]; seedFighters: SeedFighter[] },
): Promise<void> {
  const patchByToken = new Map(heals.patches.map((patch) => [patch.tokenId, patch]));
  await updateBattle(battleId, (current) => {
    const seedFighters = [...current.seedFighters];
    for (const seed of heals.seedFighters) {
      // The merge rule `db/battleSeed.spawnRosterInstance` uses: dedupe by
      // creature identity when the row has one, by id otherwise.
      const duplicate = seedFighters.some((existing) =>
        seed.creatureKey === undefined
          ? existing.id === seed.id
          : existing.creatureKey === seed.creatureKey,
      );
      if (!duplicate) seedFighters.push(seed);
    }
    const tokens = current.board.tokens.map((token) => {
      const patch = patchByToken.get(token.id);
      if (patch === undefined) return token;
      return {
        ...token,
        artifactId: patch.artifactId,
        currentHp: patch.currentHp,
        ...(patch.creatureKey === undefined ? {} : { creatureKey: patch.creatureKey }),
      };
    });
    return { seedFighters, board: { ...current.board, tokens } };
  });
}

/**
 * THE repair entry point: heal the encounter roster that seeded `battleId` and
 * the statless tokens already frozen on its board, in ONE pass.
 *
 * It is a NO-OP (and writes nothing) when there is nothing to heal — no
 * name-only roster row and no token without a backing row — which is what makes
 * a second run byte-identical to the first.
 *
 * Both halves ride the same copy/expansion seams (see the module doc); the row
 * write goes through the ONE artifact write seam (`artifactRepo.updateArtifact`,
 * so the change is a numbered revision the owner can see) and the battle write
 * through the ONE read-modify-write battle seam (`battleRepo.updateBattle`).
 */
export async function repairStatlessMobsForBattle(battleId: Id): Promise<MobStatRepairReport> {
  const report: MobStatRepairReport = { healed: [], unresolved: [], tokensHealed: [] };
  const battle = await getBattle(battleId);
  if (battle === undefined) throw new NotFoundError('Battle', battleId);
  if (battle.encounterArtifactId === null) return report;
  const encounter = await getArtifact(battle.encounterArtifactId);
  if (encounter?.kind !== 'encounter') return report;
  const statlessTokens = battle.board.tokens.filter((token) => token.artifactId === null);
  const hasNameOnly = encounter.data.monsters.some((entry) => entry.source.type === 'none');
  if (!hasNameOnly && statlessTokens.length === 0) return report;

  // ONE pool read + ONE name resolution per name-only row, both reused by both
  // halves: the token heal reads the entries this pass just healed.
  const { resolve } = await openLibraryNameReader();
  const roster = await healedRosterEntries(encounter.data.monsters, resolve);
  if (roster.healed.length > 0) {
    // The revision is recorded as `user` because `domain/artifactRevision
    // .revisionSourceSchema` has exactly two values (`user`/`persona`) and no
    // system arm; the row really did change under the owner's hands and he can
    // revert it from the revision history.
    await updateArtifact(encounter.id, {
      data: { ...encounter.data, monsters: roster.entries },
    });
  }
  if (statlessTokens.length > 0) {
    const heals = await statlessTokenHeals(statlessTokens, roster.entries);
    if (heals.patches.length > 0) {
      await applyStatlessTokenHeals(battleId, heals);
      report.tokensHealed = heals.labels;
    }
  }
  report.healed = roster.healed;
  report.unresolved = roster.unresolved;
  return report;
}
