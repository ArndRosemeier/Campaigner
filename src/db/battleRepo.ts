import type { Artifact, Battle, BattleBoard, FighterStatsLookup, Id } from '@/domain';
import { battleSchema } from '@/domain';
import type { BattleView } from '@/domain/battle/view';
import {
  applyStageReset,
  ensurePcTokens,
  fillNpcTokenHp,
  scrubArtifactFromBoard,
} from '@/domain/battle/board';
import { db } from '@/db/db';
import { NotFoundError } from '@/lib/errors';
import { buildFighterStatsLookup, isBattleEmpty, pcFightersOf } from '@/db/fighterStats';
import { listArtifactsByCampaign, listGlobalArtifacts, adoptedCopyIdOf } from '@/db/artifactRepo';
import { stampNewEntity } from '@/domain/entity';

/**
 * Battle persistence (10-MILESTONE-6 M6-E; re-keyed by encounter, docs/17 row
 * 254): ONE live battle per ENCOUNTER ARTIFACT, created lazily on first
 * mutation, deleted when it empties. The module id stays on the row (the board
 * acts on its module and `deleteBattlesByModule` drops a module's boards), but
 * it is NOT the identity — a module with several encounters has one board per
 * encounter.
 *
 * Every read AND write is PARSE-NORMALIZED through `battleSchema`: a row
 * persisted by an older app version predates later-arc board fields (effects,
 * mapLayout, entrance, everLive, reseed, token treasure), and the schema's
 * `.default(...)` values materialize them at the read boundary — the UI never
 * sees an `undefined` array the type claims exists. Every write is also
 * NORMALIZED (the analog of the source's `normalizeEncounter` /
 * `fillTokenCurrentHp`): NPC token HP re-filled/clamped from the backing stats,
 * PC tokens re-ensured for every statful pc artifact, HP clamped to
 * [0, maxHp]. UI reads via useLiveQuery; drag commits are single repo calls.
 */

/**
 * Legacy-row guard at the Dexie boundary: zod fills the schema defaults for
 * fields the stored row lacks. A corrupt row fails loudly here (AGENTS rule
 * 3) instead of crashing a render with an `undefined` field. Exported for
 * read-only callers that must judge a stored row exactly as the scrub path
 * judges it (`artifactRepo.inspectKindRemoval`'s census).
 */
export function parseBattleRow(row: Battle): Battle {
  return battleSchema.parse(row);
}

/**
 * Mutable battle fields; identity (`campaignId`/`moduleId`) is immutable and
 * the BOARD is deliberately NOT patchable through `patchBattle` (docs/17 row
 * 336): a board carried in a plain patch is a board derived from whatever the
 * caller last RENDERED, and replacing the row's board with it silently drops
 * every token another writer landed in between — the lost update that made a
 * spawned mob vanish on the next redraw. Board writes ride
 * `mutateBattleBoard` (or the row-level `updateBattle` callback when sibling
 * fields move with the board), so the mutation is always applied to the row
 * read inside the transaction.
 */
export type BattlePatch = Partial<Omit<Battle, 'id' | 'campaignId' | 'moduleId' | 'board'>>;

/** Fields a read-modify-write mutation may set — the board included, because
 * `updateBattle`'s callback receives the CURRENT row (docs/17 row 336). */
export type BattleWrite = Partial<Omit<Battle, 'id' | 'campaignId' | 'moduleId'>>;

/** Full-row save: parse-normalizes and applies normalize-on-write. */
export async function saveBattle(battle: Battle): Promise<Battle> {
  const normalized = await normalizeBattle(battle);
  await db.battles.put(normalized);
  return normalized;
}

/** The empty board a freshly created battle row starts from (no map, no
 * tokens, not live). ONE literal — every create path goes through it. */
function emptyBoard(): BattleBoard {
  return {
    mapImageId: null,
    mapLayout: null,
    live: false,
    everLive: false,
    tokens: [],
    veils: [],
    effects: [],
    gridSize: null,
    tokenSize: 64,
    sceneryMovementLocked: false,
    initiativeEnabled: false,
    initiativeOrder: [],
    activeIndex: 0,
    stage: null,
    stagingGround: null,
    entrance: null,
  };
}

