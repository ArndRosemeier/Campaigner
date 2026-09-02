import {
  GRID_SIZE_DEFAULT,
  STAGING_GROUND_CELLS,
  TOKEN_SIZE_DEFAULT,
  type BattleBoard,
  type BattleToken,
  type FighterStatsLookup,
  type StageSnapshot,
  type StagingGround,
} from '@/domain/battle';
import { newId, type Id } from '@/domain/entity';

/**
 * Board mechanics (09-MILESTONE-5 M5-B, ported from GM Cockpit's
 * `host/encounter.ts`): empty boards, staging-ground spawn layout, stage
 * capture/reset, artifact scrubbing, and the HP ownership split. Pure —
 * no React, no store, no Dexie; fighter stats are injected as plain numbers.
 */

export function emptyBoard(): BattleBoard {
  return {
    mapImageId: null,
    mapLayout: null,
    live: false,
    tokens: [],
    veils: [],
    gridSize: GRID_SIZE_DEFAULT,
    tokenSize: TOKEN_SIZE_DEFAULT,
    sceneryMovementLocked: false,
    initiativeEnabled: false,
    initiativeOrder: [],
    activeIndex: 0,
    stage: null,
    stagingGround: null,
  };
}

export function stagingGroundAt(
  x: number,
  y: number,
  boardWidthPx: number,
  boardHeightPx: number,
  cellPx: number,
): StagingGround {
  if (!(boardWidthPx > 0) || !(boardHeightPx > 0)) {
    throw new Error('Board size must be positive');
  }
  if (!(cellPx > 0)) {
    throw new Error(`Cell size must be positive, got ${String(cellPx)}`);
  }
  return {
    x,
    y,
    cellWidth: cellPx / boardWidthPx,
    cellHeight: cellPx / boardHeightPx,
  };
}

/** Row-major spawn point inside the 3×3 staging ground (0-based index). */
export function spawnPointInStagingGround(
  fighterIndex: number,
  staging: StagingGround,
): { x: number; y: number } {
  const col = fighterIndex % STAGING_GROUND_CELLS;
  const row = Math.floor(fighterIndex / STAGING_GROUND_CELLS);
  const topLeftX = staging.x - (STAGING_GROUND_CELLS / 2) * staging.cellWidth;
  const topLeftY = staging.y - (STAGING_GROUND_CELLS / 2) * staging.cellHeight;
  return {
    x: topLeftX + (col + 0.5) * staging.cellWidth,
    y: topLeftY + (row + 0.5) * staging.cellHeight,
  };
}

/** Fallback cascade layout for tokens spawned without a staging ground. */
export function fallbackSpawnPoint(index: number): { x: number; y: number } {
  return {
    x: 0.18 + (index % 5) * 0.14,
    y: 0.22 + Math.floor(index / 5) * 0.16,
  };
}

export function isStampToken(token: BattleToken): boolean {
  return token.shape === 'circle' || token.shape === 'square';
}

/** Portrait tokens backed by an artifact (pc/npc); stamps are scenery. */
export function fighterTokens(board: BattleBoard): BattleToken[] {
  return board.tokens.filter((token) => token.artifactId !== null);
}

export interface ResolvedCombatHp {
  maxHp: number;
  currentHp: number;
  /** 'artifact' = the pc artifact owns current HP; 'token' = the token instance. */
  ownedBy: 'artifact' | 'token';
}

/**
 * HP ownership split (ported verbatim): PCs resolve current HP from their
 * ARTIFACT; NPCs from the TOKEN instance. Missing stats throw — a statless
 * fighter is a loud UI badge elsewhere, never a placeholder number here.
 */
export function combatHpForToken(
  token: BattleToken,
  stats: FighterStatsLookup,
): ResolvedCombatHp | null {
  if (token.artifactId === null) {
    return null;
  }
  const fighter = stats(token.artifactId);
  if (fighter === undefined) {
    return null;
  }
  if (fighter.kind === 'pc') {
    if (fighter.currentHp === null) {
      throw new Error(`PC “${fighter.name}” is missing current HP`);
    }
    return { maxHp: fighter.maxHp, currentHp: fighter.currentHp, ownedBy: 'artifact' };
  }
  const currentHp = instanceCurrentHpFor(fighter, token.currentHp);
  if (currentHp === null) {
    throw new Error(`NPC “${token.label}” in this battle is missing current HP`);
  }
  return { maxHp: fighter.maxHp, currentHp, ownedBy: 'token' };
}

