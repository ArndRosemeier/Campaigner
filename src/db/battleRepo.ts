import type { Artifact, Battle, BattleBoard, FighterStatsLookup, Id } from '@/domain';
import {
  applyStageReset,
  ensurePcTokens,
  fillNpcTokenHp,
} from '@/domain/battle/board';
import { db } from '@/db/db';
import { NotFoundError } from '@/lib/errors';
import { buildFighterStatsLookup, isBattleEmpty, pcFightersOf } from '@/db/fighterStats';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { stampNewEntity } from '@/domain/entity';

/**
 * Battle persistence (09-MILESTONE-5 M5-B): one live battle per session,
 * created lazily on first mutation, deleted when it empties. Every write is
 * NORMALIZED (the analog of the source's `normalizeEncounter` /
 * `fillTokenCurrentHp`): NPC token HP re-filled/clamped from the backing
 * stats, PC tokens re-ensured for every statful pc artifact, HP clamped to
 * [0, maxHp]. UI reads via useLiveQuery; drag commits are single repo calls.
 */

/** Mutable battle fields; identity (`campaignId`/`sessionId`) is immutable. */
export type BattlePatch = Partial<Omit<Battle, 'id' | 'campaignId' | 'sessionId'>>;

/** Full-row save: parse-normalizes and applies normalize-on-write. */
export async function saveBattle(battle: Battle): Promise<Battle> {
  const normalized = await normalizeBattle(battle);
  await db.battles.put(normalized);
  return normalized;
}

/**
 * One live battle per session (source rule: no "create" action exists).
 * Returns the existing row or lazily creates an empty prep board.
 */
export async function ensureBattle(campaignId: Id, sessionId: Id): Promise<Battle> {
  const existing = await db.battles.where('sessionId').equals(sessionId).first();
  if (existing !== undefined) {
    return existing;
  }
  const stamp = stampNewEntity();
  const created: Battle = {
    ...stamp,
    campaignId,
    sessionId,
    encounterArtifactId: null,
    seedFighters: [],
    board: {
      mapImageId: null,
      live: false,
      tokens: [],
      veils: [],
      gridSize: null,
      tokenSize: 64,
      sceneryMovementLocked: false,
      initiativeEnabled: false,
      initiativeOrder: [],
      activeIndex: 0,
      stage: null,
      stagingGround: null,
    },
  };
  return saveBattle(created);
}

export async function getBattle(id: Id): Promise<Battle | undefined> {
  return db.battles.get(id);
}

export async function getBattleBySession(sessionId: Id): Promise<Battle | undefined> {
  return db.battles.where('sessionId').equals(sessionId).first();
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
    return saveBattle({ ...current, ...patch, campaignId: current.campaignId, sessionId: current.sessionId });
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
  const artifacts = await listArtifactsByCampaign(battle.campaignId);
  const stats = buildFighterStatsLookup(battle, artifacts);
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
  for (const battle of battles) {
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

/** Deleting a session artifact drops its battle (one live battle per session). */
export async function deleteBattlesBySession(sessionId: Id): Promise<void> {
  await db.battles.where('sessionId').equals(sessionId).delete();
}

/**
 * Normalize-on-write: PC tokens ensured, NPC token HP re-filled from the
 * backing stats when null and clamped to [0, maxHp]. PC token HP is NEVER
 * written here — the pc artifact owns it (the UI writes damage/heal for PCs
 * through `artifactRepo.updateArtifact`).
 */
async function normalizeBattle(battle: Battle): Promise<Battle> {
  const artifacts = await listArtifactsByCampaign(battle.campaignId);
  const stats = buildFighterStatsLookup(battle, artifacts);
  let board = ensurePcTokens(battle.board, pcFightersOf(artifacts));
  board = fillNpcTokenHp(board, stats);
  return { ...battle, board };
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
