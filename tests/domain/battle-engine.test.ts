import { describe, expect, it } from 'vitest';

import {
  STAGING_GROUND_CELLS,
  TOKEN_SIZE_DEFAULT,
  VEIL_DEFAULT_CELLS,
  type BattleBoard,
  type BattleToken,
  type BattleVeil,
  type FighterStatsLookup,
  tokenSizeFittingGrid,
  TOKEN_RING_OUTSET_PX,
  nextTokenScale,
} from '@/domain/battle';
import {
  applyStageReset,
  combatHpForToken,
  captureStageSnapshot,
  emptyBoard,
  ensurePcTokens,
  fallbackSpawnPoint,
  fillNpcTokenHp,
  instanceCurrentHpFor,
  restoreAllNpcHp,
  scrubArtifactFromBoard,
  spawnPointInStagingGround,
  stagingGroundAt,
  tokenFromFighter,
} from '@/domain/battle/board';
import {
  activeInitiativeTokenId,
  adjustActiveIndexForOrder,
  clearTokenInitiative,
  compareInitiativeTokens,
  initiativeTotal,
  nextTurn,
  pruneInitiativeToVisibleFighters,
  rollTokenInitiative,
  sortInitiativeOrder,
  visibleFighterTokenIds,
} from '@/domain/battle/initiative';
import {
  portraitCoveredByVeil,
  resizeVeilFromEdge,
  veilCellPx,
  veilSpanNorm,
} from '@/domain/battle/veil';
import { snapAxisToGrid, snapPointToGrid, tokenSpanCells } from '@/domain/battle/gridSnap';
import {
  beginBoardGesture,
  beginInitiativeDrag,
  endBoardGesture,
  endInitiativeDrag,
  initiativeDragEpoch,
  isBoardGestureActive,
  isInitiativeDragging,
  subscribeInitiativeDragEpoch,
} from '@/domain/battle/gestureGate';
import { newId } from '@/domain/entity';

/**
 * Golden tests for the ported battle engine (09-MILESTONE-5 M5-B). The
 * source (GM Cockpit `host/`) had NO tests — these pin the ported behavior:
 * HP ownership split, initiative reconcile/prune/adjust, veil coverage,
 * snap metrics, stage reset, staging-ground spawn layout, gesture gates.
 */

const CAMPAIGN_PC = '00000000-0000-4000-8000-000000000000a1';
const CAMPAIGN_NPC = '00000000-0000-4000-8000-000000000000b2';
const SEED_MONSTER = '00000000-0000-4000-8000-000000000000c3';

const pcStats = {
  kind: 'pc' as const,
  name: 'Serren',
  maxHp: 22,
  initiativeBonus: 3,
  currentHp: 17,
};
const npcStats = {
  kind: 'npc' as const,
  name: 'Goblin',
  maxHp: 7,
  initiativeBonus: 2,
  currentHp: null,
};

const stats: FighterStatsLookup = (id) => {
  if (id === CAMPAIGN_PC) return pcStats;
  if (id === CAMPAIGN_NPC) return npcStats;
  if (id === SEED_MONSTER) return { kind: 'npc', name: 'Goblin (seed)', maxHp: 7, initiativeBonus: 2, currentHp: null };
  return undefined;
};

function pcToken(overrides: Partial<BattleToken> = {}): BattleToken {
  return {
    id: newId(),
    artifactId: CAMPAIGN_PC,
    label: 'Serren',
    x: 0.5,
    y: 0.5,
    visible: true,
    scale: 1,
    shape: 'portrait',
    color: null,
    // PC tokens carry NO instance HP — the artifact owns it.
    currentHp: null,
    initiativeRoll: null,
    initiativeBonus: null,
    conditions: [],
    ...overrides,
  };
}

function npcToken(overrides: Partial<BattleToken> = {}): BattleToken {
  return {
    id: newId(),
    artifactId: CAMPAIGN_NPC,
    label: 'Goblin',
    x: 0.5,
    y: 0.5,
    visible: true,
    scale: 1,
    shape: 'portrait',
    color: null,
    currentHp: 7,
    initiativeRoll: null,
    initiativeBonus: null,
    conditions: [],
    ...overrides,
  };
}

