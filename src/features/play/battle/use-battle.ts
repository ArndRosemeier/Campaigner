import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import type { Artifact, Battle, BattleTokenId, FighterStatsLookup, Id } from '@/domain';
import { db } from '@/db/db';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { getBattleBySession } from '@/db/battleRepo';
import { buildFighterStatsLookup, pcFightersOf } from '@/db/fighterStats';
import { portraitCoveredByVeils } from '@/domain/battle/veil';
import { veilCellPx } from '@/domain/battle/veil';
import type { BattleVeil } from '@/domain/battle';

/**
 * Live battle state for the table surface (09-MILESTONE-5 M5-D): the battle
 * row via liveQuery, the campaign's fighter stats, and the derived
 * covered-token set — the ONE place that turns Dexie rows into the plain
 * numbers the engine consumes.
 */

export interface BattleState {
  battle: Battle | undefined;
  /** Fighter stats across the campaign artifacts + the battle's seed roster. */
  stats: FighterStatsLookup;
  /** Token ids currently covered by a veil/fog (removed from the DOM). */
  coveredTokenIds: ReadonlySet<BattleTokenId>;
  /** Artifacts backing tokens (pc/npc rows — for portraits and HP writes). */
  artifacts: Artifact[];
  /** Statful PC fighters, for stage reset re-spawns. */
  pcFighters: { artifactId: Id; stats: { kind: 'pc' | 'npc'; name: string; maxHp: number } }[];
}

export function useBattleState(
  campaignId: Id,
  sessionId: Id | null,
  boardWidthPx: number,
  boardHeightPx: number,
): BattleState {
  const battle = useLiveQuery(
    async () => (sessionId === null ? undefined : getBattleBySession(sessionId)),
    [sessionId],
    undefined,
  );
  const artifacts = useLiveQuery(() => listArtifactsByCampaign(campaignId), [campaignId], [] as Artifact[]);

  const stats = useMemo<FighterStatsLookup>(
    () => buildFighterStatsLookup(battle ?? { seedFighters: [] }, artifacts),
    [battle, artifacts],
  );
  const pcFighters = useMemo(() => pcFightersOf(artifacts), [artifacts]);

  const coveredTokenIds = useMemo(() => {
    const covered = new Set<BattleTokenId>();
    if (battle === undefined) return covered;
    const board = battle.board;
    // Before the board has a pixel size (first paint), nothing is covered.
    if (board.veils.length === 0 || boardWidthPx <= 0 || boardHeightPx <= 0) return covered;
    const cellPx = veilCellPx(board.gridSize, board.tokenSize);
    for (const token of board.tokens) {
      if (portraitCoveredByVeils(token, board.veils, board.tokenSize, cellPx, boardWidthPx, boardHeightPx)) {
        covered.add(token.id);
      }
    }
    return covered;
  }, [battle, boardWidthPx, boardHeightPx]);

  return { battle, stats, coveredTokenIds, artifacts, pcFighters };
}

/** Resolves the active session artifact id (the battle owner), or null. */
export function useActiveSessionId(campaignId: Id, activeSessionId: Id | null): Id | null {
  const sessions = useLiveQuery(
    async () =>
      (await db.artifacts.where('campaignId').equals(campaignId).toArray()).filter(
        (artifact) => artifact.kind === 'session',
      ),
    [campaignId],
    [] as Artifact[],
  );
  if (activeSessionId !== null) {
    return activeSessionId;
  }
  return sessions[0]?.id ?? null;
}

export type { BattleVeil };