/**
 * The ONE battle a given ENCOUNTER owns (docs/17 row 254), or undefined.
 * `encounterArtifactId` is the identity: two encounters in one module resolve
 * two independent boards.
 *
 * A row whose `encounterArtifactId` is null (a legacy board written before
 * seeding stamped provenance, or one whose seeding encounter was deleted) has
 * NO owner and is unreachable from here — it is KEPT, never deleted on a guess
 * (docs/18 §5).
 *
 * Legacy duplicate rows (the same encounter seeded into two modules while the
 * `moduleId` index was unique, or imported from such an export) are resolved
 * to the row the index yields first; the others stay in the table and are named
 * in docs/18 §5 rather than silently dropped.
 *
 * The key names a row the CAMPAIGN owns (docs/17 row 268): a battle seeded from
 * a LIBRARY-scoped encounter is re-keyed to the adopted copy, so the id is
 * never a stored library reference. An affordance still holding the LIBRARY
 * card resolves through `getBattleForEncounter` — the ONE hop — rather than
 * through this identity lookup.
 */
export async function getBattleByEncounter(encounterArtifactId: Id): Promise<Battle | undefined> {
  const row = await db.battles.where('encounterArtifactId').equals(encounterArtifactId).first();
  return row === undefined ? undefined : parseBattleRow(row);
}

/**
 * The battle the ENCOUNTER an AFFORDANCE or URL holds owns — the keyed lookup
 * plus the LIBRARY-ADOPTION hop (docs/17 row 268).
 *
 * Since a battle seeded from a LIBRARY-scoped encounter is KEYED to the
 * CAMPAIGN's adopted copy, a caller that still holds the library card (the
 * encounter's own Run-battle button, or a URL typed before the v29 backfill
 * re-keyed the row) resolves through the campaign's copy. ONE hop, campaign-
 * scoped, and a READ only: nothing is adopted, re-keyed or written here — the
 * write-time half is `db/battleSeed.campaignOwnedEncounter`.
 *
 * A miss on the fallback is a genuine "no battle" (the surface's empty state),
 * never a guess: `adoptedCopyIdOf` answers only the campaign's OWN copy.
 */
export async function getBattleForEncounter(
  campaignId: Id,
  encounterArtifactId: Id,
): Promise<Battle | undefined> {
  const direct = await getBattleByEncounter(encounterArtifactId);
  if (direct !== undefined) return direct;
  const copyId = await adoptedCopyIdOf(campaignId, encounterArtifactId);
  return copyId === undefined ? undefined : getBattleByEncounter(copyId);
}

/** Every battle row the module holds, one per encounter it seeded from.
 * The module PDF resolves each encounter's map through this list; nothing
 * treats the result as "the module's battle" (a module may have several). */
export async function listBattlesByModule(moduleId: Id): Promise<Battle[]> {
  const rows = await db.battles.where('moduleId').equals(moduleId).toArray();
  return rows.map(parseBattleRow);
}

/**
 * The one live battle an ENCOUNTER owns, or a lazily created empty prep board
 * (docs/17 row 254). The module id is stamped for the board's own module-scoped
 * needs, never as identity.
 *
 * Concurrency: the get-or-create runs inside ONE readwrite Dexie transaction
 * over `battles` (+ `artifacts`, which normalize-on-write reads). Two seeds
 * racing for the same encounter both issue the read inside their own IndexedDB
 * transaction, and IndexedDB serializes readwrite transactions over the same
 * store — the second one's read runs after the first has committed, so it
 * finds the winner's row instead of materializing a second board. This replaced
 * the v16 UNIQUE `&moduleId` index as the arbiter: a module now owns one battle
 * PER ENCOUNTER, so a module-keyed unique index would refuse the second
 * encounter's board outright.
 */
export async function ensureBattleForEncounter(
  campaignId: Id,
  moduleId: Id,
  encounterArtifactId: Id,
): Promise<Battle> {
  return db.transaction('rw', [db.battles, db.artifacts], async () => {
    const existing = await db.battles
      .where('encounterArtifactId')
      .equals(encounterArtifactId)
      .first();
    if (existing !== undefined) {
      return parseBattleRow(existing);
    }
    const stamp = stampNewEntity();
    const created: Battle = {
      ...stamp,
      campaignId,
      moduleId,
      encounterArtifactId,
      reseed: null,
      seedFighters: [],
      board: emptyBoard(),
      view: null,
    };
    return saveBattle(created);
  });
}