describe('HP ownership split', () => {
  it('resolves PC HP from the artifact and flags ownership', () => {
    const resolved = combatHpForToken(pcToken(), stats);
    expect(resolved).toEqual({ maxHp: 22, currentHp: 17, ownedBy: 'artifact' });
  });

  it('resolves NPC HP from the token instance and flags ownership', () => {
    const token = npcToken({ currentHp: 3 });
    const resolved = combatHpForToken(token, stats);
    expect(resolved).toEqual({ maxHp: 7, currentHp: 3, ownedBy: 'token' });
  });

  it('seeds a fresh NPC instance at max HP, never from the artifact', () => {
    expect(instanceCurrentHpFor(npcStats, null)).toBe(7);
    expect(instanceCurrentHpFor(npcStats, 3)).toBe(3);
    expect(instanceCurrentHpFor(pcStats, null)).toBeNull();
  });

  it('refuses to resolve HP for a fighter without stats (loud, no placeholder)', () => {
    expect(combatHpForToken(pcToken({ artifactId: newId() }), stats)).toBeNull();
    // A null instance HP is a REPAIRABLE state for NPCs (filled from max),
    // not a placeholder: combat HP resolves to the artifact's max.
    expect(combatHpForToken(npcToken({ currentHp: null }), stats)).toEqual({
      maxHp: 7,
      currentHp: 7,
      ownedBy: 'token',
    });
  });

  it('re-fills null NPC token HP from the backing stats and clamps on write', () => {
    const board: BattleBoard = {
      ...emptyBoard(),
      tokens: [npcToken({ currentHp: null }), npcToken({ currentHp: 99, label: 'Goblin 2' })],
    };
    const next = fillNpcTokenHp(board, stats);
    expect(next.tokens[0]?.currentHp).toBe(7);
    expect(next.tokens[1]?.currentHp).toBe(7);
    // PC tokens are untouched — their HP lives on the artifact.
    const withPc = fillNpcTokenHp({ ...board, tokens: [pcToken()] }, stats);
    expect(withPc.tokens[0]?.currentHp).toBeNull();
  });

  it('restoreAllNpcHp resets instance HP to artifact max', () => {
    const board: BattleBoard = { ...emptyBoard(), tokens: [npcToken({ currentHp: 1 })] };
    expect(restoreAllNpcHp(board, stats).tokens[0]?.currentHp).toBe(7);
  });
});

describe('token spawning & staging ground', () => {
  it('spawns row-major inside the 3×3 staging ground', () => {
    const ground = stagingGroundAt(0.5, 0.5, 720, 480, 72);
    const first = spawnPointInStagingGround(0, ground);
    const second = spawnPointInStagingGround(1, ground);
    const fourth = spawnPointInStagingGround(3, ground);
    expect(STAGING_GROUND_CELLS).toBe(3);
    // Cell width is 72/720 = 0.1 → columns are 0.1 apart, rows 0.15.
    expect(second.x - first.x).toBeCloseTo(0.1, 10);
    expect(fourth.y - first.y).toBeCloseTo(0.15, 10);
    expect(first.x).toBeCloseTo(0.4, 10);
    expect(first.y).toBeCloseTo(0.35, 10);
  });

  it('falls back to a cascade layout without a staging ground', () => {
    expect(fallbackSpawnPoint(0)).toEqual({ x: 0.18, y: 0.22 });
    expect(fallbackSpawnPoint(5)).toEqual({ x: 0.18, y: 0.38 });
  });

  it('creates NPC tokens with fresh instance HP and empty initiative', () => {
    const token = tokenFromFighter(CAMPAIGN_NPC, npcStats, 0, true, null);
    expect(token.currentHp).toBe(7);
    expect(token.initiativeRoll).toBeNull();
    expect(token.initiativeBonus).toBeNull();
    expect(token.shape).toBe('portrait');
  });

  it('creates PC tokens without instance HP', () => {
    const token = tokenFromFighter(CAMPAIGN_PC, pcStats, 0, true, null);
    expect(token.currentHp).toBeNull();
  });

  it('ensurePcTokens spawns one token per statful PC, skipping existing ones', () => {
    const ground = stagingGroundAt(0.5, 0.5, 720, 480, 72);
    const existing = tokenFromFighter(CAMPAIGN_PC, pcStats, 0, true, null);
    const board: BattleBoard = { ...emptyBoard(), stagingGround: ground, tokens: [existing] };
    const next = ensurePcTokens(board, [
      { artifactId: CAMPAIGN_PC, stats: pcStats },
      { artifactId: SEED_MONSTER, stats: { kind: 'npc', name: 'Other PC', maxHp: 9 } },
    ]);
    expect(next.tokens).toHaveLength(2);
    expect(next.tokens[0]?.id).toBe(existing.id);
    expect(next.tokens[1]?.artifactId).toBe(SEED_MONSTER);
    // Spawned row-major at the staging ground's second slot.
    expect(next.tokens[1]?.x).toBeCloseTo(spawnPointInStagingGround(0, ground).x, 10);
  });

  it('keeps the board identity when nothing changed', () => {
    const board: BattleBoard = { ...emptyBoard(), tokens: [npcToken()] };
    expect(fillNpcTokenHp(board, stats)).toBe(board);
  });
});

