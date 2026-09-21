import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import type { AnyArtifact, Battle, BattleTokenId, FighterStatsLookup, Id } from '@/domain';
import { listArtifactsByCampaign, listGlobalArtifacts } from '@/db/artifactRepo';
import { getBattleForEncounter } from '@/db/battleRepo';
import { buildFighterStatsLookup, pcFightersOf } from '@/db/fighterStats';
import type { FighterStatsLike } from '@/domain/battle/board';
import { portraitCoveredByVeils } from '@/domain/battle/veil';
import { veilCellPx } from '@/domain/battle/veil';
import type { BattleVeil } from '@/domain/battle';

/**
 * Live battle state for the encounter-anchored table surface (M6-E; re-keyed
 * by encounter, docs/17 row 254): the battle row ITS encounter owns,
 * campaign/global fighter stats, and the derived covered-token set. This is the
 * one place Dexie rows become the engine's plain numbers.
 *
 * `contentWidthPx`/`contentHeightPx` MUST be the aspect-fitted CONTENT div's
 * size — the frame tokens and veils are %-positioned in — not the outer
 * container's. Under letterbox the two differ, and coverage must match the
 * rendered geometry (veil rect vs token rect in the same frame).
 */
export interface BattleState {
  battle: Battle | undefined;
  stats: FighterStatsLookup;
  coveredTokenIds: ReadonlySet<BattleTokenId>;
  artifacts: AnyArtifact[];
  pcFighters: { artifactId: Id; stats: FighterStatsLike }[];
}

export function useBattleState(
  campaignId: Id,
  encounterArtifactId: Id,
  contentWidthPx: number,
  contentHeightPx: number,
): BattleState {
  // The route names ONE encounter; this resolves the battle it owns (docs/17
  // row 254) through the ONE encounter→battle resolver, which also answers a
  // URL still naming the LIBRARY encounter the battle was adopted from before
  // the row-268 re-key (docs/17 row 268) — a reload after the v29 upgrade must
  // not land on an empty table.
  const battle = useLiveQuery(
    async () =>
      encounterArtifactId === ''
        ? undefined
        : getBattleForEncounter(campaignId, encounterArtifactId),
    [campaignId, encounterArtifactId],
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
    if (board.veils.length === 0 || contentWidthPx <= 0 || contentHeightPx <= 0) return covered;
    const cellWidthPx = board.mapLayout === null
      ? veilCellPx(board.gridSize, board.tokenSize)
      : contentWidthPx / board.mapLayout.cols;
    const cellHeightPx = board.mapLayout === null
      ? cellWidthPx
      : contentHeightPx / board.mapLayout.rows;
    for (const token of board.tokens) {
      // M5-D amendment (2026-09-06): veils hide MOB tokens only — never PCs
      // or other tokens. The fighter kind is the seed-chain derivation, no
      // new schema field: seedFighters rows (rulebook/inline monsters) and
      // npc artifacts (npc-ref monsters) both resolve kind 'npc' through the
      // stats lookup; PCs resolve 'pc'; statless tokens and stamps are
      // absent from the lookup (the loud-badge contract) and are never
      // coverage-hidden.
      if (token.artifactId === null || stats(token.artifactId)?.kind !== 'npc') continue;
      if (portraitCoveredByVeils(
        token,
        board.veils,
        board.tokenSize,
        cellWidthPx,
        contentWidthPx,
        contentHeightPx,
        cellHeightPx,
      )) {
        covered.add(token.id);
      }
    }
    return covered;
  }, [battle, stats, contentWidthPx, contentHeightPx]);

  return { battle, stats, coveredTokenIds, artifacts, pcFighters };
}

export type { BattleVeil };