export async function getBattle(id: Id): Promise<Battle | undefined> {
  const row = await db.battles.get(id);
  return row === undefined ? undefined : parseBattleRow(row);
}

/**
 * A row write's two possible outcomes inside the seam's transaction: the
 * fields to merge over the CURRENT row, or the row's DELETION. The delete is
 * the scrub's empty-battle rule (docs/17 row 336 fix-forward): it must be
 * decided from the SAME board the caller's mutation produced, in the SAME
 * transaction, because the saved row is not the board the caller judged — a
 * second read judges the NORMALIZED row, and normalize-on-write re-ensures a
 * token for every campaign PC, which would keep an emptied board alive
 * forever.
 */
const DELETE_BATTLE = 'delete-battle' as const;

/** The outcome one row write answers inside `writeBattleRow`. */
type BattleRowOutcome = BattleWrite | typeof DELETE_BATTLE;

/**
 * THE row read-modify-write transaction (docs/17 row 336). `update` receives
 * the battle row as it is INSIDE this transaction and answers the fields to
 * merge over it — or `DELETE_BATTLE`, which removes the row here, atomically
 * with the decision — so a decision made from a render snapshot (how many
 * "Goblin" labels are on the board, where the next free spot is) can never
 * overwrite a row another writer already moved past it. That is the whole fix
 * for the owner's "spawned mob appears, then is gone at the next redraw": the
 * surface's commit and the initiative reconcile both derived the board they
 * wrote from the component's render snapshot, and the later of the two
 * clobbered the spawn.
 *
 * It is the SAME transaction shape `patchBattle` always had (battles +
 * artifacts, because normalize-on-write re-reads the campaign's pc/npc rows);
 * `updateBattle`, `patchBattle` and `mutateBattleBoard` are the typed façades
 * over it, and there is no second board-write mechanism.
 */
async function writeBattleRow(
  id: Id,
  update: (current: Battle) => BattleRowOutcome,
): Promise<Battle | undefined> {
  return db.transaction('rw', [db.battles, db.artifacts], async () => {
    const current = await db.battles.get(id);
    if (current === undefined) throw new NotFoundError('Battle', id);
    const battle = parseBattleRow(current);
    const outcome = update(battle);
    if (outcome === DELETE_BATTLE) {
      await db.battles.delete(id);
      return undefined;
    }
    return saveBattle({
      ...battle,
      ...outcome,
      campaignId: current.campaignId,
      moduleId: current.moduleId,
    });
  });
}

/**
 * `writeBattleRow` answers `undefined` only for a DELETION, which a merge-only
 * write never requests; a violation of that invariant is loud rather than a
 * silent `undefined` reaching a caller that expects a row.
 */
function savedBattle(saved: Battle | undefined, id: Id): Battle {
  if (saved === undefined) {
    throw new Error(`Battle ${id} was deleted by a write that only merges fields`);
  }
  return saved;
}

/** Merge-only row write (identity, seed roster, view, provenance). */
export async function updateBattle(
  id: Id,
  update: (current: Battle) => BattleWrite,
): Promise<Battle> {
  return savedBattle(await writeBattleRow(id, update), id);
}

/**
 * Non-board patch (identity, seed roster, view, provenance). The board is not
 * part of `BattlePatch` on purpose — see the type's comment.
 */
export async function patchBattle(id: Id, patch: BattlePatch): Promise<Battle> {
  return updateBattle(id, () => patch);
}

/**
 * THE board-mutation seam (docs/17 row 336): reads the battle row INSIDE its
 * own transaction, applies `mutate` to the CURRENT board and saves the result.
 * Every board write in the app goes through here (a combined board + sibling
 * write uses `updateBattle` directly), so a stale render can never overwrite a
 * newer board — the caller passes the CHANGE, never the board it saw.
 *
 * `mutate` may answer `null` to DELETE the battle in the same transaction: the
 * board it produced has nothing left to run (the scrub's empty-battle rule,
 * docs/17 row 336 fix-forward), and the deletion is decided from THAT board —
 * not from a second read of the saved row, which normalize-on-write may have
 * re-populated with a PC token. The call then resolves `undefined` and every
 * other outcome resolves the saved row.
 */