describe('initiative', () => {
  it('totals roll + frozen bonus and cannot total without both', () => {
    expect(initiativeTotal({ ...npcToken(), initiativeRoll: 14, initiativeBonus: 2 })).toBe(16);
    expect(initiativeTotal({ ...npcToken(), initiativeRoll: 14, initiativeBonus: null })).toBeNull();
  });

  it('freezes the artifact bonus at roll time', () => {
    const token = rollTokenInitiative(npcToken(), stats);
    expect(token.initiativeBonus).toBe(2);
    expect(token.initiativeRoll).toBeGreaterThanOrEqual(1);
    expect(token.initiativeRoll).toBeLessThanOrEqual(20);
  });

  it('refuses to roll for stamps or statless fighters', () => {
    expect(() => rollTokenInitiative(pcToken({ artifactId: null }), stats)).toThrow();
    expect(() => rollTokenInitiative(pcToken({ artifactId: newId() }), stats)).toThrow();
  });

  it('sorts by total desc, then bonus desc, then label A–Z', () => {
    const a = npcToken({ label: 'A', initiativeRoll: 12, initiativeBonus: 2 });
    const b = npcToken({ label: 'B', initiativeRoll: 14, initiativeBonus: 0 });
    const c = npcToken({ label: 'C', initiativeRoll: 12, initiativeBonus: 2 });
    const d = npcToken({ label: 'D', initiativeRoll: 12, initiativeBonus: 0 });
    const order = sortInitiativeOrder([d.id, c.id, b.id, a.id], [a, b, c, d]);
    expect(order).toEqual([a.id, c.id, b.id, d.id]);
    expect(compareInitiativeTokens(a, c)).toBeLessThanOrEqual(0);
    expect(compareInitiativeTokens(b, d)).toBeLessThan(0);
  });

  it('prunes hidden and covered fighters from the order and clears their rolls', () => {
    const visible = npcToken({ initiativeRoll: 10, initiativeBonus: 2 });
    const hidden = npcToken({ visible: false, initiativeRoll: 18, initiativeBonus: 2 });
    const covered = npcToken({ initiativeRoll: 15, initiativeBonus: 2 });
    const board: BattleBoard = {
      ...emptyBoard(),
      initiativeEnabled: true,
      tokens: [visible, hidden, covered],
      initiativeOrder: [visible.id, hidden.id, covered.id],
      activeIndex: 2,
    };
    const coveredIds = new Set([covered.id]);
    const next = pruneInitiativeToVisibleFighters(board, stats, coveredIds);
    expect(next.initiativeOrder).toEqual([visible.id]);
    expect(next.tokens.find((token) => token.id === hidden.id)?.initiativeRoll).toBeNull();
    expect(next.tokens.find((token) => token.id === covered.id)?.initiativeBonus).toBeNull();
    // The active token (covered) left the order → activeIndex follows to 0.
    expect(next.activeIndex).toBe(0);
  });

  it('keeps the board identity when the prune changes nothing', () => {
    const fighter = npcToken({ initiativeRoll: 10, initiativeBonus: 2 });
    const board: BattleBoard = {
      ...emptyBoard(),
      initiativeEnabled: true,
      tokens: [fighter],
      initiativeOrder: [fighter.id],
    };
    expect(pruneInitiativeToVisibleFighters(board, stats, new Set())).toBe(board);
  });

  it('lists only visible, artifact-backed, statful fighters as initiative members', () => {
    const fighter = npcToken();
    const statless = pcToken({ artifactId: newId() });
    const stamp = npcToken({ artifactId: null, shape: 'circle', color: '#ff0000' });
    const hidden = npcToken({ visible: false });
    const board: BattleBoard = { ...emptyBoard(), tokens: [fighter, statless, stamp, hidden] };
    expect(visibleFighterTokenIds(board, stats, new Set())).toEqual([fighter.id]);
  });

  it('cycles turns and tracks the active token', () => {
    const a = npcToken({ initiativeRoll: 20, initiativeBonus: 0 });
    const b = npcToken({ initiativeRoll: 10, initiativeBonus: 0 });
    const board: BattleBoard = {
      ...emptyBoard(),
      initiativeEnabled: true,
      tokens: [a, b],
      initiativeOrder: [a.id, b.id],
      activeIndex: 0,
    };
    expect(activeInitiativeTokenId(board)).toBe(a.id);
    expect(activeInitiativeTokenId(nextTurn(board))).toBe(b.id);
    expect(activeInitiativeTokenId(nextTurn(nextTurn(board)))).toBe(a.id);
    const disabled: BattleBoard = { ...board, initiativeEnabled: false };
    expect(nextTurn(disabled)).toBe(disabled);
  });

  it('adjusts the active index to the active token’s new position', () => {
    const order = ['a', 'b', 'c'] as const;
    expect(adjustActiveIndexForOrder(['a', 'c'], order, 1)).toBe(0);
    expect(adjustActiveIndexForOrder(['a', 'c'], order, 2)).toBe(1);
    expect(adjustActiveIndexForOrder([], order, 0)).toBe(0);
  });

  it('clears every roll (stage reset / disable initiative)', () => {
    const tokens = [npcToken({ initiativeRoll: 5, initiativeBonus: 1 })];
    const cleared = clearTokenInitiative(tokens);
    expect(cleared[0]?.initiativeRoll).toBeNull();
    expect(cleared[0]?.initiativeBonus).toBeNull();
  });
});