/**
 * NPC instances own current HP on the token: existing instance HP wins,
 * otherwise a fresh instance starts at max (the artifact NEVER stores it).
 */
export function instanceCurrentHpFor(
  fighter: { kind: 'pc' | 'npc'; name: string; maxHp: number },
  existingInstanceHp: number | null,
): number | null {
  if (fighter.kind !== 'npc') {
    return null;
  }
  if (existingInstanceHp !== null) {
    return existingInstanceHp;
  }
  return fighter.maxHp;
}

/**
 * Re-fills NPC token HP from the backing artifact when null and clamps HP
 * to [0, maxHp] — the repo-level normalize-on-write analog of the source's
 * `fillTokenCurrentHp`. Tokens whose artifact is gone (deleted mid-flight)
 * are left untouched; scrubbing is the explicit artifact-delete path.
 */
export function fillNpcTokenHp(
  board: BattleBoard,
  stats: FighterStatsLookup,
): BattleBoard {
  const tokens = board.tokens.map((token) => {
    if (token.artifactId === null) {
      return token;
    }
    const fighter = stats(token.artifactId);
    if (fighter?.kind !== 'npc') {
      return token;
    }
    const currentHp = instanceCurrentHpFor(fighter, token.currentHp);
    const clamped = currentHp === null ? null : Math.max(0, Math.min(fighter.maxHp, currentHp));
    if (token.currentHp === clamped) {
      return token;
    }
    return { ...token, currentHp: clamped };
  });
  // Unchanged tokens keep their object identity — a reference diff is exact.
  const changed = tokens.some((token, index) => token !== board.tokens[index]);
  return changed ? { ...board, tokens } : board;
}

/** Restores every NPC instance HP to the artifact's max (stage reset). */
export function restoreAllNpcHp(board: BattleBoard, stats: FighterStatsLookup): BattleBoard {
  const tokens = board.tokens.map((token) => {
    if (token.artifactId === null) {
      return token;
    }
    const fighter = stats(token.artifactId);
    if (fighter?.kind !== 'npc') {
      return token;
    }
    if (token.currentHp === fighter.maxHp) {
      return token;
    }
    return { ...token, currentHp: fighter.maxHp };
  });
  const changed = tokens.some((token, index) => token !== board.tokens[index]);
  return changed ? { ...board, tokens } : board;
}

/**
 * Builds an artifact-backed portrait token. `visible` is false while the
 * board is prep scratch (live: false) — the source's seeding rule.
 */
export function tokenFromFighter(
  artifactId: Id,
  fighter: FighterStatsLike,
  index: number,
  visible: boolean,
  at: { x: number; y: number } | null,
): BattleToken {
  return {
    id: newId(),
    artifactId,
    x: at === null ? fallbackSpawnPoint(index).x : at.x,
    y: at === null ? fallbackSpawnPoint(index).y : at.y,
    visible,
    label: fighter.name,
    scale: 1,
    shape: 'portrait',
    color: null,
    // NPC instances start at max; PCs report null (the artifact owns HP).
    currentHp: instanceCurrentHpFor(fighter, null),
    initiativeRoll: null,
    initiativeBonus: null,
    conditions: [],
  };
}

/** Minimal shape `tokenFromFighter` needs (satisfied by FighterStats). */
export interface FighterStatsLike {
  kind: 'pc' | 'npc';
  name: string;
  maxHp: number;
}

/** Spawns any pc artifact that has no token yet, row-major in the staging ground. */
export function ensurePcTokens(
  board: BattleBoard,
  pcArtifacts: readonly { artifactId: Id; stats: FighterStatsLike }[],
): BattleBoard {
  const present = new Set(
    board.tokens.flatMap((token) => (token.artifactId === null ? [] : [token.artifactId])),
  );
  const tokens = [...board.tokens];
  let layoutIndex = fighterTokens(board).length;
  let pcIndex = 0;
  let changed = false;
  for (const pc of pcArtifacts) {
    if (present.has(pc.artifactId)) {
      continue;
    }
    const at =
      board.stagingGround === null
        ? null
        : spawnPointInStagingGround(pcIndex, board.stagingGround);
    tokens.push(tokenFromFighter(pc.artifactId, pc.stats, layoutIndex, board.live, at));
    layoutIndex += 1;
    pcIndex += 1;
    changed = true;
  }
  return changed ? { ...board, tokens } : board;
}