export async function mutateBattleBoard(
  id: Id,
  mutate: (board: BattleBoard, battle: Battle) => BattleBoard | null,
): Promise<Battle | undefined> {
  return writeBattleRow(id, (current) => {
    const board = mutate(current.board, current);
    return board === null ? DELETE_BATTLE : { board };
  });
}

/** Replaces the stage snapshot (⚑ Set stage) — the stage rides the CURRENT
 * board, so a token spawned since the render is kept (docs/17 row 336). */
export async function saveBattleStage(id: Id, stage: BattleBoard['stage']): Promise<Battle> {
  return savedBattle(await mutateBattleBoard(id, (board) => ({ ...board, stage })), id);
}

/**
 * Persists the surface's VIEW state (docs/17 row 262b) — the player-safe flag,
 * zoom/pan and the rail selections. Rides the EXISTING `patchBattle` row path
 * (never a second persistence mechanism): the board commit path and this one
 * merge over the row, so a board write and a view write cannot clobber each
 * other. The caller (`features/play/battle/use-battle-view`) is responsible for
 * debouncing gestures and for landing the write on the page-hide seam; this is
 * the ONE typed writer of `Battle['view']`.
 */
export async function saveBattleView(id: Id, view: BattleView): Promise<Battle> {
  return patchBattle(id, { view });
}

/**
 * ↻ Reset (M5-D): restores the saved opening layout against the CURRENT
 * stats and PC roster — geometry, veils, cleared initiative, NPC instance
 * HP back to artifact max, missing PCs re-spawned. The battle stays live.
 */
export async function resetBattleToStage(id: Id): Promise<Battle> {
  const battle = await getBattle(id);
  if (battle === undefined) throw new NotFoundError('Battle', id);
  if (battle.board.stage === null) {
    throw new Error('No stage snapshot saved — set the stage before resetting');
  }
  // Battle stats resolve across scopes (10-MILESTONE-6 C): campaign and
  // module-owned rows come from the campaign query, library monsters from
  // the global scan. Only campaign-scoped PCs reach pcFightersOf — a global
  // pc is unrepresentable, so currentHp ownership is unchanged.
  const [artifacts, globals] = await Promise.all([
    listArtifactsByCampaign(battle.campaignId),
    listGlobalArtifacts(),
  ]);
  const stats = buildFighterStatsLookup(battle, [...artifacts, ...globals]);
  // The reset is applied to the CURRENT board (docs/17 row 336): the opening
  // layout replaces the tokens, but every other field of the live board — and a
  // token spawned since this read — rides along, so the reset cannot resurrect
  // a board the table has moved on from more than it means to.
  return savedBattle(
    await mutateBattleBoard(id, (board) => {
      const stage = board.stage;
      if (stage === null) {
        throw new Error('No stage snapshot saved — set the stage before resetting');
      }
      return applyStageReset(board, stage, stats, pcFightersOf(artifacts));
    }),
    id,
  );
}

export async function deleteBattle(id: Id): Promise<void> {
  await db.battles.delete(id);
}

/**
 * Source rule: deleting the last non-PC token with no map deletes the battle —
 * a battle with no fighter tokens, no map and no provenance has nothing left
 * to run.
 *
 * The id-only form, judging the row AS SAVED. The artifact scrub does NOT use
 * it: the scrub's own deletion is decided inside its transaction, on the board
 * the scrub produced, because the saved row has been through
 * normalize-on-write, which re-ensures a PC token and would answer "not empty"
 * for a board that just lost its last mob (docs/17 row 336 fix-forward).
 */
export async function deleteBattleIfEmpty(id: Id): Promise<void> {
  const battle = await getBattle(id);
  if (battle === undefined) return;
  if (isBattleEmpty(battle)) {
    await db.battles.delete(id);
  }
}

