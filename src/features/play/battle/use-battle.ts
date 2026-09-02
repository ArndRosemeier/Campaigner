import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import type { AnyArtifact, Battle, BattleTokenId, FighterStatsLookup, Id } from '@/domain';
import { listArtifactsByCampaign, listGlobalArtifacts } from '@/db/artifactRepo';
import { getBattleByModule } from '@/db/battleRepo';
import { buildFighterStatsLookup, pcFightersOf } from '@/db/fighterStats';
import { portraitCoveredByVeils } from '@/domain/battle/veil';
import { veilCellPx } from '@/domain/battle/veil';
import type { BattleVeil } from '@/domain/battle';

/**
 * Live battle state for the module-anchored table surface (M6-E): the battle
 * row, campaign/module/global fighter stats, and the derived covered-token
 * set. This is the one place Dexie rows become the engine's plain numbers.
 */
export interface BattleState {
  battle: Battle | undefined;
  stats: FighterStatsLookup;
  coveredTokenIds: ReadonlySet<BattleTokenId>;
  artifacts: AnyArtifact[];
  pcFighters: { artifactId: Id; stats: { kind: 'pc' | 'npc'; name: string; maxHp: number } }[];
}

export function useBattleState(
  campaignId: Id,
  moduleId: Id,
  boardWidthPx: number,
  boardHeightPx: number,
): BattleState {
  const battle = useLiveQuery(
    async () => (moduleId === '' ? undefined : getBattleByModule(moduleId)),
    [moduleId],
    undefined,
  );
  const artifacts = useLiveQuery(
    async () => [
      ...(await listArtifactsByCampaign(campaignId)),
      ...(await listGlobalArtifacts()),
    ],
    [campaignId],
    [] as AnyArtifact[],
  );

  const stats = useMemo<FighterStatsLookup>(
    () => buildFighterStatsLookup(battle ?? { seedFighters: [] }, artifacts),
    [battle, artifacts],
  );
  const pcFighters = useMemo(() => pcFightersOf(artifacts), [artifacts]);

  const coveredTokenIds = useMemo(() => {
    const covered = new Set<BattleTokenId>();
    if (battle === undefined) return covered;
    const board = battle.board;
    if (board.veils.length === 0 || boardWidthPx <= 0 || boardHeightPx <= 0) return covered;
    const cellWidthPx = board.mapLayout === null
      ? veilCellPx(board.gridSize, board.tokenSize)
      : boardWidthPx / board.mapLayout.cols;
    const cellHeightPx = board.mapLayout === null
      ? cellWidthPx
      : boardHeightPx / board.mapLayout.rows;
    for (const token of board.tokens) {
      if (portraitCoveredByVeils(
        token,
        board.veils,
        board.tokenSize,
        cellWidthPx,
        boardWidthPx,
        boardHeightPx,
        cellHeightPx,
      )) {
        covered.add(token.id);
      }
    }
    return covered;
  }, [battle, boardWidthPx, boardHeightPx]);

  return { battle, stats, coveredTokenIds, artifacts, pcFighters };
}

export type { BattleVeil };