describe('veils', () => {
  const boardPx = 720;
  const cellPx = 72;

  function veil(overrides: Partial<BattleVeil> = {}): BattleVeil {
    return {
      id: newId(),
      kind: 'veil',
      x: 0.5,
      y: 0.5,
      widthCells: VEIL_DEFAULT_CELLS,
      heightCells: VEIL_DEFAULT_CELLS,
      ...overrides,
    };
  }

  it('derives cell metrics from the grid (or token size when the grid is off)', () => {
    expect(veilCellPx(cellPx, TOKEN_SIZE_DEFAULT)).toBe(cellPx);
    expect(veilCellPx(null, 64)).toBe(64);
    expect(veilSpanNorm(2, cellPx, boardPx)).toBeCloseTo(144 / 720, 10);
    expect(() => veilSpanNorm(0, cellPx, boardPx)).toThrow();
    expect(() => veilCellPx(17.5, TOKEN_SIZE_DEFAULT)).toThrow();
  });

  it('resizes from an edge handle with the opposite edge pinned and cells quantized', () => {
    const base = veil();
    // A 2-cell veil centered at 0.5 spans 0.4..0.6. Dragging the east edge
    // to 1.1 (0.4 + 7 cells) quantizes to 7 cells; the west edge stays at 0.4.
    const east = resizeVeilFromEdge(base, 'e', { x: 1.1, y: 0.5 }, boardPx, boardPx, cellPx);
    expect(east.widthCells).toBe(7);
    expect(east.x).toBeCloseTo(0.4 + (7 * cellPx) / boardPx / 2, 10);
    // Dragging the west edge to 0.5 shrinks to a single cell, east edge pinned.
    const west = resizeVeilFromEdge(base, 'w', { x: 0.5, y: 0.5 }, boardPx, boardPx, cellPx);
    expect(west.widthCells).toBe(1);
    expect(west.x).toBeCloseTo(0.6 - cellPx / boardPx / 2, 10);
  });

  it('reports portrait tokens covered by a veil; stamps are never covered', () => {
    const token = npcToken({ x: 0.5, y: 0.5 });
    const covering = veil({ x: 0.5, y: 0.5 });
    const elsewhere = veil({ x: 0.1, y: 0.1 });
    expect(portraitCoveredByVeil(token, covering, 64, cellPx, boardPx, boardPx)).toBe(true);
    expect(portraitCoveredByVeil(token, elsewhere, 64, cellPx, boardPx, boardPx)).toBe(false);
    expect(
      portraitCoveredByVeil({ ...token, shape: 'circle', color: '#ff0000' }, covering, 64, cellPx, boardPx, boardPx),
    ).toBe(false);
  });
});

describe('grid snapping', () => {
  it('quantizes a token center to the middle of its span block', () => {
    expect(tokenSpanCells(0.5)).toBe(1);
    expect(tokenSpanCells(1)).toBe(1);
    expect(tokenSpanCells(2)).toBe(2);
    // 0.31*720 = 223.2 → cell 3.1 → block center 3.5 cells = 252px → 0.35.
    expect(snapAxisToGrid(0.31, 720, 72, 1)).toBeCloseTo(252 / 720, 10);
    expect(() => snapAxisToGrid(0.5, 720, 72, 0)).toThrow();
    expect(() => snapAxisToGrid(0.5, 720, 72.5, 1)).toThrow();
  });

  it('snaps both axes', () => {
    const snapped = snapPointToGrid(0.31, 0.62, 720, 720, 72, 1);
    expect(snapped.x).toBeCloseTo(0.35, 10);
    expect(snapped.y).toBeCloseTo(0.65, 10);
  });
});