export function captureStageSnapshot(board: BattleBoard): StageSnapshot {
  return {
    mapImageId: board.mapImageId,
    mapLayout: board.mapLayout === null ? null : { ...board.mapLayout },
    gridSize: board.gridSize,
    tokenSize: board.tokenSize,
    tokens: board.tokens.map((token) => ({ ...token, conditions: [...token.conditions] })),
    veils: board.veils.map((veil) => ({ ...veil })),
    stagingGround:
      board.stagingGround === null
        ? null
        : { ...board.stagingGround },
  };
}

export function cloneStageSnapshot(stage: StageSnapshot): StageSnapshot {
  return {
    mapImageId: stage.mapImageId,
    mapLayout: stage.mapLayout === null ? null : { ...stage.mapLayout },
    gridSize: stage.gridSize,
    tokenSize: stage.tokenSize,
    tokens: stage.tokens.map((token) => ({ ...token, conditions: [...token.conditions] })),
    veils: stage.veils.map((veil) => ({ ...veil })),
    stagingGround: stage.stagingGround === null ? null : { ...stage.stagingGround },
  };
}

function resetTokenForStage(
  token: BattleToken,
  stats: FighterStatsLookup,
): BattleToken {
  const base: BattleToken = {
    ...token,
    conditions: [...token.conditions],
    initiativeRoll: null,
    initiativeBonus: null,
  };
  if (token.artifactId === null) {
    return base;
  }
  const fighter = stats(token.artifactId);
  if (fighter?.kind !== 'npc') {
    return base;
  }
  return { ...base, currentHp: instanceCurrentHpFor(fighter, null) };
}

/**
 * Restores the saved opening layout: geometry + tokens + veils, initiative
 * cleared, NPC instance HP reset to artifact max, missing PCs re-spawned at
 * the staging ground — the battle stays live.
 */
export function applyStageReset(
  board: BattleBoard,
  stage: StageSnapshot,
  stats: FighterStatsLookup,
  pcArtifacts: readonly { artifactId: Id; stats: FighterStatsLike }[],
): BattleBoard {
  const tokens = stage.tokens.map((token) => resetTokenForStage(token, stats));
  const next: BattleBoard = {
    ...board,
    mapImageId: stage.mapImageId,
    mapLayout: stage.mapLayout === null ? null : { ...stage.mapLayout },
    gridSize: stage.gridSize,
    tokenSize: stage.tokenSize,
    tokens,
    veils: stage.veils.map((veil) => ({ ...veil })),
    stagingGround: stage.stagingGround === null ? null : { ...stage.stagingGround },
    activeIndex: 0,
    initiativeEnabled: false,
    initiativeOrder: [],
  };
  return ensurePcTokens(next, pcArtifacts);
}

/**
 * Removing an artifact scrubs its tokens from the board AND its entries from
 * initiative (the token ids go with it); `activeIndex` follows the active
 * token to its new position.
 */
export function scrubArtifactFromBoard(board: BattleBoard, artifactId: Id): BattleBoard {
  const removedTokenIds = new Set(
    board.tokens.filter((token) => token.artifactId === artifactId).map((token) => token.id),
  );
  const tokens = board.tokens.filter((token) => token.artifactId !== artifactId);
  const initiativeOrder = board.initiativeOrder.filter((id) => !removedTokenIds.has(id));
  if (tokens.length === board.tokens.length && initiativeOrder.length === board.initiativeOrder.length) {
    return board;
  }
  const activeId = board.initiativeOrder[board.activeIndex];
  const activeIndex = activeId === undefined ? 0 : Math.max(0, initiativeOrder.indexOf(activeId));
  const fighterCount = fighterTokens({ ...board, tokens }).length;
  return {
    ...board,
    activeIndex: fighterCount === 0 ? 0 : Math.min(activeIndex, Math.max(initiativeOrder.length - 1, 0)),
    initiativeOrder,
    tokens,
  };
}
