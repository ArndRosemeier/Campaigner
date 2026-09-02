import {
  type BattleBoard,
  type BattleToken,
  type BattleTokenId,
  type BattleVeil,
  type FighterStatsLookup,
} from '@/domain/battle';
import { portraitCoveredByVeils } from '@/domain/battle/veil';

/**
 * Initiative (09-MILESTONE-5 M5-B, ported from GM Cockpit's
 * `host/initiative.ts`): d20 + bonus frozen onto the token at roll time,
 * sort by total desc → bonus desc → label A–Z, and the player-safe prune —
 * hidden or covered fighters drop out of the order and lose their rolls.
 * Pure; fighter stats are injected as plain numbers.
 */

export function initiativeTotal(token: BattleToken): number | null {
  if (token.initiativeRoll === null || token.initiativeBonus === null) {
    return null;
  }
  return token.initiativeRoll + token.initiativeBonus;
}

export function rollInitiativeD20(): number {
  return 1 + Math.floor(Math.random() * 20);
}

/**
 * Rolls for ONE token, freezing the artifact's current bonus onto the token
 * so later artifact edits never rewrite history. A fighter without stats
 * (no statblock) cannot roll — the caller keeps it out of initiative.
 */
export function rollTokenInitiative(
  token: BattleToken,
  stats: FighterStatsLookup,
): BattleToken {
  if (token.artifactId === null) {
    throw new Error(`Token “${token.label}” is not backed by a fighter artifact`);
  }
  const fighter = stats(token.artifactId);
  if (fighter === undefined) {
    throw new Error(`Fighter “${token.label}” has no combat stats to roll initiative with`);
  }
  return { ...token, initiativeRoll: rollInitiativeD20(), initiativeBonus: fighter.initiativeBonus };
}

export function compareInitiativeTokens(left: BattleToken, right: BattleToken): number {
  const leftTotal = initiativeTotal(left);
  const rightTotal = initiativeTotal(right);
  if (leftTotal === null || rightTotal === null) {
    throw new Error('Cannot sort tokens without initiative rolls');
  }
  if (rightTotal !== leftTotal) {
    return rightTotal - leftTotal;
  }
  const leftBonus = left.initiativeBonus ?? 0;
  const rightBonus = right.initiativeBonus ?? 0;
  if (rightBonus !== leftBonus) {
    return rightBonus - leftBonus;
  }
  return left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
}

export function sortInitiativeOrder(
  order: readonly BattleTokenId[],
  tokens: readonly BattleToken[],
): BattleTokenId[] {
  const byId = new Map(tokens.map((token) => [token.id, token]));
  return [...order].sort((leftId, rightId) => {
    const left = byId.get(leftId);
    const right = byId.get(rightId);
    if (left === undefined || right === undefined) {
      throw new Error('Initiative order references a missing token');
    }
    return compareInitiativeTokens(left, right);
  });
}

export function activeInitiativeTokenId(board: BattleBoard): BattleTokenId | null {
  if (!board.initiativeEnabled || board.initiativeOrder.length === 0) {
    return null;
  }
  return board.initiativeOrder[board.activeIndex] ?? null;
}

/** Token ids of visible fighters (artifact-backed with stats, not covered). */
export function visibleFighterTokenIds(
  board: BattleBoard,
  stats: FighterStatsLookup,
  coveredTokenIds: ReadonlySet<BattleTokenId>,
): BattleTokenId[] {
  const ids: BattleTokenId[] = [];
  for (const token of board.tokens) {
    if (!token.visible || coveredTokenIds.has(token.id)) {
      continue;
    }
    if (token.artifactId === null || stats(token.artifactId) === undefined) {
      continue;
    }
    ids.push(token.id);
  }
  return ids;
}

/**
 * Drop hidden or veiled fighters from initiative order and clear their
 * rolls; revealing them again re-enters them via the caller's auto-roll.
 * `activeIndex` follows the active token to its new position.
 */
export function pruneInitiativeToVisibleFighters(
  board: BattleBoard,
  stats: FighterStatsLookup,
  coveredTokenIds: ReadonlySet<BattleTokenId>,
): BattleBoard {
  const visibleIds = new Set(visibleFighterTokenIds(board, stats, coveredTokenIds));
  const tokens = board.tokens.map((token) => {
    if (visibleIds.has(token.id)) {
      return token;
    }
    if (token.initiativeRoll === null && token.initiativeBonus === null) {
      return token;
    }
    return { ...token, initiativeRoll: null, initiativeBonus: null };
  });
  const initiativeOrder = board.initiativeOrder.filter((id) => visibleIds.has(id));
  const orderChanged =
    initiativeOrder.length !== board.initiativeOrder.length ||
    initiativeOrder.some((id, index) => id !== board.initiativeOrder[index]);
  const tokensChanged = tokens.some((token, index) => token !== board.tokens[index]);
  if (!tokensChanged && !orderChanged) {
    return board;
  }
  return {
    ...board,
    tokens,
    initiativeOrder,
    activeIndex: adjustActiveIndexForOrder(initiativeOrder, board.initiativeOrder, board.activeIndex),
  };
}

/** Whether this token participates in initiative right now. */
export function tokenInitiativeVisible(
  token: BattleToken,
  stats: FighterStatsLookup,
  veils: readonly BattleVeil[],
  unitSize: number,
  cellPx: number,
  boardWidthPx: number,
  boardHeightPx: number,
): boolean {
  if (token.artifactId === null || !token.visible) {
    return false;
  }
  if (stats(token.artifactId) === undefined) {
    return false;
  }
  return !portraitCoveredByVeils(token, veils, unitSize, cellPx, boardWidthPx, boardHeightPx);
}

export function clearTokenInitiative(tokens: readonly BattleToken[]): BattleToken[] {
  return tokens.map((token) => ({
    ...token,
    initiativeRoll: null,
    initiativeBonus: null,
  }));
}

export function adjustActiveIndexForOrder(
  order: readonly BattleTokenId[],
  previousOrder: readonly BattleTokenId[],
  previousIndex: number,
): number {
  const activeId = previousOrder[previousIndex];
  if (activeId === undefined) {
    return 0;
  }
  const nextIndex = order.indexOf(activeId);
  return nextIndex >= 0 ? nextIndex : 0;
}

export function removeTokenFromInitiativeOrder(
  order: readonly BattleTokenId[],
  tokenId: BattleTokenId,
): BattleTokenId[] {
  return order.filter((id) => id !== tokenId);
}

/**
 * >>> next turn: advance activeIndex, wrapping around the order.
 * Returns the same board (identity preserved) when initiative is off/empty.
 */
export function nextTurn(board: BattleBoard): BattleBoard {
  if (!board.initiativeEnabled || board.initiativeOrder.length === 0) {
    return board;
  }
  return { ...board, activeIndex: (board.activeIndex + 1) % board.initiativeOrder.length };
}