/**
 * Removing a pc/npc artifact scrubs its tokens (and initiative entries) from
 * every battle of the campaign; empty battles delete themselves. Called from
 * `deleteArtifact` — the UI never invokes this directly.
 *
 * The scrub itself is the ONE domain seam `scrubArtifactFromBoard` (docs/17
 * row 263): it removes the artifact's tokens from the board list AND from the
 * saved stage snapshot, so a delete can never leave a stage token dangling for
 * `resetBattleToStage` to put back. This function only owns the row walk and
 * the empty-battle rule — the same `=== board` identity test the seam returns
 * for "nothing changed", so a battle with no matching token is left untouched
 * (the reference diff is asked of the row walk's own read and then re-asked
 * against the CURRENT board inside the write, docs/17 row 336: a board that
 * gained a token since the walk is scrubbed as it is now, never replaced by
 * the walk's snapshot).
 *
 * THE EMPTY RULE IS DECIDED ON THE SCRUBBED BOARD, IN THE SAME TRANSACTION
 * (docs/17 row 336 fix-forward). `isBattleEmpty` judges the board this scrub
 * PRODUCED — the board the removal CENSUS judges, so prediction and execution
 * cannot disagree — and `mutateBattleBoard` deletes the row right there. A
 * second read of the saved row would judge the NORMALIZED board instead:
 * normalize-on-write re-ensures a token for every campaign PC
 * (`ensurePcTokens`), so a board whose last mob was just scrubbed would read
 * as non-empty and survive forever while the census promised a deletion.
 */
export async function scrubArtifactFromBattles(campaignId: Id, artifactId: Id): Promise<void> {
  const battles = await db.battles.where('campaignId').equals(campaignId).toArray();
  for (const row of battles) {
    const battle = parseBattleRow(row);
    if (scrubArtifactFromBoard(battle.board, artifactId) === battle.board) continue;
    await mutateBattleBoard(battle.id, (board, current) => {
      const next = scrubArtifactFromBoard(board, artifactId);
      return isBattleEmpty({ ...current, board: next }) ? null : next;
    });
  }
}

/** Deleting a module drops every live board it owns (one per encounter). */
export async function deleteBattlesByModule(moduleId: Id): Promise<void> {
  await db.battles.where('moduleId').equals(moduleId).delete();
}

/**
 * A battlemap + grid to stamp onto a board. The DERIVATION is
 * `db/battleSeed.encounterBattlemap` (the ONE seam every caller reads); this
 * is the write-side shape the three board-map writers below take.
 */
export interface BattlemapSlot {
  mapImageId: Id;
  mapLayout: BattleBoard['mapLayout'];
}

/**
 * THE one board-map patch body (docs/17 row 328): map + layout stamped onto a
 * board, tokens/veils/effects/stage and every other field riding along
 * untouched. The convergence path, the heal and the explicit apply all go
 * through it, so they cannot drift into three near-copies.
 */
function withBattlemap(board: BattleBoard, map: BattlemapSlot): BattleBoard {
  return { ...board, mapImageId: map.mapImageId, mapLayout: map.mapLayout };
}

/** THE one board-map row write: the patch above through the read-modify-write
 * board seam (never a raw table write, never from the surface). The map lands
 * on the CURRENT board, so a tile spawned or moved since the caller's read
 * rides along (docs/17 row 336). */
async function writeBoardMap(battleId: Id, map: BattlemapSlot): Promise<Battle> {
  return savedBattle(
    await mutateBattleBoard(battleId, (board) => withBattlemap(board, map)),
    battleId,
  );
}

/**
 * (a) HEAL a board that has NO map (docs/17 row 328): adopt the encounter's
 * current map + grid. Safe by construction — the guard and the write share ONE
 * readwrite transaction, so a board that already carries a map is returned
 * UNTOUCHED (never written; byte-identical) and a second call after the first
 * is a no-op. `true` means THIS call applied the map, which is what the
 * surface's one-time note keys on.
 *
 * This is the arm that covers a board which went live before its map existed
 * (the owner's repro, docs/17 row 325): there is nothing to freeze, so giving
 * it the map it should always have had clobbers nothing.
 */
export async function healBattleBoardMap(battleId: Id, map: BattlemapSlot): Promise<boolean> {
  return db.transaction('rw', [db.battles, db.artifacts], async () => {
    const current = await db.battles.get(battleId);
    if (current === undefined) throw new NotFoundError('Battle', battleId);
    const battle = parseBattleRow(current);
    if (battle.board.mapImageId !== null) return false;
    await writeBoardMap(battleId, map);
    return true;
  });
}

/**
 * (b) EXPLICIT APPLY (docs/17 row 328): the GM's own "Use the encounter's
 * current map" action writes map + layout on demand and leaves tokens/veils
 * alone. The surface owns the arm-and-confirm copy; this entry point owns the
 * write, so the surface never patches a board itself.
 */