describe('token scale', () => {
  it('steps through half → whole sizes', () => {
    expect(nextTokenScale(0.5, 1)).toBe(1);
    expect(nextTokenScale(1, 1)).toBe(2);
    expect(nextTokenScale(2.5, -1)).toBe(1);
    expect(nextTokenScale(1, -1)).toBe(0.5);
    expect(nextTokenScale(0.5, -1)).toBe(0.5);
  });

  it('derives the default token size from the grid ring outset', () => {
    expect(TOKEN_SIZE_DEFAULT).toBe(tokenSizeFittingGrid(72));
    expect(tokenSizeFittingGrid(72)).toBeLessThanOrEqual(72 - TOKEN_RING_OUTSET_PX * 2);
  });
});

describe('scrub & stage reset', () => {
  it('removes an artifact’s tokens and initiative entries', () => {
    const fighter = npcToken();
    const other = npcToken({ artifactId: SEED_MONSTER });
    const board: BattleBoard = {
      ...emptyBoard(),
      tokens: [fighter, other],
      initiativeOrder: [fighter.id, other.id],
      activeIndex: 0,
    };
    const next = scrubArtifactFromBoard(board, CAMPAIGN_NPC);
    expect(next.tokens.map((token) => token.id)).toEqual([other.id]);
    expect(next.initiativeOrder).toEqual([other.id]);
    expect(scrubArtifactFromBoard(board, newId())).toBe(board);
  });

  it('restores the exact opening layout and resets NPC instance HP', () => {
    const ground = stagingGroundAt(0.5, 0.5, 720, 480, 72);
    const goblin = npcToken({ currentHp: 2, initiativeRoll: 11, initiativeBonus: 2 });
    const opened: BattleBoard = {
      ...emptyBoard(),
      live: true,
      stagingGround: ground,
      mapImageId: null,
      tokens: [goblin],
      initiativeEnabled: true,
      initiativeOrder: [goblin.id],
    };
    const stage = captureStageSnapshot(opened);
    // The battle drifts: token damaged, initiative rolled, a stamp added.
    const drifted: BattleBoard = {
      ...opened,
      tokens: [...opened.tokens, { ...goblin, id: newId(), artifactId: null, shape: 'circle', color: '#ff0000', currentHp: null }],
      activeIndex: 0,
    };
    const reset = applyStageReset(drifted, stage, stats, []);
    expect(reset.live).toBe(true);
    expect(reset.tokens).toHaveLength(1);
    expect(reset.tokens[0]?.currentHp).toBe(7);
    expect(reset.tokens[0]?.initiativeRoll).toBeNull();
    expect(reset.initiativeEnabled).toBe(false);
    expect(reset.initiativeOrder).toEqual([]);
  });

  it('re-spawns missing PCs at the staging ground on reset', () => {
    const ground = stagingGroundAt(0.5, 0.5, 720, 480, 72);
    const pc = pcToken();
    const opened: BattleBoard = { ...emptyBoard(), stagingGround: ground, tokens: [pc] };
    const stage = captureStageSnapshot(opened);
    const emptied: BattleBoard = { ...opened, tokens: [] };
    const reset = applyStageReset(emptied, stage, stats, [{ artifactId: CAMPAIGN_PC, stats: pcStats }]);
    expect(reset.tokens).toHaveLength(1);
    expect(reset.tokens[0]?.artifactId).toBe(CAMPAIGN_PC);
  });
});

describe('gesture gates', () => {
  it('counts nested board gestures and throws on unbalanced end', () => {
    expect(isBoardGestureActive()).toBe(false);
    beginBoardGesture();
    beginBoardGesture();
    expect(isBoardGestureActive()).toBe(true);
    endBoardGesture();
    endBoardGesture();
    expect(isBoardGestureActive()).toBe(false);
    expect(() => {
      endBoardGesture();
    }).toThrow();
  });

  it('bumps the initiative drag epoch when the last drag ends and notifies listeners', () => {
    const epochs: number[] = [];
    const unsubscribe = subscribeInitiativeDragEpoch(() => {
      epochs.push(initiativeDragEpoch());
    });
    beginInitiativeDrag();
    expect(isInitiativeDragging()).toBe(true);
    beginInitiativeDrag();
    endInitiativeDrag();
    expect(isInitiativeDragging()).toBe(true);
    expect(epochs).toEqual([]);
    endInitiativeDrag();
    expect(isInitiativeDragging()).toBe(false);
    expect(epochs).toEqual([1]);
    expect(() => {
      endInitiativeDrag();
    }).toThrow();
    unsubscribe();
  });
});
