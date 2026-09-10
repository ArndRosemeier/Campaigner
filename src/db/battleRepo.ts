import type { Artifact, Battle, BattleBoard, FighterStatsLookup, Id } from '@/domain';
import { battleSchema } from '@/domain';
import {
  applyStageReset,
  ensurePcTokens,
  fillNpcTokenHp,
} from '@/domain/battle/board';
import { db } from '@/db/db';
import { NotFoundError } from '@/lib/errors';
import { buildFighterStatsLookup, isBattleEmpty, pcFightersOf } from '@/db/fighterStats';
import { listArtifactsByCampaign, listGlobalArtifacts } from '@/db/artifactRepo';
import { stampNewEntity } from '@/domain/entity';

/**
 * Battle persistence (10-MILESTONE-6 M6-E): one live battle per module,
 * created lazily on first mutation, deleted when it empties. Every read AND
 * write is PARSE-NORMALIZED through `battleSchema`: a row persisted by an
 * older app version predates later-arc board fields (effects, mapLayout,
 * entrance, everLive, reseed, token treasure), and the schema's
 * `.default(...)` values materialize them at the read boundary — the UI
 * never sees an `undefined` array the type claims exists. Every write is
 * also NORMALIZED (the analog of the source's `normalizeEncounter` /
 * `fillTokenCurrentHp`): NPC token HP re-filled/clamped from the backing
 * stats, PC tokens re-ensured for every statful pc artifact, HP clamped to
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

/** Mutable battle fields; identity (`campaignId`/`moduleId`) is immutable. */
export type BattlePatch = Partial<Omit<Battle, 'id' | 'campaignId' | 'moduleId'>>;

/** Full-row save: parse-normalizes and applies normalize-on-write. */
export async function saveBattle(battle: Battle): Promise<Battle> {
  const normalized = await normalizeBattle(battle);
  await db.battles.put(normalized);
  return normalized;
}

/** Whether `error` is a Dexie unique-index violation (fake-indexeddb
 * surfaces the same name on its DOMException) — the loser of a concurrent
 * get-or-create re-reads the winner's row instead of failing. */
function isConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'ConstraintError'
  );
}

/**
 * One live battle per module (the module reader is the play view).
 * Returns the existing row or lazily creates an empty prep board.
 *
 * Concurrency: two seeds racing for the same module both see "no row" and
 * both attempt a save — the UNIQUE `&moduleId` index (Dexie v16) elects one
 * writer and the loser catches the ConstraintError and re-reads the
 * winner's battle (idempotent get-or-create; the index is the arbiter, the
 * re-read keeps every caller on the shared row).
 */
export async function ensureBattle(campaignId: Id, moduleId: Id): Promise<Battle> {
  const existing = await db.battles.where('moduleId').equals(moduleId).first();
  if (existing !== undefined) {
    return parseBattleRow(existing);
  }
  const stamp = stampNewEntity();
  const created: Battle = {
    ...stamp,
    campaignId,
    moduleId,
    encounterArtifactId: null,
    reseed: null,
    seedFighters: [],
    board: {
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
    },
  };
  try {
    return await saveBattle(created);
  } catch (error) {
    if (!isConstraintError(error)) throw error;
    const winner = await db.battles.where('moduleId').equals(moduleId).first();
    if (winner === undefined) throw error;
    return parseBattleRow(winner);
  }
}

export async function getBattle(id: Id): Promise<Battle | undefined> {
  const row = await db.battles.get(id);
  return row === undefined ? undefined : parseBattleRow(row);
}

export async function getBattleByModule(moduleId: Id): Promise<Battle | undefined> {
  const row = await db.battles.where('moduleId').equals(moduleId).first();
  return row === undefined ? undefined : parseBattleRow(row);
}

/** Race-safe read-modify-write with normalize-on-write (module pattern). */
export async function patchBattle(id: Id, patch: BattlePatch): Promise<Battle> {
  // The transaction spans battles AND artifacts: normalize-on-write re-reads
  // the campaign's pc/npc artifacts inside the same transaction (Dexie joins
  // ambient queries to the innermost transaction).
  return db.transaction('rw', [db.battles, db.artifacts], async () => {
    const current = await db.battles.get(id);
    if (current === undefined) throw new NotFoundError('Battle', id);
    // Identity fields are immutable; the board is merged wholesale by the caller.
    return saveBattle({ ...parseBattleRow(current), ...patch, campaignId: current.campaignId, moduleId: current.moduleId });
  });
}

/** Replaces the board wholesale (the UI's single-commit drag path). */
export async function saveBattleBoard(id: Id, board: BattleBoard): Promise<Battle> {
  return patchBattle(id, { board });
}