export async function applyBattleBoardMap(battleId: Id, map: BattlemapSlot): Promise<Battle> {
  return writeBoardMap(battleId, map);
}

/**
 * Single-map-slot convergence (owner decision, docs/11): after an encounter
 * regenerate-finalize swaps the battlemap, every battle seeded from that
 * encounter but never opened (`board.everLive === false`) converges onto the
 * fresh map — `board.mapImageId` + `board.mapLayout` move, tokens/veils and
 * everything else stay. A battle that already went live stays FROZEN on the
 * board the table actually played (Open battle never reseeds — docs/18
 * gotcha); the caller toasts loudly and names the REAL way out, the battle
 * surface's own "Use the encounter's current map" action (docs/17 row 328).
 * Rides `writeBoardMap` (parse-normalized, one tx per battle) — never the
 * surface.
 */
export async function convergeBoardsToRegeneratedMap(
  encounterArtifactId: Id,
  map: BattlemapSlot,
): Promise<{ converged: number; liveSkipped: number }> {
  const rows = await db.battles
    .where('encounterArtifactId')
    .equals(encounterArtifactId)
    .toArray();
  let converged = 0;
  let liveSkipped = 0;
  for (const row of rows) {
    const battle = parseBattleRow(row);
    if (battle.board.everLive) {
      liveSkipped += 1;
      continue;
    }
    if (battle.board.mapImageId === map.mapImageId) continue;
    await writeBoardMap(battle.id, map);
    converged += 1;
  }
  return { converged, liveSkipped };
}

/**
 * Normalize-on-write: PC tokens ensured, NPC token HP re-filled from the
 * backing stats when null and clamped to [0, maxHp]. PC token HP is NEVER
 * written here — the pc artifact owns it (the UI writes damage/heal for PCs
 * through `artifactRepo.updateArtifact`).
 *
 * `boardChanged` is a REFERENCE diff: both seams return the SAME board object
 * when they change nothing, which is what lets the open-path trigger below skip
 * a pointless put.
 */
async function normalizeBattleParts(
  battle: Battle,
): Promise<{ battle: Battle; boardChanged: boolean }> {
  // Parse-normalize first (defaults for legacy rows), then normalize-on-write.
  const parsed = battleSchema.parse(battle);
  const [artifacts, globals] = await Promise.all([
    listArtifactsByCampaign(parsed.campaignId),
    listGlobalArtifacts(),
  ]);
  const stats = buildFighterStatsLookup(parsed, [...artifacts, ...globals]);
  const board = fillNpcTokenHp(ensurePcTokens(parsed.board, pcFightersOf(artifacts)), stats);
  return { battle: { ...parsed, board }, boardChanged: board !== parsed.board };
}

async function normalizeBattle(battle: Battle): Promise<Battle> {
  return (await normalizeBattleParts(battle)).battle;
}

/**
 * The OPEN path's trigger of the ONE PC-token seam (docs/17 row 308).
 *
 * Opening a battle is a READ, so a battle that already went `live` gained NO
 * player created afterwards until the GM happened to touch something — which is
 * not "all campaign players need to be in all battles, ALWAYS". This runs the
 * SAME normalize-on-write the save path runs and `put`s ONLY when the board
 * actually changed: `ensurePcTokens`/`fillNpcTokenHp` preserve the board object
 * when they change nothing, and every put re-fires the Dexie live queries, so
 * an unchanged open must not write at all.
 *
 * `undefined` means the row vanished between the caller's read and this write
 * (a concurrent delete) — the board is gone, the caller keeps the key it
 * resolved, and no placeholder row is invented.
 */
export async function normalizeBattleOnOpen(id: Id): Promise<Battle | undefined> {
  return db.transaction('rw', [db.battles, db.artifacts], async () => {
    const current = await db.battles.get(id);
    if (current === undefined) return undefined;
    const { battle, boardChanged } = await normalizeBattleParts(current);
    if (!boardChanged) return battle;
    await db.battles.put(battle);
    return battle;
  });
}

/** Exposed for UI effects that need the same lookup the repo normalizes with. */
export function statsLookupFor(battle: Battle, artifacts: readonly Artifact[]): FighterStatsLookup {
  return buildFighterStatsLookup(battle, artifacts);
}