/** Replaces the stage snapshot (⚑ Set stage). */
export async function saveBattleStage(id: Id, stage: BattleBoard['stage']): Promise<Battle> {
  return patchBattle(id, { board: { ...(await requireBoard(id)), stage } });
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
  const board = applyStageReset(battle.board, battle.board.stage, stats, pcFightersOf(artifacts));
  return saveBattleBoard(id, board);
}

export async function deleteBattle(id: Id): Promise<void> {
  await db.battles.delete(id);
}

/**
 * Source rule: deleting the last non-PC token with no map deletes the battle.
 * Called after scrubbing; a battle with no fighter tokens, no map and no
 * provenance has nothing left to run.
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
 */
export async function scrubArtifactFromBattles(campaignId: Id, artifactId: Id): Promise<void> {
  const battles = await db.battles.where('campaignId').equals(campaignId).toArray();
  for (const row of battles) {
    const battle = parseBattleRow(row);
    const hasToken = battle.board.tokens.some((token) => token.artifactId === artifactId);
    if (!hasToken) continue;
    const tokens = battle.board.tokens.filter((token) => token.artifactId !== artifactId);
    const removedIds = new Set(
      battle.board.tokens.filter((token) => token.artifactId === artifactId).map((token) => token.id),
    );
    const initiativeOrder = battle.board.initiativeOrder.filter((id) => !removedIds.has(id));
    const activeId = battle.board.initiativeOrder[battle.board.activeIndex];
    const activeIndex =
      activeId === undefined ? 0 : Math.max(0, initiativeOrder.indexOf(activeId));
    const board: BattleBoard = { ...battle.board, tokens, initiativeOrder, activeIndex };
    await db.battles.put({ ...battle, board });
    await deleteBattleIfEmpty(battle.id);
  }
}

/** Deleting a module drops its live battle state. */
export async function deleteBattlesByModule(moduleId: Id): Promise<void> {
  await db.battles.where('moduleId').equals(moduleId).delete();
}

/**
 * Single-map-slot convergence (owner decision, docs/11): after an encounter
 * regenerate-finalize swaps the battlemap, every battle seeded from that
 * encounter but never opened (`board.everLive === false`) converges onto the
 * fresh map — `board.mapImageId` + `board.mapLayout` move, tokens/veils and
 * everything else stay. A battle that already went live stays FROZEN on the
 * board the table actually played (Open battle never reseeds — docs/18
 * gotcha); the caller toasts loudly so the GM re-runs the battle to pick up
 * the new map. Rides the `patchBattle` path (parse-normalized, one tx per
 * battle) — never the surface.
 */
export async function convergeBoardsToRegeneratedMap(
  encounterArtifactId: Id,
  map: { mapImageId: Id; mapLayout: BattleBoard['mapLayout'] },
): Promise<{ converged: number; liveSkipped: number }> {
  const rows = await db.battles.filter((battle) => battle.encounterArtifactId === encounterArtifactId).toArray();
  let converged = 0;
  let liveSkipped = 0;
  for (const row of rows) {
    const battle = parseBattleRow(row);
    if (battle.board.everLive) {
      liveSkipped += 1;
      continue;
    }
    if (battle.board.mapImageId === map.mapImageId) continue;
    await patchBattle(battle.id, {
      board: { ...battle.board, mapImageId: map.mapImageId, mapLayout: map.mapLayout },
    });
    converged += 1;
  }
  return { converged, liveSkipped };
}

/**
 * Normalize-on-write: PC tokens ensured, NPC token HP re-filled from the
 * backing stats when null and clamped to [0, maxHp]. PC token HP is NEVER
 * written here — the pc artifact owns it (the UI writes damage/heal for PCs
 * through `artifactRepo.updateArtifact`).
 */
async function normalizeBattle(battle: Battle): Promise<Battle> {
  // Parse-normalize first (defaults for legacy rows), then normalize-on-write.
  const parsed = battleSchema.parse(battle);
  const [artifacts, globals] = await Promise.all([
    listArtifactsByCampaign(parsed.campaignId),
    listGlobalArtifacts(),
  ]);
  const stats = buildFighterStatsLookup(parsed, [...artifacts, ...globals]);
  let board = ensurePcTokens(parsed.board, pcFightersOf(artifacts));
  board = fillNpcTokenHp(board, stats);
  return { ...parsed, board };
}

async function requireBoard(id: Id): Promise<BattleBoard> {
  const battle = await getBattle(id);
  if (battle === undefined) throw new NotFoundError('Battle', id);
  return battle.board;
}

/** Exposed for UI effects that need the same lookup the repo normalizes with. */
export function statsLookupFor(battle: Battle, artifacts: readonly Artifact[]): FighterStatsLookup {
  return buildFighterStatsLookup(battle, artifacts);
}
